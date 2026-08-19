-- ============================================================
-- Migration 006 — real sessions, and a brake on the login form.
--
-- The session cookie used to be a single fixed value derived from the
-- environment secret: identical for every sign-in, on every device,
-- forever. Signing out deleted the cookie locally and left the token
-- valid; changing the password did not invalidate it at all. Anyone
-- who ever saw that cookie held permanent access to an admin that can
-- charge saved cards.
--
-- Sessions are now rows. Each sign-in mints its own random token, only
-- the SHA-256 of it is stored, it expires, and it can be revoked —
-- individually, or all at once when the password changes.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/006_real_sessions.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SHA-256 of the cookie value. The token itself is never stored, so a
  -- copy of this table is not a set of working credentials.
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token   ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON admin_sessions(expires_at);

-- Failed sign-in attempts, so the login form can be slowed down.
-- Keyed by IP. Successful sign-in clears the row.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  first_fail_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until  TEXT
);
