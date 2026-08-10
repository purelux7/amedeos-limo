-- ============================================================
-- Amadeo's Private Car Service — CRM database (Cloudflare D1)
-- Two tables: customers (people) and bookings (rides).
-- A customer can have many bookings. Pickup/dropoff are
-- geocoded on save so the map loads fast (no re-lookup).
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  home_address  TEXT,            -- optional; for "where customers live" view
  home_lat      REAL,
  home_lng      REAL,
  notes         TEXT,            -- Matt's private notes on the customer
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(email),
  UNIQUE(phone)
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,

  -- trip details (mirror the booking form)
  service       TEXT,
  pickup        TEXT,
  pickup_lat    REAL,
  pickup_lng    REAL,
  dropoff       TEXT,
  dropoff_lat   REAL,
  dropoff_lng   REAL,
  ride_date     TEXT,            -- YYYY-MM-DD
  ride_time     TEXT,            -- HH:MM
  passengers    TEXT,
  notes         TEXT,            -- customer's request notes (flight #, child seat…)

  -- operations
  status        TEXT NOT NULL DEFAULT 'new',    -- new | confirmed | done | canceled
  paid          INTEGER NOT NULL DEFAULT 0,     -- 0 = unpaid, 1 = paid (manual for now)
  price         REAL,                           -- optional flat rate Matt sets
  source        TEXT DEFAULT 'website',         -- website | phone | manual

  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fast lookups for the dashboard
CREATE INDEX IF NOT EXISTS idx_bookings_date   ON bookings(ride_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_cust   ON bookings(customer_id);
