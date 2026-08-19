/* Named logins.

   What matters is separation: that two people are distinguishable,
   that revoking one does not touch the other, and that turning
   somebody off ends their sessions rather than merely their right to
   start new ones. */

import { freshDb, makeEnv, ok, section, T } from "./harness.mjs";

const W = new URL("..", import.meta.url).pathname;
const { anyUsers, authenticate, createUser, updateUser, changeOwnPassword, findUser } =
  await import(`${W}/users.js`);
const { createSession, validSession } = await import(`${W}/sessions.js`);

function req(body, token) {
  const h = new Map();
  if (token) h.set("cookie", `afacs=${token}`);
  h.set("user-agent", "Mac Chrome");
  return { headers: { get: (k) => h.get(String(k).toLowerCase()) || null }, json: async () => body || {} };
}
const cors = {};
const { DB } = freshDb();
const env = makeEnv(DB);
env.ADMIN_PASSWORD = "bootstrap-secret";

section("Before anyone exists");
ok("no users yet", !(await anyUsers(env)));

section("Creating logins");
let r = await createUser(req({ username: "donny", name: "Donny Marshall", role: "owner", password: "donny007$$" }), env, cors);
ok("owner created", r.status === 200);
r = await createUser(req({ username: "matt", name: "Matt Gaglioti", role: "owner", password: "mattyride$$" }), env, cors);
ok("second owner created", r.status === 200);
ok("users now exist", await anyUsers(env));

r = await createUser(req({ username: "matt", password: "somethinglong" }), env, cors);
ok("a duplicate username is refused", r.status === 409);
r = await createUser(req({ username: "x y", password: "somethinglong" }), env, cors);
ok("a username with a space is refused", r.status === 422);
r = await createUser(req({ username: "shorty", password: "short" }), env, cors);
ok("a short password is refused", r.status === 422);

section("Signing in");
ok("donny signs in", Boolean(await authenticate(env, "donny", "donny007$$")));
ok("matt signs in", Boolean(await authenticate(env, "matt", "mattyride$$")));
ok("each other's passwords do not work", !(await authenticate(env, "donny", "mattyride$$")));
ok("a made-up user does not sign in", !(await authenticate(env, "nobody", "donny007$$")));
ok("username is case-insensitive", Boolean(await authenticate(env, "DONNY", "donny007$$")));

section("Sessions belong to a person");
const donny = await findUser(env, "donny");
const matt = await findUser(env, "matt");
const dSess = await createSession(env, req(), donny.id);
const mSess = await createSession(env, req(), matt.id);
ok("both sessions valid", Boolean(await validSession(env, req(null, dSess.token))) && Boolean(await validSession(env, req(null, mSess.token))));

section("Deactivating one person leaves the other alone");
r = await updateUser(req({ active: false }), env, cors, matt.id);
ok("matt deactivated", r.status === 200);
ok("matt can no longer sign in", !(await authenticate(env, "matt", "mattyride$$")));
ok("matt's open session is dead too", !(await validSession(env, req(null, mSess.token))));
ok("donny is untouched", Boolean(await validSession(env, req(null, dSess.token))));
ok("donny still signs in", Boolean(await authenticate(env, "donny", "donny007$$")));

section("The last owner cannot be switched off");
r = await updateUser(req({ active: false }), env, cors, donny.id);
ok("refused", r.status === 409);
ok("donny still active", Boolean(await authenticate(env, "donny", "donny007$$")));

section("Changing your own password");
const fresh = await createSession(env, req(), donny.id);
const other = await createSession(env, req(), donny.id);
r = await changeOwnPassword(req({ current: "donny007$$", next: "NewLongPassword1" }, fresh.token), env, cors, await findUser(env, "donny"));
ok("changed", r.status === 200);
ok("new password works", Boolean(await authenticate(env, "donny", "NewLongPassword1")));
ok("old password is dead", !(await authenticate(env, "donny", "donny007$$")));
ok("the device that changed it stays in", Boolean(await validSession(env, req(null, fresh.token))));
ok("their other device is signed out", !(await validSession(env, req(null, other.token))));

r = await changeOwnPassword(req({ current: "wrong", next: "AnotherLongOne1" }, fresh.token), env, cors, await findUser(env, "donny"));
ok("wrong current password refused", r.status === 401);

console.log(`\n${T.fail ? "FAILED" : "passed"} — ${T.pass} passed, ${T.fail} failed`);
process.exit(T.fail ? 1 : 0);
