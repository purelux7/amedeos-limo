/* ============================================================
   Audit trail.

   Deliberately dumb: one row, one sentence, written to be read by a
   person six months later who is trying to work out what happened to
   an invoice. Never throws — an audit write must not be able to fail
   the action it is describing.
   ============================================================ */

export async function audit(env, request, { action, entity, entityId, summary, detail }) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (action, entity, entity_id, summary, detail, ip, user_agent)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      String(action).slice(0, 60),
      entity ? String(entity).slice(0, 30) : null,
      entityId != null ? String(entityId).slice(0, 40) : null,
      summary ? String(summary).slice(0, 400) : null,
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
      request ? String(request.headers.get("CF-Connecting-IP") || "").slice(0, 60) : null,
      request ? String(request.headers.get("User-Agent") || "").slice(0, 200) : null
    ).run();
  } catch (e) {
    console.log("audit write failed:", e && e.message);
  }
}

export async function auditList(env, cors, url) {
  const entity = url.searchParams.get("entity");
  const entityId = url.searchParams.get("id");
  const limit = Math.min(300, Number(url.searchParams.get("limit")) || 120);

  let sql = `SELECT * FROM audit_log`;
  const binds = [];
  if (entity && entityId) { sql += ` WHERE entity = ? AND entity_id = ?`; binds.push(entity, String(entityId)); }
  else if (entity) { sql += ` WHERE entity = ?`; binds.push(entity); }
  sql += ` ORDER BY id DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
  return new Response(JSON.stringify({ events: results || [] }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
