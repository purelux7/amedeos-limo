-- ============================================================
-- Migration 004 — full gratuity ladder.
--
-- 15% and 18% added at the operator's request. Eight options is too
-- many to sit open on the page, so the booking form now shows a single
-- collapsed line and only expands the ladder if the customer chooses
-- to change it.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/004_tip_options.sql
-- ============================================================

INSERT OR REPLACE INTO settings (key, value) VALUES
  ('tip_options', '15,18,20,22.5,25,30');
