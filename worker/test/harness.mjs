/* D1-compatible shim over node:sqlite + an Authorize.net fetch stub.
   Lets the real worker code run unmodified against a real SQLite database. */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const WORKER = new URL("..", import.meta.url).pathname;

/* ---------- D1 shim ---------- */
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    // D1 returns PROMISES from run/first/all. The shim must too, or code
    // that chains .then() works in tests and breaks in production.
    const make = (args) => ({
      async run() {
        const r = db.prepare(sql).run(...args);
        return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
      async first() {
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
    });
    const base = make([]);
    base.bind = (...args) => make(args);
    return base;
  }
}

export function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(`${WORKER}/schema.sql`, "utf8"));
  db.exec(readFileSync(`${WORKER}/migrations/002_booking_engine.sql`, "utf8"));
  db.exec(readFileSync(`${WORKER}/migrations/003_matt_rates_and_tips.sql`, "utf8"));
  db.exec(readFileSync(`${WORKER}/migrations/004_tip_options.sql`, "utf8"));
  db.exec(readFileSync(`${WORKER}/migrations/005_invoices_and_payment_links.sql`, "utf8"));
  db.exec(readFileSync(`${WORKER}/migrations/006_real_sessions.sql`, "utf8"));
  return { db, DB: new D1(db) };
}

/* ---------- Authorize.net stub ----------
   Responses are emitted WITH a real UTF-8 BOM so the parser's BOM
   handling is exercised on every single call, exactly as production does. */
const BOM = "﻿";

export const anet = {
  calls: [],
  nextProfile: null,     // override the createCustomerProfile response
  nextCharge: null,      // override the createTransaction response
  reset() { this.calls = []; this.nextProfile = null; this.nextCharge = null; },
};

function bomJson(obj) {
  return new Response(BOM + JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function installFetchStub() {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);

    if (u.includes("authorize.net")) {
      const body = JSON.parse(opts.body);
      const kind = Object.keys(body)[0];
      anet.calls.push({ kind, body: body[kind] });

      if (kind === "authenticateTestRequest") {
        return bomJson({ messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] } });
      }
      if (kind === "createCustomerProfileRequest") {
        if (anet.nextProfile) { const r = anet.nextProfile; anet.nextProfile = null; return bomJson(r); }
        return bomJson({
          customerProfileId: "9100" + anet.calls.length,
          customerPaymentProfileIdList: ["7200" + anet.calls.length],
          messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
        });
      }
      if (kind === "createCustomerPaymentProfileRequest") {
        return bomJson({
          customerPaymentProfileId: "7300" + anet.calls.length,
          messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
        });
      }
      if (kind === "getCustomerPaymentProfileRequest") {
        return bomJson({
          paymentProfile: { payment: { creditCard: { cardType: "Visa", cardNumber: "XXXX1111", expirationDate: "XXXX" } } },
          messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
        });
      }
      if (kind === "createTransactionRequest") {
        if (anet.nextCharge) { const r = anet.nextCharge; anet.nextCharge = null; return bomJson(r); }
        return bomJson({
          transactionResponse: {
            responseCode: "1", authCode: "ABC123", transId: "6001" + anet.calls.length,
            messages: [{ code: "1", description: "This transaction has been approved." }],
          },
          messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
        });
      }
      return bomJson({ messages: { resultCode: "Error", message: [{ code: "E00001", text: "unknown" }] } });
    }

    // Resend / Twilio / Mapbox: pretend success, record nothing.
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

/* Canned Authorize.net responses for failure-path tests. */
export const RESPONSES = {
  declined: {
    transactionResponse: {
      responseCode: "2", transId: "0",
      errors: [{ errorCode: "2", errorText: "This transaction has been declined." }],
    },
    // NOTE: resultCode is "Ok" even though the card was declined.
    messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
  },
  duplicateProfile: {
    messages: {
      resultCode: "Error",
      message: [{ code: "E00039", text: "A duplicate record with ID 55512345 already exists." }],
    },
  },
  expiredCard: {
    messages: {
      resultCode: "Error",
      message: [{ code: "E00027", text: "The credit card has expired." }],
    },
  },
  heldForReview: {
    transactionResponse: { responseCode: "4", transId: "6009999" },
    messages: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
  },
};

/* ---------- env ---------- */
export function makeEnv(DB) {
  return {
    DB,
    ANET_API_LOGIN_ID: "testlogin",
    ANET_TRANSACTION_KEY: "testkey",
    ANET_ENV: "production",
    ANET_PUBLIC_CLIENT_KEY: "testclientkey",
    RESEND_API_KEY: "",          // email disabled -> send() short-circuits
    TO_EMAIL: "owner@example.com",
    FROM_EMAIL: "test@example.com",
    SITE_URL: "https://example.com",
  };
}

export function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
}

export function req(body, headers = {}) {
  return new Request("https://x/api/book", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/* ---------- assertions ---------- */
export const T = { pass: 0, fail: 0, failures: [] };

export function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { T.pass++; console.log(`  ok   ${name}`); }
  else {
    T.fail++; T.failures.push(name);
    console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}
export function ok(name, cond, detail = "") {
  if (cond) { T.pass++; console.log(`  ok   ${name}`); }
  else { T.fail++; T.failures.push(name); console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
export function section(t) { console.log(`\n${t}`); }
