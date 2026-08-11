/* ============================================================
   Amedeo's Private Car Service — reservations + CRM backend
   Cloudflare Worker. Handles:
     POST /reserve        save booking + geocode + email (Resend)
     POST /admin/login    password login -> session cookie
     POST /admin/logout   clear session
     GET  /admin          phone-first CRM dashboard (HTML)
     GET  /api/me         { authed }
     GET  /api/bookings   list bookings (+ customer) [auth]
     PATCH /api/bookings/:id  update status/paid/price/notes [auth]
     GET  /api/customers  list customers w/ home location [auth]

   Bindings / secrets (see wrangler.toml):
     DB              D1 database (afacs-crm)
     RESEND_API_KEY  secret — email
     MAPBOX_TOKEN    secret — geocoding + map
     ADMIN_PASSWORD  secret — dashboard login
     TO_EMAIL / FROM_EMAIL  vars — reservation email delivery
   ============================================================ */

import {
  handleConfig, handleQuote, handleDay, handleBook,
  handleManageGet, handleManageCancel,
  handleBlackouts, handleExtras, handleHealth,
  handleManageTip, handleOwnerTip,
} from "./api.js";
import { runScheduled, runDigest } from "./cron.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { loadSettings, localToUtc, blockWindow } from "./engine.js";

const ALLOWED_ORIGINS = [
  "https://allfloridaairportscarservice.com",
  "https://www.allfloridaairportscarservice.com",
  "https://purelux7.github.io",
  // Local development against `wrangler dev`. Harmless in production: CORS is
  // a browser-side control only, so it was never what protects these
  // endpoints — the public ones are public by design and the private ones sit
  // behind the session cookie check below.
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  // Accept.js refuses to run on a non-HTTPS page (E_WC_02), so exercising the
  // card step locally requires serving the site over TLS too.
  "https://localhost:8443",
  "https://127.0.0.1:8443",
];

const STUART = "-80.2528,27.1975"; // proximity bias for geocoding (Stuart, FL)

// Trip length assumed for legacy /reserve requests, which carry no destination
// code. Roughly a Fort Lauderdale round trip — long enough to be safe.
const LEGACY_BLOCK_HOURS = 3.5;

export default {
  // Two schedules share this handler; event.cron says which fired.
  //   */15 * * * *  charge sweep — anything that reached T-24h
  //   0 12 * * *    daily digest — 8am EDT / 7am EST
  async scheduled(event, env, ctx) {
    if (event.cron === "0 12 * * *") {
      ctx.waitUntil(runDigest(env));
    } else {
      ctx.waitUntil(runScheduled(env, ctx));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    // ---- CORS (for the public /reserve endpoint, called cross-origin) ----
    const origin = request.headers.get("Origin") || "";
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "POST, PATCH, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      // ---------- public booking endpoint ----------
      if ((path === "/reserve" || path === "/") && method === "POST") {
        return await handleReserve(request, env, cors);
      }

      // ---------- public booking engine (no auth) ----------
      // These sit ABOVE the /api/ auth gate below on purpose: the booking
      // form on the public site calls them cross-origin.
      if (path === "/api/config" && method === "GET") {
        return await handleConfig(env, cors);
      }
      if (path === "/api/quote" && method === "POST") {
        return await handleQuote(request, env, cors);
      }
      if (path === "/api/day" && method === "GET") {
        return await handleDay(url, env, cors);
      }
      if (path === "/api/book" && method === "POST") {
        return await handleBook(request, env, cors, ctx);
      }
      if (path === "/api/manage" && method === "GET") {
        return await handleManageGet(url, env, cors);
      }
      if (path === "/api/manage/tip" && method === "POST") {
        return await handleManageTip(request, env, cors, ctx);
      }
      if (path === "/api/manage/cancel" && method === "POST") {
        return await handleManageCancel(request, env, cors, ctx);
      }

      // ---------- dashboard page ----------
      if (path === "/admin" && method === "GET") {
        return new Response(renderDashboard(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ---------- auth ----------
      if (path === "/admin/login" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
          return json({ error: "Wrong password" }, 401, cors);
        }
        const token = await sessionToken(env);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `afacs=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
          },
        });
      }
      if (path === "/admin/logout" && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "afacs=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
          },
        });
      }
      if (path === "/api/me" && method === "GET") {
        return json({ authed: await isAuthed(request, env) }, 200, cors);
      }

      // ---------- protected API ----------
      if (path.startsWith("/api/")) {
        if (!(await isAuthed(request, env))) return json({ error: "Unauthorized" }, 401, cors);

        if (path === "/api/bookings" && method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT b.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
             FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
             ORDER BY b.ride_date DESC, b.ride_time DESC, b.id DESC`
          ).all();
          return json({ bookings: results || [] }, 200, cors);
        }

        const mBooking = path.match(/^\/api\/bookings\/(\d+)$/);
        if (mBooking && (method === "PATCH" || method === "POST")) {
          const id = Number(mBooking[1]);
          const b = await request.json().catch(() => ({}));
          const sets = [], vals = [];
          if ("status" in b) { sets.push("status = ?"); vals.push(String(b.status)); }
          if ("paid" in b) { sets.push("paid = ?"); vals.push(b.paid ? 1 : 0); }
          if ("price" in b) { sets.push("price = ?"); vals.push(b.price === "" || b.price == null ? null : Number(b.price)); }
          if ("notes" in b) { sets.push("notes = ?"); vals.push(String(b.notes || "")); }
          if (!sets.length) return json({ error: "Nothing to update" }, 400, cors);
          vals.push(id);
          await env.DB.prepare(`UPDATE bookings SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
          return json({ ok: true }, 200, cors);
        }

        if (path === "/api/health" && method === "GET") {
          return await handleHealth(env, cors);
        }

        if (path === "/api/blackouts" || path.startsWith("/api/blackouts/")) {
          return await handleBlackouts(request, url, env, cors, method);
        }

        const mTip = path.match(/^\/api\/bookings\/(\d+)\/tip$/);
        if (mTip && method === "POST") {
          return await handleOwnerTip(request, env, cors, Number(mTip[1]), ctx);
        }

        const mExtras = path.match(/^\/api\/bookings\/(\d+)\/extras$/);
        if (mExtras && method === "POST") {
          return await handleExtras(request, env, cors, Number(mExtras[1]), ctx);
        }

        // Manual "run the charge sweep now" button for the admin screen.
        if (path === "/api/run-charges" && method === "POST") {
          const out = await runScheduled(env, ctx);
          return json(out, 200, cors);
        }

        // Send the daily digest on demand — also the way to prove the
        // heartbeat works without waiting until tomorrow morning.
        if (path === "/api/run-digest" && method === "POST") {
          const out = await runDigest(env);
          return json(out, 200, cors);
        }

        if (path === "/api/customers" && method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT c.*, COUNT(b.id) AS ride_count
             FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id
             GROUP BY c.id ORDER BY ride_count DESC, c.name ASC`
          ).all();
          return json({ customers: results || [] }, 200, cors);
        }

        return json({ error: "Not found" }, 404, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: "Server error", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

/* ---------------- reservation handling ---------------- */

export async function handleReserve(request, env, cors) {
  let d;
  try { d = await request.json(); } catch { return json({ error: "Invalid request" }, 400, cors); }

  if (d.company) return json({ ok: true }, 200, cors); // honeypot

  const required = ["pickup", "dropoff", "date", "time", "passengers", "service", "name", "phone", "email"];
  for (const f of required) {
    if (!d[f] || String(d[f]).trim() === "") return json({ error: `Missing field: ${f}` }, 422, cors);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email))) {
    return json({ error: "Invalid email" }, 422, cors);
  }

  // Save to the CRM (best-effort: never block the email on a DB hiccup).
  if (env.DB) {
    try {
      const customerId = await upsertCustomer(env, d.name, d.email, d.phone);
      const [pu, dropoff] = await Promise.all([
        geocode(d.pickup, env),
        geocode(d.dropoff, env),
      ]);
      // Legacy quote-request path (the old form still posts here). It has no
      // destination code and therefore no known trip length, but it MUST still
      // occupy the calendar — otherwise an enquiry and a paid booking can land
      // on the same 5am slot and Matt is double-booked. A conservative default
      // block is far better than none.
      const settings = await loadSettings(env);
      const rideStartUtc = localToUtc(d.date, d.time, settings.tz);
      let blockStart = null, blockEnd = null;
      if (Number.isFinite(rideStartUtc)) {
        const w = blockWindow(rideStartUtc, LEGACY_BLOCK_HOURS, settings);
        blockStart = w.start;
        blockEnd = w.end;
      }

      await env.DB.prepare(
        `INSERT INTO bookings
           (customer_id, service, pickup, pickup_lat, pickup_lng, dropoff, dropoff_lat, dropoff_lng,
            ride_date, ride_time, passengers, notes, source,
            ride_start_utc, block_start_utc, block_end_utc, hours_engaged)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'website', ?,?,?,?)`
      ).bind(
        customerId, d.service, d.pickup, pu?.lat ?? null, pu?.lng ?? null,
        d.dropoff, dropoff?.lat ?? null, dropoff?.lng ?? null,
        d.date, d.time, d.passengers, d.notes || "",
        Number.isFinite(rideStartUtc) ? rideStartUtc : null,
        blockStart, blockEnd, LEGACY_BLOCK_HOURS
      ).run();
    } catch (e) {
      // swallow — the email still goes out so the booking is never lost
      console.log("CRM save failed:", e && e.message);
    }
  }

  // ---- send the reservation email (unchanged behavior) ----
  const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const row = (label, val) =>
    `<tr><td style="padding:8px 14px;color:#7b8597;font:600 13px Arial,sans-serif;white-space:nowrap">${label}</td>` +
    `<td style="padding:8px 14px;color:#1b2533;font:400 15px Arial,sans-serif">${esc(val) || "—"}</td></tr>`;

  const subject = `New Reservation — ${esc(d.service)} · ${esc(d.name)}`;
  const html = `
    <div style="background:#f4f6f9;padding:28px">
      <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e8ef">
        <div style="background:#0e2340;padding:22px 26px">
          <div style="color:#fff;font:800 20px Arial,sans-serif">New Reservation Request</div>
          <div style="color:#c4a253;font:600 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin-top:4px">Amedeo's Private Car Service</div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          ${row("Service", d.service)}${row("Name", d.name)}${row("Phone", d.phone)}${row("Email", d.email)}
          ${row("Pickup", d.pickup)}${row("Drop off", d.dropoff)}${row("Date", d.date)}${row("Time", d.time)}
          ${row("Passengers", d.passengers)}${row("Notes", d.notes)}
        </table>
        <div style="padding:16px 26px;background:#f4f6f9;color:#7b8597;font:400 12px Arial,sans-serif">
          Saved to your CRM. Reply to this email to reach the client.
        </div>
      </div>
    </div>`;
  const text =
    `New Reservation Request — Amedeo's Private Car Service\n\n` +
    `Service:    ${d.service}\nName:       ${d.name}\nPhone:      ${d.phone}\nEmail:      ${d.email}\n` +
    `Pickup:     ${d.pickup}\nDrop off:   ${d.dropoff}\nDate:       ${d.date}\nTime:       ${d.time}\n` +
    `Passengers: ${d.passengers}\nNotes:      ${d.notes || "—"}\n`;

  if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: String(env.TO_EMAIL).split(",").map((s) => s.trim()).filter(Boolean),
        reply_to: String(d.email),
        subject, html, text,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      // booking is already saved; report email failure but don't 500 the user hard
      return json({ ok: true, emailWarning: true, detail }, 200, cors);
    }

    // ---- customer confirmation email (best-effort; never blocks the booking) ----
    try {
      const replyTo = String(env.TO_EMAIL).split(",").map((s) => s.trim()).filter(Boolean);
      const custSubject = `We received your reservation request — Amedeo's Private Car Service`;
      const custHtml = `
    <div style="background:#f4f6f9;padding:28px">
      <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e8ef">
        <div style="background:#0e2340;padding:26px">
          <div style="color:#fff;font:800 22px Arial,sans-serif">Thank you, ${esc((d.name || "").split(" ")[0]) || "there"}.</div>
          <div style="color:#c4a253;font:600 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin-top:6px">Amedeo's Private Car Service</div>
        </div>
        <div style="padding:24px 26px 6px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
          We've received your reservation request. Matt will personally review the details below and confirm your ride and flat rate shortly — usually within the hour.
        </div>
        <table style="width:100%;border-collapse:collapse;margin:14px 0 4px">
          ${row("Service", d.service)}${row("Pickup", d.pickup)}${row("Drop off", d.dropoff)}
          ${row("Date", d.date)}${row("Time", d.time)}${row("Passengers", d.passengers)}${row("Notes", d.notes)}
        </table>
        <div style="padding:14px 26px 24px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
          Need it sooner or have a change? Call or text <a href="tel:+18486670999" style="color:#0e2340;font-weight:700;text-decoration:none">848-667-0999</a>.
        </div>
        <div style="padding:16px 26px;background:#f4f6f9;color:#7b8597;font:400 12px Arial,sans-serif">
          This is a confirmation that your request was received — it is not yet a confirmed booking. Amedeo's Private Car Service · Stuart, Florida.
        </div>
      </div>
    </div>`;
      const custText =
        `Thank you, ${(d.name || "").split(" ")[0] || "there"}.\n\n` +
        `We've received your reservation request. Matt will personally confirm your ride and flat rate shortly — usually within the hour.\n\n` +
        `Service:    ${d.service}\nPickup:     ${d.pickup}\nDrop off:   ${d.dropoff}\n` +
        `Date:       ${d.date}\nTime:       ${d.time}\nPassengers: ${d.passengers}\nNotes:      ${d.notes || "—"}\n\n` +
        `Need it sooner or have a change? Call or text 848-667-0999.\n\n` +
        `This is a confirmation that your request was received — it is not yet a confirmed booking.\n` +
        `Amedeo's Private Car Service · Stuart, Florida\n`;

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [String(d.email)],
          reply_to: replyTo,
          subject: custSubject,
          html: custHtml,
          text: custText,
        }),
      });
    } catch (e) {
      // never let the customer confirmation affect the booking result
      console.log("Customer confirmation email failed:", e && e.message);
    }
  }
  return json({ ok: true }, 200, cors);
}

async function upsertCustomer(env, name, email, phone) {
  const e = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
  const p = phone && String(phone).trim() ? String(phone).trim() : null;

  let existing = null;
  if (e || p) {
    existing = await env.DB.prepare(
      `SELECT id FROM customers WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1`
    ).bind(e, p).first();
  }
  if (existing && existing.id) {
    await env.DB.prepare(
      `UPDATE customers SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?`
    ).bind(name, e, p, existing.id).run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    `INSERT INTO customers (name, email, phone) VALUES (?,?,?)`
  ).bind(name, e, p).run();
  return res.meta.last_row_id;
}

async function geocode(query, env) {
  if (!env.MAPBOX_TOKEN || !query) return null;
  try {
    const u = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${env.MAPBOX_TOKEN}&limit=1&country=us&proximity=${STUART}`;
    const r = await fetch(u);
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.features && j.features[0] && j.features[0].center;
    if (!c) return null;
    return { lng: c[0], lat: c[1] };
  } catch { return null; }
}

/* ---------------- auth ---------------- */

async function sessionToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ADMIN_PASSWORD || "x"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("afacs-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)afacs=([a-f0-9]+)/);
  if (!m) return false;
  const expected = await sessionToken(env);
  // constant-time-ish compare
  if (m[1].length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= m[1].charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/* ---------------- helpers ---------------- */

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}

function renderDashboard() {
  return DASHBOARD_HTML;
}
