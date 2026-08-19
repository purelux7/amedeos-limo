/* ============================================================
   Admin sessions.

   Previously the cookie was HMAC(ADMIN_PASSWORD, "afacs-admin-v1") —
   one constant string, the same on every device, valid forever, and
   unaffected by signing out or changing the password. This replaces it
   with ordinary session rows: random per sign-in, hashed at rest,
   expiring, and revocable.

   Only the SHA-256 of the token is stored. Someone who reads the
   database does not thereby hold a working cookie.
   ============================================================ */

const SESSION_DAYS = 30;

/* Sign-in throttle. Deliberately gentle: this admin has exactly one
   user, and locking Matt out of his own business at 4am to stop a
   bot is a worse outcome than the bot getting a few more guesses. */
const MAX_FAILS = 8;
const LOCKOUT_MINUTES = 15;
const FAIL_WINDOW_MINUTES = 30;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function newToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export function readCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)afacs=([a-f0-9]{16,128})/);
  return m ? m[1] : null;
}

export function cookieHeader(token, maxAgeSeconds) {
  return `afacs=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export const CLEAR_COOKIE = "afacs=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

export async function createSession(env, request) {
  const token = newToken();
  const tokenHash = await hashToken(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().replace("T", " ").slice(0, 19);

  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, datetime('now'), ?, ?)`
  ).bind(
    tokenHash,
    expires,
    String(request.headers.get("User-Agent") || "").slice(0, 200),
    String(request.headers.get("CF-Connecting-IP") || "").slice(0, 60)
  ).run();

  // Opportunistic cleanup. No cron needed for a table this small.
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now')`).run().catch(() => {});

  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function validSession(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT id, expires_at FROM admin_sessions
      WHERE token_hash = ? AND expires_at > datetime('now')`
  ).bind(await hashToken(token)).first().catch(() => null);
  if (!row) return null;

  // Touch at most once a minute; every admin screen makes several calls
  // and there is no reason to write on all of them.
  await env.DB.prepare(
    `UPDATE admin_sessions SET last_seen_at = datetime('now')
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-1 minute'))`
  ).bind(row.id).run().catch(() => {});

  return row;
}

export async function destroySession(env, request) {
  const token = readCookie(request);
  if (!token) return;
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`)
    .bind(await hashToken(token)).run().catch(() => {});
}

/** Revoke every session except, optionally, the one making the request. */
export async function revokeAll(env, request, { keepCurrent = false } = {}) {
  const token = keepCurrent ? readCookie(request) : null;
  if (token) {
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash != ?`)
      .bind(await hashToken(token)).run();
  } else {
    await env.DB.prepare(`DELETE FROM admin_sessions`).run();
  }
}

export async function listSessions(env, request) {
  const token = readCookie(request);
  const currentHash = token ? await hashToken(token) : "";
  const { results } = await env.DB.prepare(
    `SELECT id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip
       FROM admin_sessions WHERE expires_at > datetime('now')
      ORDER BY last_seen_at DESC`
  ).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    device: describeAgent(r.user_agent),
    ip: r.ip,
    current: r.token_hash === currentHash,
  }));
}

function describeAgent(ua) {
  const s = String(ua || "");
  if (!s) return "Unknown device";
  const os = /iPhone/.test(s) ? "iPhone"
    : /iPad/.test(s) ? "iPad"
    : /Android/.test(s) ? "Android"
    : /Mac OS X/.test(s) ? "Mac"
    : /Windows/.test(s) ? "Windows"
    : "Unknown device";
  const br = /CriOS|Chrome/.test(s) ? "Chrome"
    : /Firefox/.test(s) ? "Firefox"
    : /Safari/.test(s) ? "Safari"
    : "";
  return br ? `${os} · ${br}` : os;
}

/* ------------------------------------------------------------
   Sign-in throttle
   ------------------------------------------------------------ */
export async function loginBlocked(env, ip) {
  if (!ip) return null;
  const row = await env.DB.prepare(
    `SELECT fails, locked_until FROM login_attempts WHERE ip = ?`
  ).bind(ip).first().catch(() => null);
  if (!row || !row.locked_until) return null;
  const until = await env.DB.prepare(
    `SELECT locked_until > datetime('now') AS still FROM login_attempts WHERE ip = ?`
  ).bind(ip).first().catch(() => null);
  return until && until.still ? row.locked_until : null;
}

export async function noteFailure(env, ip) {
  if (!ip) return;
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, fails, first_fail_at) VALUES (?, 1, datetime('now'))
     ON CONFLICT(ip) DO UPDATE SET
       fails = CASE WHEN first_fail_at < datetime('now', ?) THEN 1 ELSE fails + 1 END,
       first_fail_at = CASE WHEN first_fail_at < datetime('now', ?) THEN datetime('now') ELSE first_fail_at END`
  ).bind(ip, `-${FAIL_WINDOW_MINUTES} minutes`, `-${FAIL_WINDOW_MINUTES} minutes`).run().catch(() => {});

  await env.DB.prepare(
    `UPDATE login_attempts SET locked_until = datetime('now', ?)
      WHERE ip = ? AND fails >= ?`
  ).bind(`+${LOCKOUT_MINUTES} minutes`, ip, MAX_FAILS).run().catch(() => {});
}

export async function clearFailures(env, ip) {
  if (!ip) return;
  await env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip).run().catch(() => {});
}

export { SESSION_DAYS, MAX_FAILS, LOCKOUT_MINUTES };
