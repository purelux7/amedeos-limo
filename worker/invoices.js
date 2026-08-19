/* ============================================================
   Invoicing, payment links, and the calendar feed.

   The booking form already takes money for rides it created. This
   file covers everything else: work agreed on the phone, corporate
   accounts, wedding days, standing weekly runs, no-show fees.

   An invoice carries its own secret pay link. The customer opens it,
   types a card into Authorize.net's own Accept.js iframe-less
   tokenizer, and this Worker charges the resulting one-time token.
   No card number ever touches this code, this database, or Matt's
   phone — the same SAQ A-EP posture the booking form already has.
   ============================================================ */

import { manageToken, money } from "./engine.js";
import {
  anetConfigured,
  createProfileFromNonce,
  chargeProfile,
  addPaymentProfile,
  describeCard,
} from "./authnet.js";
import { send, siteUrl, esc } from "./notify.js";
import { audit } from "./audit.js";

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------------------
   Invoice numbers.

   Sequence lives in settings, not in max(id): a voided invoice must
   not have its number reused, and Matt may start the run at a number
   that matches paper invoices he has already handed out.
   ------------------------------------------------------------ */
async function nextInvoiceNumber(env) {
  const prefix =
    (await env.DB.prepare(`SELECT value FROM settings WHERE key = 'invoice_prefix'`).first())?.value || "AM";
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'invoice_seq'`).first();
  const next = (Number(row && row.value) || 0) + 1;
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('invoice_seq', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(String(next)).run();
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(next).padStart(4, "0")}`;
}

async function loadInvoice(env, id) {
  const inv = await env.DB.prepare(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = ?`
  ).bind(id).first();
  if (!inv) return null;
  const { results } = await env.DB.prepare(
    `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id`
  ).bind(id).all();
  inv.items = results || [];
  return inv;
}

async function loadInvoiceByToken(env, token) {
  const row = await env.DB.prepare(
    `SELECT id FROM invoices WHERE pay_token = ?`
  ).bind(token).first();
  return row ? await loadInvoice(env, row.id) : null;
}

/* Recompute totals from the stored line items. The client sends line
   items; it does NOT send a total. A total the browser can choose is a
   total anyone can choose. */
async function retotal(env, id) {
  const { results } = await env.DB.prepare(
    `SELECT amount FROM invoice_items WHERE invoice_id = ?`
  ).bind(id).all();
  const subtotal = round2((results || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const inv = await env.DB.prepare(`SELECT tip FROM invoices WHERE id = ?`).bind(id).first();
  const tip = round2(inv && inv.tip);
  const total = round2(subtotal + tip);
  await env.DB.prepare(
    `UPDATE invoices SET subtotal = ?, total = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(subtotal, total, id).run();
  return { subtotal, tip, total };
}

async function writeItems(env, id, items) {
  await env.DB.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).bind(id).run();
  const rows = (Array.isArray(items) ? items : []).filter((it) => String(it.label || "").trim() !== "");
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    const qty = Number(it.qty) || 1;
    const unit = round2(it.unitPrice);
    await env.DB.prepare(
      `INSERT INTO invoice_items (invoice_id, label, qty, unit_price, amount, sort_order)
       VALUES (?,?,?,?,?,?)`
    ).bind(id, String(it.label).slice(0, 200), qty, unit, round2(qty * unit), i).run();
  }
}

async function logMessage(env, fields) {
  try {
    await env.DB.prepare(
      `INSERT INTO message_log (invoice_id, booking_id, customer_id, channel, to_addr, subject, body, status, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      fields.invoiceId || null, fields.bookingId || null, fields.customerId || null,
      fields.channel, fields.to || "", fields.subject || "", fields.body || "",
      fields.status || "sent", fields.detail || ""
    ).run();
  } catch (e) {
    console.log("message_log write failed:", e && e.message);
  }
}

/* The pay page is served BY THIS WORKER, so the link must point at the
   Worker's own host — not at SITE_URL, which is the GitHub Pages site
   and has no /pay route. PAY_BASE lets that be overridden without a
   code change if the page ever moves. */
function payUrl(env, token) {
  const base = (env.PAY_BASE || "https://api.allfloridaairportscarservice.com").replace(/\/$/, "");
  return `${base}/pay/${token}`;
}

/* An invoice is only reachable once it has a token. Draft invoices get
   one lazily, the first time a link is actually needed. */
async function ensureToken(env, inv) {
  if (inv.pay_token) return inv.pay_token;
  const token = manageToken();
  await env.DB.prepare(`UPDATE invoices SET pay_token = ? WHERE id = ?`).bind(token, inv.id).run();
  inv.pay_token = token;
  return token;
}

/* ============================================================
   ADMIN ENDPOINTS
   ============================================================ */

export async function listInvoices(env, cors, url) {
  const status = url.searchParams.get("status");
  const where = status && status !== "all" ? `WHERE i.status = ?` : "";
  const stmt = env.DB.prepare(
    `SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 300`
  );
  const { results } = await (status && status !== "all" ? stmt.bind(status) : stmt).all();
  return json({ invoices: results || [] }, 200, cors);
}

export async function getInvoice(env, cors, id) {
  const inv = await loadInvoice(env, id);
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (inv.pay_token) inv.pay_url = payUrl(env, inv.pay_token);
  return json({ invoice: inv }, 200, cors);
}

export async function createInvoice(request, env, cors) {
  const d = await request.json().catch(() => ({}));

  let customerId = d.customerId ? Number(d.customerId) : null;
  // A name and one of email/phone is enough to bill someone who has never
  // booked online.
  //
  // This MUST go through upsertCustomer rather than matching on its own.
  // An earlier version here looked up by email and only fell back to phone
  // when no email was given — so invoicing a repeat rider from a second
  // email address hit the UNIQUE(phone) constraint and 500'd. upsertCustomer
  // matches on either column and merges, which is the behaviour the booking
  // form has always had.
  if (!customerId && d.name) {
    const e = d.email ? String(d.email).trim().toLowerCase() : null;
    const ph = d.phone ? String(d.phone).trim() : null;

    // Match on EITHER column — matching on email alone and inserting
    // blind violates UNIQUE(phone) the moment a repeat rider is billed
    // from a second address.
    const existing = (e || ph)
      ? await env.DB.prepare(
          `SELECT id, name, email, phone FROM customers
            WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?)
            LIMIT 1`
        ).bind(e, ph).first()
      : null;

    if (existing) {
      // Deliberately NOT upsertCustomer. That helper overwrites name and
      // email, which is right for the booking form — the customer is
      // typing their own details — and wrong here, where Matt typing a
      // half-remembered name into an invoice would rename a real client
      // and replace their address. Only genuinely empty fields are filled.
      customerId = existing.id;
      const sets = [], vals = [];
      if (!existing.email && e) { sets.push("email = ?"); vals.push(e); }
      if (!existing.phone && ph) { sets.push("phone = ?"); vals.push(ph); }
      if (sets.length) {
        vals.push(customerId);
        await env.DB.prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
      }
    } else {
      const ins = await env.DB.prepare(
        `INSERT INTO customers (name, email, phone) VALUES (?,?,?)`
      ).bind(String(d.name).slice(0, 120), e, ph).run();
      customerId = ins.meta.last_row_id;
    }
  }
  if (!customerId) return json({ error: "Who is this invoice for?" }, 422, cors);

  const number = await nextInvoiceNumber(env);
  const ins = await env.DB.prepare(
    `INSERT INTO invoices (number, customer_id, booking_id, status, tip, due_date, notes, private_note, pay_token)
     VALUES (?,?,?,'draft',?,?,?,?,?)`
  ).bind(
    number, customerId, d.bookingId || null, round2(d.tip),
    d.dueDate || null, d.notes || null, d.privateNote || null, manageToken()
  ).run();

  const id = ins.meta.last_row_id;
  await writeItems(env, id, d.items);
  const totals = await retotal(env, id);
  await audit(env, request, {
    action: "invoice.create", entity: "invoice", entityId: id,
    summary: `Created invoice ${number} for $${money(totals.total)}`,
  });
  return await getInvoice(env, cors, id);
}

export async function updateInvoice(request, env, cors, id) {
  const inv = await loadInvoice(env, id);
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (inv.status === "paid") {
    return json({ error: "This invoice is paid. Issue a new one rather than editing it." }, 409, cors);
  }
  const d = await request.json().catch(() => ({}));

  const sets = [], vals = [];
  if ("tip" in d) { sets.push("tip = ?"); vals.push(round2(d.tip)); }
  if ("dueDate" in d) { sets.push("due_date = ?"); vals.push(d.dueDate || null); }
  if ("notes" in d) { sets.push("notes = ?"); vals.push(d.notes || null); }
  if ("privateNote" in d) { sets.push("private_note = ?"); vals.push(d.privateNote || null); }
  if ("status" in d && ["draft", "sent", "void"].includes(d.status)) {
    sets.push("status = ?"); vals.push(d.status);
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    await env.DB.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }
  if (Array.isArray(d.items)) await writeItems(env, id, d.items);
  await retotal(env, id);
  return await getInvoice(env, cors, id);
}

/* ------------------------------------------------------------
   Send the link by email.
   ------------------------------------------------------------ */
export async function sendInvoiceEmail(env, cors, id) {
  const inv = await loadInvoice(env, id);
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (!inv.customer_email) {
    return json({ error: "That customer has no email address on file. Text it instead." }, 422, cors);
  }
  if (round2(inv.total) <= 0) {
    return json({ error: "Add at least one line item before sending." }, 422, cors);
  }

  const token = await ensureToken(env, inv);
  const url = payUrl(env, token);
  const rows = inv.items
    .map(
      (it) =>
        `<tr><td style="padding:9px 0;border-bottom:1px solid #e6e8ec">${esc(it.label)}${
          it.qty > 1 ? ` <span style="color:#8a929d">× ${it.qty}</span>` : ""
        }</td><td align="right" style="padding:9px 0;border-bottom:1px solid #e6e8ec;white-space:nowrap">$${money(it.amount)}</td></tr>`
    )
    .join("");

  const html = `
    <div style="font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#14171c;max-width:560px;margin:0 auto">
      <p style="letter-spacing:.24em;text-transform:uppercase;font-size:11px;color:#8a6d2f;margin:0 0 6px">Amedeo's Private Car Service</p>
      <h1 style="font-size:22px;margin:0 0 4px;font-weight:600">Invoice ${esc(inv.number)}</h1>
      <p style="color:#5b6470;margin:0 0 22px">Hello ${esc((inv.customer_name || "").split(" ")[0] || "there")} — here is your invoice.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">${rows}
        ${inv.tip > 0 ? `<tr><td style="padding:9px 0;color:#5b6470">Gratuity</td><td align="right" style="padding:9px 0">$${money(inv.tip)}</td></tr>` : ""}
        <tr><td style="padding:14px 0;font-weight:700">Total due</td><td align="right" style="padding:14px 0;font-weight:700;font-size:18px">$${money(inv.total)}</td></tr>
      </table>
      <p style="margin:26px 0">
        <a href="${url}" style="display:inline-block;background:#8a6d2f;color:#fff;text-decoration:none;padding:15px 30px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Pay this invoice</a>
      </p>
      ${inv.notes ? `<p style="color:#5b6470;font-size:14px">${esc(inv.notes)}</p>` : ""}
      <p style="color:#8a929d;font-size:12px;margin-top:26px">Questions? Call 848-667-0999.</p>
    </div>`;

  const text = `Invoice ${inv.number} — $${money(inv.total)} due.\nPay securely: ${url}\n\nAmedeo's Private Car Service · 848-667-0999`;

  const res = await send(env, {
    to: inv.customer_email,
    subject: `Invoice ${inv.number} from Amedeo's — $${money(inv.total)}`,
    html,
    text,
  });

  await logMessage(env, {
    invoiceId: id, customerId: inv.customer_id, channel: "email",
    to: inv.customer_email, subject: `Invoice ${inv.number}`, body: text,
    status: res && res.ok === false ? "failed" : "sent",
    detail: res && res.error ? String(res.error) : "",
  });

  if (res && res.ok === false) {
    return json({ error: "The email did not go out. Text the link instead." }, 502, cors);
  }
  if (inv.status === "draft") {
    await env.DB.prepare(
      `UPDATE invoices SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
  }
  return json({ ok: true, url }, 200, cors);
}

/* ------------------------------------------------------------
   Send the link by text.

   Amedeo's has no SMS account of its own yet, and PureLux Bio's
   must not be borrowed — that would bill Matt's texts to an
   unrelated company and send them from an unrelated number. So
   there are two paths, and the caller is told which one ran:

     sent    — Twilio is configured for THIS business; it went out.
     handoff — no Twilio; the admin gets an sms: URL that opens
               Matt's own Messages app with the text pre-written.

   The handoff is not a stub. It is a working way to text a payment
   link on day one, from the number customers already know.
   ------------------------------------------------------------ */
export async function sendInvoiceSms(env, cors, id) {
  const inv = await loadInvoice(env, id);
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (!inv.customer_phone) {
    return json({ error: "That customer has no phone number on file." }, 422, cors);
  }
  if (round2(inv.total) <= 0) {
    return json({ error: "Add at least one line item before sending." }, 422, cors);
  }

  const token = await ensureToken(env, inv);
  const url = payUrl(env, token);
  const body = `Amedeo's Private Car Service — invoice ${inv.number}, $${money(inv.total)}. Pay securely: ${url}`;
  // E.164 or Twilio rejects it, and the sms: handoff is more reliable
  // with a country code too.
  let to = String(inv.customer_phone).replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(to)) to = "+1" + to;
  else if (/^1\d{10}$/.test(to)) to = "+" + to;

  const user = env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID;
  const pass = env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN;
  const twilioReady = Boolean(env.TWILIO_ACCOUNT_SID && user && pass && env.TWILIO_FROM);

  if (twilioReady) {
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + btoa(`${user}:${pass}`),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }),
        }
      );
      const ok = res.ok;
      await logMessage(env, {
        invoiceId: id, customerId: inv.customer_id, channel: "sms", to, body,
        status: ok ? "sent" : "failed", detail: ok ? "" : await res.text(),
      });
      if (!ok) return json({ error: "The text did not go out." }, 502, cors);
      if (inv.status === "draft") {
        await env.DB.prepare(
          `UPDATE invoices SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
        ).bind(id).run();
      }
      return json({ ok: true, mode: "sent", url }, 200, cors);
    } catch (e) {
      return json({ error: "The text did not go out." }, 502, cors);
    }
  }

  await logMessage(env, {
    invoiceId: id, customerId: inv.customer_id, channel: "sms-handoff",
    to, body, status: "handoff", detail: "No Twilio account for this business yet",
  });
  if (inv.status === "draft") {
    await env.DB.prepare(
      `UPDATE invoices SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
    ).bind(id).run();
  }
  return json(
    // "?&body=" is the one separator both iOS and Android Messages accept:
    // iOS wants &, Android wants ?, and this satisfies each of them.
    { ok: true, mode: "handoff", url, smsHref: `sms:${to}?&body=${encodeURIComponent(body)}`, body, to },
    200,
    cors
  );
}

export async function voidInvoice(env, cors, id, request) {
  const inv = await loadInvoice(env, id);
  if (!inv) return json({ error: "Not found" }, 404, cors);
  if (inv.status === "paid") {
    return json({ error: "Paid invoices cannot be voided. Refund it from the Merchant Interface." }, 409, cors);
  }
  await env.DB.prepare(
    `UPDATE invoices SET status = 'void', pay_token = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  await audit(env, request, {
    action: "invoice.void", entity: "invoice", entityId: id,
    summary: `Voided invoice ${inv.number} ($${money(inv.total)}); its pay link is now dead`,
  });
  return json({ ok: true }, 200, cors);
}

/* ============================================================
   CALENDAR
   Bookings and time off for one month, in the shape the admin
   calendar grid wants. Reads the block window, not just the ride
   time, so a 5am Orlando run correctly shows as occupying most
   of the morning.
   ============================================================ */
export async function calendarFeed(env, cors, url) {
  const month = url.searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return json({ error: "month must be YYYY-MM" }, 422, cors);
  }
  const first = `${month}-01`;
  const last = `${month}-31`;

  const { results: bookings } = await env.DB.prepare(
    `SELECT b.id, b.ride_date, b.ride_time, b.dest_code, b.pickup, b.dropoff, b.status,
            b.payment_status, b.quoted_total, b.hours_engaged, b.passengers,
            c.name AS customer_name, c.phone AS customer_phone
       FROM bookings b LEFT JOIN customers c ON c.id = b.customer_id
      WHERE b.ride_date BETWEEN ? AND ?
        AND b.status != 'canceled'
      ORDER BY b.ride_date, b.ride_time`
  ).bind(first, last).all();

  let blackouts = [];
  try {
    const r = await env.DB.prepare(
      `SELECT * FROM blackouts WHERE date(start_utc/1000, 'unixepoch') <= ?
          AND date(end_utc/1000, 'unixepoch') >= ?`
    ).bind(last, first).all();
    blackouts = r.results || [];
  } catch (e) {
    // blackouts table shape varies by migration; the calendar still works.
    blackouts = [];
  }

  const { results: invoices } = await env.DB.prepare(
    `SELECT i.id, i.number, i.total, i.status, i.due_date, c.name AS customer_name
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.due_date BETWEEN ? AND ? AND i.status != 'void'`
  ).bind(first, last).all();

  return json({ month, bookings: bookings || [], blackouts, invoices: invoices || [] }, 200, cors);
}

/* ============================================================
   PUBLIC PAY LINK
   ============================================================ */

export async function payInfo(env, cors, token) {
  const inv = await loadInvoiceByToken(env, token);
  if (!inv) return json({ error: "This payment link is no longer valid." }, 404, cors);
  return json(
    {
      invoice: {
        number: inv.number,
        status: inv.status,
        customerName: inv.customer_name,
        items: inv.items.map((i) => ({ label: i.label, qty: i.qty, amount: i.amount })),
        subtotal: inv.subtotal,
        tip: inv.tip,
        total: inv.total,
        notes: inv.notes,
        paidAt: inv.paid_at,
        cardLast4: inv.card_last4,
      },
      payments: {
        enabled: anetConfigured(env) && Boolean(env.ANET_PUBLIC_CLIENT_KEY),
        apiLoginId: env.ANET_API_LOGIN_ID || "",
        clientKey: env.ANET_PUBLIC_CLIENT_KEY || "",
        mode: env.ANET_ENV === "production" ? "production" : "sandbox",
      },
    },
    200,
    cors
  );
}

export async function payCharge(request, env, cors, token) {
  const inv = await loadInvoiceByToken(env, token);
  if (!inv) return json({ error: "This payment link is no longer valid." }, 404, cors);
  if (inv.status === "paid") return json({ error: "This invoice is already paid." }, 409, cors);
  if (inv.status === "void") return json({ error: "This invoice was cancelled." }, 409, cors);
  if (round2(inv.total) <= 0) return json({ error: "Nothing to pay." }, 409, cors);
  if (!anetConfigured(env)) return json({ error: "Card payments are unavailable right now." }, 503, cors);

  const d = await request.json().catch(() => ({}));
  const opaque = d.opaqueData;
  if (!opaque || !opaque.dataDescriptor || !opaque.dataValue) {
    return json({ error: "Please re-enter the card details." }, 422, cors);
  }

  // The ZIP is not optional. Without it Authorize.net has nothing to check
  // the address against and returns AVS "P" — not applicable — which means
  // a stolen card number sails through a link anyone can open. The booking
  // form has always required it; this path must too, and must enforce it
  // server-side because the browser check is trivially bypassed.
  const zip = String(d.zip || "").trim();
  if (!/^\d{5}(-?\d{4})?$/.test(zip)) {
    return json({ error: "Enter the billing ZIP for this card." }, 422, cors);
  }

  // Names go on the merchant record, so keep them to something that reads
  // like a name — an admin placeholder in the customer row must not end up
  // stamped on an Authorize.net transaction.
  const nameParts = String(inv.customer_name || "").trim().split(/\s+/);
  const looksLikeName = nameParts.length > 0 && String(inv.customer_name || "").length <= 60;
  const billTo = {
    firstName: String(d.firstName || (looksLikeName && nameParts[0]) || "Customer").slice(0, 50),
    lastName: String(d.lastName || (looksLikeName && nameParts.slice(1).join(" ")) || "Rider").slice(0, 50),
    zip: zip.slice(0, 20),
  };

  try {
    const customer = await env.DB.prepare(
      `SELECT anet_customer_profile_id FROM customers WHERE id = ?`
    ).bind(inv.customer_id).first();

    let profileId = customer && customer.anet_customer_profile_id;
    let paymentProfileId;

    if (profileId) {
      paymentProfileId = await addPaymentProfile(env, { customerProfileId: profileId, opaque, billTo });
    } else {
      try {
        const created = await createProfileFromNonce(env, {
          customerId: inv.customer_id,
          email: inv.customer_email,
          description: inv.customer_name,
          opaque,
          billTo,
        });
        profileId = created.customerProfileId;
        paymentProfileId = created.paymentProfileId;
      } catch (e) {
        if (e.duplicateProfileId) {
          profileId = e.duplicateProfileId;
          paymentProfileId = await addPaymentProfile(env, { customerProfileId: profileId, opaque, billTo });
        } else {
          throw e;
        }
      }
      await env.DB.prepare(`UPDATE customers SET anet_customer_profile_id = ? WHERE id = ?`)
        .bind(profileId, inv.customer_id).run();
    }

    // Cardholder-initiated: they are sitting on the page submitting it.
    const paid = await chargeProfile(env, {
      customerProfileId: profileId,
      paymentProfileId,
      amount: inv.total,
      invoiceNumber: String(inv.number || inv.id).slice(0, 20),
      description: `Amedeo's invoice ${inv.number}`.slice(0, 255),
    });

    if (!paid.ok) {
      return json(
        {
          error: paid.declined
            ? "That card was declined. Please try another card."
            : "We couldn't complete the payment. Please try again or call 848-667-0999.",
        },
        402,
        cors
      );
    }

    let last4 = "";
    try {
      const card = await describeCard(env, { customerProfileId: profileId, paymentProfileId });
      last4 = (card && card.last4) || "";
    } catch (e) { /* cosmetic only */ }

    await env.DB.prepare(
      `UPDATE invoices
          SET status = 'paid', amount_paid = ?, trans_id = ?, card_last4 = ?,
              paid_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`
    ).bind(inv.total, paid.transId || "", last4, inv.id).run();

    // Receipt, best effort — a failed receipt must never look like a
    // failed payment to someone whose card was just charged.
    //
    // But it must not vanish silently either: a customer who pays and gets
    // nothing reasonably concludes the payment failed. Every outcome,
    // including "there was no address to send to", lands in message_log so
    // the admin can see why no receipt went out.
    if (!inv.customer_email) {
      await logMessage(env, {
        invoiceId: inv.id, customerId: inv.customer_id, channel: "email",
        subject: `Receipt ${inv.number}`, status: "failed",
        detail: "Paid, but no email address on file — no receipt was sent.",
      });
    }
    if (inv.customer_email) {
      try {
        await send(env, {
          to: inv.customer_email,
          subject: `Payment received — invoice ${inv.number}`,
          html: `<div style="font-family:-apple-system,system-ui,sans-serif;color:#14171c">
                   <p style="letter-spacing:.24em;text-transform:uppercase;font-size:11px;color:#8a6d2f">Amedeo's Private Car Service</p>
                   <h1 style="font-weight:600;font-size:20px">Thank you — payment received</h1>
                   <p>Invoice ${esc(inv.number)} · <strong>$${money(inv.total)}</strong>${last4 ? ` · card ending ${esc(last4)}` : ""}</p>
                   <p style="color:#5b6470;font-size:13px">Keep this email as your receipt.</p>
                 </div>`,
          text: `Payment received. Invoice ${inv.number} — $${money(inv.total)}.`,
        });
        await logMessage(env, {
          invoiceId: inv.id, customerId: inv.customer_id, channel: "email",
          to: inv.customer_email, subject: `Receipt ${inv.number}`, status: "sent",
        });
      } catch (e) {
        await logMessage(env, {
          invoiceId: inv.id, customerId: inv.customer_id, channel: "email",
          to: inv.customer_email, subject: `Receipt ${inv.number}`,
          status: "failed", detail: String((e && e.message) || e).slice(0, 300),
        });
      }
    }

    return json({ ok: true, transId: paid.transId, last4, total: inv.total }, 200, cors);
  } catch (e) {
    console.log("invoice charge failed:", e && e.message);
    return json({ error: "We couldn't complete the payment. Please call 848-667-0999." }, 502, cors);
  }
}

export { loadInvoice, payUrl };
