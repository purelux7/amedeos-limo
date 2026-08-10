/* ============================================================
   Authorize.net client (Cloudflare Worker / fetch-based)

   Card numbers NEVER reach this Worker. The browser sends the card
   straight to Authorize.net via Accept.js and gets back a one-time
   nonce ("opaqueData"). We exchange that nonce for a stored profile
   id, and from then on we charge by id. That keeps the site at
   PCI SAQ A-EP instead of full SAQ D.

   Three gotchas this file handles, all of which fail silently otherwise:

   1. BOM. Authorize.net's JSON responses begin with a UTF-8 byte
      order mark, which is illegal in JSON and makes JSON.parse throw.
      We strip it before parsing.

   2. resultCode "Ok" does NOT mean the card was approved. A declined
      card comes back as resultCode Ok with transactionResponse
      .responseCode "2". Both must be checked or declines look like
      successes.

   3. The Accept.js nonce is single-use and expires in 15 minutes —
      and it is consumed even by a FAILED profile creation. It must be
      exchanged immediately and never retried.

   Env:
     ANET_API_LOGIN_ID     secret
     ANET_TRANSACTION_KEY  secret
     ANET_ENV              var — "sandbox" | "production"
   ============================================================ */

const ENDPOINTS = {
  sandbox: "https://apitest.authorize.net/xml/v1/request.api",
  production: "https://api.authorize.net/xml/v1/request.api",
};

export function anetConfigured(env) {
  return Boolean(env.ANET_API_LOGIN_ID && env.ANET_TRANSACTION_KEY);
}

function endpointFor(env) {
  return ENDPOINTS[env.ANET_ENV === "production" ? "production" : "sandbox"];
}

function auth(env) {
  return {
    name: env.ANET_API_LOGIN_ID,
    transactionKey: env.ANET_TRANSACTION_KEY,
  };
}

/* Authorize.net caps refId at 20 characters and rejects longer ones. */
function refId(prefix, id) {
  return `${prefix}${id}`.slice(0, 20);
}

/**
 * POST a request envelope and return parsed JSON.
 * Handles the BOM and non-JSON error bodies.
 */
async function call(env, payload) {
  const res = await fetch(endpointFor(env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  // Strip UTF-8 BOM (EF BB BF -> U+FEFF once decoded) plus any stray whitespace.
  const cleaned = raw.replace(/^﻿/, "").trim();

  if (!cleaned) {
    throw new Error(`Authorize.net returned an empty response (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Authorize.net returned a non-JSON response (HTTP ${res.status}): ${cleaned.slice(0, 300)}`
    );
  }
}

/** Pull the resultCode / first message out of any Authorize.net response. */
function envelope(json) {
  const m = json && json.messages;
  const first = m && Array.isArray(m.message) && m.message[0] ? m.message[0] : {};
  return {
    ok: m && m.resultCode === "Ok",
    code: first.code || "",
    text: first.text || "",
  };
}

/* ------------------------------------------------------------
   Customer profile (the vault)
   ------------------------------------------------------------ */

/**
 * Exchange a one-time Accept.js nonce for a stored customer profile.
 *
 * validationMode "liveMode" makes Authorize.net run a zero-dollar
 * authorization against the card and void it immediately, so a dead
 * card is caught AT BOOKING rather than at T-24h when it is too late
 * to do anything about it.
 *
 * Returns { customerProfileId, paymentProfileId }.
 */
export async function createProfileFromNonce(env, { customerId, email, description, opaque, billTo }) {
  const payload = {
    createCustomerProfileRequest: {
      merchantAuthentication: auth(env),
      refId: refId("cust", customerId),
      profile: {
        // Authorize.net caps merchantCustomerId at 20 chars.
        merchantCustomerId: String(customerId).slice(0, 20),
        description: (description || "Amedeo's customer").slice(0, 255),
        email: email || undefined,
        paymentProfiles: {
          customerType: "individual",
          // FIELD ORDER MATTERS. Authorize.net's JSON API is a facade over
          // an XML schema, so members must appear in schema order or the
          // request is rejected. billTo precedes payment here.
          ...(billTo ? { billTo } : {}),
          payment: {
            opaqueData: {
              dataDescriptor: opaque.dataDescriptor,
              dataValue: opaque.dataValue,
            },
          },
        },
      },
      validationMode: env.ANET_ENV === "production" ? "liveMode" : "testMode",
    },
  };

  const json = await call(env, payload);
  const env_ = envelope(json);

  if (env_.ok) {
    const paymentProfileId =
      (json.customerPaymentProfileIdList && json.customerPaymentProfileIdList[0]) || null;
    if (!json.customerProfileId || !paymentProfileId) {
      throw new Error("Authorize.net accepted the card but returned no profile id");
    }
    return {
      customerProfileId: String(json.customerProfileId),
      paymentProfileId: String(paymentProfileId),
    };
  }

  // E00039 — this email already has a profile. Authorize.net puts the
  // existing id in the message text: "A duplicate record with ID 12345 already exists."
  if (env_.code === "E00039") {
    const existing = (env_.text.match(/ID\s+(\d+)/) || [])[1];
    if (existing) {
      const err = new Error("duplicate_profile");
      err.duplicateProfileId = String(existing);
      throw err;
    }
  }

  throw new Error(`Authorize.net could not save the card (${env_.code}): ${env_.text}`);
}

/**
 * Add a new card to a customer profile that already exists.
 * Used when a repeat customer books with a different card.
 * Returns the new paymentProfileId.
 */
export async function addPaymentProfile(env, { customerProfileId, opaque, billTo }) {
  const payload = {
    createCustomerPaymentProfileRequest: {
      merchantAuthentication: auth(env),
      customerProfileId: String(customerProfileId),
      paymentProfile: {
        customerType: "individual",
        ...(billTo ? { billTo } : {}),
        payment: {
          opaqueData: {
            dataDescriptor: opaque.dataDescriptor,
            dataValue: opaque.dataValue,
          },
        },
      },
      validationMode: env.ANET_ENV === "production" ? "liveMode" : "testMode",
    },
  };

  const json = await call(env, payload);
  const env_ = envelope(json);

  if (env_.ok && json.customerPaymentProfileId) {
    return String(json.customerPaymentProfileId);
  }

  // E00039 here means this exact card is already on the profile — reuse it.
  if (env_.code === "E00039") {
    const existing = (env_.text.match(/ID\s+(\d+)/) || [])[1];
    if (existing) return String(existing);
  }

  throw new Error(`Authorize.net could not add the card (${env_.code}): ${env_.text}`);
}

/** Look up the last 4 and card brand for display. Never fails the caller. */
export async function describeCard(env, { customerProfileId, paymentProfileId }) {
  try {
    const json = await call(env, {
      getCustomerPaymentProfileRequest: {
        merchantAuthentication: auth(env),
        customerProfileId: String(customerProfileId),
        customerPaymentProfileId: String(paymentProfileId),
      },
    });
    const cc =
      json &&
      json.paymentProfile &&
      json.paymentProfile.payment &&
      json.paymentProfile.payment.creditCard;
    if (!cc) return null;
    return {
      brand: cc.cardType || "",
      last4: String(cc.cardNumber || "").slice(-4),
      expiry: cc.expirationDate || "",
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------
   Charging
   ------------------------------------------------------------ */

/**
 * Charge a stored card.
 *
 * Returns a RESULT OBJECT rather than throwing on decline, because a
 * decline is a normal business outcome the caller must record and act
 * on — not an exception. Only transport failures throw.
 *
 *   { ok, declined, transId, authCode, code, message }
 */
export async function chargeProfile(env, {
  customerProfileId,
  paymentProfileId,
  amount,
  invoiceNumber,
  description,
  cofReason,
}) {
  // Authorize.net wants a plain decimal string; floats like 254.99999 are rejected.
  const amountStr = Number(amount).toFixed(2);

  const payload = {
    createTransactionRequest: {
      merchantAuthentication: auth(env),
      refId: refId("inv", invoiceNumber || ""),
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: amountStr,
        profile: {
          customerProfileId: String(customerProfileId),
          paymentProfile: { paymentProfileId: String(paymentProfileId) },
        },
        order: {
          invoiceNumber: String(invoiceNumber || "").slice(0, 20),
          description: String(description || "Car service").slice(0, 255),
        },
        // ---- Stored Credential Framework (Visa/Mastercard mandate) ----
        // The customer is not present when this runs, so it is a
        // Merchant-Initiated Transaction and must say so. Unflagged MITs
        // get declined at materially higher rates and downgrade the
        // interchange. Mastercard additionally requires the original
        // transaction link identifier to be sent with MITs from
        // 23 Oct 2026 — CIM populates that automatically, but ONLY when
        // the request is flagged as credential-on-file below.
        //
        // Order matters: both members must follow `order` per the schema.
        processingOptions: { isSubsequentAuth: "true" },
        ...(cofReason ? { subsequentAuthInformation: { reason: cofReason } } : {}),
      },
    },
  };

  const json = await call(env, payload);
  const env_ = envelope(json);
  const tr = json && json.transactionResponse;

  // A missing transactionResponse means the request itself was rejected
  // (bad credentials, unknown profile id, malformed amount).
  if (!tr) {
    return {
      ok: false,
      declined: false,
      code: env_.code || "NO_TRANSACTION",
      message: env_.text || "Authorize.net returned no transaction response",
    };
  }

  const responseCode = String(tr.responseCode || "");
  const err = Array.isArray(tr.errors) && tr.errors[0] ? tr.errors[0] : null;

  // 1 = approved, 2 = declined, 3 = error, 4 = held for review.
  // resultCode can be "Ok" on a decline, so responseCode is the authority.
  if (responseCode === "1") {
    return {
      ok: true,
      declined: false,
      transId: String(tr.transId || ""),
      authCode: String(tr.authCode || ""),
      code: "1",
      message: (tr.messages && tr.messages[0] && tr.messages[0].description) || "Approved",
    };
  }

  if (responseCode === "4") {
    // Held for review — the money is not captured yet but the card is fine.
    return {
      ok: false,
      declined: false,
      heldForReview: true,
      transId: String(tr.transId || ""),
      code: "4",
      message: "Held for review by Authorize.net",
    };
  }

  return {
    ok: false,
    declined: responseCode === "2",
    transId: String(tr.transId || ""),
    code: err ? String(err.errorCode) : responseCode || env_.code,
    message: err ? String(err.errorText) : env_.text || "Card was not approved",
  };
}

/**
 * Void an unsettled transaction, or refund a settled one.
 * Authorize.net rejects a refund before settlement and a void after it,
 * so we try void first and fall back to refund.
 */
export async function refundOrVoid(env, { transId, amount, customerProfileId, paymentProfileId }) {
  const voidRes = await call(env, {
    createTransactionRequest: {
      merchantAuthentication: auth(env),
      transactionRequest: {
        transactionType: "voidTransaction",
        refTransId: String(transId),
      },
    },
  });
  const voidTr = voidRes && voidRes.transactionResponse;
  if (voidTr && String(voidTr.responseCode) === "1") {
    return { ok: true, mode: "void", transId: String(voidTr.transId || "") };
  }

  const refundRes = await call(env, {
    createTransactionRequest: {
      merchantAuthentication: auth(env),
      transactionRequest: {
        transactionType: "refundTransaction",
        amount: Number(amount).toFixed(2),
        refTransId: String(transId),
        profile: {
          customerProfileId: String(customerProfileId),
          paymentProfile: { paymentProfileId: String(paymentProfileId) },
        },
      },
    },
  });
  const rTr = refundRes && refundRes.transactionResponse;
  if (rTr && String(rTr.responseCode) === "1") {
    return { ok: true, mode: "refund", transId: String(rTr.transId || "") };
  }

  const e = envelope(refundRes);
  const err = rTr && Array.isArray(rTr.errors) && rTr.errors[0];
  return {
    ok: false,
    mode: "none",
    code: err ? String(err.errorCode) : e.code,
    message: err ? String(err.errorText) : e.text || "Could not void or refund",
  };
}

/** Cheap credential check for the admin health screen. */
export async function pingCredentials(env) {
  try {
    const json = await call(env, {
      authenticateTestRequest: { merchantAuthentication: auth(env) },
    });
    const e = envelope(json);
    return { ok: e.ok, code: e.code, message: e.text };
  } catch (err) {
    return { ok: false, code: "TRANSPORT", message: String(err.message || err) };
  }
}
