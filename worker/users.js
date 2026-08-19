/* ============================================================
   Named logins.

   Replaces the single shared password. Each person has their own
   username, their own hash and their own sessions, so access can be
   given and taken back one person at a time, and the audit trail can
   name who did a thing rather than reporting that somebody did.

   Bootstrapping: until the first user exists, the old single-password
   check still works and is treated as the owner. That is what lets an
   existing installation upgrade without locking itself out, and it
   stops working the moment a real user is created.
   ============================================================ */

import { hashPassword, verifyPassword } from "./backoffice.js";
import { audit } from "./audit.js";

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,30}$/i;
export const ROLES = ["owner", "driver"];

export async function anyUsers(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM admin_users WHERE active = 1`)
    .first().catch(() => null);
  return Boolean(row && row.n > 0);
}

export async function findUser(env, username) {
  if (!username) return null;
  return await env.DB.prepare(
    `SELECT * FROM admin_users WHERE username = ? AND active = 1`
  ).bind(String(username).trim()).first().catch(() => null);
}

export async function getUserById(env, id) {
  if (!id) return null;
  return await env.DB.prepare(`SELECT * FROM admin_users WHERE id = ? AND active = 1`)
    .bind(id).first().catch(() => null);
}

/** Returns the user row on success, or null. */
export async function authenticate(env, username, password) {
  const user = await findUser(env, username);
  if (!user) return null;
  if (!(await verifyPassword(password, user.password_hash))) return null;
  await env.DB.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(user.id).run().catch(() => {});
  return user;
}

export async function listUsers(env, cors) {
  const { results } = await env.DB.prepare(
    `SELECT id, username, name, role, active, created_at, last_login_at
       FROM admin_users ORDER BY active DESC, username`
  ).all().catch(() => ({ results: [] }));
  return json({ users: results || [] }, 200, cors);
}

export async function createUser(request, env, cors, actor) {
  const d = await request.json().catch(() => ({}));
  const username = String(d.username || "").trim().toLowerCase();
  const password = String(d.password || "");
  const role = ROLES.includes(d.role) ? d.role : "driver";

  if (!USERNAME.test(username)) {
    return json({ error: "Usernames are letters, numbers, dots, dashes or underscores." }, 422, cors);
  }
  if (password.length < 10) {
    return json({ error: "Use at least 10 characters." }, 422, cors);
  }

  const clash = await env.DB.prepare(`SELECT id FROM admin_users WHERE username = ?`)
    .bind(username).first().catch(() => null);
  if (clash) return json({ error: "That username is taken." }, 409, cors);

  const ins = await env.DB.prepare(
    `INSERT INTO admin_users (username, name, role, password_hash) VALUES (?,?,?,?)`
  ).bind(username, d.name ? String(d.name).slice(0, 80) : null, role, await hashPassword(password)).run();

  await audit(env, request, {
    action: "user.create", entity: "user", entityId: ins.meta.last_row_id,
    summary: `Created the ${role} login "${username}"`,
  });
  return json({ ok: true, id: ins.meta.last_row_id }, 200, cors);
}

export async function updateUser(request, env, cors, id, actor) {
  const target = await env.DB.prepare(`SELECT * FROM admin_users WHERE id = ?`).bind(id).first();
  if (!target) return json({ error: "Not found" }, 404, cors);
  const d = await request.json().catch(() => ({}));

  const sets = [], vals = [], said = [];
  if ("name" in d) { sets.push("name = ?"); vals.push(d.name ? String(d.name).slice(0, 80) : null); said.push("name"); }
  if ("role" in d && ROLES.includes(d.role)) { sets.push("role = ?"); vals.push(d.role); said.push(`role ${d.role}`); }
  if ("password" in d) {
    if (String(d.password).length < 10) return json({ error: "Use at least 10 characters." }, 422, cors);
    sets.push("password_hash = ?"); vals.push(await hashPassword(String(d.password))); said.push("password");
  }
  if ("active" in d) {
    // The last owner cannot switch off the lights on the way out.
    if (!d.active && target.role === "owner") {
      const others = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND active = 1 AND id != ?`
      ).bind(id).first().catch(() => null);
      if (!others || others.n === 0) {
        return json({ error: "That is the only owner left. Make someone else an owner first." }, 409, cors);
      }
    }
    sets.push("active = ?"); vals.push(d.active ? 1 : 0); said.push(d.active ? "reactivated" : "deactivated");
  }
  if (!sets.length) return json({ error: "Nothing to update" }, 400, cors);

  vals.push(id);
  await env.DB.prepare(`UPDATE admin_users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();

  // Turning someone off, or changing their password, has to end their
  // sessions — otherwise the login is revoked and the open laptop is not.
  if (("active" in d && !d.active) || "password" in d) {
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id = ?`).bind(id).run().catch(() => {});
  }

  await audit(env, request, {
    action: "user.update", entity: "user", entityId: id,
    summary: `Updated "${target.username}": ${said.join(", ")}`,
  });
  return json({ ok: true }, 200, cors);
}

/** Anyone may change their OWN password; only an owner may change someone else's. */
export async function changeOwnPassword(request, env, cors, user) {
  const d = await request.json().catch(() => ({}));
  const current = String(d.current || "");
  const next = String(d.next || "");

  if (!(await verifyPassword(current, user.password_hash))) {
    return json({ error: "That is not the current password." }, 401, cors);
  }
  if (next.length < 10) return json({ error: "Use at least 10 characters." }, 422, cors);
  if (next === current) return json({ error: "That is the password you already have." }, 422, cors);

  await env.DB.prepare(`UPDATE admin_users SET password_hash = ? WHERE id = ?`)
    .bind(await hashPassword(next), user.id).run();

  // Every other device belonging to THIS user, not everybody's.
  const keep = request.headers.get("Cookie") || "";
  const m = keep.match(/(?:^|;\s*)afacs=([a-f0-9]{16,128})/);
  if (m) {
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1])))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?`)
      .bind(user.id, hex).run().catch(() => {});
  }

  await audit(env, request, {
    action: "auth.password_change", entity: "user", entityId: user.id,
    summary: `${user.username} changed their password; their other devices were signed out`,
  });
  return json({ ok: true }, 200, cors);
}
