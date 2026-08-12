# Amedeo's — Audit Prompt

Paste everything below the line into a fresh Claude Code session started in
`~/Code/amedeos-limo`. It produces a prioritised, evidence-backed list of what
is actually broken — not a checklist of things that were merely looked at.

---

You are auditing a live, revenue-taking website. Real customers can book and be
charged right now. Find what is broken, prove it, and rank it. Do not fix
anything unless I ask.

## The system

| Piece | Where |
|---|---|
| Site | `https://allfloridaairportscarservice.com` — static HTML/CSS/JS on GitHub Pages, repo `purelux7/amedeos-limo` |
| API | `https://api.allfloridaairportscarservice.com` — Cloudflare Worker `afacs-reservations`, source in `worker/` |
| Database | Cloudflare D1 `afacs-crm` |
| Payments | Authorize.net, **production credentials only — there is no sandbox for this merchant** |
| Admin | `/admin` on the API domain, password-protected |
| Tests | `cd worker && node test/run.mjs` |

A one-man chauffeur service. Customer picks a destination, gets a flat rate,
optionally adds a gratuity, enters a card, and is **charged in full at booking**.
The card is vaulted at Authorize.net via Accept.js; the site never sees the
number. A cron sweep every 15 minutes is a fallback charger; a daily digest email
doubles as a heartbeat.

## Hard rules — these override any instinct to be thorough

1. **Never charge a real card.** Test cards (`4111…`) are correctly declined by
   the production gateway — that is the expected result, not a bug. Never enter a
   live card to "see if it works".
2. **Never DELETE or UPDATE database rows.** Real customer bookings sit
   alongside old test rows and are not visually distinguishable. Read only.
   `SELECT` is fine; anything else, propose it and stop.
3. **Never deploy, push, or run a migration.** Report; do not ship.
4. **Never claim something works because the code looks right.** Every finding
   needs a command, a response, or a screenshot behind it.
5. If the browser tab is backgrounded (`document.hidden === true`), CSS
   transitions and `requestAnimationFrame` are frozen. Measurements taken then
   are artifacts, not bugs. Check visibility before reporting animation issues.

## What to audit

### 1. Money correctness — highest priority
- Does the price shown to the customer equal the amount actually charged?
  Compare `quoted_total` against `amount_charged` and the `charges` ledger for
  every booking.
- Does the `charges` ledger reconcile per booking? Fares, tips, extras, refunds
  should net to `amount_charged`.
- Can any input produce a charge that differs from the displayed total? Try
  negative tips, absurd tips, tampered `tipPct`/`tipAmount`/`hours` in a direct
  API call.
- Is there any path where a customer is charged but no booking exists, or a
  booking exists with no charge?
- Cancellation: does the refund/keep amount match the published policy in
  `terms.html` exactly?

### 2. Emails must match reality
Read every template in `worker/notify.js` against what the code actually does.
This has been wrong before: the confirmation told a customer "nothing has been
charged yet" **after** taking $288, and omitted the tip line so the arithmetic
didn't add up. Check every number, date, and claim in every template.

### 3. The booking flow, in a real browser
Drive `allfloridaairportscarservice.com` end to end. Confirm:
- rates load; each destination quotes the right price
- the gratuity control works — every option, Other, None — and the total tracks
- unavailable times are refused and alternatives offered
- a declined card leaves **no** booking holding a calendar slot
- validation messages are accurate and human
- it works on a narrow viewport, not just desktop

### 4. Security
- Are protected endpoints actually protected? (`/api/bookings`, `/api/health`,
  `/api/blackouts`, `/api/customers`, `/api/run-charges` must all 401.)
- Is any secret reachable from the browser? The Transaction Key and Signature
  Key must never appear in `/api/config`, page source, or the repo.
- Check `git log -p` for credentials ever committed.
- Can the manage-token link be guessed or enumerated?
- Does any endpoint leak one customer's data to another?

### 5. Database integrity
- Rows with `payment_status = 'charged'` but `amount_charged = 0`, or vice versa.
- Bookings holding calendar slots (`block_start_utc`) that are cancelled or dead.
- Orphans: bookings with no customer, charges with no booking.
- Duplicate customers — phone numbers are **not** normalised, so `772-555-0100`
  and `(772) 555-0100` create two people.
- Are old pre-launch test bookings still present and would they confuse Matt?
- Do `rates` and `settings` match what the site actually displays?

### 6. Timezone and scheduling
Everything is stored as epoch ms and rendered in `America/New_York`. Check the
charge sweep, calendar blocking, and digest for any place a wall-clock string is
used for arithmetic. Pay attention to DST boundaries.

### 7. Front-end integrity
- Does `styles.css` have balanced braces? An unmatched `}` silently kills every
  rule after it — this has shipped before.
- Is any content hidden behind an animation that might not run?
- Console errors on load and on submit.
- Are asset cache-busting versions bumped for the current files?

### 8. Legal, SEO, accessibility
- Do `terms.html` and `privacy.html` still describe what the system does?
  (Payment timing changed from T-24h to at-booking; gratuity is no longer
  auto-added.)
- Does the site reference an email address that doesn't receive mail?
- `robots.txt`, sitemap, canonical tags, meta descriptions, structured data for
  a local service business, crawlability and renderability.
- Keyboard navigation, focus states, colour contrast, `prefers-reduced-motion`.

## Smoke tests to run

```bash
cd worker && node test/run.mjs            # full suite, expect all passing

# public endpoints
curl -s https://api.allfloridaairportscarservice.com/api/config | head -c 400
curl -s -X POST https://api.allfloridaairportscarservice.com/api/quote \
  -H 'Content-Type: application/json' -d '{"destCode":"MCO","tipPct":20}'

# protected endpoints — every one must return 401
for p in /api/bookings /api/health /api/blackouts /api/customers; do
  curl -s -o /dev/null -w "$p %{http_code}\n" \
    https://api.allfloridaairportscarservice.com$p
done

# hostile inputs — none should produce a charge above the shown total
curl -s -X POST .../api/quote -d '{"destCode":"MCO","tipPct":-50}'
curl -s -X POST .../api/quote -d '{"destCode":"MCO","tipAmount":999999}'
curl -s -X POST .../api/quote -d '{"destCode":"HOURLY","hours":9999}'
```

Then drive the real site in a browser and complete a booking with a test card.
Expect a decline with a clear message and **no** booking left behind.

## How to report

For each finding give me:

- **Severity** — Critical (money wrong, data loss, security) / High (customer-facing
  breakage) / Medium (degrades trust or conversion) / Low (polish)
- **What is wrong**, in one sentence
- **The evidence** — the exact command and its output, or the screenshot
- **How it fails in practice** — the concrete scenario where a real customer or
  Matt is harmed
- **The fix**, specific enough to act on

Rank strictly by what costs money or trust first. Say plainly what you checked
and could **not** verify — an honest gap is more useful than a confident guess.
If you find nothing wrong in an area, say so rather than padding the list.

Do not fix anything. Report, then wait.
