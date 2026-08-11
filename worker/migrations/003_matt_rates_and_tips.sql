-- ============================================================
-- Migration 003 — Matt's own rate sheet, tips unbundled,
-- and payment taken at booking instead of T-24h.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/003_matt_rates_and_tips.sql
-- ============================================================

-- ---------- Matt's handwritten rates (2026-08-11) ----------
-- "Melbourne/Orlando" is MLB — the airport's full name is Orlando
-- Melbourne International, which is why it appears twice on his sheet.
-- Prices are now the FULL price: no gratuity is folded in.
UPDATE rates SET price = 80.0,  updated_at = datetime('now') WHERE code = 'PBI';
UPDATE rates SET price = 150.0, updated_at = datetime('now') WHERE code = 'FLL';
UPDATE rates SET price = 200.0, updated_at = datetime('now') WHERE code = 'MIA';
UPDATE rates SET price = 200.0, updated_at = datetime('now') WHERE code = 'MCO';
UPDATE rates SET price = 100.0, updated_at = datetime('now') WHERE code = 'VRB';
UPDATE rates SET price = 125.0, updated_at = datetime('now') WHERE code = 'MLB';
-- Not on his sheet; left as-is so nothing changes silently.
--   LOCAL  = 75.00
--   HOURLY = 80.00/hr

-- ---------- tips are no longer bundled into the fare ----------
-- gratuity_pct becomes a SUGGESTION shown in the booking form, not an
-- amount added automatically. Defaulting the selector to 20% keeps it
-- opt-out rather than opt-in, which is how card terminals behave and is
-- the difference between Matt earning a wage on the long routes or not.
INSERT OR REPLACE INTO settings (key, value) VALUES
  ('gratuity_pct',      '0'),          -- nothing is auto-added to the fare
  ('tip_default_pct',   '20'),         -- pre-selected; one tap to change or remove
  ('tip_options',       '20,22.5,25,30'),
  ('tip_enabled',       '1'),
  ('charge_at_booking', '1');          -- take payment immediately, not at T-24h

-- ---------- tip accounting ----------
-- Tips are tracked separately from the fare so Matt can see what he
-- actually earned in tips, and so a post-ride tip can be added to a
-- booking that was already paid in full.
ALTER TABLE bookings ADD COLUMN tip_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN tip_pct REAL;
ALTER TABLE bookings ADD COLUMN tip_added_after INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bookings_tip ON bookings(tip_amount);
