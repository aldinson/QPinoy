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
--
-- ⚠ ALWAYS follow this with `npm run db:seed:accounts`, or use
--   `npm run db:setup`, which chains both in the right order.
--
--   Deleting the demo venue below cascades to venue_members (see
--   schema.sql), so running this file ALONE silently strips
--   owner@/manager@/attendant@qpinoy.demo of their access: they can
--   still log in, but land on the "create your venue" onboarding
--   screen instead of the console, as though the venue were gone.
--   seedAccounts.js re-grants those memberships and is idempotent, so
--   re-running it is always safe.
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

-- =========================================================
-- Directory venues — for exercising customer-side search and
-- remote join (GET /venues?q=, POST /venues/:id/queue/join).
-- =========================================================
-- The single venue above is enough to test the QUEUE, but not the
-- "find a business" flow: one row can't show filtering working, or
-- an empty line, or a busy one. These five are deliberately varied
-- in name, trade, and how many people are waiting, and are spread
-- across real Metro Manila coordinates so the geofence maths gets
-- plausible inputs rather than lower-Manhattan ones.
--
-- Deliberately NOT given venue_members rows: these exist to be found
-- and joined by a customer, and leaving them unstaffed keeps the
-- demo owner's console showing exactly one venue (its own) instead
-- of a picker with six.
--
-- trial_ends_at defaults to 14 days out (see schema.sql), so all of
-- these are inside their trial and joinable while SUBSCRIPTION_ENABLE
-- is on — a past_due venue would 402 the join and make this test data
-- useless for its one purpose.

DELETE FROM queue_entries WHERE venue_id IN (
  '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005',
  '00000000-0000-0000-0000-000000000006'
);
DELETE FROM venues WHERE id IN (
  '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005',
  '00000000-0000-0000-0000-000000000006'
);

INSERT INTO venues (id, name, address, geofence_lat, geofence_lng, geofence_radius_meters, avg_service_minutes, is_automation_enabled)
VALUES
  ('00000000-0000-0000-0000-000000000002','Sunrise Family Clinic',      '12 Katipunan Ave, Quezon City', 14.6390, 121.0770, 150, 12, TRUE),
  ('00000000-0000-0000-0000-000000000003','Kuya Ben Barbershop',        '88 Aguirre Ave, Parañaque',     14.4680, 121.0180, 100,  8, TRUE),
  ('00000000-0000-0000-0000-000000000004','Serenity Spa & Wellness',    '5 Burgos Circle, Taguig',       14.5510, 121.0490, 120, 45, TRUE),
  ('00000000-0000-0000-0000-000000000005','Bright Smile Dental Studio', '210 Banawe St, Quezon City',    14.6280, 120.9950, 130, 30, TRUE),
  ('00000000-0000-0000-0000-000000000006','Glow Hair Salon Makati',     '77 Jupiter St, Makati',         14.5610, 121.0270, 110, 40, TRUE);

-- A couple of these start with people already waiting so the search
-- list shows a mix of "No one waiting" and a real headcount, and so
-- joining one visibly lands you behind somebody.
INSERT INTO queue_entries
  (venue_id, customer_name, customer_phone, status, payment_tier, order_weight, is_checked_in, live_eta_minutes, expected_slot_at)
VALUES
  ('00000000-0000-0000-0000-000000000002','Marites Bautista','+639170000201','waiting','standard_free',  10,TRUE, 3, now()+interval '5 minutes'),
  ('00000000-0000-0000-0000-000000000002','Jomar Villanueva','+639170000202','waiting','standard_free',  20,TRUE, 6, now()+interval '17 minutes'),
  ('00000000-0000-0000-0000-000000000003','Ricardo Santos',  '+639170000301','waiting','standard_free',  10,TRUE, 2, now()+interval '4 minutes'),
  ('00000000-0000-0000-0000-000000000005','Liza Mendoza',    '+639170000501','waiting','premium_secured',10,FALSE,15,now()+interval '10 minutes'),
  ('00000000-0000-0000-0000-000000000005','Paolo Reyes',     '+639170000502','waiting','standard_free',  20,TRUE, 5, now()+interval '40 minutes'),
  ('00000000-0000-0000-0000-000000000005','Angelica Cruz',   '+639170000503','waiting','standard_free',  30,TRUE, 8, now()+interval '70 minutes');
-- Serenity Spa and Glow Hair Salon are left empty on purpose: the
-- "No one waiting" state needs a venue to exercise it too.

COMMIT;

\echo ''
\echo 'Seeded: Riverside Dermatology (venue 00000000-0000-0000-0000-000000000001)'
\echo 'Line:   Alice, Bob, Charlie, Dana(at-risk), Ethan(at-risk), Fiona'
\echo ''
\echo 'Plus 5 directory venues for search/remote-join testing:'
\echo '  Sunrise Family Clinic       (2 waiting)'
\echo '  Kuya Ben Barbershop         (1 waiting)'
\echo '  Serenity Spa & Wellness     (empty)'
\echo '  Bright Smile Dental Studio  (3 waiting)'
\echo '  Glow Hair Salon Makati      (empty)'
\echo ''
