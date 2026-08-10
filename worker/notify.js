/* ============================================================
   Outbound email (Resend) + Matt's SMS alert (Twilio, optional).

   Every send is best-effort and NEVER throws into the caller. A
   booking that is paid and on the calendar must not fail because an
   email provider hiccuped — the money and the calendar are the source
   of truth, the email is a courtesy.
   ============================================================ */

const NAVY = "#0e2340";
const GOLD = "#c4a253";

export function esc(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])
  );
}

function row(label, val) {
  return (
    `<tr><td style="padding:8px 14px;color:#7b8597;font:600 13px Arial,sans-serif;white-space:nowrap">${label}</td>` +
    `<td style="padding:8px 14px;color:#1b2533;font:400 15px Arial,sans-serif">${esc(val) || "—"}</td></tr>`
  );
}

function shell(title, bodyHtml, footer) {
  return `
  <div style="background:#f4f6f9;padding:28px">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e8ef">
      <div style="background:${NAVY};padding:24px 26px">
        <div style="color:#fff;font:800 21px Arial,sans-serif">${esc(title)}</div>
        <div style="color:${GOLD};font:600 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin-top:5px">Amedeo's Private Car Service</div>
      </div>
      ${bodyHtml}
      <div style="padding:16px 26px;background:#f4f6f9;color:#7b8597;font:400 12px Arial,sans-serif">
        ${footer || "Amedeo's Private Car Service · Stuart, Florida · 848-667-0999"}
      </div>
    </div>
  </div>`;
}

async function send(env, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, skipped: true };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        reply_to: replyTo,
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      console.log("Resend failed:", res.status, await res.text());
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.log("Resend threw:", e && e.message);
    return { ok: false };
  }
}

function ownerEmails(env) {
  return String(env.TO_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function siteUrl(env) {
  return env.SITE_URL || "https://allfloridaairportscarservice.com";
}

/* ------------------------------------------------------------
   Customer — booking confirmed, card saved, nothing charged yet
   ------------------------------------------------------------ */
export async function sendBookingConfirmed(env, { booking, quote, when, card, manageUrl, chargeWhen }) {
  const first = String(booking.name || "").split(" ")[0] || "there";

  const body = `
    <div style="padding:24px 26px 4px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      Your ride is confirmed, ${esc(first)}. Matt will be there.
    </div>
    <table style="width:100%;border-collapse:collapse;margin:12px 0 2px">
      ${row("Pickup", when.pretty)}
      ${row("From", booking.pickup)}
      ${row("To", booking.dropoff)}
      ${row("Passengers", booking.passengers)}
      ${booking.flight_number ? row("Flight", booking.flight_number) : ""}
    </table>
    <table style="width:100%;border-collapse:collapse;margin:6px 0 2px;border-top:1px solid #e3e8ef">
      ${row("Flat rate", "$" + quote.base.toFixed(2))}
      ${row(`Gratuity (${quote.gratuityPct}%)`, "$" + quote.gratuity.toFixed(2))}
      ${row("Total", "$" + quote.total.toFixed(2))}
      ${card ? row("Card on file", `${card.brand} ending ${card.last4}`) : ""}
    </table>
    <div style="margin:16px 26px;padding:14px 16px;background:#f8f6ef;border-left:3px solid ${GOLD};color:#1b2533;font:400 14px/1.6 Arial,sans-serif">
      <strong>Nothing has been charged yet.</strong> Your card will be charged
      $${quote.total.toFixed(2)} on ${esc(chargeWhen)} — the day before your ride.
      Cancel before then and you are not charged at all.
    </div>
    <div style="padding:4px 26px 22px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      <a href="${esc(manageUrl)}" style="color:${NAVY};font-weight:700">View or cancel this booking</a><br/>
      Questions? Call or text <a href="tel:+18486670999" style="color:${NAVY};font-weight:700;text-decoration:none">848-667-0999</a>.
    </div>`;

  const text =
    `Your ride is confirmed, ${first}.\n\n` +
    `Pickup:  ${when.pretty}\nFrom:    ${booking.pickup}\nTo:      ${booking.dropoff}\n` +
    `Flat rate: $${quote.base.toFixed(2)}\nGratuity (${quote.gratuityPct}%): $${quote.gratuity.toFixed(2)}\n` +
    `Total:   $${quote.total.toFixed(2)}\n\n` +
    `NOTHING HAS BEEN CHARGED YET. Your card will be charged on ${chargeWhen}, the day before your ride.\n` +
    `Cancel before then and you are not charged.\n\n` +
    `Manage: ${manageUrl}\nQuestions: 848-667-0999\n`;

  return send(env, {
    to: booking.email,
    replyTo: ownerEmails(env),
    subject: `Confirmed — ${when.pretty} to ${booking.dropoff}`,
    html: shell("Your ride is confirmed", body, "Tolls and airport parking are billed at cost after the ride."),
    text,
  });
}

/* ------------------------------------------------------------
   Customer — receipt after the T-24h charge
   ------------------------------------------------------------ */
export async function sendReceipt(env, { booking, amount, when, transId, kind }) {
  const isExtras = kind === "extras";
  const title = isExtras ? "Receipt — additional charges" : "Payment received";

  const body = `
    <div style="padding:24px 26px 4px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      ${isExtras
        ? "Thank you for riding with us. Here are the additional charges from your trip."
        : `Your card has been charged for tomorrow's ride.`}
    </div>
    <table style="width:100%;border-collapse:collapse;margin:12px 0 2px">
      ${row("Amount", "$" + Number(amount).toFixed(2))}
      ${row("Pickup", when.pretty)}
      ${row("From", booking.pickup)}
      ${row("To", booking.dropoff)}
      ${isExtras && booking.extras_note ? row("For", booking.extras_note) : ""}
      ${row("Transaction", transId || "—")}
    </table>
    <div style="padding:14px 26px 22px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      Questions about this charge? Call or text
      <a href="tel:+18486670999" style="color:${NAVY};font-weight:700;text-decoration:none">848-667-0999</a>.
    </div>`;

  return send(env, {
    to: booking.email || booking.customer_email,
    replyTo: ownerEmails(env),
    subject: `${title} — $${Number(amount).toFixed(2)}`,
    html: shell(title, body),
    text:
      `${title}\n\nAmount: $${Number(amount).toFixed(2)}\nPickup: ${when.pretty}\n` +
      `From: ${booking.pickup}\nTo: ${booking.dropoff}\nTransaction: ${transId || "—"}\n\n` +
      `Questions? 848-667-0999\n`,
  });
}

/* ------------------------------------------------------------
   Customer — card declined at T-24h, needs action
   ------------------------------------------------------------ */
export async function sendCardProblem(env, { booking, when, amount, manageUrl }) {
  const body = `
    <div style="padding:24px 26px 4px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      We tried to charge your card for tomorrow's ride and it did not go through.
      <strong>Your booking is still held</strong> — we just need a working card.
    </div>
    <table style="width:100%;border-collapse:collapse;margin:12px 0 2px">
      ${row("Pickup", when.pretty)}
      ${row("Amount due", "$" + Number(amount).toFixed(2))}
    </table>
    <div style="padding:14px 26px 22px;color:#1b2533;font:400 15px/1.6 Arial,sans-serif">
      <a href="${esc(manageUrl)}" style="color:${NAVY};font-weight:700">Update your card</a>
      &nbsp;or call Matt directly at
      <a href="tel:+18486670999" style="color:${NAVY};font-weight:700;text-decoration:none">848-667-0999</a>.
    </div>`;

  return send(env, {
    to: booking.email || booking.customer_email,
    replyTo: ownerEmails(env),
    subject: `Action needed — card declined for ${when.pretty}`,
    html: shell("We couldn't process your card", body),
    text:
      `We tried to charge your card for tomorrow's ride and it did not go through.\n` +
      `Your booking is still held.\n\nPickup: ${when.pretty}\nAmount due: $${Number(amount).toFixed(2)}\n\n` +
      `Update your card: ${manageUrl}\nOr call Matt: 848-667-0999\n`,
  });
}

/* ------------------------------------------------------------
   Matt — new booking, and the T-24h "tomorrow's ride" alert
   ------------------------------------------------------------ */
export async function sendOwnerBooking(env, { booking, quote, when, kind }) {
  const isAlert = kind === "alert";
  const title = isAlert ? "Tomorrow's ride" : "New booking";

  const body = `
    <table style="width:100%;border-collapse:collapse;margin:14px 0 2px">
      ${row("Pickup", when.pretty)}
      ${row("Customer", booking.name || booking.customer_name)}
      ${row("Phone", booking.phone || booking.customer_phone)}
      ${row("From", booking.pickup)}
      ${row("To", booking.dropoff)}
      ${row("Passengers", booking.passengers)}
      ${booking.flight_number ? row("Flight", booking.flight_number) : ""}
      ${booking.notes ? row("Notes", booking.notes) : ""}
      ${row("Total", "$" + Number(quote.total).toFixed(2))}
      ${row("Payment", isAlert ? "CHARGED" : "Card on file — charges " + (booking.chargeWhen || "T-24h"))}
    </table>`;

  return send(env, {
    to: ownerEmails(env),
    replyTo: booking.email || booking.customer_email,
    subject: `${title} — ${when.pretty} · ${booking.dropoff}`,
    html: shell(title, body),
    text:
      `${title}\n\n${when.pretty}\n${booking.name || booking.customer_name} · ${booking.phone || booking.customer_phone}\n` +
      `${booking.pickup}\n  -> ${booking.dropoff}\n` +
      `Total: $${Number(quote.total).toFixed(2)}\n`,
  });
}

/* ------------------------------------------------------------
   Matt — SMS. Optional: only fires if Twilio vars are present.
   ------------------------------------------------------------ */
export async function smsOwner(env, message) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM || !env.OWNER_PHONE) {
    return { ok: false, skipped: true };
  }
  try {
    const body = new URLSearchParams({
      To: env.OWNER_PHONE,
      From: env.TWILIO_FROM,
      Body: message.slice(0, 1500),
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }
    );
    if (!res.ok) {
      console.log("Twilio failed:", res.status, await res.text());
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.log("Twilio threw:", e && e.message);
    return { ok: false };
  }
}

export { send, ownerEmails, siteUrl };
