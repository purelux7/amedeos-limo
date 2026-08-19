/* ============================================================
   Bookings created and managed from the back office.

   Matt takes bookings on the phone. Until now the only way a ride
   could enter the system was a customer filling in the website form,
   which meant the calendar he is supposed to trust was missing
   precisely the rides he arranged himself — and a calendar with holes
   in it is not a calendar, it is a guess.

   These rides carry source='phone'. They take no card: the customer is
   not present to enter one, and inventing a way for an admin to type
   somebody's card number into a form is exactly the liability the
   booking flow was designed to avoid. Payment for a phone booking is
   an invoice with a pay link.
   ============================================================ */

import {
  loadSettings, getRate, quoteFor, localToUtc, blockWindow,
  checkAvailability, money,
} from "./engine.js";
import { refundOrVoid } from "./authnet.js";
import { audit } from "./audit.js";

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

async function findOrMakeCustomer(env, d) {
  if (d.customerId) return Number(d.customerId);
  const name = String(d.name || "").trim();
  if (!name) return null;
  const e = d.email ? String(d.email).trim().toLowerCase() : null;
  const p = d.phone ? String(d.phone).trim() : null;

  const existing = (e || p)
    ? await env.DB.prepare(
        `SELECT id FROM customers
          WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1`
      ).bind(e, p).first()
    : null;
  if (existing) return existing.id;

  const ins = await env.DB.prepare(
    `INSERT INTO customers (name, email, phone) VALUES (?,?,?)`
  ).bind(name.slice(0, 120), e, p).run();
  return ins.meta.last_row_id;
}

export async function createBooking(request, env, cors) {
  const d = await request.json().catch(() => ({}));

  if (!DATE.test(d.date || "")) return json({ error: "Pick a date." }, 422, cors);
  if (!TIME.test(d.time || "")) return json({ error: "Pick a pickup time." }, 422, cors);
  if (!String(d.pickup || "").trim()) return json({ error: "Where is the pickup?" }, 422, cors);
  if (!String(d.dropoff || "").trim()) return json({ error: "Where are they going?" }, 422, cors);

  const customerId = await findOrMakeCustomer(env, d);
  if (!customerId) return json({ error: "Who is this ride for?" }, 422, cors);

  const settings = await loadSettings(env);
  const rideStartUtc = localToUtc(d.date, d.time, settings.tz);
  if (!Number.isFinite(rideStartUtc)) return json({ error: "That date and time did not parse." }, 422, cors);

  // Hours engaged decides how much of the calendar this ride occupies.
  // A named destination knows its own round trip; anything else is
  // whatever Matt says, defaulting to a conservative two hours.
  let hours = Number(d.hours);
  let price = d.price === "" || d.price == null ? null : Number(d.price);
  let destCode = d.destCode || null;

  if (destCode) {
    const rate = await getRate(env, destCode);
    if (rate) {
      if (!Number.isFinite(hours) || hours <= 0) hours = rate.hours_engaged;
      if (price == null) {
        const q = quoteFor(rate, settings, { hours: d.hours });
        price = q.total;
      }
    }
  }
  if (!Number.isFinite(hours) || hours <= 0) hours = 2;
  if (price != null && (!Number.isFinite(price) || price < 0)) {
    return json({ error: "That price is not a number." }, 422, cors);
  }

  // Conflicts are reported, not enforced. Matt knows things the calendar
  // does not — a short local hop between two airport runs, a customer who
  // is happy to wait. Refusing his own booking because the system disagrees
  // would push him straight back to pen and paper, which is the failure
  // this whole feature exists to fix.
  const availability = await checkAvailability(env, rideStartUtc, hours, settings);
  if (!availability.available && !d.force) {
    return json(
      { error: availability.reason, conflict: true, canForce: true },
      409,
      cors
    );
  }

  const { start: blockStart, end: blockEnd } = blockWindow(rideStartUtc, hours, settings);

  const ins = await env.DB.prepare(
    `INSERT INTO bookings
       (customer_id, dest_code, pickup, dropoff, ride_date, ride_time, passengers, notes,
        flight_number, source, status, quoted_total, hours_engaged,
        ride_start_utc, block_start_utc, block_end_utc, payment_status, amount_charged)
     VALUES (?,?,?,?,?,?,?,?,?, 'phone', ?, ?, ?, ?, ?, ?, 'none', 0)`
  ).bind(
    customerId, destCode, String(d.pickup).slice(0, 300), String(d.dropoff).slice(0, 300),
    d.date, d.time, String(d.passengers || "1"), d.notes ? String(d.notes).slice(0, 800) : null,
    d.flight ? String(d.flight).slice(0, 20) : null,
    d.status === "new" ? "new" : "confirmed",
    price, hours, rideStartUtc, blockStart, blockEnd
  ).run();

  const id = ins.meta.last_row_id;
  await audit(env, request, {
    action: "booking.create", entity: "booking", entityId: id,
    summary: `Booked ${d.date} ${d.time} — ${d.pickup} to ${d.dropoff}` +
             (price != null ? ` for $${money(price)}` : "") +
             (d.force && !availability.available ? " (booked over a conflict)" : ""),
    detail: { customerId, hours, destCode, forced: Boolean(d.force) },
  });

  return json({ ok: true, id, hours, price, warning: availability.available ? null : availability.reason }, 200, cors);
}

export async function updateBooking(request, env, cors, id) {
  const b = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!b) return json({ error: "Not found" }, 404, cors);
  const d = await request.json().catch(() => ({}));
  const settings = await loadSettings(env);

  const sets = [], vals = [], changed = [];
  const date = DATE.test(d.date || "") ? d.date : b.ride_date;
  const time = TIME.test(d.time || "") ? d.time : b.ride_time;

  // Moving a ride has to move the block it occupies too, or the calendar
  // keeps holding the old slot and refuses bookings into thin air.
  if (date !== b.ride_date || time !== b.ride_time || d.hours != null) {
    const hours = Number(d.hours) > 0 ? Number(d.hours) : (Number(b.hours_engaged) || 2);
    const startUtc = localToUtc(date, time, settings.tz);
    if (!Number.isFinite(startUtc)) return json({ error: "That date and time did not parse." }, 422, cors);
    const w = blockWindow(startUtc, hours, settings);
    sets.push("ride_date = ?", "ride_time = ?", "hours_engaged = ?",
              "ride_start_utc = ?", "block_start_utc = ?", "block_end_utc = ?");
    vals.push(date, time, hours, startUtc, w.start, w.end);
    changed.push(`moved to ${date} ${time}`);
  }
  if ("pickup" in d) { sets.push("pickup = ?"); vals.push(String(d.pickup).slice(0, 300)); changed.push("pickup"); }
  if ("dropoff" in d) { sets.push("dropoff = ?"); vals.push(String(d.dropoff).slice(0, 300)); changed.push("dropoff"); }
  if ("passengers" in d) { sets.push("passengers = ?"); vals.push(String(d.passengers)); }
  if ("notes" in d) { sets.push("notes = ?"); vals.push(d.notes ? String(d.notes).slice(0, 800) : null); }
  if ("price" in d) {
    const p = d.price === "" || d.price == null ? null : Number(d.price);
    if (p != null && (!Number.isFinite(p) || p < 0)) return json({ error: "That price is not a number." }, 422, cors);
    sets.push("quoted_total = ?"); vals.push(p); changed.push("price");
  }
  if ("status" in d && ["new", "confirmed", "done", "canceled"].includes(d.status)) {
    sets.push("status = ?"); vals.push(d.status); changed.push(`status ${d.status}`);
  }
  if (!sets.length) return json({ error: "Nothing to update" }, 400, cors);

  vals.push(id);
  await env.DB.prepare(`UPDATE bookings SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  await audit(env, request, {
    action: "booking.update", entity: "booking", entityId: id,
    summary: `Ride ${id}: ${changed.join(", ") || "edited"}`,
  });
  return json({ ok: true }, 200, cors);
}

/* ------------------------------------------------------------
   Cancelling from the admin.

   If money was taken, it is given back — void before settlement,
   refund after, whichever Authorize.net accepts. The slot is released
   either way, because a cancelled ride that still blocks the calendar
   costs Matt the day.
   ------------------------------------------------------------ */
export async function cancelBooking(request, env, cors, id) {
  const b = await env.DB.prepare(
    `SELECT b.*, c.anet_customer_profile_id
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.id = ?`
  ).bind(id).first();
  if (!b) return json({ error: "Not found" }, 404, cors);
  if (b.status === "canceled") return json({ error: "That ride is already cancelled." }, 409, cors);

  const d = await request.json().catch(() => ({}));
  let refund = null;

  if (d.refund && Number(b.amount_charged) > 0) {
    const charge = await env.DB.prepare(
      `SELECT anet_trans_id FROM charges
        WHERE booking_id = ? AND status = 'ok' AND anet_trans_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    ).bind(id).first().catch(() => null);

    if (!charge || !charge.anet_trans_id) {
      return json({ error: "No completed charge found to refund." }, 409, cors);
    }
    refund = await refundOrVoid(env, {
      transId: charge.anet_trans_id,
      amount: b.amount_charged,
      customerProfileId: b.anet_customer_profile_id,
      paymentProfileId: b.anet_payment_profile_id,
    });
    if (!refund.ok) {
      return json({ error: `The bank refused the refund: ${refund.message}` }, 502, cors);
    }
  }

  await env.DB.prepare(
    `UPDATE bookings
        SET status = 'canceled', block_start_utc = NULL, block_end_utc = NULL,
            charge_after_utc = NULL
      WHERE id = ?`
  ).bind(id).run();

  await audit(env, request, {
    action: "booking.cancel", entity: "booking", entityId: id,
    summary: `Cancelled ride ${id} (${b.ride_date} ${b.ride_time})` +
             (refund ? ` and ${refund.mode === "void" ? "voided" : "refunded"} $${money(b.amount_charged)}` : ""),
    detail: refund ? { mode: refund.mode, transId: refund.transId } : null,
  });

  return json({ ok: true, refunded: refund ? refund.mode : null }, 200, cors);
}

/* Refund a paid invoice. Same void-then-refund ladder. */
export async function refundInvoice(request, env, cors, id) {
  const inv = await env.DB.prepare(
    `SELECT i.*, c.anet_customer_profile_id
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = ?`
  ).bind(id).first();
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (inv.status !== "paid") return json({ error: "That invoice was never paid." }, 409, cors);
  if (!inv.trans_id) return json({ error: "No transaction recorded for that invoice." }, 409, cors);

  const res = await refundOrVoid(env, {
    transId: inv.trans_id,
    amount: inv.amount_paid || inv.total,
    customerProfileId: inv.anet_customer_profile_id,
    paymentProfileId: null,
  });
  if (!res.ok) return json({ error: `The bank refused the refund: ${res.message}` }, 502, cors);

  await env.DB.prepare(
    `UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  await audit(env, request, {
    action: "invoice.refund", entity: "invoice", entityId: id,
    summary: `${res.mode === "void" ? "Voided" : "Refunded"} invoice ${inv.number} — $${money(inv.amount_paid || inv.total)}`,
    detail: { mode: res.mode, transId: res.transId },
  });

  return json({ ok: true, mode: res.mode }, 200, cors);
}
