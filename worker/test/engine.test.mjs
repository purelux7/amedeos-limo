/* Verification of the booking engine's pure logic.
   Run: node engine.test.mjs                                       */

import {
  localToUtc, utcToLocal, money, quoteFor, blockWindow,
  cancellationCharge, chargeAfterFor,
} from "../engine.js";

const TZ = "America/New_York";
let pass = 0, fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ---------- 1. timezone conversion ---------- */
section("Local -> UTC (DST correctness)");

// Nov 20 2026 is EST (UTC-5). 05:00 local = 10:00 UTC.
check("winter EST 05:00 -> 10:00Z",
  new Date(localToUtc("2026-11-20", "05:00", TZ)).toISOString(),
  "2026-11-20T10:00:00.000Z");

// Jul 15 2026 is EDT (UTC-4). 05:00 local = 09:00 UTC.
check("summer EDT 05:00 -> 09:00Z",
  new Date(localToUtc("2026-07-15", "05:00", TZ)).toISOString(),
  "2026-07-15T09:00:00.000Z");

// The instant before fall-back (Nov 1 2026, 2am EDT -> 1am EST).
check("day of fall-back, 00:30 EDT -> 04:30Z",
  new Date(localToUtc("2026-11-01", "00:30", TZ)).toISOString(),
  "2026-11-01T04:30:00.000Z");

// After the switch the same morning: 06:00 EST -> 11:00Z.
check("day of fall-back, 06:00 EST -> 11:00Z",
  new Date(localToUtc("2026-11-01", "06:00", TZ)).toISOString(),
  "2026-11-01T11:00:00.000Z");

// Spring forward Mar 8 2026: 03:00 EDT -> 07:00Z.
check("day of spring-forward, 03:00 EDT -> 07:00Z",
  new Date(localToUtc("2026-03-08", "03:00", TZ)).toISOString(),
  "2026-03-08T07:00:00.000Z");

section("UTC -> local round trip");
for (const [d, t] of [["2026-11-20","05:00"],["2026-07-15","17:45"],["2026-03-08","23:00"],["2026-01-01","00:00"]]) {
  const back = utcToLocal(localToUtc(d, t, TZ), TZ);
  check(`round trip ${d} ${t}`, [back.date, back.time], [d, t]);
}

/* ---------- 2. the T-24h charge across a DST boundary ---------- */
section("T-24h charge timing");

const s = { chargeLeadHours: 24, tz: TZ };

// Ride Nov 1 2026 06:00 EST. That local day has 25 hours, so 24 REAL
// hours earlier is Oct 31 at 07:00 local, not 06:00. Absolute time is
// what matters for the charge, and this proves we use absolute time.
const ride = localToUtc("2026-11-01", "06:00", TZ);
const chargeAt = chargeAfterFor(ride, s);
check("charge is exactly 24h before in real time",
  (ride - chargeAt) / 3_600_000, 24);
check("…which lands at 07:00 local the previous day",
  utcToLocal(chargeAt, TZ).time, "07:00");

// Normal (no DST) case stays at the same wall clock.
const ride2 = localToUtc("2026-07-15", "05:00", TZ);
check("summer: T-24h same wall clock",
  utcToLocal(chargeAfterFor(ride2, s), TZ).time, "05:00");

/* ---------- 3. money ---------- */
section("Money rounding");
check("float noise rounds clean", money(254.999999999), 255);
check("half-up at cents", money(1.005), 1.01);
check("gratuity of 215", money(215 * 0.2), 43);
check("no negative zero", money(0), 0);
check("MIA total", money(255 + money(255 * 0.2)), 306);

/* ---------- 4. quotes ---------- */
section("Quotes");
const settings = { gratuityPct: 20 };
const mia = quoteFor({ code: "MIA", label: "Miami", price: 255, hours_engaged: 3.8 }, settings);
check("MIA base/gratuity/total", [mia.base, mia.gratuity, mia.total], [255, 51, 306]);
check("MIA blocks 3.8h", mia.hoursEngaged, 3.8);

const hourly4 = quoteFor({ code: "HOURLY", label: "Hourly", price: 95, hours_engaged: 3 }, settings, { hours: 4 });
check("hourly x4 = 380 + 76", [hourly4.base, hourly4.gratuity, hourly4.total], [380, 76, 456]);

const hourlyMin = quoteFor({ code: "HOURLY", label: "Hourly", price: 95, hours_engaged: 3 }, settings, { hours: 1 });
check("hourly enforces 3h minimum", hourlyMin.base, 285);

/* ---------- 5. calendar blocking ---------- */
section("Calendar block windows");
const cfg = { bufferMinutes: 30 };
const start = localToUtc("2026-07-15", "05:00", TZ);
const w = blockWindow(start, 3.8, cfg);
check("block starts 30m before pickup", utcToLocal(w.start, TZ).time, "04:30");
check("block ends 3.8h + 30m after", utcToLocal(w.end, TZ).time, "09:18");

// Overlap arithmetic used by findConflict: existing.start < new.end && existing.end > new.start
const a = blockWindow(localToUtc("2026-07-15", "05:00", TZ), 3.8, cfg); // MIA 04:30-09:18
const overlaps = (x, y) => x.start < y.end && x.end > y.start;
check("07:00 PBI overlaps the MIA run",
  overlaps(a, blockWindow(localToUtc("2026-07-15", "07:00", TZ), 2.0, cfg)), true);
check("10:00 PBI does NOT overlap",
  overlaps(a, blockWindow(localToUtc("2026-07-15", "10:00", TZ), 2.0, cfg)), false);
check("09:00 PBI still overlaps (inside buffer)",
  overlaps(a, blockWindow(localToUtc("2026-07-15", "09:00", TZ), 2.0, cfg)), true);

/* ---------- 6. cancellation policy ---------- */
section("Cancellation policy");
const pol = { freeCancelHours: 24, halfCancelHours: 4 };
const now = Date.parse("2026-07-15T12:00:00Z");
const at = (h) => now + h * 3_600_000;
check("48h out  -> free",      cancellationCharge(at(48), 306, pol, now).pct, 0);
check("24h out  -> free (boundary)", cancellationCharge(at(24), 306, pol, now).pct, 0);
check("23h out  -> 50%",       cancellationCharge(at(23), 306, pol, now).pct, 50);
check("4h out   -> 50% (boundary)",  cancellationCharge(at(4), 306, pol, now).pct, 50);
check("3h out   -> 100%",      cancellationCharge(at(3), 306, pol, now).pct, 100);
check("no-show  -> 100%",      cancellationCharge(at(-1), 306, pol, now).pct, 100);
check("50% of 306 = 153",      cancellationCharge(at(23), 306, pol, now).amount, 153);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
