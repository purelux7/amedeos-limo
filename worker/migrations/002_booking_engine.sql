-- ============================================================
-- Amedeo's Private Car Service — booking engine + payments
-- Migration 002. Additive only: nothing in migration 001 is
-- dropped or rewritten, so existing bookings survive untouched.
--
-- Apply with:
--   wrangler d1 execute afacs-crm --remote --file=migrations/002_booking_engine.sql
-- ============================================================

-- ---------- destinations Matt actually serves, with flat rates ----------
-- hours_engaged is the ROUND TRIP time including the empty return drive.
-- It is what the calendar blocks out, so he can never be double-booked.
CREATE TABLE IF NOT EXISTS rates (
  code            TEXT PRIMARY KEY,       -- PBI, FLL, MIA, MCO, MLB, VRB, LOCAL, HOURLY
  label           TEXT NOT NULL,          -- shown in the booking dropdown
  price           REAL NOT NULL,          -- flat base fare, per vehicle, one way
  hours_engaged   REAL NOT NULL,          -- round-trip hours to block on the calendar
  miles_one_way   INTEGER,                -- reference only
  sort_order      INTEGER NOT NULL DEFAULT 100,
  active          INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Approved 2026 rate schedule (final, 2026-08-10).
-- Priced against UberX rather than against cost: every customer-facing
-- total (base + 20% gratuity) lands ~35% over the UberX fare for the same
-- route, close enough that Uber is not the obvious default.
--
-- PBI is the deliberate exception — an entry rate, not a margin route. It
-- is the highest-frequency run and its job is to win the repeat customer
-- who later books MIA and MCO. It clears roughly $11/hr and is expected to.
--
-- These numbers are near the floor: another ~15% off puts MCO under
-- Florida minimum wage for a 4.8-hour round trip.
INSERT OR REPLACE INTO rates (code, label, price, hours_engaged, miles_one_way, sort_order) VALUES
  ('PBI',    'Palm Beach International (PBI)',       75.0, 2.0,  45,  10),
  ('LOCAL',  'Local — Martin & St. Lucie County',    75.0, 1.5,  NULL, 20),
  ('VRB',    'Vero Beach',                           95.0, 1.7,  35,  30),
  ('MLB',    'Melbourne (MLB)',                     150.0, 3.0,  85,  40),
  ('FLL',    'Fort Lauderdale (FLL)',               160.0, 3.2,  90,  50),
  ('MIA',    'Miami International (MIA)',           195.0, 3.8, 112,  60),
  ('MCO',    'Orlando International (MCO)',         235.0, 4.8, 140,  70),
  ('HOURLY', 'Hourly chauffeur (3 hr minimum)',      80.0, 3.0,  NULL, 80);

-- ---------- dates/times Matt is unavailable ----------
-- A whole-day blackout has start_utc/end_utc spanning that local day.
CREATE TABLE IF NOT EXISTS blackouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start_utc   INTEGER NOT NULL,           -- epoch ms
  end_utc     INTEGER NOT NULL,           -- epoch ms
  label       TEXT,                       -- "Vacation", "Doctor", …
  all_day     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blackouts_range ON blackouts(start_utc, end_utc);

-- ---------- tunable business rules (no redeploy to change) ----------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO settings (key, value) VALUES
  ('gratuity_pct',            '20'),      -- auto-added to every quote
  ('charge_lead_hours',       '24'),      -- charge the card T-24h before pickup
  ('free_cancel_hours',       '24'),      -- full refund outside this window
  ('half_cancel_hours',       '4'),       -- 50% between half and free window
  ('buffer_minutes',          '30'),      -- padding between consecutive rides
  ('day_start_local',         '04:00'),   -- earliest pickup offered
  ('day_end_local',           '22:00'),   -- latest pickup offered
  ('min_lead_hours',          '3'),       -- no bookings inside this window
  ('max_advance_days',        '365'),
  ('wait_rate_per_min',       '1.25'),
  ('arrival_free_wait_min',   '45'),
  ('departure_free_wait_min', '15'),
  ('extra_stop',              '20'),
  ('child_seat',              '15'),
  ('cleaning_fee',            '200'),
  ('timezone',                'America/New_York'),
  ('auto_confirm',            '1'),       -- 1 = instant confirm, Matt does nothing
  ('decline_window_min',      '30');      -- Matt's "reply N to decline" grace period

-- ---------- customers: link to the Authorize.net vault ----------
-- The card itself is NEVER stored here. Only Authorize.net's reference id.
ALTER TABLE customers ADD COLUMN anet_customer_profile_id TEXT;
ALTER TABLE customers ADD COLUMN last_booked_at TEXT;
ALTER TABLE customers ADD COLUMN total_rides INTEGER NOT NULL DEFAULT 0;

-- ---------- bookings: quote, calendar block, and payment state ----------
ALTER TABLE bookings ADD COLUMN dest_code TEXT;
ALTER TABLE bookings ADD COLUMN direction TEXT;              -- to_airport | from_airport | point_to_point
ALTER TABLE bookings ADD COLUMN quoted_base REAL;
ALTER TABLE bookings ADD COLUMN quoted_gratuity REAL;
ALTER TABLE bookings ADD COLUMN quoted_total REAL;
ALTER TABLE bookings ADD COLUMN hours_engaged REAL;

ALTER TABLE bookings ADD COLUMN ride_start_utc INTEGER;      -- epoch ms, pickup moment
ALTER TABLE bookings ADD COLUMN block_start_utc INTEGER;     -- calendar block (incl. buffer)
ALTER TABLE bookings ADD COLUMN block_end_utc INTEGER;

ALTER TABLE bookings ADD COLUMN anet_payment_profile_id TEXT;
ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'none';
  -- none | card_on_file | charged | failed | refunded | waived
ALTER TABLE bookings ADD COLUMN charge_after_utc INTEGER;    -- when the cron may charge
ALTER TABLE bookings ADD COLUMN charged_at TEXT;
ALTER TABLE bookings ADD COLUMN charge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN last_charge_error TEXT;
ALTER TABLE bookings ADD COLUMN amount_charged REAL NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN extras_total REAL NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN extras_note TEXT;

ALTER TABLE bookings ADD COLUMN manage_token TEXT;           -- customer self-service link
ALTER TABLE bookings ADD COLUMN flight_number TEXT;
ALTER TABLE bookings ADD COLUMN terms_accepted_at TEXT;      -- chargeback evidence
ALTER TABLE bookings ADD COLUMN terms_ip TEXT;
ALTER TABLE bookings ADD COLUMN reminded_at TEXT;
ALTER TABLE bookings ADD COLUMN round_trip_of INTEGER;       -- links outbound/return pair

CREATE INDEX IF NOT EXISTS idx_bookings_block   ON bookings(block_start_utc, block_end_utc);
CREATE INDEX IF NOT EXISTS idx_bookings_charge  ON bookings(payment_status, charge_after_utc);
CREATE INDEX IF NOT EXISTS idx_bookings_token   ON bookings(manage_token);

-- ---------- every money movement, for reconciliation and disputes ----------
CREATE TABLE IF NOT EXISTS charges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,           -- fare | extras | cancellation | refund
  amount         REAL NOT NULL,
  status         TEXT NOT NULL,           -- ok | declined | error
  anet_trans_id  TEXT,
  anet_auth_code TEXT,
  anet_code      TEXT,                    -- response/error code for support calls
  message        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_charges_booking ON charges(booking_id);
