/* ============================================================
   Booking engine — rates, quotes, availability, timing.

   TIMEZONE POLICY (the thing most likely to bite):
   Matt and his customers think in Florida local time. The Worker runs
   in UTC. Every instant is therefore stored as epoch milliseconds, and
   local wall-clock strings are converted at the edges only. Nothing
   downstream — the calendar, the T-24h charge sweep — ever reasons
   about "5:00 AM" as a string.

   America/New_York shifts by an hour twice a year. A booking made in
   January for a June ride must charge 24 hours before the ride as it
   will actually be experienced, not 25. The conversion below is
   DST-correct because it asks Intl what the offset is AT THAT INSTANT
   rather than assuming a fixed one.
   ============================================================ */

/* ---------------- timezone ---------------- */

/** Offset (ms) of `tz` from UTC at a given instant. */
function zoneOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some ICU builds emit hour 24 for midnight
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second)
  );
  return asIfUtc - utcMs;
}

/**
 * "2026-11-20" + "05:00" in America/New_York -> epoch ms.
 * Two-pass so a naive guess that lands on the wrong side of a DST
 * boundary gets corrected.
 */
export function localToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(timeStr).split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;

  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off1 = zoneOffsetMs(naive, tz);
  let utc = naive - off1;
  const off2 = zoneOffsetMs(utc, tz);
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

/** epoch ms -> { date:"YYYY-MM-DD", time:"HH:MM", pretty:"Fri, Nov 20 · 5:00 AM" } */
export function utcToLocal(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  const hh = String(hour).padStart(2, "0");

  const pretty = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(utcMs));

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${hh}:${map.minute}`,
    pretty,
  };
}

/* ---------------- settings + rates ---------------- */

export async function loadSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const raw = {};
  for (const r of results || []) raw[r.key] = r.value;

  const num = (k, fallback) => {
    const v = Number(raw[k]);
    return Number.isFinite(v) ? v : fallback;
  };

  return {
    tz: raw.timezone || "America/New_York",
    gratuityPct: num("gratuity_pct", 20),
    chargeLeadHours: num("charge_lead_hours", 24),
    freeCancelHours: num("free_cancel_hours", 24),
    halfCancelHours: num("half_cancel_hours", 4),
    bufferMinutes: num("buffer_minutes", 30),
    dayStart: raw.day_start_local || "04:00",
    dayEnd: raw.day_end_local || "22:00",
    minLeadHours: num("min_lead_hours", 3),
    maxAdvanceDays: num("max_advance_days", 365),
    waitRatePerMin: num("wait_rate_per_min", 1.25),
    arrivalFreeWaitMin: num("arrival_free_wait_min", 45),
    departureFreeWaitMin: num("departure_free_wait_min", 15),
    extraStop: num("extra_stop", 20),
    childSeat: num("child_seat", 15),
    cleaningFee: num("cleaning_fee", 200),
    autoConfirm: raw.auto_confirm !== "0",
    declineWindowMin: num("decline_window_min", 30),
  };
}

export async function loadRates(env) {
  const { results } = await env.DB.prepare(
    `SELECT code, label, price, hours_engaged, miles_one_way
       FROM rates WHERE active = 1 ORDER BY sort_order ASC`
  ).all();
  return results || [];
}

export async function getRate(env, code) {
  if (!code) return null;
  return await env.DB.prepare(
    `SELECT code, label, price, hours_engaged, miles_one_way
       FROM rates WHERE code = ? AND active = 1`
  )
    .bind(String(code).toUpperCase())
    .first();
}

/* ---------------- money ---------------- */

/** Round half-up to cents. Avoids 254.99999999 reaching Authorize.net. */
export function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Build the full price breakdown for a destination.
 * Hourly hire multiplies the base by the requested hours (3 hr minimum).
 */
export function quoteFor(rate, settings, opts = {}) {
  // Clamped at both ends. The upper bound is not cosmetic: hours drives the
  // calendar block, so an unclamped value from the request body would let
  // anyone reserve weeks of Matt's calendar with a single booking.
  const requested = Number(opts.hours);
  const hours = Math.min(12, Math.max(3, Number.isFinite(requested) ? requested : 3));
  const isHourly = rate.code === "HOURLY";

  const base = money(isHourly ? rate.price * hours : rate.price);
  const gratuity = money(base * (settings.gratuityPct / 100));
  const total = money(base + gratuity);
  const hoursEngaged = isHourly ? hours : rate.hours_engaged;

  return {
    code: rate.code,
    label: rate.label,
    base,
    gratuityPct: settings.gratuityPct,
    gratuity,
    total,
    hoursEngaged,
    note: "Tolls and airport parking are billed at cost after the ride.",
  };
}

/* ---------------- calendar ---------------- */

/**
 * The window a ride occupies on Matt's calendar: the pickup, the whole
 * round trip including the empty drive home, and a buffer either side.
 * This — not the pickup time — is what prevents double-booking.
 */
export function blockWindow(rideStartUtc, hoursEngaged, settings) {
  const buffer = settings.bufferMinutes * 60_000;
  return {
    start: rideStartUtc - buffer,
    end: rideStartUtc + hoursEngaged * 3_600_000 + buffer,
  };
}

/** Statuses that still hold a slot. A canceled ride frees its time. */
const HOLDING_STATUSES = ["new", "confirmed"];

/**
 * Is [start,end) free? Returns null if free, or a reason object if not.
 * Overlap test is the standard half-open comparison:
 *   existing.start < candidate.end  AND  existing.end > candidate.start
 */
export async function findConflict(env, start, end, ignoreBookingId = null) {
  const placeholders = HOLDING_STATUSES.map(() => "?").join(",");
  const params = [...HOLDING_STATUSES, end, start];
  let sql =
    `SELECT id, ride_date, ride_time, dest_code
       FROM bookings
      WHERE status IN (${placeholders})
        AND block_start_utc IS NOT NULL
        AND block_start_utc < ?
        AND block_end_utc   > ?`;
  if (ignoreBookingId) {
    sql += ` AND id != ?`;
    params.push(ignoreBookingId);
  }
  const hit = await env.DB.prepare(sql + ` LIMIT 1`).bind(...params).first();
  if (hit) {
    return { type: "booking", bookingId: hit.id, destCode: hit.dest_code };
  }

  const black = await env.DB.prepare(
    `SELECT id, label FROM blackouts
      WHERE start_utc < ? AND end_utc > ? LIMIT 1`
  )
    .bind(end, start)
    .first();
  if (black) {
    return { type: "blackout", label: black.label || "Unavailable" };
  }

  return null;
}

/**
 * Full availability decision for a requested pickup.
 * Returns { available, reason } — reason is customer-safe wording that
 * never leaks another customer's booking details.
 */
export async function checkAvailability(env, rideStartUtc, hoursEngaged, settings, ignoreId = null) {
  const now = Date.now();

  if (!Number.isFinite(rideStartUtc)) {
    return { available: false, reason: "That date and time could not be read." };
  }
  if (rideStartUtc < now + settings.minLeadHours * 3_600_000) {
    return {
      available: false,
      reason: `Please book at least ${settings.minLeadHours} hours ahead. For anything sooner, call 848-667-0999.`,
    };
  }
  if (rideStartUtc > now + settings.maxAdvanceDays * 86_400_000) {
    return { available: false, reason: "That date is too far out to book online." };
  }

  const { start, end } = blockWindow(rideStartUtc, hoursEngaged, settings);
  const conflict = await findConflict(env, start, end, ignoreId);
  if (conflict) {
    return {
      available: false,
      reason:
        conflict.type === "blackout"
          ? "Matt is unavailable that day."
          : "That time is already booked.",
      conflictType: conflict.type,
    };
  }
  return { available: true };
}

/**
 * Nearest open pickup times on the same local day, for the "that time is
 * taken — here's what's open" suggestion. Scans on 30-minute steps.
 */
export async function suggestAlternatives(env, rideStartUtc, hoursEngaged, settings, limit = 3) {
  const { date } = utcToLocal(rideStartUtc, settings.tz);
  const dayStart = localToUtc(date, settings.dayStart, settings.tz);
  const dayEnd = localToUtc(date, settings.dayEnd, settings.tz);
  const step = 30 * 60_000;

  const out = [];
  const seen = new Set();

  // Walk outward from the requested time so the closest options come first.
  for (let delta = step; delta <= 12 * 3_600_000 && out.length < limit; delta += step) {
    for (const candidate of [rideStartUtc - delta, rideStartUtc + delta]) {
      if (out.length >= limit) break;
      if (candidate < dayStart || candidate > dayEnd) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      const check = await checkAvailability(env, candidate, hoursEngaged, settings);
      if (check.available) {
        out.push({ utc: candidate, ...utcToLocal(candidate, settings.tz) });
      }
    }
  }
  return out;
}

/** Every blocked window on a local date — lets the form grey out times. */
export async function dayBlocks(env, dateStr, settings) {
  const dayStart = localToUtc(dateStr, "00:00", settings.tz);
  const dayEnd = dayStart + 86_400_000;

  const { results: bookings } = await env.DB.prepare(
    `SELECT block_start_utc AS s, block_end_utc AS e
       FROM bookings
      WHERE status IN ('new','confirmed')
        AND block_start_utc IS NOT NULL
        AND block_start_utc < ? AND block_end_utc > ?`
  )
    .bind(dayEnd, dayStart)
    .all();

  const { results: blocks } = await env.DB.prepare(
    `SELECT start_utc AS s, end_utc AS e, label
       FROM blackouts WHERE start_utc < ? AND end_utc > ?`
  )
    .bind(dayEnd, dayStart)
    .all();

  return [
    ...(bookings || []).map((r) => ({ start: r.s, end: r.e, kind: "booked" })),
    ...(blocks || []).map((r) => ({ start: r.s, end: r.e, kind: "blackout", label: r.label })),
  ];
}

/* ---------------- policy ---------------- */

/**
 * What a cancellation costs right now, per the published policy.
 * Deliberately mirrors the signed rate sheet exactly.
 */
export function cancellationCharge(rideStartUtc, total, settings, now = Date.now()) {
  const hoursOut = (rideStartUtc - now) / 3_600_000;
  if (hoursOut >= settings.freeCancelHours) {
    return { pct: 0, amount: 0, label: "No charge" };
  }
  if (hoursOut >= settings.halfCancelHours) {
    return { pct: 50, amount: money(total * 0.5), label: "50% — inside 24 hours" };
  }
  return { pct: 100, amount: money(total), label: "100% — inside 4 hours or no-show" };
}

/** When the cron becomes allowed to charge this booking. */
export function chargeAfterFor(rideStartUtc, settings) {
  return rideStartUtc - settings.chargeLeadHours * 3_600_000;
}

/** Unguessable token for the customer's manage/cancel link. */
export function manageToken() {
  return crypto.randomUUID().replace(/-/g, "");
}
