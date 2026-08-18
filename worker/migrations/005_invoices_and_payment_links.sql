-- ============================================================
-- Migration 005 — invoicing, payment links, and a message log.
--
-- Everything Matt needs to bill work that did not come through the
-- booking form: a corporate account, a wedding, a standing weekly
-- run, a no-show fee. An invoice can stand alone or hang off a
-- booking; either way it carries its own pay link.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/005_invoices_and_payment_links.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT UNIQUE,                     -- AM-2026-0007, human-facing
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL,

  -- draft   → being written, customer has never seen it
  -- sent    → link is live and has been emailed or texted
  -- paid    → settled in full
  -- void    → cancelled; kept for the record, never deleted
  status        TEXT NOT NULL DEFAULT 'draft',

  subtotal      REAL NOT NULL DEFAULT 0,
  tip           REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  amount_paid   REAL NOT NULL DEFAULT 0,

  due_date      TEXT,                            -- YYYY-MM-DD, optional
  notes         TEXT,                            -- shown to the customer
  private_note  TEXT,                            -- never leaves the admin

  -- The pay link's secret. Long and random: it is the only thing
  -- standing between a URL and someone else's invoice, so it is
  -- generated the same way the booking manage tokens are.
  pay_token     TEXT UNIQUE,
  trans_id      TEXT,                            -- Authorize.net transaction
  card_last4    TEXT,

  sent_at       TEXT,
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 1,
  unit_price    REAL NOT NULL DEFAULT 0,
  amount        REAL NOT NULL DEFAULT 0,         -- qty * unit_price, stored so
                                                 -- a past invoice never changes
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Every outbound email and text, so "did he ever send it?" has an answer.
CREATE TABLE IF NOT EXISTS message_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL,                   -- email | sms | sms-handoff
  to_addr       TEXT,
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'sent',    -- sent | failed | handoff
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_token    ON invoices(pay_token);
CREATE INDEX IF NOT EXISTS idx_items_invoice     ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_msg_invoice       ON message_log(invoice_id);

-- Invoice numbering. Kept in settings so it survives a table rebuild and
-- so Matt can set the starting number if he has already sent paper ones.
INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_seq', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_prefix', 'AM');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invoice_terms', 'Payment is due on receipt. Thank you for riding with Amedeo''s.');
