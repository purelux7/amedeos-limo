-- ============================================================
-- Migration 007 — an audit trail for the back office.
--
-- One shared login sits in front of a live merchant account. Charges
-- and messages were already recorded; nothing recorded who changed a
-- rate, voided an invoice, cancelled a ride, refunded money or changed
-- the password. That is the difference between "something is wrong"
-- and "here is what happened, and when".
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/007_audit_log.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,       -- booking.create, invoice.void, settings.update …
  entity      TEXT,                -- booking | invoice | customer | settings | auth
  entity_id   TEXT,
  summary     TEXT,                -- human sentence, written for a reader not a parser
  detail      TEXT,                -- optional JSON
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity, entity_id);
