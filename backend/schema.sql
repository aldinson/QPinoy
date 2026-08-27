-- =========================================================
-- QPinoy — B2B2C Virtual Queuing Platform
-- PostgreSQL schema for the "Presence vs Payment" queue engine
-- =========================================================
-- Design notes:
--
-- * order_weight is a DOUBLE PRECISION "fractional index." Moving,
--   inserting, or reprioritizing a row only ever recomputes ONE
--   row's weight (the midpoint of its two new neighbours), so a
--   reorder is O(1) regardless of how many people are in line —
--   unlike renumbering sequential integers (1,2,3..), which is O(n).
--
-- * CAVEAT (documented, not hidden): repeatedly splitting the same
--   gap thousands of times will eventually approach the precision
--   limit of DOUBLE PRECISION (~15-17 significant digits). This is
--   the well-known trade-off of fractional indexing (the same
--   technique behind Figma's layer ordering and most drag-and-drop
--   list APIs). Mitigation: queueEngine.rebalanceIfNeeded() resets
--   all active weights to clean, evenly-spaced integers without
--   changing relative order. Run it nightly per venue, or lazily
--   whenever two adjacent weights are closer than 1e-9.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------
CREATE TYPE queue_status AS ENUM ('waiting', 'serving', 'served', 'dropped', 'cancelled');
CREATE TYPE payment_tier AS ENUM ('standard_free', 'premium_secured');
CREATE TYPE automation_flag AS ENUM ('stepped_back', 'dropped', 'reinstated');

-- ---------------------------------------------------------
-- VENUES — the "B2B" side of B2B2C: clinics, spas, barbershops, salons
-- ---------------------------------------------------------
CREATE TABLE venues (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT NOT NULL,
    address                 TEXT,
    geofence_lat            DOUBLE PRECISION NOT NULL,
    geofence_lng            DOUBLE PRECISION NOT NULL,
    geofence_radius_meters  INTEGER NOT NULL DEFAULT 150,
    avg_service_minutes     INTEGER NOT NULL DEFAULT 15,
    -- Global attendant toggle. When false, the two-slot-prior
    -- automation trigger is a no-op and the dashboard falls back to
    -- manual attendant reordering.
    is_automation_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- QUEUE ENTRIES — the "C": end customers currently in (or recently
-- through) a venue's line
-- ---------------------------------------------------------
CREATE TABLE queue_entries (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id              UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    customer_name         TEXT NOT NULL,
    customer_phone        TEXT,
    status                queue_status NOT NULL DEFAULT 'waiting',
    payment_tier          payment_tier NOT NULL DEFAULT 'standard_free',

    -- The fractional-index sort key. Only ever touched one row at a
    -- time — see design notes above.
    order_weight          DOUBLE PRECISION NOT NULL,

    -- Presence + ETA inputs to the automation trigger.
    is_checked_in         BOOLEAN NOT NULL DEFAULT FALSE,  -- geofence result
    last_lat              DOUBLE PRECISION,
    last_lng              DOUBLE PRECISION,
    live_eta_minutes      INTEGER,                          -- from Distance Matrix polling
    expected_slot_at      TIMESTAMPTZ,                      -- when this customer's turn is predicted

    -- Attendant "Lock-Back" override state.
    is_override_locked    BOOLEAN NOT NULL DEFAULT FALSE,
    last_automation_flag  automation_flag,                  -- most recent automated action, for the UI's "Reinstate" affordance

    joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT order_weight_positive CHECK (order_weight > 0)
);

-- ---------------------------------------------------------
-- INDEXES — tuned for low-latency reads of "the live line," which is
-- the hottest query path in the whole system (polled continuously by
-- every attendant dashboard and customer phone at every venue).
-- ---------------------------------------------------------

-- Partial index: only 'waiting'/'serving' rows are indexed, so it
-- stays small and fast even as thousands of historical 'served' /
-- 'dropped' rows accumulate for a venue over time.
CREATE INDEX idx_active_queue_order
    ON queue_entries (venue_id, order_weight)
    WHERE status IN ('waiting', 'serving');

-- Speeds up status-filtered lookups (e.g. "is anyone currently being served").
CREATE INDEX idx_queue_status ON queue_entries (venue_id, status);

-- At most one 'serving' row per venue — enforced at the DB level, not
-- just in application code, and doubles as a fast existence check.
CREATE UNIQUE INDEX idx_one_serving_per_venue
    ON queue_entries (venue_id)
    WHERE status = 'serving';

-- Automation engine filters out locked rows on every evaluation.
CREATE INDEX idx_override_locked
    ON queue_entries (venue_id)
    WHERE is_override_locked = TRUE;

-- ---------------------------------------------------------
-- updated_at auto-touch (housekeeping, not core queue logic)
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_venues
BEFORE UPDATE ON venues
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_touch_queue_entries
BEFORE UPDATE ON queue_entries
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------
-- Maintenance: rebalance a venue's active weights to clean, evenly
-- spaced integers (10, 20, 30, ...) without changing relative order.
-- Mirrors queueEngine.rebalanceIfNeeded(); provided here as a SQL-only
-- fallback for ops teams who want to run it straight from psql/cron
-- without going through the Node layer.
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION rebalance_active_queue(p_venue_id UUID) RETURNS INTEGER AS $$
DECLARE
    r RECORD;
    i INTEGER := 0;
BEGIN
    FOR r IN
        SELECT id FROM queue_entries
         WHERE venue_id = p_venue_id AND status IN ('waiting', 'serving')
         ORDER BY (status = 'serving') DESC, order_weight ASC
         FOR UPDATE
    LOOP
        i := i + 1;
        UPDATE queue_entries SET order_weight = i * 10 WHERE id = r.id;
    END LOOP;
    RETURN i;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------
-- Seed example (one venue, six customers) — mirrors the frontend
-- simulator's default scenario 1:1, useful for local dev / demos.
-- ---------------------------------------------------------
-- INSERT INTO venues (id, name, geofence_lat, geofence_lng, is_automation_enabled)
-- VALUES ('00000000-0000-0000-0000-000000000001', 'Riverside Dermatology', 40.7128, -74.0060, TRUE);
--
-- INSERT INTO queue_entries (venue_id, customer_name, status, payment_tier, order_weight, is_checked_in, live_eta_minutes, expected_slot_at)
-- VALUES
--   ('00000000-0000-0000-0000-000000000001', 'Alice Chen',     'waiting', 'premium_secured', 10, TRUE,  2,  now() + interval '0 minutes'),
--   ('00000000-0000-0000-0000-000000000001', 'Bob Martinez',   'waiting', 'standard_free',   20, TRUE,  3,  now() + interval '6 minutes'),
--   ('00000000-0000-0000-0000-000000000001', 'Charlie Nguyen', 'waiting', 'standard_free',   30, TRUE,  2,  now() + interval '12 minutes'),
--   ('00000000-0000-0000-0000-000000000001', 'Dana Osei',      'waiting', 'premium_secured', 40, FALSE, 25, now() + interval '18 minutes'),
--   ('00000000-0000-0000-0000-000000000001', 'Ethan Brooks',   'waiting', 'standard_free',   50, FALSE, 20, now() + interval '24 minutes'),
--   ('00000000-0000-0000-0000-000000000001', 'Fiona Alvarez',  'waiting', 'standard_free',   60, TRUE,  4,  now() + interval '30 minutes');
