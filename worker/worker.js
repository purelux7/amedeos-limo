/* ============================================================
   Amadeo's Private Car Service — reservation form handler
   Cloudflare Worker. Receives the booking form POST and sends
   an email via Resend. Secrets/vars:
     RESEND_API_KEY  (secret)  — Resend API key
     TO_EMAIL        (var)     — where reservations are delivered
     FROM_EMAIL      (var)     — verified sender (or onboarding@resend.dev in test mode)
   ============================================================ */

const ALLOWED_ORIGINS = [
  "https://allfloridaairportscarservice.com",
  "https://www.allfloridaairportscarservice.com",
  "https://purelux7.github.io",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    let d;
    try { d = await request.json(); } catch { return json({ error: "Invalid request" }, 400, cors); }

    // Honeypot: real users never fill this hidden field.
    if (d.company) return json({ ok: true }, 200, cors);

    const required = ["pickup", "dropoff", "date", "time", "passengers", "service", "name", "phone", "email"];
    for (const f of required) {
      if (!d[f] || String(d[f]).trim() === "") return json({ error: `Missing field: ${f}` }, 422, cors);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email))) {
      return json({ error: "Invalid email" }, 422, cors);
    }

    const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const row = (label, val) =>
      `<tr><td style="padding:8px 14px;color:#7b8597;font:600 13px Arial,sans-serif;white-space:nowrap">${label}</td>` +
      `<td style="padding:8px 14px;color:#1b2533;font:400 15px Arial,sans-serif">${esc(val) || "—"}</td></tr>`;

    const subject = `New Reservation — ${esc(d.service)} · ${esc(d.name)}`;

    const html = `
      <div style="background:#f4f6f9;padding:28px">
        <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e8ef">
          <div style="background:#0e2340;padding:22px 26px">
            <div style="color:#fff;font:800 20px Arial,sans-serif">New Reservation Request</div>
            <div style="color:#c4a253;font:600 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin-top:4px">Amadeo's Private Car Service</div>
          </div>
          <table style="width:100%;border-collapse:collapse">
            ${row("Service", d.service)}
            ${row("Name", d.name)}
            ${row("Phone", d.phone)}
            ${row("Email", d.email)}
            ${row("Pickup", d.pickup)}
            ${row("Drop off", d.dropoff)}
            ${row("Date", d.date)}
            ${row("Time", d.time)}
            ${row("Passengers", d.passengers)}
            ${row("Notes", d.notes)}
          </table>
          <div style="padding:16px 26px;background:#f4f6f9;color:#7b8597;font:400 12px Arial,sans-serif">
            Reply directly to this email to reach the client.
          </div>
        </div>
      </div>`;

    const text =
      `New Reservation Request — Amadeo's Private Car Service\n\n` +
      `Service:    ${d.service}\nName:       ${d.name}\nPhone:      ${d.phone}\nEmail:      ${d.email}\n` +
      `Pickup:     ${d.pickup}\nDrop off:   ${d.dropoff}\nDate:       ${d.date}\nTime:       ${d.time}\n` +
      `Passengers: ${d.passengers}\nNotes:      ${d.notes || "—"}\n`;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [env.TO_EMAIL],
        reply_to: String(d.email),
        subject,
        html,
        text,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return json({ error: "Email failed to send", detail }, 502, cors);
    }
    return json({ ok: true }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}
