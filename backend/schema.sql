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
-- 'no_show' is distinct from 'served': it means an attendant called this
-- customer and they never appeared, as opposed to actually being attended
-- to. Conflating the two (the original bug: callNextCustomer auto-marked
-- whoever was previously 'serving' as 'served' with no way to say
-- otherwise) silently corrupts service-time and no-show-rate analytics.
-- See markNoShow() in queueEngine.js.
CREATE TYPE queue_status AS ENUM ('waiting', 'serving', 'served', 'dropped', 'cancelled', 'no_show');
CREATE TYPE payment_tier AS ENUM ('standard_free', 'premium_secured');
CREATE TYPE automation_flag AS ENUM ('stepped_back', 'dropped', 'reinstated');

-- How an account was onboarded. This is an ONBOARDING HINT ONLY — it
-- decides which home screen you land on, never what you're allowed to
-- do. Real authorization comes from venue_members below, so that a
-- single person can be a customer at one venue and staff at another
-- without needing two accounts.
CREATE TYPE account_type AS ENUM ('customer', 'business');

-- Per-venue staff roles, most privileged first:
--   owner     — created the venue. Full control. Cannot be removed
--               (there must always be exactly one).
--   manager   — the "authorized user" an owner delegates to: can add
--               and remove other staff, and everything an attendant can do.
--   attendant — runs the line and enrolls customers, but cannot touch
--               the staff list.
CREATE TYPE venue_role AS ENUM ('owner', 'manager', 'attendant');

-- ---------------------------------------------------------
-- USERS — every human with an account, on either side of the B2B2C.
-- Customers self-register here; so do business owners. Which venues
-- (if any) a user can act on is decided entirely by venue_members.
-- ---------------------------------------------------------
CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- CITEXT would be tidier, but it needs another extension; lower()
    -- on write plus this unique index gets the same guarantee with one
    -- less moving part. authRoutes.js normalises before every write.
    email          TEXT NOT NULL UNIQUE,
    -- scrypt, salted per row. See password.js — the format string
    -- carries its own parameters so they can be raised later without
    -- invalidating existing hashes.
    password_hash  TEXT NOT NULL,
    full_name      TEXT NOT NULL,
    -- Mandatory, and always stored in E.164 (+639171234567) rather
    -- than as the user typed it — see phone.js. Email and mobile are
    -- the two ways a venue can reach someone whose turn is coming up,
    -- so both are required at signup.
    --
    -- Deliberately NOT unique: households and small businesses share
    -- one handset often enough that a uniqueness constraint would
    -- reject real people. Add one only if phone ever becomes a login
    -- identifier, where it would be required.
    phone          TEXT NOT NULL,
    account_type   account_type NOT NULL DEFAULT 'customer',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT email_is_lowercase CHECK (email = lower(email))
);

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
    -- How long a customer's check-in QR (see tokens.js's enrollment
    -- token) stays valid before it expires and the customer's screen
    -- silently re-fetches a fresh one, WHEN that token was requested in
    -- this venue's context (GET /me/enrollment-token?venueId=...).
    -- Owner/manager-configurable — see PATCH .../enrollment-qr-ttl in
    -- venueRoutes.js. Bounded in application code (60-3600s): short
    -- enough that a photographed code stops being useful reasonably
    -- fast, long enough to actually be configurable and not just a
    -- cosmetic knob. A customer's enrollment token is otherwise
    -- venue-agnostic (any venue's staff can scan it), so this setting
    -- only takes effect when the token was requested WITH this venue in
    -- mind — see authRoutes.js.
    enrollment_qr_ttl_seconds INTEGER NOT NULL DEFAULT 900,

    -- Subscription state — see subscriptions.js for the full reasoning.
    -- Deliberately just two timestamps, no stored status enum: a
    -- venue's effective status (trialing/active/past_due) is always
    -- COMPUTED from these against now(), never cached, so there's no
    -- background job required to "expire" anything and no risk of
    -- stale status from a missed cron run.
    --
    --   trial_ends_at             set once at creation (14 days out).
    --                             Ignored forever once a payment lands.
    --   subscription_paid_until   NULL until the first successful
    --                             payment; from then on this alone
    --                             determines coverage. Extended by
    --                             subscriptions.js's computeNewPeriodEnd()
    --                             on every successful checkout.
    trial_ends_at              TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
    subscription_paid_until    TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- VENUE MEMBERS — who is allowed to act on a venue, and how.
-- This table IS the authorization model: no row here means no staff
-- powers at this venue, whatever the user's account_type says.
-- ---------------------------------------------------------
CREATE TABLE venue_members (
    venue_id    UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role        venue_role NOT NULL DEFAULT 'attendant',
    -- Who granted this access. Kept for an audit trail; nullable
    -- because a venue's founding owner row is self-granted.
    granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One role per person per venue: makes "what can this user do
    -- here" a single-row lookup with no precedence rules to get wrong.
    PRIMARY KEY (venue_id, user_id)
);

-- Exactly one owner per venue, enforced by the database rather than
-- by application code that could be bypassed or race itself.
CREATE UNIQUE INDEX idx_one_owner_per_venue
    ON venue_members (venue_id)
    WHERE role = 'owner';

-- "Which venues does this user staff?" — the query behind every
-- staff-side page load.
CREATE INDEX idx_venue_members_user ON venue_members (user_id);

-- ---------------------------------------------------------
-- QUEUE ENTRIES — the "C": end customers currently in (or recently
-- through) a venue's line
-- ---------------------------------------------------------
CREATE TABLE queue_entries (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id              UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    -- The registered customer this ticket belongs to, when there is
    -- one. NULL is legitimate and expected: a walk-in with no account
    -- still gets a ticket, added by staff by name. When it IS set, it
    -- is what lets that customer update their own location and see
    -- their own place in line without being able to touch anyone
    -- else's row. ON DELETE SET NULL so deleting an account doesn't
    -- silently vaporise a line someone is currently standing in.
    user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
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

-- "Where am I in line right now?" — the customer's own home screen
-- polls this. Partial, so it stays tiny no matter how much history a
-- frequent customer accumulates.
CREATE INDEX idx_active_entries_by_user
    ON queue_entries (user_id)
    WHERE status IN ('waiting', 'serving');

-- A registered customer can hold at most ONE live ticket per venue.
-- Without this, a staff member scanning the same QR twice (or two
-- staff scanning at once on separate phones) would quietly create a
-- duplicate ticket and give that customer two places in the same
-- line. Enforced here rather than only in enrollment code, because
-- the check-then-insert in application code is a race by nature.
CREATE UNIQUE INDEX idx_one_active_entry_per_user_per_venue
    ON queue_entries (venue_id, user_id)
    WHERE user_id IS NOT NULL AND status IN ('waiting', 'serving');

-- ---------------------------------------------------------
-- PUSH SUBSCRIPTIONS — Web Push registrations, one row per browser/device
-- a customer has enabled notifications on. See backend/push.js.
--
-- This is the "pull, don't push" channel DEPLOYMENT.md (§4) recommended
-- instead of trusting a phone's last stored location once its screen
-- locks: the queue engine pushes a notification at the exact moment it
-- matters (their turn is close, or they were skipped), and the tap
-- itself is a fresh presence signal, not a stale GPS fix.
-- ---------------------------------------------------------
CREATE TABLE push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The PushSubscription's endpoint URL IS the natural unique key —
    -- one per browser/device registration. A user with several devices
    -- (phone + laptop) gets several rows and is notified on all of them.
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Every device this user should be notified on" — the query
-- sendPushToUser() runs on every queue-state notification.
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

-- ---------------------------------------------------------
-- SUBSCRIPTION PAYMENTS — one row per checkout attempt (GCash, Maya, or
-- card via PayMongo; PayPal separately), an audit trail, and the
-- correlation table a webhook uses to find the pending payment it's
-- confirming. See backend/paymongo.js, backend/paypal.js,
-- backend/billingRoutes.js.
--
-- A row starts 'pending' the instant a checkout session/order is
-- created (before the payer has done anything), and is flipped to
-- 'paid' by whichever confirms first — the payer's browser returning
-- to the app (PayPal's capture-on-return; PayMongo has no equivalent
-- synchronous step) or the provider's webhook — whichever wins the
-- race. Both paths are idempotent: see the unique index below and the
-- "already paid, no-op" checks in billingRoutes.js.
-- ---------------------------------------------------------
CREATE TYPE payment_provider AS ENUM ('paymongo', 'paypal');
CREATE TYPE subscription_payment_status AS ENUM ('pending', 'paid', 'failed', 'cancelled');

CREATE TABLE subscription_payments (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id             UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    provider             payment_provider NOT NULL,
    -- PayMongo checkout_session id, or PayPal order id. NOT NULL —
    -- there is no legitimate row without a provider reference, because
    -- the row is only ever created immediately after that provider call
    -- succeeds (see billingRoutes.js — a failed create-checkout call
    -- never gets this far).
    provider_reference   TEXT NOT NULL,
    amount_centavos      INTEGER NOT NULL,
    status               subscription_payment_status NOT NULL DEFAULT 'pending',
    -- What this specific payment bought, computed once at checkout
    -- creation time via subscriptions.computeNewPeriodEnd() — recorded
    -- here (not just recomputed later from venues.subscription_paid_until)
    -- so the billing history in the UI can show what each past payment
    -- actually covered, even after later payments moved the venue's
    -- current coverage further out.
    period_start         TIMESTAMPTZ NOT NULL,
    period_end           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at              TIMESTAMPTZ
);

-- One row per (provider, provider_reference): a webhook that fires
-- twice for the same event (both providers document this as expected,
-- not a bug — "at least once" delivery) must not extend a venue's
-- coverage twice. billingRoutes.js's webhook handlers look the row up
-- by this pair and no-op if it's already 'paid'.
CREATE UNIQUE INDEX idx_subscription_payments_provider_ref
    ON subscription_payments (provider, provider_reference);

-- "This venue's billing history" — the query the Billing screen runs.
CREATE INDEX idx_subscription_payments_venue ON subscription_payments (venue_id, created_at DESC);
-- Its updated_at trigger is created below, alongside the other tables'
-- (touch_updated_at() isn't defined until then).

-- ---------------------------------------------------------
-- FEEDBACK — a customer's star rating and optional comment.
--
-- Stored here as the source of truth, and separately emailed to
-- FEEDBACK_EMAIL_TO as a notification (backend/mailer.js). The row is
-- written FIRST and the mail attempted after, deliberately in that
-- order: SMTP is the flakiest dependency in this app and the one most
-- likely to be unconfigured (it is optional, exactly like VAPID keys
-- and the Maps key), and feedback a customer took the trouble to write
-- must not evaporate because a mail server was down or a password was
-- wrong. email_sent_at records whether the notification actually got
-- out, so unsent feedback is findable rather than silently lost.
-- ---------------------------------------------------------
CREATE TABLE feedback (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Who wrote it. ON DELETE SET NULL rather than CASCADE: if the
    -- account goes away the feedback is still worth having, and it
    -- stops being attributable, which is the right outcome for both.
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Optional context: which venue this is about, when the customer
    -- was in a line at the time. NULL means feedback about the app
    -- itself, which is just as valid a thing to send.
    venue_id      UUID REFERENCES venues(id) ON DELETE SET NULL,
    rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment       TEXT,
    email_sent_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Newest feedback first" — how anyone would actually read this table.
CREATE INDEX idx_feedback_created ON feedback (created_at DESC);
-- "Which feedback never made it out by email" — the recovery query if
-- SMTP was misconfigured for a while.
CREATE INDEX idx_feedback_unsent ON feedback (created_at DESC) WHERE email_sent_at IS NULL;

-- ---------------------------------------------------------
-- RATE LIMITS — fixed-window counters, shared across instances.
--
-- Deliberately in Postgres rather than in process memory. The
-- production target is Netlify Functions, where each request may land
-- on a different (or freshly cold-started) container: an in-memory
-- counter there resets constantly and is bypassed simply by making
-- requests fast enough to spread across instances. A counter is only
-- a rate limit if every instance can see it.
--
-- The cost is one extra round-trip per limited request. That is
-- acceptable because the endpoints being limited (login, location
-- pings) already query this same database anyway.
--
-- IF NOT EXISTS so this block can be pasted straight into an already-
-- deployed database without re-running the whole schema. The same goes
-- for push_subscriptions above, if upgrading a database created before
-- it existed:
--
--   ALTER TABLE venues ADD COLUMN IF NOT EXISTS enrollment_qr_ttl_seconds INTEGER NOT NULL DEFAULT 900;
--
--   CREATE TABLE IF NOT EXISTS push_subscriptions (
--       id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--       user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--       endpoint    TEXT NOT NULL UNIQUE,
--       p256dh      TEXT NOT NULL,
--       auth        TEXT NOT NULL,
--       created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
--   );
--   CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
--
--   ALTER TABLE venues ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days');
--   ALTER TABLE venues ADD COLUMN IF NOT EXISTS subscription_paid_until TIMESTAMPTZ;
--
--   CREATE TYPE payment_provider AS ENUM ('paymongo', 'paypal');
--   CREATE TYPE subscription_payment_status AS ENUM ('pending', 'paid', 'failed', 'cancelled');
--   CREATE TABLE IF NOT EXISTS subscription_payments (
--       id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--       venue_id           UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
--       provider           payment_provider NOT NULL,
--       provider_reference TEXT NOT NULL,
--       amount_centavos    INTEGER NOT NULL,
--       status             subscription_payment_status NOT NULL DEFAULT 'pending',
--       period_start       TIMESTAMPTZ NOT NULL,
--       period_end         TIMESTAMPTZ NOT NULL,
--       created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
--       updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
--       paid_at            TIMESTAMPTZ
--   );
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_provider_ref ON subscription_payments (provider, provider_reference);
--   CREATE INDEX IF NOT EXISTS idx_subscription_payments_venue ON subscription_payments (venue_id, created_at DESC);
--
--   CREATE TABLE IF NOT EXISTS feedback (
--       id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--       user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
--       venue_id      UUID REFERENCES venues(id) ON DELETE SET NULL,
--       rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
--       comment       TEXT,
--       email_sent_at TIMESTAMPTZ,
--       created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
--   );
--   CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
--   CREATE INDEX IF NOT EXISTS idx_feedback_unsent ON feedback (created_at DESC) WHERE email_sent_at IS NULL;
--   CREATE TRIGGER trg_touch_subscription_payments BEFORE UPDATE ON subscription_payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
    -- 'purpose:dimension:<sha256 of the identifier>' — see rateLimit.js.
    -- The identifier (IP address, email) is hashed rather than stored
    -- in the clear: this table would otherwise become a second, and
    -- much less guarded, home for personal data whose only purpose is
    -- counting.
    bucket        TEXT PRIMARY KEY,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
    hits          INTEGER NOT NULL DEFAULT 0
);

-- Supports the housekeeping sweep that drops long-finished windows.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);

-- ---------------------------------------------------------
-- Upgrading a database that already exists: add the 'no_show' enum value
-- (added after initial release — see the comment above queue_status).
-- ALTER TYPE ... ADD VALUE cannot run inside a multi-statement transaction
-- block on older Postgres, so run this line on its own against an
-- already-deployed database instead of re-running the whole schema:
--
--   ALTER TYPE queue_status ADD VALUE IF NOT EXISTS 'no_show';
-- ---------------------------------------------------------

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

CREATE TRIGGER trg_touch_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_touch_venue_members
BEFORE UPDATE ON venue_members
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_touch_subscription_payments
BEFORE UPDATE ON subscription_payments
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
