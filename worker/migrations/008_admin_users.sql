-- ============================================================
-- Migration 008 — named users.
--
-- There was one password. Everyone who had it was indistinguishable
-- from everyone else who had it, which meant the audit trail added in
-- 007 could say what happened but never who did it, and letting a
-- second person in meant handing over the only key in existence —
-- with no way to take it back except changing it for everybody.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/008_admin_users.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  -- owner: everything, including managing users.
  -- driver: everything operational — the calendar, rides, customers,
  --         invoices, refunds — but cannot create or remove logins.
  role          TEXT NOT NULL DEFAULT 'driver',
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_username ON admin_users(username);

-- Sessions belong to a person now.
ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER;

-- And so does every audited action.
ALTER TABLE audit_log ADD COLUMN actor TEXT;
