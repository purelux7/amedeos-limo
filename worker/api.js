/* ============================================================
   Public booking API + customer self-service + admin operations.

   Booking order of operations matters and is deliberate:
     1. quote + availability pre-check
     2. INSERT the booking (this claims the calendar slot)
     3. re-check for an overlapping booking with a LOWER id
        -> if one exists we lost a race; delete ours, return 409
     4. only then vault the card
     5. mark confirmed and send mail

   Claiming the slot before touching the card means a lost race never
   leaves a vaulted card attached to a booking that does not exist, and
   a card failure never leaves a slot held by an unpaid booking.
   ============================================================ */

import {
  loadSettings, loadRates, getRate, quoteFor, money,
  localToUtc, utcToLocal, blockWindow, checkAvailability,
  suggestAlternatives, dayBlocks, cancellationCharge, chargeAfterFor,
  manageToken,
} from "./engine.js";
import {
  anetConfigured, createProfileFromNonce, addPaymentProfile,
  describeCard, chargeProfile, refundOrVoid, pingCredentials,
} from "./authnet.js";
import {
  sendBookingConfirmed, sendReceipt, sendOwnerBooking, smsOwner, siteUrl, esc,
} from "./notify.js";

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });

/* ------------------------------------------------------------
   GET /api/config — everything the booking form needs to render
   ------------------------------------------------------------ */
export async function handleConfig(env, cors) {
  const [settings, rates] = await Promise.all([loadSettings(env), loadRates(env)]);
  return json(
    {
      rates: rates.map((r) => ({
        code: r.code,
        label: r.label,
        price: r.price,
        hours: r.hours_engaged,
      })),
      gratuityPct: settings.gratuityPct,
      minLeadHours: settings.minLeadHours,
      maxAdvanceDays: settings.maxAdvanceDays,
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      chargeLeadHours: settings.chargeLeadHours,
      timezone: settings.tz,
      fees: {
        waitPerMin: settings.waitRatePerMin,
        arrivalFreeWaitMin: settings.arrivalFreeWaitMin,
        departureFreeWaitMin: settings.departureFreeWaitMin,
        extraStop: settings.extraStop,
        childSeat: settings.childSeat,
      },
      // Accept.js needs these two in the browser. Both are public by design;
      // the Transaction Key is NOT here and must never be.
      payments: {
        enabled: anetConfigured(env) && Boolean(env.ANET_PUBLIC_CLIENT_KEY),
        apiLoginId: env.ANET_API_LOGIN_ID || "",
        clientKey: env.ANET_PUBLIC_CLIENT_KEY || "",
        mode: env.ANET_ENV === "production" ? "production" : "sandbox",
      },
    },
    200,
    cors
  );
}

/* ------------------------------------------------------------
   POST /api/quote — price + availability for a requested pickup
   ------------------------------------------------------------ */
export async function handleQuote(request, env, cors) {
  const d = await request.json().catch(() => ({}));
  const settings = await loadSettings(env);

  const rate = await getRate(env, d.destCode);
  if (!rate) return json({ error: "Pick a destination." }, 422, cors);

  const quote = quoteFor(rate, settings, { hours: d.hours });

  if (!d.date || !d.time) {
    return json({ quote, availability: null }, 200, cors);
  }

  const rideStartUtc = localToUtc(d.date, d.time, settings.tz);
  const availability = await checkAvailability(env, rideStartUtc, quote.hoursEngaged, settings);

  let alternatives = [];
  if (!availability.available && availability.conflictType) {
    alternatives = await suggestAlternatives(env, rideStartUtc, quote.hoursEngaged, settings);
  }

  const chargeAt = chargeAfterFor(rideStartUtc, settings);
  return json(
    {
      quote,
      availability,
      alternatives: alternatives.map((a) => ({ time: a.time, pretty: a.pretty })),
      chargeOn: Number.isFinite(chargeAt) ? utcToLocal(chargeAt, settings.tz).pretty : null,
    },
    200,
    cors
  );
}

/* ------------------------------------------------------------
   GET /api/day?date=YYYY-MM-DD — blocked windows, to grey out times
   ------------------------------------------------------------ */
export async function handleDay(url, env, cors) {
  const date = url.searchParams.get("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return json({ error: "date=YYYY-MM-DD required" }, 422, cors);
  }
  const settings = await loadSettings(env);
  const blocks = await dayBlocks(env, date, settings);
  return json(
    {
      date,
      blocks: blocks.map((b) => ({
        from: utcToLocal(b.start, settings.tz).time,
        to: utcToLocal(b.end, settings.tz).time,
        kind: b.kind,
      })),
    },
    200,
    cors
  );
}

/* ------------------------------------------------------------
   POST /api/book — the real booking endpoint
   ------------------------------------------------------------ */
export async function handleBook(request, env, cors, ctx) {
  const d = await request.json().catch(() => ({}));
  if (d.company) return json({ ok: true }, 200, cors); // honeypot

  const required = ["destCode", "pickup", "dropoff", "date", "time", "passengers", "name", "phone", "email"];
  for (const f of required) {
    if (!d[f] || String(d[f]).trim() === "") {
      return json({ error: `Missing field: ${f}` }, 422, cors);
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email))) {
    return json({ error: "That email address doesn't look right." }, 422, cors);
  }
  if (!d.termsAccepted) {
    return json({ error: "Please accept the rate and cancellation terms." }, 422, cors);
  }

  const settings = await loadSettings(env);
  const rate = await getRate(env, d.destCode);
  if (!rate) return json({ error: "That destination isn't available." }, 422, cors);

  const quote = quoteFor(rate, settings, { hours: d.hours });
  const rideStartUtc = localToUtc(d.date, d.time, settings.tz);

  // --- 1. pre-check -------------------------------------------------
  const pre = await checkAvailability(env, rideStartUtc, quote.hoursEngaged, settings);
  if (!pre.available) {
    const alts = pre.conflictType
      ? await suggestAlternatives(env, rideStartUtc, quote.hoursEngaged, settings)
      : [];
    return json(
      { error: pre.reason, alternatives: alts.map((a) => ({ time: a.time, pretty: a.pretty })) },
      409,
      cors
    );
  }

  const customerId = await upsertCustomer(env, d.name, d.email, d.phone);
  const { start: blockStart, end: blockEnd } = blockWindow(rideStartUtc, quote.hoursEngaged, settings);
  const token = manageToken();
  const chargeAfter = chargeAfterFor(rideStartUtc, settings);
  const ip = request.headers.get("CF-Connecting-IP") || "";

  // --- 2. claim the slot -------------------------------------------
  const ins = await env.DB.prepare(
    `INSERT INTO bookings
       (customer_id, service, dest_code, direction, pickup, dropoff, ride_date, ride_time,
        passengers, notes, flight_number, source, status,
        quoted_base, quoted_gratuity, quoted_total, hours_engaged,
        ride_start_utc, block_start_utc, block_end_utc, charge_after_utc,
        payment_status, manage_token, terms_accepted_at, terms_ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'website', 'new',
             ?,?,?,?,?,?,?,?, 'none', ?, datetime('now'), ?)`
  )
    .bind(
      customerId, rate.label, rate.code, d.direction || null,
      d.pickup, d.dropoff, d.date, d.time,
      d.passengers, d.notes || "", d.flightNumber || null,
      quote.base, quote.gratuity, quote.total, quote.hoursEngaged,
      rideStartUtc, blockStart, blockEnd, chargeAfter,
      token, ip
    )
    .run();

  const bookingId = ins.meta.last_row_id;

  // --- 3. did we lose a race? ---------------------------------------
  const raceLoser = await env.DB.prepare(
    `SELECT id FROM bookings
      WHERE id != ? AND status IN ('new','confirmed')
        AND block_start_utc < ? AND block_end_utc > ?
        AND id < ?
      LIMIT 1`
  )
    .bind(bookingId, blockEnd, blockStart, bookingId)
    .first();

  if (raceLoser) {
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(bookingId).run();
    const alts = await suggestAlternatives(env, rideStartUtc, quote.hoursEngaged, settings);
    return json(
      {
        error: "That time was just booked by someone else.",
        alternatives: alts.map((a) => ({ time: a.time, pretty: a.pretty })),
      },
      409,
      cors
    );
  }

  // --- 4. vault the card --------------------------------------------
  let card = null;
  const hasNonce = d.opaqueDataDescriptor && d.opaqueDataValue;

  if (anetConfigured(env) && hasNonce) {
    const opaque = { dataDescriptor: d.opaqueDataDescriptor, dataValue: d.opaqueDataValue };

    // Billing address drives AVS. Without it the issuer can't verify the
    // cardholder's ZIP, which raises fraud exposure and downgrades the
    // interchange rate. Field order follows the Authorize.net schema.
    const nameParts = String(d.name).trim().split(/\s+/);
    const billTo = {
      firstName: (nameParts[0] || "").slice(0, 50),
      lastName: (nameParts.slice(1).join(" ") || nameParts[0] || "").slice(0, 50),
      ...(d.billingAddress ? { address: String(d.billingAddress).slice(0, 60) } : {}),
      ...(d.billingZip ? { zip: String(d.billingZip).slice(0, 20) } : {}),
      country: "US",
    };

    try {
      const customer = await env.DB.prepare(
        `SELECT anet_customer_profile_id FROM customers WHERE id = ?`
      ).bind(customerId).first();

      let profileId = customer && customer.anet_customer_profile_id;
      let paymentProfileId;

      if (profileId) {
        paymentProfileId = await addPaymentProfile(env, { customerProfileId: profileId, opaque, billTo });
      } else {
        try {
          const created = await createProfileFromNonce(env, {
            customerId, email: d.email, description: d.name, opaque, billTo,
          });
          profileId = created.customerProfileId;
          paymentProfileId = created.paymentProfileId;
        } catch (e) {
          // The email already had a profile Authorize.net-side. Adopt it.
          if (e.duplicateProfileId) {
            profileId = e.duplicateProfileId;
            paymentProfileId = await addPaymentProfile(env, { customerProfileId: profileId, opaque, billTo });
          } else {
            throw e;
          }
        }
        await env.DB.prepare(`UPDATE customers SET anet_customer_profile_id = ? WHERE id = ?`)
          .bind(profileId, customerId).run();
      }

      await env.DB.prepare(
        `UPDATE bookings SET anet_payment_profile_id = ?, payment_status = 'card_on_file', status = ?
          WHERE id = ?`
      ).bind(paymentProfileId, settings.autoConfirm ? "confirmed" : "new", bookingId).run();

      card = await describeCard(env, { customerProfileId: profileId, paymentProfileId });
    } catch (e) {
      // Card failed. Release the slot rather than hold it with an unpayable booking.
      await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(bookingId).run();
      return json(
        { error: cardErrorForCustomer(e), field: "card" },
        402,
        cors
      );
    }
  } else {
    // No payment configured yet — behave as a request, not a confirmed booking.
    await env.DB.prepare(`UPDATE bookings SET status = 'new' WHERE id = ?`).bind(bookingId).run();
  }

  // --- 5. notify ----------------------------------------------------
  const when = utcToLocal(rideStartUtc, settings.tz);
  const chargeWhen = utcToLocal(chargeAfter, settings.tz).pretty;
  const manageUrl = `${siteUrl(env)}/manage.html?t=${token}`;
  const booking = { ...d, flight_number: d.flightNumber, chargeWhen };

  const mail = Promise.all([
    card
      ? sendBookingConfirmed(env, { booking, quote, when, card, manageUrl, chargeWhen })
      : Promise.resolve(),
    sendOwnerBooking(env, { booking, quote, when, kind: "new" }),
    smsOwner(
      env,
      `NEW BOOKING\n${when.pretty}\n${d.name} · ${d.phone}\n${d.pickup} -> ${d.dropoff}\n$${quote.total.toFixed(2)} ${card ? "(card on file)" : "(NO CARD)"}`
    ),
  ]);
  if (ctx && ctx.waitUntil) ctx.waitUntil(mail);
  else await mail;

  await env.DB.prepare(
    `UPDATE customers SET last_booked_at = datetime('now'), total_rides = total_rides + 1 WHERE id = ?`
  ).bind(customerId).run();

  return json(
    {
      ok: true,
      bookingId,
      manageUrl,
      quote,
      confirmed: Boolean(card),
      chargeOn: chargeWhen,
      card: card ? { brand: card.brand, last4: card.last4 } : null,
    },
    200,
    cors
  );
}

/** Turn an Authorize.net failure into something a customer can act on. */
function cardErrorForCustomer(e) {
  const msg = String((e && e.message) || "");
  if (/expired/i.test(msg)) return "That card appears to be expired. Please try another card.";
  if (/declin/i.test(msg)) return "That card was declined. Please try another card.";
  if (/E00114|E00116|OTS/i.test(msg)) {
    return "The payment session timed out. Please re-enter your card and try again.";
  }
  return "We couldn't verify that card. Please check the number, expiry, and ZIP and try again.";
}

/* ------------------------------------------------------------
   Customer self-service — GET /api/manage?t=…  /  POST cancel
   ------------------------------------------------------------ */
export async function handleManageGet(url, env, cors) {
  const t = url.searchParams.get("t") || "";
  const settings = await loadSettings(env);
  const b = await env.DB.prepare(
    `SELECT b.*, c.name AS customer_name, c.email AS customer_email
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.manage_token = ? LIMIT 1`
  ).bind(t).first();

  if (!b) return json({ error: "Booking not found." }, 404, cors);

  const when = utcToLocal(b.ride_start_utc, settings.tz);
  const policy = cancellationCharge(b.ride_start_utc, b.quoted_total, settings);

  return json(
    {
      booking: {
        status: b.status,
        paymentStatus: b.payment_status,
        pickup: b.pickup,
        dropoff: b.dropoff,
        when: when.pretty,
        passengers: b.passengers,
        flight: b.flight_number,
        base: b.quoted_base,
        gratuity: b.quoted_gratuity,
        total: b.quoted_total,
        amountCharged: b.amount_charged,
        chargeOn: b.charge_after_utc ? utcToLocal(b.charge_after_utc, settings.tz).pretty : null,
      },
      cancelPolicy: policy,
    },
    200,
    cors
  );
}

export async function handleManageCancel(request, env, cors, ctx) {
  const d = await request.json().catch(() => ({}));
  const settings = await loadSettings(env);
  const b = await env.DB.prepare(
    `SELECT b.*, c.email AS customer_email, c.anet_customer_profile_id
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.manage_token = ? LIMIT 1`
  ).bind(String(d.token || "")).first();

  if (!b) return json({ error: "Booking not found." }, 404, cors);
  if (b.status === "canceled") return json({ ok: true, alreadyCanceled: true }, 200, cors);

  // The sweep has this booking mid-flight. Cancelling now would read
  // amount_charged as 0, take no fee, and then the in-flight charge would
  // land anyway — a full fare taken for a cancelled ride. Make them retry
  // a few seconds later, by which point the charge has settled either way.
  if (b.payment_status === "charging") {
    return json(
      { error: "Your payment is being processed right now. Please try again in a moment." },
      409,
      cors
    );
  }

  const policy = cancellationCharge(b.ride_start_utc, b.quoted_total, settings);
  const alreadyCharged = Number(b.amount_charged) || 0;
  let refunded = 0;
  let lateFee = 0;

  // Cancelling late but the T-24h sweep hasn't run yet — the card is on
  // file and untouched. Without this the published 50%/100% policy would
  // be unenforceable for anyone who cancels between booking and T-24h,
  // which is exactly when a late cancellation actually costs Matt.
  if (
    policy.amount > alreadyCharged &&
    anetConfigured(env) &&
    b.anet_customer_profile_id &&
    b.anet_payment_profile_id
  ) {
    const owed = money(policy.amount - alreadyCharged);
    const res = await chargeProfile(env, {
      customerProfileId: b.anet_customer_profile_id,
      paymentProfileId: b.anet_payment_profile_id,
      amount: owed,
      invoiceNumber: `C${b.id}`,
      description: `Cancellation fee — ${policy.label}`.slice(0, 255),
      cofReason: "noShow",
    });
    await logCharge(
      env, b.id, "cancellation", owed,
      res.ok ? "ok" : res.declined ? "declined" : "error",
      res.transId, res.code, res.message
    );
    if (res.ok) lateFee = owed;
  }

  // Charged more than the policy allows to keep? Give the difference back.
  if (alreadyCharged > policy.amount && anetConfigured(env)) {
    const lastCharge = await env.DB.prepare(
      `SELECT anet_trans_id FROM charges
        WHERE booking_id = ? AND kind = 'fare' AND status = 'ok'
        ORDER BY id DESC LIMIT 1`
    ).bind(b.id).first();

    if (lastCharge && lastCharge.anet_trans_id) {
      const diff = money(alreadyCharged - policy.amount);
      const res = await refundOrVoid(env, {
        transId: lastCharge.anet_trans_id,
        amount: diff,
        customerProfileId: b.anet_customer_profile_id,
        paymentProfileId: b.anet_payment_profile_id,
      });
      if (res.ok) {
        refunded = diff;
        await logCharge(env, b.id, "refund", -diff, "ok", res.transId, "", res.mode);
      } else {
        await logCharge(env, b.id, "refund", -diff, "error", "", res.code, res.message);
      }
    }
  }

  const netCharged = money(alreadyCharged + lateFee - refunded);
  const finalPaymentStatus =
    refunded > 0 ? "refunded" : netCharged > 0 ? "charged" : b.payment_status;

  await env.DB.prepare(
    `UPDATE bookings SET status = 'canceled', payment_status = ?, amount_charged = ?
      WHERE id = ?`
  ).bind(finalPaymentStatus, netCharged, b.id).run();

  const when = utcToLocal(b.ride_start_utc, settings.tz);
  const notice = smsOwner(
    env,
    `CANCELED\n${when.pretty}\n${b.pickup} -> ${b.dropoff}\n` +
      `Kept $${netCharged.toFixed(2)} (${policy.label})` +
      `${refunded ? ` · refunded $${refunded.toFixed(2)}` : ""}`
  );
  if (ctx && ctx.waitUntil) ctx.waitUntil(notice);

  return json(
    { ok: true, charged: netCharged, refunded, policy: policy.label },
    200,
    cors
  );
}

/* ------------------------------------------------------------
   Admin — blackouts, health, post-ride extras, manual charge
   ------------------------------------------------------------ */
export async function handleBlackouts(request, url, env, cors, method) {
  const settings = await loadSettings(env);

  if (method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM blackouts WHERE end_utc > ? ORDER BY start_utc ASC`
    ).bind(Date.now()).all();
    return json(
      {
        blackouts: (results || []).map((b) => ({
          id: b.id,
          label: b.label,
          from: utcToLocal(b.start_utc, settings.tz).date,
          to: utcToLocal(b.end_utc - 1, settings.tz).date,
        })),
      },
      200,
      cors
    );
  }

  if (method === "POST") {
    const d = await request.json().catch(() => ({}));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.from || "")) {
      return json({ error: "from=YYYY-MM-DD required" }, 422, cors);
    }
    const to = /^\d{4}-\d{2}-\d{2}$/.test(d.to || "") ? d.to : d.from;
    const start = localToUtc(d.from, "00:00", settings.tz);
    // end is the start of the day AFTER `to`, so a single-day block covers it fully
    const endBase = localToUtc(to, "00:00", settings.tz);
    const end = endBase + 86_400_000;

    const res = await env.DB.prepare(
      `INSERT INTO blackouts (start_utc, end_utc, label, all_day) VALUES (?,?,?,1)`
    ).bind(start, end, d.label || "Unavailable").run();
    return json({ ok: true, id: res.meta.last_row_id }, 200, cors);
  }

  const m = url.pathname.match(/^\/api\/blackouts\/(\d+)$/);
  if (method === "DELETE" && m) {
    await env.DB.prepare(`DELETE FROM blackouts WHERE id = ?`).bind(Number(m[1])).run();
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "Not found" }, 404, cors);
}

/** POST /api/bookings/:id/extras — Matt's one-tap post-ride charge. */
export async function handleExtras(request, env, cors, bookingId, ctx) {
  const d = await request.json().catch(() => ({}));
  const settings = await loadSettings(env);

  const b = await env.DB.prepare(
    `SELECT b.*, c.email AS customer_email, c.anet_customer_profile_id
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.id = ?`
  ).bind(bookingId).first();
  if (!b) return json({ error: "Booking not found" }, 404, cors);

  const waitMin = Math.max(0, Number(d.waitMinutes) || 0);
  const tolls = Math.max(0, Number(d.tolls) || 0);
  const stops = Math.max(0, Number(d.extraStops) || 0);
  const other = Math.max(0, Number(d.other) || 0);

  const amount = money(
    waitMin * settings.waitRatePerMin + tolls + stops * settings.extraStop + other
  );
  if (amount <= 0) return json({ ok: true, amount: 0, skipped: true }, 200, cors);

  const parts = [];
  if (waitMin) parts.push(`${waitMin} min wait`);
  if (tolls) parts.push(`tolls $${tolls.toFixed(2)}`);
  if (stops) parts.push(`${stops} extra stop${stops > 1 ? "s" : ""}`);
  if (other) parts.push(`other $${other.toFixed(2)}`);
  const note = parts.join(", ");

  if (!anetConfigured(env) || !b.anet_payment_profile_id || !b.anet_customer_profile_id) {
    return json({ error: "No card on file for this booking." }, 400, cors);
  }

  const res = await chargeProfile(env, {
    customerProfileId: b.anet_customer_profile_id,
    paymentProfileId: b.anet_payment_profile_id,
    amount,
    invoiceNumber: `X${b.id}`,
    description: `Extras — ${note}`.slice(0, 255),
    cofReason: "delayedCharge",
  });

  await logCharge(env, b.id, "extras", amount, res.ok ? "ok" : "error", res.transId, res.code, res.message);

  if (!res.ok) {
    return json({ error: res.message || "Card declined", code: res.code }, 402, cors);
  }

  await env.DB.prepare(
    `UPDATE bookings SET extras_total = extras_total + ?, extras_note = ?,
            amount_charged = amount_charged + ? WHERE id = ?`
  ).bind(amount, note, amount, b.id).run();

  const when = utcToLocal(b.ride_start_utc, settings.tz);
  const mail = sendReceipt(env, {
    booking: { ...b, email: b.customer_email, extras_note: note },
    amount,
    when,
    transId: res.transId,
    kind: "extras",
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(mail);

  return json({ ok: true, amount, transId: res.transId }, 200, cors);
}

/** GET /api/health — is everything actually wired up? */
export async function handleHealth(env, cors) {
  const out = {
    database: false,
    rates: 0,
    resend: Boolean(env.RESEND_API_KEY),
    twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.OWNER_PHONE),
    authorizeNet: { configured: anetConfigured(env), clientKey: Boolean(env.ANET_PUBLIC_CLIENT_KEY), mode: env.ANET_ENV || "sandbox" },
  };
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rates WHERE active = 1`).first();
    out.database = true;
    out.rates = r ? r.n : 0;
  } catch (e) {
    out.databaseError = String(e.message || e);
  }
  if (anetConfigured(env)) {
    out.authorizeNet.ping = await pingCredentials(env);
  }
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings WHERE payment_status = 'card_on_file' AND status = 'confirmed'`
  ).first().catch(() => null);
  out.awaitingCharge = pending ? pending.n : null;
  return json(out, 200, cors);
}

/* ------------------------------------------------------------
   shared helpers
   ------------------------------------------------------------ */

export async function logCharge(env, bookingId, kind, amount, status, transId, code, message) {
  try {
    await env.DB.prepare(
      `INSERT INTO charges (booking_id, kind, amount, status, anet_trans_id, anet_code, message)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(bookingId, kind, amount, status, transId || null, code || null, (message || "").slice(0, 500)).run();
  } catch (e) {
    console.log("charge log failed:", e && e.message);
  }
}

export async function upsertCustomer(env, name, email, phone) {
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
  const res = await env.DB.prepare(`INSERT INTO customers (name, email, phone) VALUES (?,?,?)`)
    .bind(name, e, p).run();
  return res.meta.last_row_id;
}
