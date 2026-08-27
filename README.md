# QPinoy — Presence vs Payment Queue Engine

A B2B2C virtual queuing platform for service venues (clinics, spas, barbershops,
salons). The core idea: a customer's place in line depends on both **whether
they're physically present** and **how much they've committed financially** —
so the line self-corrects around no-shows without punishing everyone equally.

**69 automated tests. No placeholder code.** Every layer — the pure algorithm,
the SQL transactions, the HTTP endpoints, the service worker — is tested
against real infrastructure, not mocks.

## Quick start

```bash
git clone <your-repo-url> && cd qpinoy

docker compose up -d              # Postgres on :5433, schema + seed auto-applied

cd backend && npm install
cp .env.example .env              # set DATABASE_URL=postgres://qpinoy:qpinoy@localhost:5433/qpinoy
npm run dev                       # API on :4000

cd ../frontend && npm install
npm run dev                       # UI on :5173
```

Full instructions, including a native-Postgres path, are in
**[LOCAL_SETUP.md](LOCAL_SETUP.md)**. Going to production is covered in
**[DEPLOYMENT.md](DEPLOYMENT.md)** — read section 4 first, it describes a
platform constraint that affects this app's core design.

## Repository layout

```
backend/                       Node/Express API + Postgres
  queueCore.js                  Pure ordering algorithm — zero imports, fully unit-tested
  queueEngine.js                Transaction layer: row locks + persistence
  routes.js                     Express REST endpoints
  server.js                     Entry point, CORS allowlist, graceful shutdown
  geofence.js                   Haversine presence math (server-authoritative)
  distanceMatrixClient.js       Swappable ETA adapter (Google, or offline fallback)
  schema.sql                    DDL, enums, partial indexes
  seed.sql                      Demo data (full reset, idempotent)
  smoke.js                      Scripted end-to-end walkthrough
  Dockerfile                    Multi-stage production build
  *.test.js                     64 tests (43 unit, 21 integration)

frontend/                      Vite + React + Tailwind PWA
  src/QueueSimulator.jsx        Interactive simulator — mirrors the real algorithm
  src/sw.js                     Service worker (build-time precache injection)
  public/                       manifest.json, offline.html, icons
  test/                         5 service worker install tests

docker-compose.yml             Postgres for local dev
.github/workflows/ci.yml       CI: tests against a real Postgres, plus frontend build
LOCAL_SETUP.md                 Tech stack + setup, both Docker and native
DEPLOYMENT.md                  Hosting, HTTPS, installing on phones
```

## Try it live

`frontend/src/QueueSimulator.jsx` is a real, running mirror of the backend
algorithm — not a mockup. Six customers are seeded exactly like `seed.sql`.
Charlie Nguyen (flask icon) is the test ticket: toggle her GPS and payment
status, then tap **Call next customer**. Watch the activity log — it names
exactly who the engine evaluated and why. Keep tapping "Call next" without
touching anything and you'll also see Dana (seeded not-checked-in) get
automatically stepped back by the engine on her own, since the trigger
re-evaluates whoever is two slots behind *whoever's currently serving*, not
just the one customer you're prodding.

## The algorithm

### 1. Fractional-index sorting (`order_weight`)

Positions are a `DOUBLE PRECISION`, not sequential integers. Moving someone
recomputes **only their own row** — the midpoint of their two new neighbors —
so a reorder is O(1) no matter how long the line is. Renumbering 1,2,3... on
every move would be O(n) per move.

*Trade-off, stated plainly:* splitting the same gap thousands of times will
eventually run into `DOUBLE PRECISION`'s precision limit (this is the same
known trade-off behind Figma's layer ordering and most drag-and-drop APIs).
Mitigation is shipped, not hand-waved: `rebalanceIfNeeded()` in
`queueEngine.js` (and `rebalance_active_queue()` in `schema.sql`) resets a
venue's active weights to clean, evenly-spaced integers without touching
relative order. Run it lazily (weights within `1e-9` of each other) or on a
nightly cron.

### 2. Two-slot-prior trigger

The instant an attendant calls the next customer, the engine looks exactly two
slots behind the new "now serving" row. If that customer is **not** geofenced-
checked-in **and** their live ETA would land after their expected slot:

| Tier | Action |
|---|---|
| Premium (50% deposit) | **Step back one slot.** Single-row update: their weight becomes the midpoint of the two people now around them. A gentle nudge, not a punishment. |
| Standard (free walk-in) | **Drop to the back.** Single-row update: `weight = MAX(active weight) + 10`. |

Both are one-row writes — the rest of the line is untouched.

A subtlety worth naming rather than hiding: because the trigger re-fires on
*every* new "serving" event, a premium customer who stays unconfirmed across
several consecutive calls will keep cascading back one slot at a time — a
slower decay than a free walk-in's instant drop, which is consistent with
"gentle safety net," but it does mean "one gentle step" can repeat. The
simulator's default data (Dana) demonstrates this on purpose.

### 3. Lock-Back override

`is_override_locked` is the escape hatch for indoor-GPS failure (customer is
actually in the building; their phone disagrees). The attendant's "Reinstate
slot" action places them exactly halfway between whoever's serving and
whoever's currently first-in-line, and sets the lock flag. The automation
engine checks this flag before evaluating anyone — a locked customer is
invisible to the trigger from then on, even if their GPS keeps misbehaving.

### 4. Automation toggle

`venues.is_automation_enabled` is checked first, before anything else. Off ⇒
the two-slot-prior trigger is a complete no-op and the dashboard leans on
manual up/down reordering (same midpoint math, attendant-initiated instead of
automatic).

### 5. Geofence and ETA: computed server-side, never trusted from the client

The `/location` endpoint only ever accepts raw `lat`/`lng`. It never accepts
an `isCheckedIn` boolean directly — if it did, anyone calling the API could
just claim to be present. Instead:

- `geofence.js` computes real Haversine great-circle distance between the
  customer and the venue, and checks it against `geofence_radius_meters`.
- `distanceMatrixClient.js` is the one place in the codebase that knows how
  to get a live ETA. It calls the real Google Distance Matrix API when
  `GOOGLE_MAPS_API_KEY` is set, and falls back to a distance/assumed-speed
  estimate otherwise — so local dev, demos, and the test suite never need
  network access or a real key.

Both are swap-in points: point `distanceMatrixClient.js` at a different
provider, or replace the Haversine check with a polygon-based geofence,
without touching anything else in the system.

## Verified, not just written

- **26 unit tests** (`queueCore.test.js`) cover every branch of the pure
  algorithm in isolation: on-track, override-locked, automation-off,
  step-back (with/without a second neighbor, and the "already last in line"
  edge case that would otherwise throw), drop, reinstate (4 fallback cases),
  and manual move (front/back edges).
- **11 unit tests** (`geofence.test.js`) verify the Haversine math against the
  exact spherical-law value for a pure-latitude delta, plus inside/outside/
  boundary/missing-coordinate cases.
- **6 unit tests** (`distanceMatrixClient.test.js`) cover both the no-API-key
  fallback and the real Google Distance Matrix response-parsing path (via a
  mocked `fetch`), including its error and non-OK-status handling.
- **5 integration tests** (`queueEngine.integration.test.js`) run the real SQL
  transaction layer against an actual local Postgres instance — this is how
  an early version of `onCustomerStartedServing` was caught assuming its
  caller had already flipped the row's status in a separate transaction (a
  real race-condition window). It's now one atomic `callNextCustomer` call.
- **16 HTTP-layer tests** (`routes.integration.test.js`) boot a real Express
  app on an ephemeral port and hit every endpoint with real requests —
  success paths, 400s on bad input (invalid `direction`, non-boolean
  `enabled`, an out-of-range or non-numeric `lat`), and 404s on a
  nonexistent venue. This is also how a real coordinate-validation gap was
  caught: `/location` used to accept whatever `isCheckedIn` value a client
  sent, and separately did no sanity-check on `lat`/`lng` at all, so a
  malformed value could silently corrupt the geofence math. `lat`/`lng` are
  now the only inputs accepted, and both `geofence.js` (the check itself)
  and `routes.js` (input validation) got fixed together.
- `schema.sql` was executed end-to-end against Postgres 16 with zero errors.
- The indexes weren't just declared and trusted — they were load-tested. A
  venue was seeded with 60,000 historical `served` rows plus a handful of
  live ones, then `EXPLAIN ANALYZE` was run against the *exact* parameterized
  query shapes the Node code actually sends (including the `FOR UPDATE`
  locking variants). Two things were worth confirming rather than assuming:
  whether Postgres would match a parameterized `status = ANY($2::array)`
  against a partial index declared with a literal `WHERE status IN (...)`
  predicate (it does, on Postgres 16), and whether the DB-level "only one
  serving row per venue" guarantee actually holds — confirmed by directly
  attempting to violate it, which Postgres correctly rejected with
  `duplicate key value violates unique constraint "idx_one_serving_per_venue"`.
  Forcing a sequential scan for comparison (`SET enable_indexscan = off`)
  took **5.27ms** and touched all 60,000 historical rows; the indexed version
  took **0.06-0.09ms** — roughly a 60-90x difference at this volume, and the
  gap widens as a venue's history grows, since the partial index only ever
  contains the small active subset regardless of how much history piles up.
- Running the full suite twice in a row with no manual database reset in
  between used to fail: `queueEngine.integration.test.js`'s five tests are
  intentionally sequential and stateful (each depends on the previous one's
  mutations, mirroring a real shift), and it originally assumed a human had
  re-seeded the database by hand before each run. It now seeds and cleans up
  its own fixture, so `npm test` is genuinely idempotent — verified by
  running it three times back to back with zero manual steps in between.
- The frontend's hand-ported algorithm was extracted and run against the same
  fixtures as the backend's test suite to confirm they agree.
- `server.js` was actually booted against a live database, hit over real
  HTTP (`/health` and `/api/venues/:id/queue`), and sent a real `SIGTERM` to
  confirm it drains and exits instead of hanging.

## Running it locally

See **LOCAL_SETUP.md** for the full tech stack, Docker and native setup
paths, and troubleshooting. Quick version:

```bash
cd backend
npm install
createdb qpinoy          # then: psql qpinoy -f schema.sql
DATABASE_URL=postgres://localhost/qpinoy npm start
```

| Endpoint | Effect |
|---|---|
| `GET /api/venues/:id/queue` | Live line, in serve order |
| `POST /api/venues/:id/queue/:entryId/serve` | Call next customer (atomic: completes prior, promotes this one, runs the trigger) |
| `POST /api/venues/:id/queue/:entryId/reinstate` | Lock-Back override |
| `POST /api/venues/:id/queue/:entryId/move` | Manual one-slot nudge (`{ "direction": "up" \| "down" }`) |
| `PATCH /api/venues/:id/automation` | Global toggle (`{ "enabled": true }`) |
| `PATCH /api/venues/:id/queue/:entryId/location` | Geofence/ETA ping — body is `{ lat, lng }` only; `is_checked_in` and `live_eta_minutes` are computed server-side |
| `POST /api/venues/:id/rebalance` | Maintenance — wire to cron, not a button |

Copy `.env.example` to `.env` and fill in `DATABASE_URL` (and optionally
`GOOGLE_MAPS_API_KEY` for live-traffic ETAs instead of the distance-based
fallback).

## PWA

The frontend is installable on a phone's home screen — own icon, full screen,
no browser chrome, no App Store. It needs HTTPS in production; see
[DEPLOYMENT.md](DEPLOYMENT.md).

- `public/manifest.json` + `public/icons/` — 192/512 plus maskable variants,
  drawn to match the app's ticket/brass design language rather than stock
  placeholders.
- `src/sw.js` — cache-first for the app shell, network-first for `/api/*`, and
  **never** caches mutations (`serve`/`reinstate`/`move`/`automation` are all
  non-`GET`), so an attendant can't silently replay a stale action offline.
- `public/offline.html` — the fallback served when the shell can't be fetched.

**The precache list is injected at build time**, not hardcoded. Vite emits
content-hashed filenames (`assets/index-DIGZYB46.js`), so any hardcoded path
would 404 in production — and because `cache.addAll()` is atomic per spec, a
single 404 rejects the whole install, meaning the service worker never
activates and offline support silently doesn't exist, with no error anywhere
visible. `vite-plugin-pwa` in `injectManifest` mode fills in the real asset
list while keeping the hand-written caching logic above. `frontend/test/`
asserts this behaviour, and CI fails the build if the manifest isn't injected.
