/* Full-stack audit of the Amedeo's booking backend.
   Runs the REAL worker modules against a REAL SQLite database with a
   stubbed Authorize.net that emits BOM-prefixed JSON like production. */

import {
  freshDb, installFetchStub, makeEnv, makeCtx, req, anet, RESPONSES,
  check, ok, section, T,
} from "./harness.mjs";

installFetchStub();

const W = new URL("..", import.meta.url).pathname;
const { handleBook, handleQuote, handleConfig, handleExtras, handleManageCancel, handleManageGet } =
  await import(`${W}/api.js`);
const { runScheduled, runDigest } = await import(`${W}/cron.js`);
const { handleManageTip, handleOwnerTip } = await import(`${W}/api.js`);
const { handleReserve } = await import(`${W}/worker.js`);
const { chargeProfile, createProfileFromNonce } = await import(`${W}/authnet.js`);
const { localToUtc, utcToLocal, loadSettings, checkAvailability, quoteFor, getRate } =
  await import(`${W}/engine.js`);

const TZ = "America/New_York";
const CORS = {};
const NONCE = { opaqueDataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", opaqueDataValue: "abc123" };

/* Pick a date safely in the future, on a fixed weekday, avoiding DST edges. */
function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

function booking(over = {}) {
  return {
    destCode: "MIA", pickup: "123 SE Ocean Blvd, Stuart FL", dropoff: "Miami International Airport",
    date: futureDate(30), time: "05:00", passengers: "2",
    name: "Sarah Miller", phone: "772-555-0100", email: `sarah${Math.random()}@example.com`,
    termsAccepted: true, billingZip: "34994", ...NONCE, ...over,
  };
}

async function newEnv() {
  const { DB, db } = freshDb();
  anet.reset();
  return { env: makeEnv(DB), db };
}


/* Revert a booking to the pre-charge state so the T-24h sweep — now a
   fallback path rather than the normal one — can still be exercised. */
function awaitSweep(db, id, chargeAfterUtc) {
  db.prepare(`UPDATE bookings SET payment_status='card_on_file', amount_charged=0,
              charged_at=NULL, paid=0, charge_attempts=0, last_charge_error=NULL,
              charge_after_utc=? WHERE id=?`).run(chargeAfterUtc, id);
  db.prepare("DELETE FROM charges WHERE booking_id=?").run(id);
}

/* =========================================================
   A. SCHEMA
   ========================================================= */
section("A. Schema and seed data");
{
  const { env, db } = await newEnv();
  const rates = db.prepare("SELECT COUNT(*) n FROM rates WHERE active=1").get();
  check("8 rates seeded", rates.n, 8);

  const pbi = db.prepare("SELECT price, hours_engaged FROM rates WHERE code='PBI'").get();
  check("PBI is $80 / 2.0h", [pbi.price, pbi.hours_engaged], [80, 2]);
  const mco = db.prepare("SELECT price FROM rates WHERE code='MCO'").get();
  check("MCO is $200", mco.price, 200);

  const s = await loadSettings(env);
  check("no auto-gratuity", s.gratuityPct, 0);
  check("tip default 20%", s.tipDefaultPct, 20);
  check("tip options", s.tipOptions, [20, 22.5, 25, 30]);
  check("charges at booking", s.chargeAtBooking, true);
  check("charge lead 24h", s.chargeLeadHours, 24);
  check("timezone", s.tz, TZ);

  const cols = db.prepare("PRAGMA table_info(bookings)").all().map((c) => c.name);
  ok("bookings has payment_status", cols.includes("payment_status"));
  ok("bookings has block_start_utc", cols.includes("block_start_utc"));
  ok("bookings has manage_token", cols.includes("manage_token"));
  ok("charges ledger exists", db.prepare("SELECT COUNT(*) n FROM charges").get().n === 0);
}

/* =========================================================
   B. QUOTING
   ========================================================= */
section("B. Quoting");
{
  const { env } = await newEnv();
  const r = await handleQuote(req({ destCode: "MIA", date: futureDate(20), time: "09:00" }), env, CORS);
  const j = await r.json();
  check("MIA fare only, no auto tip", [j.quote.base, j.quote.tip, j.quote.total], [200, 0, 200]);
  ok("MIA slot available", j.availability.available === true);
  ok("charge date returned", typeof j.chargeOn === "string" && j.chargeOn.length > 0);

  const bad = await handleQuote(req({ destCode: "NOPE" }), env, CORS);
  check("unknown destination rejected", bad.status, 422);

  const hourly = await handleQuote(req({ destCode: "HOURLY", hours: 5 }), env, CORS);
  const hj = await hourly.json();
  check("hourly 5h = 400, no auto tip", [hj.quote.base, hj.quote.total], [400, 400]);
}

/* =========================================================
   C. BOOKING — happy path and validation
   ========================================================= */
section("C. Booking");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const res = await handleBook(req(booking()), env, CORS, ctx);
  const j = await res.json();

  check("booking succeeds", res.status, 200);
  ok("confirmed", j.confirmed === true);
  check("total 200 (no tip chosen)", j.quote.total, 200);
  ok("manage url issued", /manage\.html\?t=[a-f0-9]{32}/.test(j.manageUrl));
  check("card described", j.card.last4, "1111");

  const row = db.prepare("SELECT * FROM bookings WHERE id=?").get(j.bookingId);
  check("status confirmed", row.status, "confirmed");
  check("charged at booking", row.payment_status, "charged");
  check("full amount captured", row.amount_charged, 200);
  ok("payment profile stored", !!row.anet_payment_profile_id);
  ok("terms timestamped", !!row.terms_accepted_at);
  ok("block window set", row.block_start_utc < row.ride_start_utc && row.block_end_utc > row.ride_start_utc);
  check("no pending T-24h charge", row.charge_after_utc, null);

  const cust = db.prepare("SELECT * FROM customers WHERE id=?").get(row.customer_id);
  ok("customer vault id stored", !!cust.anet_customer_profile_id);

  ok("AVS zip sent to gateway",
    anet.calls.some((c) => c.kind === "createCustomerProfileRequest" &&
      c.body.profile.paymentProfiles.billTo && c.body.profile.paymentProfiles.billTo.zip === "34994"));
}

{
  const { env } = await newEnv();
  const ctx = makeCtx();
  const noTerms = await handleBook(req(booking({ termsAccepted: false })), env, CORS, ctx);
  check("terms required", noTerms.status, 422);

  const badEmail = await handleBook(req(booking({ email: "nope" })), env, CORS, ctx);
  check("bad email rejected", badEmail.status, 422);

  const missing = await handleBook(req(booking({ pickup: "" })), env, CORS, ctx);
  check("missing field rejected", missing.status, 422);

  const soonLocal = utcToLocal(Date.now() + 60 * 60 * 1000, TZ); // 1 hour from now
  const soon = await handleBook(
    req(booking({ date: soonLocal.date, time: soonLocal.time })), env, CORS, ctx);
  ok("min lead time enforced", soon.status === 409, `got ${soon.status}`);
  const soonJ = await soon.json();
  ok("min lead message tells them to call", /848-667-0999/.test(soonJ.error), soonJ.error);

  const honeypot = await handleBook(req(booking({ company: "spam" })), env, CORS, ctx);
  check("honeypot swallowed", honeypot.status, 200);
}

/* =========================================================
   D. DOUBLE-BOOKING PREVENTION
   ========================================================= */
section("D. Calendar conflicts");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const day = futureDate(40);

  const first = await handleBook(req(booking({ date: day, time: "05:00", destCode: "MIA" })), env, CORS, ctx);
  check("first booking ok", first.status, 200);

  // MIA blocks 3.8h + 30min buffer either side => 04:30 - 09:18
  const overlap = await handleBook(req(booking({ date: day, time: "07:00", destCode: "PBI" })), env, CORS, ctx);
  check("overlapping booking rejected", overlap.status, 409);
  const oj = await overlap.json();
  ok("alternatives offered", Array.isArray(oj.alternatives) && oj.alternatives.length > 0);
  ok("no other customer leaked", !JSON.stringify(oj).includes("Sarah"));

  const clear = await handleBook(req(booking({ date: day, time: "11:00", destCode: "PBI" })), env, CORS, ctx);
  check("non-overlapping accepted", clear.status, 200);

  const inBuffer = await handleBook(req(booking({ date: day, time: "10:15", destCode: "PBI" })), env, CORS, ctx);
  check("buffer respected", inBuffer.status, 409);

  const n = db.prepare("SELECT COUNT(*) n FROM bookings").get().n;
  check("only the two valid bookings persisted", n, 2);
}

{
  // A canceled ride must free its slot.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const day = futureDate(41);
  const r1 = await handleBook(req(booking({ date: day, time: "06:00", destCode: "PBI" })), env, CORS, ctx);
  const j1 = await r1.json();
  db.prepare("UPDATE bookings SET status='canceled' WHERE id=?").run(j1.bookingId);
  const r2 = await handleBook(req(booking({ date: day, time: "06:00", destCode: "PBI" })), env, CORS, ctx);
  check("canceled ride frees the slot", r2.status, 200);
}

{
  // Blackout dates block everything.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const day = futureDate(42);
  const start = localToUtc(day, "00:00", TZ);
  db.prepare("INSERT INTO blackouts (start_utc,end_utc,label,all_day) VALUES (?,?,?,1)")
    .run(start, start + 86400000, "Vacation");
  const r = await handleBook(req(booking({ date: day, time: "09:00" })), env, CORS, ctx);
  check("blackout blocks booking", r.status, 409);
  const j = await r.json();
  ok("blackout wording is customer-safe", /unavailable that day/i.test(j.error), j.error);
}

/* =========================================================
   E. CARD FAILURE MUST NOT HOLD A SLOT
   ========================================================= */
section("E. Card failure handling");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  anet.nextProfile = RESPONSES.expiredCard;

  const r = await handleBook(req(booking({ date: futureDate(50), time: "05:00" })), env, CORS, ctx);
  check("expired card returns 402", r.status, 402);
  const j = await r.json();
  ok("customer-readable error", /expired/i.test(j.error), j.error);

  const n = db.prepare("SELECT COUNT(*) n FROM bookings").get().n;
  check("no orphan booking left holding the slot", n, 0);

  // The slot must now be bookable by someone else.
  const r2 = await handleBook(req(booking({ date: futureDate(50), time: "05:00" })), env, CORS, ctx);
  check("slot is free again", r2.status, 200);
}

{
  // Duplicate profile (E00039) must adopt the existing vault id, not fail.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  anet.nextProfile = RESPONSES.duplicateProfile;
  const r = await handleBook(req(booking({ date: futureDate(51) })), env, CORS, ctx);
  check("duplicate profile recovered", r.status, 200);
  const j = await r.json();
  const row = db.prepare("SELECT customer_id FROM bookings WHERE id=?").get(j.bookingId);
  const cust = db.prepare("SELECT anet_customer_profile_id FROM customers WHERE id=?").get(row.customer_id);
  check("adopted the existing profile id", cust.anet_customer_profile_id, "55512345");
}

/* =========================================================
   F. THE T-24h CHARGE SWEEP
   ========================================================= */
section("F. Charge sweep");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const r = await handleBook(req(booking({ date: futureDate(30), time: "05:00" })), env, CORS, ctx);
  const j = await r.json();

  awaitSweep(db, j.bookingId, Date.now() + 48 * 3600000);   // due in the future

  // Not yet due.
  const early = await runScheduled(env, ctx);
  check("does not charge before T-24h", [early.charged, early.declined], [0, 0]);
  check("still card_on_file",
    db.prepare("SELECT payment_status p FROM bookings WHERE id=?").get(j.bookingId).p, "card_on_file");

  // Bring it into the window.
  db.prepare("UPDATE bookings SET charge_after_utc=? WHERE id=?").run(Date.now() - 1000, j.bookingId);

  const run1 = await runScheduled(env, ctx);
  check("charges once due", run1.charged, 1);
  const row = db.prepare("SELECT * FROM bookings WHERE id=?").get(j.bookingId);
  check("marked charged", row.payment_status, "charged");
  check("amount recorded", row.amount_charged, 200);
  check("paid flag set", row.paid, 1);
  ok("charged_at stamped", !!row.charged_at);

  const led = db.prepare("SELECT * FROM charges WHERE booking_id=?").all(j.bookingId);
  check("one ledger entry", led.length, 1);
  check("ledger amount", led[0].amount, 200);
  check("ledger ok", led[0].status, "ok");
  ok("transaction id captured", !!led[0].anet_trans_id);

  // Re-running must not charge again.
  const run2 = await runScheduled(env, ctx);
  check("idempotent — no second charge", run2.charged, 0);
  check("amount unchanged",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 200);

  ok("charge flagged as merchant-initiated",
    anet.calls.some((c) => c.kind === "createTransactionRequest" &&
      c.body.transactionRequest.processingOptions &&
      c.body.transactionRequest.processingOptions.isSubsequentAuth === "true"));
}

{
  // Two overlapping sweeps must not double-charge (compare-and-swap).
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const r = await handleBook(req(booking({ date: futureDate(31) })), env, CORS, ctx);
  const j = await r.json();
  awaitSweep(db, j.bookingId, Date.now() - 1000);

  const [a, b] = await Promise.all([runScheduled(env, ctx), runScheduled(env, ctx)]);
  check("exactly one sweep charged", a.charged + b.charged, 1);
  check("card charged exactly once",
    db.prepare("SELECT COUNT(*) n FROM charges WHERE booking_id=? AND kind='fare' AND status='ok'").get(j.bookingId).n, 1);
  check("amount is single fare",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 200);
}

{
  // Declines: retry, then give up.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const r = await handleBook(req(booking({ date: futureDate(32) })), env, CORS, ctx);
  const j = await r.json();
  awaitSweep(db, j.bookingId, Date.now() - 1000);

  anet.nextCharge = RESPONSES.declined;
  const d1 = await runScheduled(env, ctx);
  check("decline counted", d1.declined, 1);
  const after1 = db.prepare("SELECT payment_status p, charge_attempts a, last_charge_error e FROM bookings WHERE id=?").get(j.bookingId);
  check("returns to card_on_file for retry", after1.p, "card_on_file");
  check("attempt counted", after1.a, 1);
  ok("error message stored", /declined/i.test(after1.e), after1.e);

  for (let i = 0; i < 3; i++) { anet.nextCharge = RESPONSES.declined; await runScheduled(env, ctx); }
  const final = db.prepare("SELECT payment_status p, charge_attempts a FROM bookings WHERE id=?").get(j.bookingId);
  check("gives up after 4 attempts", [final.p, final.a], ["failed", 4]);

  const more = await runScheduled(env, ctx);
  check("exhausted booking is not retried forever", more.declined, 0);
}

/* =========================================================
   G. AUTHORIZE.NET CLIENT BEHAVIOUR
   ========================================================= */
section("G. Authorize.net client");
{
  const { env } = await newEnv();

  // The trap: resultCode "Ok" with responseCode "2" is a DECLINE.
  anet.nextCharge = RESPONSES.declined;
  const dec = await chargeProfile(env, { customerProfileId: "1", paymentProfileId: "2", amount: 10 });
  check("decline detected despite resultCode Ok", [dec.ok, dec.declined], [false, true]);

  anet.nextCharge = RESPONSES.heldForReview;
  const held = await chargeProfile(env, { customerProfileId: "1", paymentProfileId: "2", amount: 10 });
  check("held-for-review is not a success", held.ok, false);
  check("held-for-review is not a decline", held.declined, false);
  ok("held flag surfaced", held.heldForReview === true);

  const good = await chargeProfile(env, { customerProfileId: "1", paymentProfileId: "2", amount: 234.567 });
  check("approved", good.ok, true);
  const last = anet.calls[anet.calls.length - 1];
  check("amount sent as 2dp string", last.body.transactionRequest.amount, "234.57");
  ok("BOM-prefixed JSON parsed without error", good.transId.length > 0);

  anet.nextProfile = RESPONSES.duplicateProfile;
  let dupId = null;
  try {
    await createProfileFromNonce(env, { customerId: 1, email: "a@b.c", description: "x",
      opaque: { dataDescriptor: "d", dataValue: "v" } });
  } catch (e) { dupId = e.duplicateProfileId; }
  check("duplicate profile id extracted", dupId, "55512345");
}

/* =========================================================
   H. CANCELLATION POLICY
   ========================================================= */
section("H. Cancellation");
async function bookAt(env, ctx, hoursFromNow, dest = "MIA") {
  const when = new Date(Date.now() + hoursFromNow * 3600000);
  const local = utcToLocal(when.getTime(), TZ);
  const r = await handleBook(req(booking({ date: local.date, time: local.time, destCode: dest })), env, CORS, ctx);
  return { res: r, j: await r.json() };
}

{
  // >24h out, never charged -> nothing taken.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;

  const c = await handleManageCancel(req({ token }), env, CORS, ctx);
  const cj = await c.json();
  check("free cancellation keeps nothing", cj.charged, 0);
  check("full amount refunded", cj.refunded, 200);
  check("marked canceled",
    db.prepare("SELECT status s FROM bookings WHERE id=?").get(j.bookingId).s, "canceled");
  check("refund recorded in ledger",
    db.prepare("SELECT COUNT(*) n FROM charges WHERE booking_id=? AND kind='refund'").get(j.bookingId).n, 1);
}

{
  // Inside 24h, card never charged yet -> policy fee must still be taken.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;
  // Pull the ride to 6 hours away without charging it.
  const newStart = Date.now() + 6 * 3600000;
  db.prepare("UPDATE bookings SET ride_start_utc=? WHERE id=?").run(newStart, j.bookingId);

  const c = await handleManageCancel(req({ token }), env, CORS, ctx);
  const cj = await c.json();
  check("50% kept on late cancel", cj.charged, 100);
  check("half refunded", cj.refunded, 100);
  check("booking shows amount kept",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 100);
}

{
  // Already charged in full, then cancels with >24h notice -> refund.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;
  db.prepare("UPDATE bookings SET charge_after_utc=? WHERE id=?").run(Date.now() - 1000, j.bookingId);
  await runScheduled(env, ctx);
  check("charged before cancelling",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 200);

  const c = await handleManageCancel(req({ token }), env, CORS, ctx);
  const cj = await c.json();
  check("full refund issued", cj.refunded, 200);
  check("nothing kept", cj.charged, 0);
  check("balance zeroed",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 0);
  check("refund in ledger",
    db.prepare("SELECT COUNT(*) n FROM charges WHERE booking_id=? AND kind='refund'").get(j.bookingId).n, 1);
}

{
  // Cancelled booking must not be picked up by the sweep afterwards.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;
  await handleManageCancel(req({ token }), env, CORS, ctx);
  db.prepare("UPDATE bookings SET charge_after_utc=? WHERE id=?").run(Date.now() - 1000, j.bookingId);
  const sweep = await runScheduled(env, ctx);
  check("sweep ignores canceled bookings", sweep.charged, 0);
}

{
  const { env } = await newEnv();
  const bad = await handleManageCancel(req({ token: "nope" }), env, CORS, makeCtx());
  check("unknown token 404s", bad.status, 404);
  const badGet = await handleManageGet(new URL("https://x/api/manage?t=nope"), env, CORS);
  check("unknown token on lookup 404s", badGet.status, 404);
}

/* =========================================================
   I. POST-RIDE EXTRAS
   ========================================================= */
section("I. Extras");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  db.prepare("UPDATE bookings SET charge_after_utc=? WHERE id=?").run(Date.now() - 1000, j.bookingId);
  await runScheduled(env, ctx);

  const r = await handleExtras(req({ waitMinutes: 20, tolls: 18.50, extraStops: 1 }), env, CORS, j.bookingId, ctx);
  const rj = await r.json();
  // 20 * 1.25 + 18.50 + 20 = 63.50
  check("extras computed correctly", rj.amount, 63.5);
  check("booking extras total", db.prepare("SELECT extras_total e FROM bookings WHERE id=?").get(j.bookingId).e, 63.5);
  check("running total includes extras",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(j.bookingId).a, 263.5);
  check("extras in ledger",
    db.prepare("SELECT COUNT(*) n FROM charges WHERE booking_id=? AND kind='extras'").get(j.bookingId).n, 1);

  ok("extras flagged as delayedCharge",
    anet.calls.some((c) => c.kind === "createTransactionRequest" &&
      c.body.transactionRequest.subsequentAuthInformation &&
      c.body.transactionRequest.subsequentAuthInformation.reason === "delayedCharge"));

  const zero = await handleExtras(req({ waitMinutes: 0, tolls: 0 }), env, CORS, j.bookingId, ctx);
  const zj = await zero.json();
  ok("zero extras is a no-op", zj.skipped === true);

  anet.nextCharge = RESPONSES.declined;
  const dec = await handleExtras(req({ tolls: 10 }), env, CORS, j.bookingId, ctx);
  check("declined extras returns 402", dec.status, 402);
  check("declined extras not added to total",
    db.prepare("SELECT extras_total e FROM bookings WHERE id=?").get(j.bookingId).e, 63.5);
}

/* =========================================================
   J. DIGEST
   ========================================================= */
section("J. Daily digest");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 20);
  db.prepare("UPDATE bookings SET charge_after_utc=? WHERE id=?").run(Date.now() - 1000, j.bookingId);
  await runScheduled(env, ctx);

  const d = await runDigest(env);
  ok("digest runs without error", typeof d === "object");
  check("digest counts collected", d.collected, 200);
  ok("digest sees tomorrow's ride", d.tomorrow + d.today >= 1, JSON.stringify(d));
}

/* =========================================================
   K. CONFIG EXPOSURE — no secret leakage
   ========================================================= */
section("K. Public config safety");
{
  const { env } = await newEnv();
  const r = await handleConfig(env, CORS);
  const j = await r.json();
  const body = JSON.stringify(j);
  ok("transaction key NEVER exposed", !body.includes("testkey"));
  ok("client key exposed (it is public by design)", j.payments.clientKey === "testclientkey");
  check("api login id exposed (public)", j.payments.apiLoginId, "testlogin");
  check("payments enabled", j.payments.enabled, true);
  check("8 rates published", j.rates.length, 8);
  ok("no signature key present", !body.toLowerCase().includes("signature"));
}

/* =========================================================
   L. REGRESSIONS FOUND DURING THE STATIC AUDIT
   ========================================================= */
section("L. Audit regressions");
{
  // Calendar denial-of-service: hours came straight from the request body
  // and drives the block length. Must be clamped.
  const { env } = await newEnv();
  const rate = await getRate(env, "HOURLY");
  const s = await loadSettings(env);

  check("hours clamped to 12 max", quoteFor(rate, s, { hours: 999 }).hoursEngaged, 12);
  check("hours clamped to 3 min", quoteFor(rate, s, { hours: 1 }).hoursEngaged, 3);
  check("NaN hours falls back to 3", quoteFor(rate, s, { hours: "abc" }).hoursEngaged, 3);
  check("negative hours falls back to 3", quoteFor(rate, s, { hours: -50 }).hoursEngaged, 3);

  const ctx = makeCtx();
  const r = await handleBook(req(booking({ destCode: "HOURLY", hours: 999, date: futureDate(60), time: "09:00" })), env, CORS, ctx);
  const j = await r.json();
  ok("huge-hours booking accepted but clamped", r.status === 200);
  check("block capped at 12h + buffers", Math.round(j.quote.hoursEngaged), 12);
}

{
  // The legacy /reserve endpoint must still hold the calendar, or an old-form
  // enquiry and a new paid booking can occupy the same slot.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const day = futureDate(61);

  const legacy = await handleReserve(
    req({ service: "Airport Transfer", pickup: "Stuart", dropoff: "PBI",
          date: day, time: "05:00", passengers: "2",
          name: "Legacy Caller", phone: "772-555-0199", email: "legacy@example.com" }),
    env, CORS);
  check("legacy /reserve still accepted", legacy.status, 200);

  const row = db.prepare("SELECT * FROM bookings WHERE source='website' ORDER BY id DESC").get();
  ok("legacy booking has a ride_start_utc", !!row.ride_start_utc);
  ok("legacy booking blocks the calendar", row.block_start_utc < row.ride_start_utc && row.block_end_utc > row.ride_start_utc);

  const clash = await handleBook(req(booking({ date: day, time: "06:00", destCode: "PBI" })), env, CORS, ctx);
  check("paid booking cannot land on a legacy enquiry slot", clash.status, 409);
}

{
  // Cancel racing the charge sweep must not slip through free.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const { j } = await bookAt(env, ctx, 72);
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;
  db.prepare("UPDATE bookings SET payment_status='charging' WHERE id=?").run(j.bookingId);

  const c = await handleManageCancel(req({ token }), env, CORS, ctx);
  check("cancel blocked while charge is in flight", c.status, 409);
  check("booking not cancelled mid-charge",
    db.prepare("SELECT status s FROM bookings WHERE id=?").get(j.bookingId).s, "confirmed");
  const cj = await c.json();
  ok("customer told to retry", /try again/i.test(cj.error), cj.error);
}


/* =========================================================
   M. TIPS — optional, never folded into the fare
   ========================================================= */
section("M. Tips");
{
  const { env, db } = await newEnv();
  const ctx = makeCtx();

  // No tip chosen -> the customer pays exactly the advertised fare.
  const plain = await handleBook(req(booking({ destCode: "MCO", date: futureDate(70), time: "05:00" })), env, CORS, ctx);
  const pj = await plain.json();
  check("no tip -> fare only", [pj.quote.base, pj.quote.tip, pj.quote.total], [200, 0, 200]);
  check("charged exactly the fare",
    db.prepare("SELECT amount_charged a FROM bookings WHERE id=?").get(pj.bookingId).a, 200);
  check("tip column zero",
    db.prepare("SELECT tip_amount t FROM bookings WHERE id=?").get(pj.bookingId).t, 0);
}

{
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const r = await handleBook(req(booking({ destCode: "MCO", tipPct: 22.5, date: futureDate(71), time: "05:00" })), env, CORS, ctx);
  const j = await r.json();
  check("22.5% tip on $200 = $45", [j.quote.base, j.quote.tip, j.quote.total], [200, 45, 245]);
  const row = db.prepare("SELECT tip_amount, tip_pct, amount_charged FROM bookings WHERE id=?").get(j.bookingId);
  check("tip stored separately", [row.tip_amount, row.tip_pct], [45, 22.5]);
  check("one charge for fare+tip", row.amount_charged, 245);
  check("single transaction, not two",
    db.prepare("SELECT COUNT(*) n FROM charges WHERE booking_id=?").get(j.bookingId).n, 1);
}

{
  // Every option Matt asked for lands on a clean number.
  const { env } = await newEnv();
  const ctx = makeCtx();
  const expected = { 20: 240, 22.5: 245, 25: 250, 30: 260 };
  for (const pct of [20, 22.5, 25, 30]) {
    const r = await handleQuote(req({ destCode: "MCO", tipPct: pct }), env, CORS);
    const j = await r.json();
    check(`${pct}% -> $${expected[pct]}`, j.quote.total, expected[pct]);
  }
}

{
  // Customer adds a tip AFTER the ride, from their receipt link.
  const { env, db } = await newEnv();
  const ctx = makeCtx();
  const r = await handleBook(req(booking({ destCode: "PBI", date: futureDate(72), time: "09:00" })), env, CORS, ctx);
  const j = await r.json();
  const token = db.prepare("SELECT manage_token t FROM bookings WHERE id=?").get(j.bookingId).t;
  check("PBI fare charged", j.quote.total, 80);

  const t = await handleManageTip(req({ token, amount: 20 }), env, CORS, ctx);
  const tj = await t.json();
  check("post-ride tip charged", tj.amount, 20);
  const row = db.prepare("SELECT tip_amount, amount_charged, tip_added_after FROM bookings WHERE id=?").get(j.bookingId);
  check("tip recorded", [row.tip_amount, row.amount_charged], [20, 100]);
  check("flagged as added later", row.tip_added_after, 1);

  // Customer is present -> NOT a merchant-initiated transaction.
  const last = anet.calls.filter(c => c.kind === "createTransactionRequest").pop();
  ok("customer tip carries no delayedCharge reason",
    !last.body.transactionRequest.subsequentAuthInformation);

  // Matt adds one from the admin -> merchant-initiated.
  const o = await handleOwnerTip(req({ amount: 15 }), env, CORS, j.bookingId, ctx);
  check("owner tip charged", (await o.json()).amount, 15);
  const ownerCall = anet.calls.filter(c => c.kind === "createTransactionRequest").pop();
  check("owner tip flagged delayedCharge",
    ownerCall.body.transactionRequest.subsequentAuthInformation.reason, "delayedCharge");
  check("tips accumulate",
    db.prepare("SELECT tip_amount t FROM bookings WHERE id=?").get(j.bookingId).t, 35);
}

{
  // Guards: a tip must never reduce the fare or run away.
  const { env } = await newEnv();
  const ctx = makeCtx();
  const neg = await handleQuote(req({ destCode: "MCO", tipPct: -50 }), env, CORS);
  check("negative tip ignored", (await neg.json()).quote.total, 200);

  const huge = await handleQuote(req({ destCode: "MCO", tipAmount: 999999 }), env, CORS);
  check("absurd tip capped at half the fare", (await huge.json()).quote.total, 300);

  check("pct tip clamped to 50%", (await handleQuote(req({ destCode: "MCO", tipPct: 100000 }), env, CORS).then(r=>r.json())).quote.total, 300);

  const r = await handleBook(req(booking({ destCode: "PBI", date: futureDate(73), time: "09:00" })), env, CORS, ctx);
  const j = await r.json();
  const bad = await handleOwnerTip(req({ amount: 5000 }), env, CORS, j.bookingId, ctx);
  check("runaway post-ride tip refused", bad.status, 422);
  const zero = await handleOwnerTip(req({ amount: 0 }), env, CORS, j.bookingId, ctx);
  check("zero tip refused", zero.status, 422);
}

/* ---------- summary ---------- */
console.log(`\n${"=".repeat(52)}`);
console.log(`${T.pass} passed, ${T.fail} failed`);
if (T.fail) { console.log("\nFailures:"); T.failures.forEach((f) => console.log("  - " + f)); }
console.log("=".repeat(52) + "\n");
process.exit(T.fail ? 1 : 0);
