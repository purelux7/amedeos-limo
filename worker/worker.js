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

const ALLOWED_ORIGINS = [
  "https://allfloridaairportscarservice.com",
  "https://www.allfloridaairportscarservice.com",
  "https://purelux7.github.io",
];

const STUART = "-80.2528,27.1975"; // proximity bias for geocoding (Stuart, FL)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    // ---- CORS (for the public /reserve endpoint, called cross-origin) ----
    const origin = request.headers.get("Origin") || "";
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "POST, PATCH, GET, OPTIONS",
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

      // ---------- dashboard page ----------
      if (path === "/admin" && method === "GET") {
        return new Response(renderDashboard(env), {
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

async function handleReserve(request, env, cors) {
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
      await env.DB.prepare(
        `INSERT INTO bookings
           (customer_id, service, pickup, pickup_lat, pickup_lng, dropoff, dropoff_lat, dropoff_lng,
            ride_date, ride_time, passengers, notes, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'website')`
      ).bind(
        customerId, d.service, d.pickup, pu?.lat ?? null, pu?.lng ?? null,
        d.dropoff, dropoff?.lat ?? null, dropoff?.lng ?? null,
        d.date, d.time, d.passengers, d.notes || ""
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

function renderDashboard(env) {
  const token = env.MAPBOX_TOKEN || "";
  return DASHBOARD_HTML.replace("__MAPBOX_TOKEN__", token);
}

/* ---------------- dashboard (served at /admin) ---------------- */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<title>Amedeo's CRM</title>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css" rel="stylesheet"/>
<script src="https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js"></script>
<style>
  :root{--navy:#0e2340;--navy2:#16335c;--gold:#c4a253;--ink:#1b2533;--muted:#7b8597;--line:#e3e8ef;--bg:#f4f6f9;}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  /* login */
  #login{position:fixed;inset:0;background:var(--navy);display:flex;align-items:center;justify-content:center;padding:24px}
  .login-card{background:#fff;border-radius:14px;padding:30px 26px;width:100%;max-width:340px;text-align:center}
  .login-card h1{font-size:1.2rem;margin:0 0 4px}
  .login-card .sub{color:var(--gold);font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;margin-bottom:22px}
  input,select,textarea{font:inherit;width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink)}
  .btn{display:inline-block;border:none;border-radius:9px;padding:12px 16px;font-weight:600;cursor:pointer;background:var(--gold);color:#fff}
  .btn.block{width:100%}
  .err{color:#c2483d;font-size:.85rem;margin-top:10px;min-height:1em}
  /* app */
  #app{display:none;padding-bottom:74px}
  header{background:var(--navy);color:#fff;padding:16px 18px;position:sticky;top:0;z-index:20}
  header .brand{font-weight:800;font-size:1.05rem}
  header .brand small{display:block;color:var(--gold);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;font-weight:600;margin-top:2px}
  .wrap{padding:14px}
  .count{color:var(--muted);font-size:.82rem;margin:2px 2px 12px}
  /* booking card */
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:0 4px 14px rgba(16,35,64,.05)}
  .card .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  .card .when{font-weight:700}
  .card .svc{font-size:.72rem;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .card .who{margin:8px 0 4px;font-weight:600}
  .card a.call{color:var(--navy2);text-decoration:none;font-weight:600}
  .route{font-size:.9rem;color:#384559;margin:6px 0;line-height:1.5}
  .route .pin{color:var(--gold)}
  .meta{font-size:.8rem;color:var(--muted);margin:4px 0}
  .ctrls{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
  .ctrls select{width:auto;flex:1;min-width:120px;padding:9px 10px}
  .ctrls .price{width:96px}
  .toggle{border:1px solid var(--line);background:#fff;color:var(--muted);border-radius:30px;padding:9px 14px;font-weight:600;cursor:pointer;white-space:nowrap}
  .toggle.on{background:#1f7a4d;border-color:#1f7a4d;color:#fff}
  .badge{font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:20px;background:var(--bg);color:var(--muted)}
  .badge.new{background:#fdf3e2;color:#9a6b12}
  .badge.confirmed{background:#e7f0ff;color:#1d4ed8}
  .badge.done{background:#e9f6ee;color:#1f7a4d}
  .badge.canceled{background:#f6e9e9;color:#b03a3a}
  /* map */
  #map{width:100%;height:calc(100vh - 200px);min-height:340px;border-radius:12px;overflow:hidden}
  .mapbar{display:flex;gap:8px;margin-bottom:10px}
  /* customers */
  .crow{background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
  .crow .nm{font-weight:600}
  .crow .sm{font-size:.8rem;color:var(--muted)}
  .rides{background:var(--navy);color:#fff;border-radius:20px;font-size:.72rem;font-weight:700;padding:4px 10px}
  .pad{padding:30px;text-align:center;color:var(--muted)}
  /* bottom nav */
  nav.tabs{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);display:flex;z-index:20}
  nav.tabs .tab{flex:1;border:none;background:none;padding:12px 4px 14px;color:var(--muted);font-size:.72rem;font-weight:600;cursor:pointer}
  nav.tabs .tab.active{color:var(--navy)}
  nav.tabs .tab .ic{display:block;font-size:1.15rem;margin-bottom:2px}
</style>
</head>
<body>

<div id="login">
  <div class="login-card">
    <h1>Amedeo's CRM</h1>
    <div class="sub">Private Car Service</div>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password"/>
    <div class="err" id="loginErr"></div>
    <button class="btn block" id="loginBtn">Sign in</button>
  </div>
</div>

<div id="app">
  <header>
    <div class="brand">Amedeo's CRM<small>Private Car Service</small></div>
  </header>

  <section id="view-bookings" class="wrap">
    <div class="count" id="bkCount"></div>
    <div id="bkList"></div>
  </section>

  <section id="view-map" class="wrap" style="display:none">
    <div class="mapbar">
      <select id="mapDate"></select>
    </div>
    <div id="map"></div>
  </section>

  <section id="view-customers" class="wrap" style="display:none">
    <div class="count" id="custCount"></div>
    <div id="custList"></div>
  </section>
</div>

<nav class="tabs" id="tabs" style="display:none">
  <button class="tab active" data-view="view-bookings"><span class="ic">&#128197;</span>Bookings</button>
  <button class="tab" data-view="view-map"><span class="ic">&#128205;</span>Map</button>
  <button class="tab" data-view="view-customers"><span class="ic">&#128100;</span>Customers</button>
  <button class="tab" data-view="logout"><span class="ic">&#9211;</span>Sign out</button>
</nav>

<script>
window.MAPBOX_TOKEN = "__MAPBOX_TOKEN__";
var state = { bookings: [], customers: [], map: null, markers: [], mapReady: false };

function el(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
function gid(id){ return document.getElementById(id); }

function api(path, opts){
  opts = opts || {};
  opts.credentials = "include";
  if (opts.body){ opts.headers = {"Content-Type":"application/json"}; opts.body = JSON.stringify(opts.body); }
  return fetch(path, opts).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,data:j}; }).catch(function(){ return {ok:r.ok,status:r.status,data:{}}; }); });
}

/* ---- auth ---- */
function checkAuth(){ api("/api/me").then(function(r){ if(r.data && r.data.authed){ enterApp(); } }); }
function doLogin(){
  var pw = gid("pw").value;
  api("/admin/login", {method:"POST", body:{password:pw}}).then(function(r){
    if(r.ok){ enterApp(); } else { gid("loginErr").textContent = "Wrong password"; }
  });
}
function logout(){ api("/admin/logout", {method:"POST"}).then(function(){ location.reload(); }); }
function enterApp(){
  gid("login").style.display = "none";
  gid("app").style.display = "block";
  gid("tabs").style.display = "flex";
  loadBookings(); loadCustomers();
}

/* ---- nav ---- */
function showView(id){
  if(id === "logout"){ logout(); return; }
  ["view-bookings","view-map","view-customers"].forEach(function(v){ gid(v).style.display = (v===id)?"block":"none"; });
  var tabs = document.querySelectorAll(".tab");
  for(var i=0;i<tabs.length;i++){ tabs[i].classList.toggle("active", tabs[i].getAttribute("data-view")===id); }
  if(id === "view-map") initMap();
}

/* ---- bookings ---- */
function loadBookings(){
  api("/api/bookings").then(function(r){ state.bookings = (r.data && r.data.bookings) || []; renderBookings(); buildDateFilter(); });
}
function fmtDate(d){ if(!d) return ""; var p=d.split("-"); if(p.length!==3) return d; return p[1]+"/"+p[2]+"/"+p[0].slice(2); }
function renderBookings(){
  var list = gid("bkList"); list.innerHTML = "";
  gid("bkCount").textContent = state.bookings.length + " booking" + (state.bookings.length===1?"":"s");
  if(!state.bookings.length){ list.appendChild(el("div","pad","No bookings yet. They'll appear here the moment someone books on the site.")); return; }
  state.bookings.forEach(function(b){
    var card = el("div","card");
    var top = el("div","top");
    var when = el("div","when", fmtDate(b.ride_date) + (b.ride_time ? "  ·  " + b.ride_time : ""));
    var badge = el("span","badge " + (b.status||"new"), b.status||"new");
    top.appendChild(when); top.appendChild(badge); card.appendChild(top);
    card.appendChild(el("div","svc", b.service || "Ride"));

    var who = el("div","who"); who.appendChild(document.createTextNode((b.customer_name||"—") + "  "));
    if(b.customer_phone){ var a=el("a","call","☎ " + b.customer_phone); a.href="tel:"+b.customer_phone; who.appendChild(a); }
    card.appendChild(who);

    var route = el("div","route");
    route.appendChild(el("span","pin","● ")); route.appendChild(document.createTextNode(b.pickup||"—"));
    route.appendChild(el("br"));
    route.appendChild(el("span","pin","◎ ")); route.appendChild(document.createTextNode(b.dropoff||"—"));
    card.appendChild(route);

    var metaTxt = (b.passengers? b.passengers+" pax" : "");
    if(b.notes) metaTxt += (metaTxt?"  ·  ":"") + b.notes;
    if(metaTxt) card.appendChild(el("div","meta", metaTxt));

    var ctrls = el("div","ctrls");
    var sel = el("select");
    ["new","confirmed","done","canceled"].forEach(function(s){ var o=el("option",null,s); o.value=s; if((b.status||"new")===s)o.selected=true; sel.appendChild(o); });
    sel.onchange = function(){ updateBooking(b.id,{status:sel.value}); b.status=sel.value; badge.className="badge "+sel.value; badge.textContent=sel.value; };
    ctrls.appendChild(sel);

    var price = el("input","price"); price.type="number"; price.placeholder="$ rate"; price.value = (b.price!=null? b.price : "");
    price.onchange = function(){ updateBooking(b.id,{price:price.value}); };
    ctrls.appendChild(price);

    var paid = el("button","toggle"+(b.paid?" on":""), b.paid?"Paid":"Unpaid");
    paid.onclick = function(){ b.paid = b.paid?0:1; paid.className="toggle"+(b.paid?" on":""); paid.textContent=b.paid?"Paid":"Unpaid"; updateBooking(b.id,{paid:b.paid}); };
    ctrls.appendChild(paid);

    card.appendChild(ctrls);
    list.appendChild(card);
  });
}
function updateBooking(id, patch){ api("/api/bookings/"+id, {method:"PATCH", body:patch}); }

/* ---- customers ---- */
function loadCustomers(){
  api("/api/customers").then(function(r){ state.customers = (r.data && r.data.customers) || []; renderCustomers(); });
}
function renderCustomers(){
  var list = gid("custList"); list.innerHTML = "";
  gid("custCount").textContent = state.customers.length + " customer" + (state.customers.length===1?"":"s");
  if(!state.customers.length){ list.appendChild(el("div","pad","No customers yet.")); return; }
  state.customers.forEach(function(c){
    var row = el("div","crow");
    var left = el("div");
    left.appendChild(el("div","nm", c.name||"—"));
    var sm = el("div","sm", [c.phone, c.email].filter(Boolean).join("  ·  "));
    left.appendChild(sm);
    row.appendChild(left);
    row.appendChild(el("span","rides", (c.ride_count||0) + " rides"));
    list.appendChild(row);
  });
}

/* ---- map ---- */
function buildDateFilter(){
  var sel = gid("mapDate"); if(!sel) return;
  var dates = {}; state.bookings.forEach(function(b){ if(b.ride_date) dates[b.ride_date]=1; });
  var keys = Object.keys(dates).sort();
  sel.innerHTML = "";
  var all = el("option",null,"All dates"); all.value=""; sel.appendChild(all);
  keys.forEach(function(d){ var o=el("option",null,fmtDate(d)); o.value=d; sel.appendChild(o); });
  sel.onchange = renderPins;
}
function initMap(){
  if(!window.MAPBOX_TOKEN){ gid("map").innerHTML = '<div class="pad">Add a Mapbox token (MAPBOX_TOKEN secret) to enable the map.</div>'; return; }
  if(state.map){ renderPins(); return; }
  mapboxgl.accessToken = window.MAPBOX_TOKEN;
  state.map = new mapboxgl.Map({ container:"map", style:"mapbox://styles/mapbox/dark-v11", center:[-80.25,27.19], zoom:8.5 });
  state.map.on("load", function(){ state.mapReady = true; renderPins(); });
}
function renderPins(){
  if(!state.map || !state.mapReady) return;
  state.markers.forEach(function(m){ m.remove(); }); state.markers = [];
  var filter = gid("mapDate").value;
  var bounds = new mapboxgl.LngLatBounds(); var any=false;
  state.bookings.forEach(function(b){
    if(filter && b.ride_date !== filter) return;
    if(b.pickup_lat==null || b.pickup_lng==null) return;
    var elm = el("div"); elm.style.cssText = "width:16px;height:16px;border-radius:50%;background:#c4a253;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3)";
    var pop = new mapboxgl.Popup({offset:14}).setHTML(
      '<div style="font:600 13px sans-serif;color:#1b2533">'+ escapeHtml(b.customer_name||"Ride") +'</div>'+
      '<div style="font:400 12px sans-serif;color:#7b8597">'+ escapeHtml(fmtDate(b.ride_date)+" "+(b.ride_time||"")) +'</div>'+
      '<div style="font:400 12px sans-serif;color:#384559;margin-top:3px">'+ escapeHtml(b.pickup||"") +'</div>'
    );
    var mk = new mapboxgl.Marker(elm).setLngLat([b.pickup_lng,b.pickup_lat]).setPopup(pop).addTo(state.map);
    state.markers.push(mk); bounds.extend([b.pickup_lng,b.pickup_lat]); any=true;
  });
  if(any){ try{ state.map.fitBounds(bounds,{padding:60,maxZoom:12,duration:500}); }catch(e){} }
}
function escapeHtml(s){ return String(s||"").replace(/[<>&"]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;","\\"":"&quot;"}[c];}); }

/* ---- wire up ---- */
gid("loginBtn").onclick = doLogin;
gid("pw").addEventListener("keydown", function(e){ if(e.key==="Enter") doLogin(); });
var tb = document.querySelectorAll(".tab");
for(var i=0;i<tb.length;i++){ (function(t){ t.onclick=function(){ showView(t.getAttribute("data-view")); }; })(tb[i]); }
checkAuth();
</script>
</body>
</html>`;
