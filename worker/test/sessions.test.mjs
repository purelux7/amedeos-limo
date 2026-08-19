/* Admin sessions and the sign-in throttle.

   These guard a screen that can charge cards that are already on file,
   so the properties worth asserting are the ones that were previously
   FALSE: that two devices get different tokens, that signing out on one
   does not sign out the other, that signing out actually invalidates
   the token rather than just dropping the cookie, and that changing the
   password ejects every other device. */

import { freshDb, makeEnv, ok, section, T } from "./harness.mjs";

const W = new URL("..", import.meta.url).pathname;
const {
  createSession, validSession, destroySession, revokeAll, listSessions,
  loginBlocked, noteFailure, clearFailures, hashToken,
} = await import(`${W}/sessions.js`);
const { checkAdminPassword, changePassword, hashPassword, verifyPassword } =
  await import(`${W}/backoffice.js`);

function req(token, extra = {}) {
  const headers = new Map();
  if (token) headers.set("cookie", `afacs=${token}`);
  headers.set("user-agent", extra.ua || "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari");
  if (extra.ip) headers.set("cf-connecting-ip", extra.ip);
  return {
    headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
    json: async () => extra.body || {},
  };
}

const { DB } = freshDb();
const env = makeEnv(DB);
env.ADMIN_PASSWORD = "bootstrap-secret";

section("Sessions — each sign-in is its own");

const phone = await createSession(env, req(null, { ua: "iPhone Safari" }));
const laptop = await createSession(env, req(null, { ua: "Mac Chrome" }));
ok("two sign-ins produce different tokens", phone.token !== laptop.token);
ok("a token is 64 hex chars", /^[a-f0-9]{64}$/.test(phone.token));

ok("phone session validates", Boolean(await validSession(env, req(phone.token))));
ok("laptop session validates", Boolean(await validSession(env, req(laptop.token))));
ok("a made-up token does not", !(await validSession(env, req("f".repeat(64)))));
ok("no cookie does not", !(await validSession(env, req(null))));

section("Sessions — the raw token is never stored");

const stored = await env.DB.prepare(`SELECT token_hash FROM admin_sessions`).all();
const hashes = (stored.results || []).map((r) => r.token_hash);
ok("stored value is not the token", hashes.indexOf(phone.token) === -1);
ok("stored value is the token's hash", hashes.indexOf(await hashToken(phone.token)) !== -1);

section("Sessions — signing out is real, and local");

await destroySession(env, req(laptop.token));
ok("laptop is signed out", !(await validSession(env, req(laptop.token))));
ok("phone is untouched", Boolean(await validSession(env, req(phone.token))));

section("Sessions — listing marks the current device");

const tablet = await createSession(env, req(null, { ua: "iPad Safari" }));
const list = await listSessions(env, req(phone.token));
ok("both live sessions listed", list.length === 2);
ok("exactly one is marked current", list.filter((s) => s.current).length === 1);
ok("the current one is the phone", list.filter((s) => s.current)[0].device.indexOf("iPhone") !== -1);

section("Sessions — revoke all keeps the caller signed in");

await revokeAll(env, req(phone.token), { keepCurrent: true });
ok("phone survives", Boolean(await validSession(env, req(phone.token))));
ok("tablet is gone", !(await validSession(env, req(tablet.token))));

section("Password — the stored hash beats the bootstrap secret");

ok("bootstrap secret works before any change", await checkAdminPassword(env, "bootstrap-secret"));

const cors = {};
const res = await changePassword(
  req(phone.token, { body: { current: "bootstrap-secret", next: "CypressHarbor-9911" } }),
  env, cors
);
ok("change succeeds", res.status === 200);

ok("new password works", await checkAdminPassword(env, "CypressHarbor-9911"));
ok("bootstrap secret is now dead", !(await checkAdminPassword(env, "bootstrap-secret")));

section("Password — changing it ejects every other device");

const other = await createSession(env, req(null, { ua: "Windows Chrome" }));
await changePassword(
  req(phone.token, { body: { current: "CypressHarbor-9911", next: "LanternPalmetto-2244" } }),
  env, cors
);
ok("the device that changed it stays in", Boolean(await validSession(env, req(phone.token))));
ok("every other device is ejected", !(await validSession(env, req(other.token))));

section("Password — hashing");

const h = await hashPassword("a-good-long-password");
ok("hash is not the password", h.indexOf("a-good-long-password") === -1);
/* The Workers runtime refuses PBKDF2 above 100,000 iterations and throws
   at deriveBits. Local workerd does not enforce it, so a value that is too
   high passes every test and every dev run and then 500s in production the
   first time somebody changes their password. Assert the ceiling here. */
const iterations = Number(h.split("$")[1]);
ok("hash is pbkdf2", h.indexOf("pbkdf2$") === 0);
ok("iterations are within the Workers cap of 100000", iterations <= 100000, "got " + iterations);
ok("iterations are not trivially low", iterations >= 100000, "got " + iterations);
ok("correct password verifies", await verifyPassword("a-good-long-password", h));
ok("wrong password does not", !(await verifyPassword("a-good-long-passworD", h)));
ok("garbage stored value does not crash", !(await verifyPassword("x", "nonsense")));

section("Password — refusals");

const bad = await changePassword(req(phone.token, { body: { current: "wrong", next: "LongEnoughPassword" } }), env, cors);
ok("wrong current password is refused", bad.status === 401);
const short = await changePassword(req(phone.token, { body: { current: "LanternPalmetto-2244", next: "short" } }), env, cors);
ok("a short new password is refused", short.status === 422);

section("Sign-in throttle");

const IP = "203.0.113.77";
ok("a fresh IP is not blocked", !(await loginBlocked(env, IP)));
for (let i = 0; i < 8; i++) await noteFailure(env, IP);
ok("blocked after eight failures", Boolean(await loginBlocked(env, IP)));
ok("a different IP is unaffected", !(await loginBlocked(env, "198.51.100.9")));
await clearFailures(env, IP);
ok("a successful sign-in clears the block", !(await loginBlocked(env, IP)));

console.log(`\n${T.fail ? "FAILED" : "passed"} — ${T.pass} passed, ${T.fail} failed`);
process.exit(T.fail ? 1 : 0);
