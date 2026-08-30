# QPinoy — Presence vs Payment Queue Engine

A B2B2C virtual queuing platform for service venues (clinics, spas, barbershops,
salons). The core idea: a customer's place in line depends on both **whether
they're physically present** and **how much they've committed financially** —
so the line self-corrects around no-shows without punishing everyone equally.

**177 automated tests. No placeholder code.** Every layer — the pure algorithm,
the SQL transactions, the HTTP endpoints, the service worker — is tested
against real infrastructure, not mocks.

## Recent additions

- **No-show, distinct from served.** Calling the next customer used to
  auto-mark whoever was previously `serving` as `served`, even if they
  never showed up — silently poisoning any future no-show-rate or
  service-time analytics. `POST /venues/:id/queue/:entryId/no-show`
  (`routes.js`, `queueEngine.js:markNoShow`) lets an attendant record a
  no-show explicitly, before calling the next customer, instead.
- **Staff no longer see raw coordinates.** `GET /venues/:id/queue` used
  to `SELECT *`, which included `last_lat`/`last_lng` in the JSON
  response even though the UI never rendered them. The query is now an
  explicit column list — staff see presence *state* ("checked in" / "at
  risk"), never a customer's exact location.
- **Remote self-join.** Every join path used to require a staff member
  scanning the customer's QR. `GET /venues/:id/public` (no auth) plus
  `POST /venues/:id/queue/join` (signed-in customer, no staff involved)
  let a venue share a link/QR — `frontend/src/JoinVenue.jsx` is the
  landing page, and the attendant console has a "Join link" card
  (`AttendantDashboard.jsx`) to generate it.
- **Web Push notifications.** The queue engine now sends a real push
  notification at the moments DEPLOYMENT.md (§4) called out — "it's your
  turn," "you're next," "you were temporarily skipped" — instead of
  relying entirely on the customer keeping a tab open and polling.
  `backend/push.js` wraps `web-push`; no-ops cleanly when `VAPID_PUBLIC_KEY`/
  `VAPID_PRIVATE_KEY` aren't set, the same fallback shape
  `distanceMatrixClient.js` uses for `GOOGLE_MAPS_API_KEY`.

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
  routes.js                     Express REST endpoints for the queue (all staff-gated)
  authRoutes.js                 Register, login, /me, enrollment token, my-place-in-line
  venueRoutes.js                Venue creation + the staff roster
  auth.js                       Middleware: requireAuth, requireVenueRole
  password.js                   scrypt hashing (node:crypto, no native dep)
  tokens.js                     Signed session + QR enrollment tokens
  rateLimit.js                  Postgres-backed throttling (login, location)
  app.js                        The Express app itself — no listen(), no process lifecycle
  db.js                         Shared pg Pool factory (SSL auto-detect, serverless-aware sizing)
  server.js                     Process bootstrap for Docker/Render/local dev: app.js + db.js + listen()
  geofence.js                   Haversine presence math (server-authoritative)
  distanceMatrixClient.js       Swappable ETA adapter (Google, or offline fallback)
  push.js                       Web Push notifications (no-ops without VAPID keys)
  schema.sql                    DDL, enums, partial indexes
  seed.sql                      Demo data (full reset, idempotent)
  smoke.js                      Scripted end-to-end walkthrough
  seedAccounts.js               Demo logins, one per role (hashing can't live in .sql)
  Dockerfile                    Multi-stage production build
  .env.example                  Copy to .env for local dev
  *.test.js                     172 tests (82 unit, 90 integration)

netlify/functions/api.js       Wraps backend/app.js with serverless-http for Netlify deploys

frontend/                      Vite + React + Tailwind PWA
  src/App.jsx                   Auth-aware router shell; picks a home screen per role
  src/auth.jsx                  AuthProvider — session state, revalidated on every boot
  src/AuthScreens.jsx           Sign in / register
  src/VenueSetup.jsx            First-run venue creation for a business account
  src/AttendantDashboard.jsx    Staff console — scan customers, call next, no-show, reinstate, move
  src/QrScanner.jsx             Camera QR reader (BarcodeDetector, jsQR fallback, manual entry)
  src/StaffMembers.jsx          The staff roster: authorize and revoke
  src/CustomerHome.jsx          The customer's check-in QR, live position, and notifications toggle
  src/JoinVenue.jsx             Remote self-join landing page ("/join?venue=<id>")
  src/InstallPrompt.jsx         Android install banner (captures beforeinstallprompt)
  src/api.js                    Fetch client for the backend (attaches the Bearer token)
  src/QueueSimulator.jsx        In-memory algorithm demo — mirrors the real algorithm, no backend needed
  src/sw.js                     Service worker (build-time precache injection, push notifications)
  public/                       manifest.json, offline.html, icons
  test/                         5 service worker install tests

netlify.toml                   Netlify build, redirects (SPA + /api/*), and headers
docker-compose.yml              Postgres for local dev
.github/workflows/ci.yml       CI: tests against a real Postgres, plus frontend build
LOCAL_SETUP.md                 Tech stack + setup, both Docker and native
DEPLOYMENT.md                  Hosting (Netlify+Neon, or Render+Neon), HTTPS, installing on Android
```

## Try it live

`npm run db:setup` seeds four demo logins against the demo venue, one
per role, all with the password `demo-password-123`:

| Login | What you'll see |
|---|---|
| `owner@qpinoy.demo` | Staff console + the staff roster |
| `manager@qpinoy.demo` | Same — managers can also edit staff |
| `attendant@qpinoy.demo` | Staff console, **no** Staff button |
| `customer@qpinoy.demo` | A rotating check-in QR and their place in line |

The fastest way to see the whole loop: open the customer login on your
phone and the owner login on your laptop, hit **Scan customer**, and
point the laptop's webcam at the phone. (No camera? The scanner has an
"Enter manually" fallback that takes the same code as text.)

The app routes you by role automatically:

- **Staff** land on the live console: the real queue from Postgres,
  with call-next / reinstate / move / rebalance, plus **Scan customer**
  and a walk-in form for people without the app.
- **Customers** land on their check-in QR and their live position, with
  a "Share my location" button that geofences them in server-side (see
  [DEPLOYMENT.md §4](DEPLOYMENT.md) for the platform limits this works
  within) and, when `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set, a
  "Turn on notifications" card that works even with the app closed.
- **`/demo`** — reachable signed-out — is
  `frontend/src/QueueSimulator.jsx`, a real, running mirror
  of the backend algorithm with no backend required — not a mockup, just
  in-memory. Six customers are seeded exactly like `seed.sql`. Charlie
  Nguyen (flask icon) is the test ticket: toggle her GPS and payment
  status, then tap **Call next customer**. Watch the activity log — it
  names exactly who the engine evaluated and why. Keep tapping "Call
  next" without touching anything and you'll also see Dana (seeded
  not-checked-in) get automatically stepped back by the engine on her
  own, since the trigger re-evaluates whoever is two slots behind
  *whoever's currently serving*, not just the one customer you're
  prodding.

## Accounts and roles

Two kinds of people use QPinoy, and they meet at a QR code.

**Customers register themselves** — but signing up does not put anyone
in a line. To join a venue's queue, the customer opens the app and
shows their **check-in QR code**; a staff member scans it with their
own phone. That scan is the enrollment. It means a venue's line only
ever contains people who physically turned up and consented, and it
means the customer never has to type anything.

**Businesses register, then create a venue**, which makes them its
owner. Owners delegate with two roles:

| Role | Run the line | Enroll customers | Edit the staff list |
|---|:---:|:---:|:---:|
| **owner** | ✅ | ✅ | ✅ |
| **manager** | ✅ | ✅ | ✅ |
| **attendant** | ✅ | ✅ | ✕ |

Permissions come **only** from a user's `venue_members` row for that
venue — never from their account type. One account can be a customer
at the barber downstairs and an attendant at their own shop.

### Why the QR code is a signed token, not a user ID

`GET /me/enrollment-token` returns a **90-second signed token** that
the phone renders as a QR code and silently re-issues before it
expires. A static identifier would be a permanent credential
displayed on a screen in a public waiting room — photograph it once,
reuse it forever. The customer's identity is read from the token's
signature, so a scan cannot be redirected at someone else by editing
the request body (there's a test that tries exactly that).

The same token module signs login sessions, with one hard rule: every
token declares its purpose, and verification requires the caller to
state which purpose it expects. A QR code can therefore never be
replayed as a login session.

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
- **21 HTTP-layer tests** (`routes.integration.test.js`) boot a real Express
  app on an ephemeral port and hit every endpoint with real requests —
  success paths, 400s on bad input (invalid `direction`, non-boolean
  `enabled`, an out-of-range or non-numeric `lat`), and 404s on a
  nonexistent venue. This is also how a real coordinate-validation gap was
  caught: `/location` used to accept whatever `isCheckedIn` value a client
  sent, and separately did no sanity-check on `lat`/`lng` at all, so a
  malformed value could silently corrupt the geofence math. `lat`/`lng` are
  now the only inputs accepted, and both `geofence.js` (the check itself)
  and `routes.js` (input validation) got fixed together.
- **21 unit tests** for the auth primitives (`password.test.js`,
  `tokens.test.js`) — and these are the ones worth reading, because
  hand-rolled auth is exactly where "looks fine" isn't good enough.
  They assert the attacks *fail*: an `alg: none` header is rejected
  (the algorithm is never read from the token, so the canonical JWT
  bypass has nothing to grab); a tampered payload fails the signature;
  a token signed with a different secret is refused; an enrollment QR
  cannot be replayed as a login session, nor a session scanned as a QR;
  a token with no `exp` is treated as expired rather than eternal; and
  a missing or short `AUTH_SECRET` throws at startup instead of
  silently falling back to a default. On the password side: identical
  passwords produce different hashes (per-row salt), a hash written
  with *older, cheaper* scrypt parameters still verifies (which is why
  the parameters are stored in the hash string rather than a constant),
  and a corrupt stored hash reads as "wrong password" instead of a 500.
- **23 integration tests** (`auth.integration.test.js`) drive the whole
  account model over real HTTP against a real database — registration,
  login, delegation, the QR scan — and pin the authorization boundaries
  that are the entire point of having accounts: anonymous callers are
  refused; a signed-in stranger gets a **404** rather than a 403 on a
  venue they don't staff (a 403 would confirm the venue exists and turn
  the endpoint into an ID enumerator); an attendant cannot edit the
  staff list but a manager can; the owner row cannot be demoted or
  deleted; revoking access takes effect on the very next request; a
  wrong password and an unknown account return byte-identical replies
  so the endpoint can't be used to discover who has signed up; and a
  customer cannot push location into a stranger's ticket.
- **22 tests for rate limiting** (`rateLimit.test.js`,
  `rateLimit.integration.test.js`), and one of them found a real flaw
  in the first draft. The limiter originally keyed the login counter on
  the email address alone — which meant ten wrong guesses would lock
  the *real owner* out of their own account, from their own phone. The
  test asserting "a blocked attacker cannot lock the real user out"
  failed, and the fix was to key on the **(email, IP) pair** instead.
  Worth stressing why the obvious mitigation doesn't work: "only
  failures count and a success clears the counter" reads like it
  solves this, but the limit is checked *before* the password is
  verified, so the victim never reaches the clearing step. The
  remaining tests pin down the rest: concurrent `record()` calls never
  lose an increment (the increment is one statement precisely so
  parallel requests can't both read N and both write N+1); windows
  roll over; a successful login does **not** refill the broad per-IP
  spraying budget (or an attacker with one valid account would have a
  free reset button); failures against unknown addresses are counted
  too (otherwise the presence of throttling would itself reveal which
  emails are registered); and bucket keys hash the identifier so this
  table never becomes a second home for emails and IPs.
- A second real bug in `/location`, caught the same way: its final `UPDATE`
  scoped the write by `entryId` alone, not by `venue_id`. An `entryId` that
  actually belonged to a *different* venue would still match and get
  silently overwritten with the wrong venue's geofence result, and a
  nonexistent `entryId` returned a fabricated `200` instead of `404`. Fixed
  by scoping the `UPDATE` with `AND venue_id = $6` and checking `rowCount`;
  two new tests (cross-venue write, nonexistent entry) pin this down.
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

All `/api/venues/*` endpoints below require a `Bearer` session token
whose user holds a role at that venue. See "Accounts and roles" above.

| Endpoint | Effect |
|---|---|
| `POST /api/auth/register` | Self-service signup (`{ email, password, fullName, phone?, accountType? }`) |
| `POST /api/auth/login` | Returns a 30-day session token |
| `GET /api/auth/me` | Current user + every venue they staff |
| `GET /api/me/enrollment-token` | Short-lived token the customer's phone renders as a QR code |
| `GET /api/me/queue` | The customer's own live tickets, with position computed server-side |
| `GET /api/push/vapid-public-key` | The server's VAPID public key, or `null` if push isn't configured — no auth |
| `POST`/`DELETE /api/me/push-subscription` | Register/remove this device's Web Push subscription |
| `POST /api/venues` | Create a venue; creator becomes its owner |
| `GET /api/venues/mine` | Venues the signed-in user staffs |
| `GET /api/venues/:id/public` | Public venue info for a "join our line" link/QR — no auth |
| `GET`/`POST` `/api/venues/:id/members` | Staff roster / authorize someone (owner + manager only) |
| `DELETE /api/venues/:id/members/:userId` | Revoke staff access (owner + manager only) |

| Queue endpoint | Effect |
|---|---|
| `GET /api/venues/:id/queue` | Live line, in serve order (never includes raw `last_lat`/`last_lng`) |
| `POST /api/venues/:id/queue/enroll` | **Scan a customer in** (`{ enrollmentToken, paymentTier? }`) — staff-initiated |
| `POST /api/venues/:id/queue/join` | **Self-join remotely** — signed-in customer, no staff scan; always `standard_free` tier |
| `POST /api/venues/:id/queue` | Add a walk-in with no account, by name (`{ customerName, customerPhone?, paymentTier? }`) |
| `POST /api/venues/:id/queue/:entryId/serve` | Call next customer (atomic: completes prior, promotes this one, runs the trigger, sends push) |
| `POST /api/venues/:id/queue/:entryId/no-show` | Mark the currently-serving customer a no-show (before calling next — otherwise they'd be recorded as served) |
| `POST /api/venues/:id/queue/:entryId/reinstate` | Lock-Back override |
| `POST /api/venues/:id/queue/:entryId/move` | Manual one-slot nudge (`{ "direction": "up" \| "down" }`) |
| `PATCH /api/venues/:id/automation` | Global toggle (`{ "enabled": true }`) |
| `PATCH /api/venues/:id/queue/:entryId/location` | Geofence/ETA ping — body is `{ lat, lng }` only; `is_checked_in` and `live_eta_minutes` are computed server-side |
| `POST /api/venues/:id/rebalance` | Maintenance — wire to cron, not a button |

Copy `.env.example` to `.env` and fill in `DATABASE_URL` (and optionally
`GOOGLE_MAPS_API_KEY` for live-traffic ETAs instead of the distance-based
fallback, and `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` for push notifications —
generate a pair with `npx web-push generate-vapid-keys`).

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
