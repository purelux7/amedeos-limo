/* ============================================================
   Back-office services: authentication, metrics, customer 360,
   and editable business settings.

   The admin used to be a single password baked into a Cloudflare
   secret, which meant changing it required the CLI and a person who
   knows what wrangler is. That is not an admin portal; it is a lock
   with the key held by someone else. The password now lives as a
   PBKDF2 hash in the database, so the back office can change its own
   credentials, and the environment secret survives only as the
   bootstrap for the very first sign-in.
   ============================================================ */

import { loadSettings, loadRates, money } from "./engine.js";
import { revokeAll } from "./sessions.js";

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const PBKDF2_ITERATIONS = 210000; // OWASP 2023 floor for PBKDF2-SHA256

async function derive(password, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return b64(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${hash}`;
}

/* Constant-time-ish compare. Both sides are fixed-length base64 of a
   digest, so a length check leaks nothing useful. */
function sameDigest(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const candidate = await derive(password, unb64(parts[2]), iterations);
  return sameDigest(candidate, parts[3]);
}

async function getSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}

async function putSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, String(value)).run();
}

/* ------------------------------------------------------------
   Sign-in check used by the login route.

   Order matters. A stored hash always wins, so that changing the
   password in the back office genuinely retires the old one rather
   than leaving the environment secret quietly working forever.
   ------------------------------------------------------------ */
export async function checkAdminPassword(env, password) {
  if (!password) return false;
  const stored = await getSetting(env, "admin_password_hash").catch(() => null);
  if (stored) return await verifyPassword(password, stored);
  return Boolean(env.ADMIN_PASSWORD) && password === env.ADMIN_PASSWORD;
}

export async function changePassword(request, env, cors) {
  const d = await request.json().catch(() => ({}));
  const current = String(d.current || "");
  const next = String(d.next || "");

  if (!(await checkAdminPassword(env, current))) {
    return json({ error: "That is not the current password." }, 401, cors);
  }
  if (next.length < 10) {
    return json({ error: "Use at least 10 characters." }, 422, cors);
  }
  if (next === current) {
    return json({ error: "That is the password you already have." }, 422, cors);
  }
  await putSetting(env, "admin_password_hash", await hashPassword(next));

  // Changing the password has to mean something. Every other session is
  // revoked here — the phone left in a taxi, the browser on a hotel
  // computer, a cookie someone copied. The session making the change
  // survives, so Matt is not thrown out of the screen he is standing in.
  await revokeAll(env, request, { keepCurrent: true });

  return json({ ok: true }, 200, cors);
}

/* ============================================================
   DASHBOARD METRICS
   Money figures count only what was actually captured. A quoted
   total on an unpaid booking is a hope, not revenue, and a dashboard
   that blurs the two is worse than no dashboard.
   ============================================================ */
export async function stats(env, cors) {
  const settings = await loadSettings(env);
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const today = now.toISOString().slice(0, 10);

  const q = (sql, ...binds) =>
    env.DB.prepare(sql).bind(...binds).first().catch(() => null);

  const [
    ridesMonth, ridesToday, revenueMonth, revenueAll,
    outstanding, unpaidCount, customers, nextRide, recentPaid,
  ] = await Promise.all([
    q(`SELECT COUNT(*) AS n FROM bookings WHERE substr(ride_date,1,7) = ? AND status != 'canceled'`, ym),
    q(`SELECT COUNT(*) AS n FROM bookings WHERE ride_date = ? AND status != 'canceled'`, today),
    q(`SELECT COALESCE(SUM(amount_charged),0) AS v FROM bookings
        WHERE substr(ride_date,1,7) = ? AND payment_status = 'charged'`, ym),
    q(`SELECT COALESCE(SUM(amount_charged),0) AS v FROM bookings WHERE payment_status = 'charged'`),
    q(`SELECT COALESCE(SUM(total),0) AS v FROM invoices WHERE status IN ('draft','sent')`),
    q(`SELECT COUNT(*) AS n FROM invoices WHERE status IN ('draft','sent')`),
    q(`SELECT COUNT(*) AS n FROM customers`),
    q(`SELECT b.id, b.ride_date, b.ride_time, b.pickup, b.dropoff, b.quoted_total,
              c.name AS customer_name, c.phone AS customer_phone
         FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.ride_date >= ? AND b.status != 'canceled'
        ORDER BY b.ride_date, b.ride_time LIMIT 1`, today),
    q(`SELECT COALESCE(SUM(amount_paid),0) AS v FROM invoices WHERE status = 'paid'`),
  ]);

  // Twelve-month revenue trend, captured rides plus paid invoices.
  const { results: trend } = await env.DB.prepare(
    `SELECT substr(ride_date,1,7) AS m, COALESCE(SUM(amount_charged),0) AS v
       FROM bookings WHERE payment_status = 'charged' AND ride_date IS NOT NULL
      GROUP BY m ORDER BY m DESC LIMIT 12`
  ).all().catch(() => ({ results: [] }));

  return json(
    {
      ridesMonth: ridesMonth ? ridesMonth.n : 0,
      ridesToday: ridesToday ? ridesToday.n : 0,
      revenueMonth: money(revenueMonth ? revenueMonth.v : 0),
      revenueAll: money((revenueAll ? revenueAll.v : 0) + (recentPaid ? recentPaid.v : 0)),
      outstanding: money(outstanding ? outstanding.v : 0),
      unpaidInvoices: unpaidCount ? unpaidCount.n : 0,
      customers: customers ? customers.n : 0,
      nextRide: nextRide || null,
      trend: (trend || []).reverse(),
      timezone: settings.tz,
    },
    200,
    cors
  );
}

/* ============================================================
   CUSTOMER 360
   Everything known about one person on one screen: what they have
   spent, every ride, every invoice, and every message sent to them.
   ============================================================ */
export async function customerDetail(env, cors, id) {
  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first();
  if (!customer) return json({ error: "Not found" }, 404, cors);

  const [rides, invoices, messages] = await Promise.all([
    env.DB.prepare(
      `SELECT id, ride_date, ride_time, dest_code, pickup, dropoff, status,
              payment_status, quoted_total, amount_charged, tip_amount, created_at
         FROM bookings WHERE customer_id = ? ORDER BY ride_date DESC, ride_time DESC`
    ).bind(id).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT id, number, status, total, amount_paid, due_date, paid_at, created_at
         FROM invoices WHERE customer_id = ? ORDER BY id DESC`
    ).bind(id).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT channel, to_addr, subject, status, detail, created_at
         FROM message_log WHERE customer_id = ? ORDER BY id DESC LIMIT 40`
    ).bind(id).all().catch(() => ({ results: [] })),
  ]);

  const rideRows = rides.results || [];
  const invoiceRows = invoices.results || [];

  const spentRides = rideRows.reduce((s, r) => s + (Number(r.amount_charged) || 0), 0);
  const spentInvoices = invoiceRows
    .filter((i) => i.status === "paid")
    .reduce((s, i) => s + (Number(i.amount_paid) || 0), 0);

  return json(
    {
      customer,
      rides: rideRows,
      invoices: invoiceRows,
      messages: messages.results || [],
      totals: {
        lifetimeValue: money(spentRides + spentInvoices),
        rideCount: rideRows.filter((r) => r.status !== "canceled").length,
        lastRide: rideRows.length ? rideRows[0].ride_date : null,
        openInvoices: invoiceRows.filter((i) => i.status === "draft" || i.status === "sent").length,
      },
    },
    200,
    cors
  );
}

export async function updateCustomer(request, env, cors, id) {
  const d = await request.json().catch(() => ({}));
  const sets = [], vals = [];
  if ("name" in d && String(d.name).trim()) { sets.push("name = ?"); vals.push(String(d.name).trim().slice(0, 120)); }
  if ("email" in d) { sets.push("email = ?"); vals.push(d.email ? String(d.email).trim().toLowerCase() : null); }
  if ("phone" in d) { sets.push("phone = ?"); vals.push(d.phone ? String(d.phone).trim() : null); }
  if ("notes" in d) { sets.push("notes = ?"); vals.push(d.notes ? String(d.notes) : null); }
  if (!sets.length) return json({ error: "Nothing to update" }, 400, cors);
  vals.push(id);
  try {
    await env.DB.prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  } catch (e) {
    // UNIQUE(email) / UNIQUE(phone) — say which, rather than "server error".
    const msg = String((e && e.message) || e);
    if (/customers\.email/.test(msg)) return json({ error: "Another customer already has that email." }, 409, cors);
    if (/customers\.phone/.test(msg)) return json({ error: "Another customer already has that phone number." }, 409, cors);
    throw e;
  }
  return await customerDetail(env, cors, id);
}

/* ============================================================
   SETTINGS
   The whole point is that Matt can change how the business runs
   without anyone touching code. Every key here is already read by
   the booking engine at request time, so a change takes effect on
   the next booking with no redeploy.
   ============================================================ */

// key → [label, type, group]. Anything not listed is not editable here.
const EDITABLE = {
  timezone:              ["Timezone", "text", "Business"],
  day_start_local:       ["Earliest pickup", "time", "Business"],
  day_end_local:         ["Latest pickup", "time", "Business"],
  min_lead_hours:        ["Minimum notice (hours)", "number", "Business"],
  max_advance_days:      ["Book up to (days ahead)", "number", "Business"],
  buffer_minutes:        ["Buffer between rides (min)", "number", "Business"],
  auto_confirm:          ["Confirm bookings automatically", "bool", "Business"],

  tip_enabled:           ["Offer a gratuity at booking", "bool", "Payments"],
  tip_default_pct:       ["Gratuity pre-selected (%)", "number", "Payments"],
  tip_options:           ["Gratuity choices (%)", "text", "Payments"],
  charge_at_booking:     ["Charge the card at booking", "bool", "Payments"],
  charge_lead_hours:     ["Otherwise charge this many hours before", "number", "Payments"],
  free_cancel_hours:     ["Free cancellation window (hours)", "number", "Payments"],
  half_cancel_hours:     ["Half-charge window (hours)", "number", "Payments"],

  wait_rate_per_min:     ["Wait time ($/min)", "number", "Extras"],
  arrival_free_wait_min: ["Free wait, arrivals (min)", "number", "Extras"],
  departure_free_wait_min:["Free wait, departures (min)", "number", "Extras"],
  extra_stop:            ["Extra stop ($)", "number", "Extras"],
  child_seat:            ["Child seat ($)", "number", "Extras"],
  cleaning_fee:          ["Cleaning fee ($)", "number", "Extras"],

  invoice_prefix:        ["Invoice number prefix", "text", "Invoicing"],
  invoice_terms:         ["Invoice terms", "text", "Invoicing"],
};

export async function getSettings(env, cors) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const raw = {};
  for (const r of results || []) raw[r.key] = r.value;

  const fields = Object.entries(EDITABLE).map(([key, [label, type, group]]) => ({
    key, label, type, group, value: raw[key] == null ? "" : raw[key],
  }));

  const rates = await loadRates(env);
  return json(
    {
      fields,
      rates: rates.map((r) => ({
        code: r.code, label: r.label, price: r.price,
        hours: r.hours_engaged, miles: r.miles_one_way, active: r.active,
      })),
      notifications: {
        to: env.TO_EMAIL || "",
        from: env.FROM_EMAIL || "",
      },
      integrations: {
        resend: Boolean(env.RESEND_API_KEY),
        twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_FROM),
        authorizeNet: Boolean(env.ANET_API_LOGIN_ID && env.ANET_TRANSACTION_KEY),
        mode: env.ANET_ENV === "production" ? "production" : "sandbox",
      },
      passwordIsCustom: Boolean(raw.admin_password_hash),
    },
    200,
    cors
  );
}

export async function patchSettings(request, env, cors) {
  const d = await request.json().catch(() => ({}));
  const changed = [];
  for (const [key, value] of Object.entries(d)) {
    if (!(key in EDITABLE)) continue;           // allow-list, not a free-form key/value store
    const [, type] = EDITABLE[key];
    let v = value;
    if (type === "bool") v = value ? "1" : "0";
    else if (type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) continue;
      v = String(n);
    } else v = String(value == null ? "" : value).slice(0, 500);
    await putSetting(env, key, v);
    changed.push(key);
  }
  if (!changed.length) return json({ error: "Nothing recognised to save." }, 400, cors);
  return await getSettings(env, cors);
}

export async function patchRate(request, env, cors, code) {
  const d = await request.json().catch(() => ({}));
  const sets = [], vals = [];
  if ("label" in d) { sets.push("label = ?"); vals.push(String(d.label).slice(0, 120)); }
  if ("price" in d) {
    const n = Number(d.price);
    if (!Number.isFinite(n) || n < 0) return json({ error: "Price must be a number." }, 422, cors);
    sets.push("price = ?"); vals.push(n);
  }
  if ("hours" in d) {
    const n = Number(d.hours);
    if (!Number.isFinite(n) || n <= 0) return json({ error: "Hours must be greater than zero." }, 422, cors);
    sets.push("hours_engaged = ?"); vals.push(n);
  }
  if ("active" in d) { sets.push("active = ?"); vals.push(d.active ? 1 : 0); }
  if (!sets.length) return json({ error: "Nothing to update" }, 400, cors);
  sets.push("updated_at = datetime('now')");
  vals.push(code);
  await env.DB.prepare(`UPDATE rates SET ${sets.join(", ")} WHERE code = ?`).bind(...vals).run();
  return await getSettings(env, cors);
}

export { getSetting, putSetting };
