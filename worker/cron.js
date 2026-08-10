/* ============================================================
   Scheduled work. Runs every 15 minutes via Cron Trigger.

     1. charge every booking that has reached T-24h
     2. send Matt tomorrow's run sheet

   DOUBLE-CHARGE SAFETY
   Cron runs can overlap, and a Worker can be retried. Before calling
   Authorize.net we "claim" the booking with a conditional UPDATE that
   only matches rows still in 'card_on_file'. D1 reports how many rows
   changed; zero means another run already claimed it and this one must
   skip. That is a compare-and-swap, and it is the only thing standing
   between a customer and being charged twice.
   ============================================================ */

import { loadSettings, utcToLocal, money } from "./engine.js";
import { anetConfigured, chargeProfile, pingCredentials } from "./authnet.js";
import {
  sendReceipt, sendCardProblem, sendOwnerBooking, smsOwner, siteUrl,
  send, ownerEmails, esc,
} from "./notify.js";
import { logCharge } from "./api.js";

const MAX_ATTEMPTS = 4;

export async function runScheduled(env, ctx) {
  const settings = await loadSettings(env);
  const results = { charged: 0, declined: 0, skipped: 0, errors: [] };

  if (!anetConfigured(env)) {
    console.log("cron: Authorize.net not configured, nothing to charge");
    return results;
  }

  const now = Date.now();

  // Bookings due to be charged. We include rides that have already
  // happened but were never charged — a no-show still owes 100%.
  const { results: due } = await env.DB.prepare(
    `SELECT b.*, c.email AS customer_email, c.name AS customer_name,
            c.phone AS customer_phone, c.anet_customer_profile_id
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.status = 'confirmed'
        AND b.payment_status = 'card_on_file'
        AND b.charge_after_utc IS NOT NULL
        AND b.charge_after_utc <= ?
        AND b.charge_attempts < ?
      ORDER BY b.ride_start_utc ASC
      LIMIT 25`
  ).bind(now, MAX_ATTEMPTS).all();

  for (const b of due || []) {
    if (!b.anet_customer_profile_id || !b.anet_payment_profile_id) {
      results.skipped++;
      continue;
    }

    // --- claim (compare-and-swap) ---
    const claim = await env.DB.prepare(
      `UPDATE bookings
          SET payment_status = 'charging', charge_attempts = charge_attempts + 1
        WHERE id = ? AND payment_status = 'card_on_file'`
    ).bind(b.id).run();

    if (!claim.meta || claim.meta.changes !== 1) {
      results.skipped++;
      continue; // another run got here first
    }

    const amount = money(b.quoted_total);
    const when = utcToLocal(b.ride_start_utc, settings.tz);

    let res;
    try {
      res = await chargeProfile(env, {
        customerProfileId: b.anet_customer_profile_id,
        paymentProfileId: b.anet_payment_profile_id,
        amount,
        invoiceNumber: `R${b.id}`,
        description: `Car service ${when.date} — ${b.dropoff}`.slice(0, 255),
      });
    } catch (e) {
      // Transport failure: release the claim so the next run retries.
      await env.DB.prepare(
        `UPDATE bookings SET payment_status = 'card_on_file', last_charge_error = ? WHERE id = ?`
      ).bind(String(e.message || e).slice(0, 300), b.id).run();
      results.errors.push({ booking: b.id, error: String(e.message || e) });
      continue;
    }

    if (res.ok) {
      await env.DB.prepare(
        `UPDATE bookings
            SET payment_status = 'charged', charged_at = datetime('now'),
                amount_charged = amount_charged + ?, paid = 1, last_charge_error = NULL
          WHERE id = ?`
      ).bind(amount, b.id).run();

      await logCharge(env, b.id, "fare", amount, "ok", res.transId, res.code, res.message);
      results.charged++;

      const booking = { ...b, email: b.customer_email, name: b.customer_name, phone: b.customer_phone };
      ctx.waitUntil(
        Promise.all([
          sendReceipt(env, { booking, amount, when, transId: res.transId, kind: "fare" }),
          sendOwnerBooking(env, { booking, quote: { total: amount }, when, kind: "alert" }),
          smsOwner(
            env,
            `TOMORROW ${when.pretty}\n${b.customer_name} · ${b.customer_phone}\n${b.pickup}\n-> ${b.dropoff}\nPAID $${amount.toFixed(2)}${b.flight_number ? `\nFlight ${b.flight_number}` : ""}`
          ),
        ])
      );
      continue;
    }

    // --- not approved ---
    const exhausted = b.charge_attempts + 1 >= MAX_ATTEMPTS;
    await env.DB.prepare(
      `UPDATE bookings
          SET payment_status = ?, last_charge_error = ?
        WHERE id = ?`
    ).bind(exhausted ? "failed" : "card_on_file", `${res.code}: ${res.message}`.slice(0, 300), b.id).run();

    await logCharge(env, b.id, "fare", amount, res.declined ? "declined" : "error", res.transId, res.code, res.message);
    results.declined++;

    const booking = { ...b, email: b.customer_email, name: b.customer_name };
    const manageUrl = `${siteUrl(env)}/manage.html?t=${b.manage_token}`;

    // Tell the customer on the first failure and again when we give up.
    if (b.charge_attempts === 0 || exhausted) {
      ctx.waitUntil(
        Promise.all([
          sendCardProblem(env, { booking, when, amount, manageUrl }),
          smsOwner(
            env,
            `CARD DECLINED${exhausted ? " (final)" : ""}\n${when.pretty}\n${b.customer_name} · ${b.customer_phone}\n$${amount.toFixed(2)}\n${res.message}`
          ),
        ])
      );
    }
  }

  if (results.charged || results.declined || results.errors.length) {
    console.log("cron result:", JSON.stringify(results));
  }
  return results;
}

/* ============================================================
   Daily digest — the heartbeat.

   The dangerous failure here is a SILENT one: if the charge sweep
   stops running, nothing charges, nothing errors, and nobody notices
   until the bank balance looks wrong weeks later. This email is the
   countermeasure. Its ARRIVAL is the signal — if it does not land in
   the inbox one morning, something is broken, and that is a far
   louder alarm than any dashboard nobody opens.
   ============================================================ */

export async function runDigest(env) {
  const settings = await loadSettings(env);
  const now = Date.now();
  const dayStart = now - 86_400_000;

  const q = (sql, ...binds) =>
    env.DB.prepare(sql).bind(...binds).all().then((r) => r.results || []).catch(() => []);

  const [todayRides, tomorrowRides, charged, failures, awaiting, upcoming] = await Promise.all([
    q(`SELECT b.*, c.name AS customer_name, c.phone AS customer_phone
         FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.status != 'canceled' AND b.ride_start_utc BETWEEN ? AND ?
        ORDER BY b.ride_start_utc ASC`, now - 6 * 3_600_000, now + 18 * 3_600_000),
    q(`SELECT b.*, c.name AS customer_name, c.phone AS customer_phone
         FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.status != 'canceled' AND b.ride_start_utc BETWEEN ? AND ?
        ORDER BY b.ride_start_utc ASC`, now + 18 * 3_600_000, now + 42 * 3_600_000),
    q(`SELECT amount, kind FROM charges WHERE status = 'ok' AND created_at >= datetime(?, 'unixepoch')`,
      Math.floor(dayStart / 1000)),
    q(`SELECT b.*, c.name AS customer_name, c.phone AS customer_phone
         FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.payment_status = 'failed' AND b.status != 'canceled'
        ORDER BY b.ride_start_utc ASC LIMIT 20`),
    q(`SELECT COUNT(*) AS n, COALESCE(SUM(quoted_total),0) AS total FROM bookings
        WHERE status = 'confirmed' AND payment_status = 'card_on_file'`),
    q(`SELECT COUNT(*) AS n FROM bookings
        WHERE status != 'canceled' AND ride_start_utc > ?`, now),
  ]);

  const collected = charged.reduce((s, c) => s + Number(c.amount || 0), 0);
  const awaitingRow = awaiting[0] || { n: 0, total: 0 };
  const anetPing = anetConfigured(env) ? await pingCredentials(env) : { ok: false, message: "not configured" };

  const line = (b) => {
    const when = b.ride_start_utc ? utcToLocal(b.ride_start_utc, settings.tz) : null;
    const paid =
      b.payment_status === "charged" ? `PAID $${Number(b.amount_charged || 0).toFixed(0)}`
      : b.payment_status === "failed" ? "CARD FAILED"
      : b.payment_status === "card_on_file" ? "charges T-24h"
      : "no card";
    return `<tr>
      <td style="padding:7px 12px;font:700 14px Arial,sans-serif;white-space:nowrap">${esc(when ? when.pretty : b.ride_date)}</td>
      <td style="padding:7px 12px;font:400 14px Arial,sans-serif">${esc(b.customer_name || "—")}<br>
          <span style="color:#7b8597;font-size:12px">${esc(b.pickup || "")} → ${esc(b.dropoff || "")}</span></td>
      <td style="padding:7px 12px;font:700 13px Arial,sans-serif;white-space:nowrap;text-align:right;color:${
        b.payment_status === "charged" ? "#1f7a4d" : b.payment_status === "failed" ? "#b03a3a" : "#9a6b12"
      }">${esc(paid)}</td></tr>`;
  };

  const table = (rows, empty) =>
    rows.length
      ? `<table style="width:100%;border-collapse:collapse">${rows.map(line).join("")}</table>`
      : `<div style="padding:10px 12px;color:#7b8597;font:400 14px Arial,sans-serif">${empty}</div>`;

  const problems = failures.length > 0 || !anetPing.ok;

  const html = `
  <div style="background:#f4f6f9;padding:26px">
    <div style="max-width:640px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e8ef">
      <div style="background:#0e2340;padding:22px 26px">
        <div style="color:#fff;font:800 20px Arial,sans-serif">Daily Summary</div>
        <div style="color:#c4a253;font:600 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin-top:4px">
          Amedeo's Private Car Service</div>
      </div>

      ${problems ? `<div style="background:#f6e9e9;border-left:4px solid #b03a3a;padding:14px 22px;color:#7a2420;font:700 14px Arial,sans-serif">
        NEEDS ATTENTION${!anetPing.ok ? " — payment gateway is not responding" : ""}${failures.length ? ` — ${failures.length} card failure${failures.length > 1 ? "s" : ""}` : ""}
      </div>` : ""}

      <div style="padding:18px 22px 4px">
        <div style="display:inline-block;margin:0 22px 12px 0">
          <div style="color:#7b8597;font:700 11px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase">Collected 24h</div>
          <div style="font:800 22px Arial,sans-serif;color:#1f7a4d">$${collected.toFixed(2)}</div>
        </div>
        <div style="display:inline-block;margin:0 22px 12px 0">
          <div style="color:#7b8597;font:700 11px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase">Awaiting charge</div>
          <div style="font:800 22px Arial,sans-serif">${awaitingRow.n} &middot; $${Number(awaitingRow.total).toFixed(0)}</div>
        </div>
        <div style="display:inline-block;margin:0 0 12px 0">
          <div style="color:#7b8597;font:700 11px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase">Rides ahead</div>
          <div style="font:800 22px Arial,sans-serif">${(upcoming[0] && upcoming[0].n) || 0}</div>
        </div>
      </div>

      <div style="padding:6px 10px 0">
        <div style="color:#0e2340;font:800 13px Arial,sans-serif;padding:10px 12px 4px;letter-spacing:.04em;text-transform:uppercase">Today</div>
        ${table(todayRides, "Nothing booked today.")}
        <div style="color:#0e2340;font:800 13px Arial,sans-serif;padding:14px 12px 4px;letter-spacing:.04em;text-transform:uppercase">Tomorrow</div>
        ${table(tomorrowRides, "Nothing booked tomorrow.")}
        ${failures.length ? `<div style="color:#b03a3a;font:800 13px Arial,sans-serif;padding:14px 12px 4px;letter-spacing:.04em;text-transform:uppercase">Card failures</div>${table(failures, "")}` : ""}
      </div>

      <div style="padding:16px 22px;background:#f4f6f9;color:#7b8597;font:400 12px Arial,sans-serif;margin-top:14px">
        Payments: ${anetPing.ok ? "connected" : "NOT RESPONDING — " + esc(anetPing.message || "")} &middot;
        Mode: ${esc(env.ANET_ENV || "sandbox")}<br>
        If this email stops arriving, the scheduled jobs have stopped running.
        <a href="${siteUrl(env)}" style="color:#0e2340">Dashboard</a>
      </div>
    </div>
  </div>`;

  const text =
    `Amedeo's — Daily Summary\n\n` +
    `Collected (24h): $${collected.toFixed(2)}\n` +
    `Awaiting charge: ${awaitingRow.n} rides, $${Number(awaitingRow.total).toFixed(2)}\n` +
    `Rides ahead: ${(upcoming[0] && upcoming[0].n) || 0}\n` +
    `Card failures: ${failures.length}\n` +
    `Payments: ${anetPing.ok ? "connected" : "NOT RESPONDING"}\n\n` +
    `Today:\n` +
    (todayRides.length
      ? todayRides.map((b) => `  ${utcToLocal(b.ride_start_utc, settings.tz).pretty} — ${b.customer_name} — ${b.pickup} -> ${b.dropoff}`).join("\n")
      : "  nothing") +
    `\n\nTomorrow:\n` +
    (tomorrowRides.length
      ? tomorrowRides.map((b) => `  ${utcToLocal(b.ride_start_utc, settings.tz).pretty} — ${b.customer_name} — ${b.pickup} -> ${b.dropoff}`).join("\n")
      : "  nothing") +
    `\n\nIf this email stops arriving, the scheduled jobs have stopped running.\n`;

  await send(env, {
    to: ownerEmails(env),
    subject: `Amedeo's — ${problems ? "ATTENTION · " : ""}$${collected.toFixed(0)} collected, ${todayRides.length} today, ${tomorrowRides.length} tomorrow`,
    html,
    text,
  });

  return { collected, today: todayRides.length, tomorrow: tomorrowRides.length, failures: failures.length };
}
