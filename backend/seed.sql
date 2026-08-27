-- =========================================================
-- QPinoy — local development seed data
-- =========================================================
-- Deliberately a FULL RESET, not an upsert. Re-running this puts the
-- demo venue back to a known starting line every single time, which
-- is what you want when you're clicking through the same scenario
-- repeatedly. An `ON CONFLICT DO NOTHING` version silently leaves
-- yesterday's half-served queue in place and makes the demo behave
-- differently on the second run.
--
-- Usage:  psql "$DATABASE_URL" -f seed.sql
-- =========================================================

BEGIN;

DELETE FROM queue_entries WHERE venue_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM venues        WHERE id       = '00000000-0000-0000-0000-000000000001';

INSERT INTO venues (id, name, address, geofence_lat, geofence_lng, geofence_radius_meters, avg_service_minutes, is_automation_enabled)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Riverside Dermatology',
  '120 Riverside Dr',
  40.7128, -74.0060,   -- lower Manhattan; matches the frontend simulator's fixture
  150,                 -- 150m geofence
  6,
  TRUE
);

-- Six customers, matching the frontend simulator's seed exactly so the
-- in-browser demo and the real API tell the same story.
--
--   Alice   premium, at venue          -> safe
--   Bob     free,    at venue          -> safe
--   Charlie free,    at venue          -> safe (the simulator's "test ticket")
--   Dana    premium, away + 25min ETA  -> AT RISK, will be stepped back one slot
--   Ethan   free,    away + 20min ETA  -> AT RISK, will be dropped to the back
--   Fiona   free,    at venue          -> safe
INSERT INTO queue_entries
  (id, venue_id, customer_name, customer_phone, status, payment_tier, order_weight, is_checked_in, live_eta_minutes, expected_slot_at)
VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Alice Chen',    '+15550100','waiting','premium_secured',10,TRUE, 2, now()+interval '0 minutes'),
  ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Bob Martinez',  '+15550101','waiting','standard_free',  20,TRUE, 3, now()+interval '6 minutes'),
  ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Charlie Nguyen','+15550102','waiting','standard_free',  30,TRUE, 2, now()+interval '12 minutes'),
  ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','Dana Osei',     '+15550103','waiting','premium_secured',40,FALSE,25,now()+interval '18 minutes'),
  ('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','Ethan Brooks',  '+15550104','waiting','standard_free',  50,FALSE,20,now()+interval '24 minutes'),
  ('10000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','Fiona Alvarez', '+15550105','waiting','standard_free',  60,TRUE, 4, now()+interval '30 minutes');

COMMIT;

\echo ''
\echo 'Seeded: Riverside Dermatology (venue 00000000-0000-0000-0000-000000000001)'
\echo 'Line:   Alice, Bob, Charlie, Dana(at-risk), Ethan(at-risk), Fiona'
\echo ''
