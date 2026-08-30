# QPinoy — Product & Technical Validation Audit

Audit-only review. No source files were modified. All findings are sourced from
the actual code at commit `cc62c4a` (see footer), not from documentation
claims alone. Where documentation asserts something the code doesn't back up,
this is flagged explicitly.

---

## 0. Framing note — read this before anything else

The audit brief (sections 1–2) describes a **hypothetical MVP**: a plain
GPS-availability queue with states like "too far / approaching / ready."

The actual codebase is a **different, more specific product**: a
"Presence vs Payment" queue engine (see `README.md:1-10`) where a customer's
position depends on *both* physical presence (GPS + geofence) *and* a
payment-tier commitment (`premium_secured` 50% deposit vs `standard_free`
walk-in). This is not a gap — it's a deliberate, already-implemented business
model that the brief never mentions. It is more architecturally advanced
than "does QPinoy have GPS at all" — it already has geofencing, live ETA, and
an automated at-risk/step-back/drop algorithm with 136+ tests.

This changes the shape of the audit: the codebase is not a bare-bones MVP
missing location awareness — location awareness is arguably its most
developed feature. What's genuinely missing is notifications, multi-provider
concurrency (multi-doctor clinics), and the "temporarily skipped, returning"
customer-declared-availability model the brief specifically asks for (the
current system infers risk from GPS+ETA only; it never asks the customer
"are you available?").

---

## 1–4. System understanding, actual tech stack, architecture map

### Actual technology stack (verified in code, not docs)

| Layer | Technology | Evidence |
|---|---|---|
| Backend framework | Express 4.19 | `backend/package.json:19`, `backend/app.js` |
| Database | PostgreSQL 16, raw `pg` driver, **no ORM** | `backend/db.js`, `backend/schema.sql` |
| Auth | Custom HMAC-SHA256 signed tokens (JWT-shaped, not a JWT library), scrypt password hashing | `backend/tokens.js`, `backend/password.js` |
| Rate limiting | Postgres-backed fixed-window counters (not Redis, not in-memory) | `backend/rateLimit.js`, `schema.sql:233-245` |
| Frontend framework | React 18 + Vite 5 + Tailwind, no router library (hand-rolled `pushState`) | `frontend/src/App.jsx:15-32` |
| PWA | `vite-plugin-pwa` (injectManifest mode) + hand-written service worker | `frontend/src/sw.js` |
| Native wrapper | Capacitor 6, Android only (`frontend/android/`), iOS explicitly out of scope | `frontend/capacitor.config.json`, `DEPLOYMENT.md:205-206` |
| Location | Browser Geolocation API (`navigator.geolocation.watchPosition`) client-side; server-side Haversine geofence | `frontend/src/CustomerHome.jsx:128-150`, `backend/geofence.js` |
| ETA/Maps | Google Distance Matrix API, with a no-key straight-line fallback | `backend/distanceMatrixClient.js` |
| Maps UI | **None.** No map is rendered anywhere in the frontend — coordinates are consumed only as numbers | confirmed by absence in `frontend/src` |
| Notifications (SMS/push/email) | **None implemented.** Zero SMS, push, or email code anywhere in the repo | grep across `backend/` and `frontend/src` — see §12 |
| Hosting | Netlify Functions + Neon Postgres (primary path), or Render + Neon (Docker) | `netlify.toml`, `backend/Dockerfile`, `DEPLOYMENT.md` |
| QR | `qrcode` (generate) + `jsQR`/`BarcodeDetector` (scan) | `frontend/src/CustomerHome.jsx`, `frontend/src/QrScanner.jsx` |

### System map

```
Customer phone (PWA)              Staff phone/laptop (PWA)
   │  React + Vite                    │  React + Vite
   │  Geolocation API                 │  BarcodeDetector/jsQR camera scan
   ▼                                  ▼
        api.js  (fetch, Bearer token, localStorage)
                    │
                    ▼
        Express app.js  (single origin, /api/*)
          attachUser → requireAuth → requireVenueRole
                    │
        ┌───────────┼────────────────┐
        ▼           ▼                ▼
   authRoutes   venueRoutes      routes.js (queue)
                    │                │
                    ▼                ▼
                          queueEngine.js (transactions, row locks)
                                │
                                ▼
                          queueCore.js (pure algorithm, zero imports)
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          geofence.js   distanceMatrixClient.js   Postgres 16
          (Haversine)   (Google API or fallback)  (schema.sql)

No notification layer exists between "queue state changes" and "customer's
phone learns about it" other than the customer's own polling loop (5s) and
push-less browser tab.
```

### Main entities (from `schema.sql`)

`users`, `venues`, `venue_members` (join table = the entire authorization
model), `queue_entries`, `rate_limits`. Five tables total. No `services`,
`appointments`, `staff_shifts`, `queues` (plural), `notifications`, or
`subscriptions` tables exist.

### Main API endpoints

See `README.md:360-382` for the full table — verified accurate against
`routes.js`, `authRoutes.js`, `venueRoutes.js`. Not reproduced here in full;
notable confirmed absences: no `DELETE /queue/:entryId` (cancel), no
`POST /queue/:entryId/no-show`, no `GET /venues/:id/reports`.

### Main user roles (actually implemented)

Two tables of identity, not four:
- **`users.account_type`**: `customer` | `business` — cosmetic only, decides
  the landing screen (`App.jsx:123-136`), never checked for permissions
  (`auth.js:9-14`, explicit design comment).
- **`venue_members.role`**: `owner` | `manager` | `attendant` — this table
  *is* the entire authorization model (`schema.sql:101-105`).

Mapped against the brief's four roles:

| Brief role | Exists? | Evidence |
|---|---|---|
| CUSTOMER | ✅ Implemented | `queue join`, `view position`, `leave` ❌ missing, `check status` ✅, `confirm availability` ❌ missing (see §11), `share location` ✅ |
| STAFF/RECEPTIONIST | ✅ = `attendant` role | Full queue operations except editing staff |
| BUSINESS ADMINISTRATOR | ✅ ≈ `owner`/`manager` role | Manages venue + staff; "configure services," "view reports," "manage subscription" all ❌ missing (no services/reports/billing concept exists) |
| SAAS ADMINISTRATOR | ❌ **Does not exist** | No cross-tenant admin role, table, or route anywhere in the codebase |

---

## 5. Core queue functionality audit

| Feature | Status | Evidence |
|---|---|---|
| Create/configure queue | PARTIAL | A venue *is* the queue — one venue = one line. No separate "queue" entity, no multiple concurrent queues per venue (see §14 clinic gap) |
| Start/stop queue | IMPLEMENTED (as automation toggle, not queue open/close) | `PATCH /venues/:id/automation`, `routes.js:172-188` — this toggles the *automation trigger*, not whether the venue accepts joins. There is no "queue closed / not accepting customers" state |
| Reset queue | IMPLEMENTED (dev-only) | `seed.sql`, not an app feature |
| Queue numbering | IMPLEMENTED (fractional-index, not literal ticket numbers) | `queueCore.js:34-48`; customer sees `#${people_ahead + 1}` (`CustomerHome.jsx:168`), not a persistent ticket number |
| Customer joins remotely | ❌ **MISSING** | The *only* join path is a staff member scanning the customer's QR (`routes.js:54-103`) or staff manually adding a walk-in (`routes.js:112-134`). There is no self-service "join from home" endpoint. A customer must be physically present (or at least in front of a staff member) to be enrolled — this directly contradicts the "virtual waiting room… join a queue remotely" product premise (§1 of the brief) |
| Customer joins physically (QR scan) | ✅ IMPLEMENTED | `routes.js:54-103`, `QrScanner.jsx` |
| Duplicate prevention | ✅ IMPLEMENTED, DB-enforced | `idx_one_active_entry_per_user_per_venue`, `schema.sql:212-214`; race handled in `queueEngine.js:151-161` |
| Current number being served | ✅ IMPLEMENTED | `getLiveQueue`, staff view |
| Customer's own number/position | ✅ IMPLEMENTED, server-computed | `authRoutes.js:223-247` (`people_ahead` subquery) |
| Estimated waiting time (customer-facing) | ❌ **MISSING** — computed only internally | `expected_slot_at` is set once at join (`queueEngine.js:141`) and used only for the automation risk check; never surfaced to the customer as "~15 minutes" |
| Queue/business status (open/closed) | ❌ **MISSING** | No `is_accepting` flag on `venues` |
| Call next | ✅ IMPLEMENTED, atomic | `queueEngine.js:53-109` |
| Recall | ⚠️ UNCLEAR/PARTIAL — conflated with Reinstate | No distinct "recall the current serving customer again"; `reinstate` restores a *waiting* customer to next-in-line |
| Skip | ✅ IMPLEMENTED (automatic only) | The two-slot-prior trigger (`queueCore.js:78-108`); **no manual "skip this person" staff button** |
| Cancel (customer ticket) | ❌ **MISSING**, despite schema support | `queue_status` enum includes `'cancelled'` (`schema.sql:29`) but **no route ever sets it** — dead enum value |
| Mark served | ✅ IMPLEMENTED, but conflated with no-show (see below) | `queueEngine.js:82` |
| Mark no-show | ❌ **MISSING** — real correctness bug | When staff calls the *next* customer, whoever was previously `serving` is automatically flipped to `served` (`queueEngine.js:80-82`) — with **no check that they were actually attended to**. A genuine no-show is recorded identically to a completed visit. This corrupts any future analytics on no-show rate or true service duration |
| Reinsert skipped customer | ✅ IMPLEMENTED — "Lock-Back override" | `computeReinstate`, `queueCore.js:162-182`; UI in `AttendantDashboard.jsx:127` |

---

## 6. Virtual waiting room audit

| Capability | Status | Notes |
|---|---|---|
| Remote queue joining | ❌ MISSING | See above — joining requires a staff scan |
| Customer waiting outside premises | ✅ IMPLEMENTED | Nothing requires the customer to stay in the building once enrolled |
| Live queue updates | ✅ IMPLEMENTED, poll-based | 5s interval, `CustomerHome.jsx:9,232`; **no push, no WebSocket** |
| Estimated waiting time (customer view) | ❌ MISSING | see above |
| Customer status page | ✅ IMPLEMENTED | `CustomerHome.jsx` `TicketCard` |
| "Almost next" / "You are next" | ⚠️ PARTIAL, text-only, foreground-only | `CustomerHome.jsx:174`: "You're next — stay nearby" appears **only while the app tab is open and polling** — no notification if the phone is locked or the tab is closed |
| "Please return to the clinic" | ❌ MISSING as a push; ⚠️ PARTIAL as in-app copy | Same limitation — only visible if the customer is actively looking at the screen |
| Customer confirms they're returning | ❌ **MISSING entirely** | No confirm/acknowledge action anywhere in the UI or API. This is the single biggest gap relative to the brief's "Customer Availability" concept in §2 |
| Grace period | ❌ MISSING | No timer/window concept in schema or engine |
| Temporary skip | ⚠️ PARTIAL, automatic only | Exists as `stepped_back`/`dropped`, driven purely by GPS+ETA, **not** by a customer-declared "I'm not available" signal |
| Return-to-queue behavior | ✅ IMPLEMENTED, staff-triggered only | Lock-Back "Reinstate" — but only an attendant can trigger it; the customer cannot self-declare "I'm ready now, please give me my spot back" |

**Verdict**: QPinoy is a **presence-aware queue**, not yet a genuine
**virtual waiting room** in the brief's sense. The infrastructure for it
(geofence, ETA, automation trigger) is real and solid, but the specific
customer-facing loop the brief describes — "notify → confirm you're on the
way → hold your place" — does not exist. `DEPLOYMENT.md §4` independently
reaches the same conclusion and proposes the correct fix (web push +
confirmation tap) but nobody has built it.

---

## 7. Location / GPS readiness audit

This is the one area where the codebase substantially *exceeds* what the
brief assumes.

| Search term | Found? | Where |
|---|---|---|
| `navigator.geolocation` | ✅ | `CustomerHome.jsx:129,135`, `VenueSetup.jsx:36,42` |
| Haversine distance | ✅, real implementation, unit-tested | `backend/geofence.js:23-30`, `backend/geofence.test.js` (11 tests) |
| Geofencing | ✅, server-authoritative | `isWithinGeofence`, `geofence.js:36-40`; venue has `geofence_lat/lng/radius_meters` (`schema.sql:89-91`) |
| Distance/radius calculation | ✅ | same |
| Google Maps / Distance Matrix | ✅, real API integration with graceful fallback | `distanceMatrixClient.js:36-53` |
| Maps rendering (visual map) | ❌ MISSING | No map library, no `<Map>` component anywhere |
| Background location | ❌ MISSING (platform-limited, self-documented) | `DEPLOYMENT.md §4` explicitly names this as the unsolved constraint |
| ETA / travel-time estimation | ✅ real, live-traffic-aware when a key is set | `distanceMatrixClient.js:27-32` (`departure_time=now`) |
| Proximity → risk decision | ✅ real, tested | `isAtRisk`, `queueCore.js:50-63` |

**Important privacy finding (flag for §16 too):** `GET /venues/:venueId/queue`
(`routes.js:32-39`, `queueEngine.js:30-38`) does `SELECT * FROM
queue_entries`, which includes `last_lat` and `last_lng` — **raw
coordinates are sent to the staff dashboard's API response**, even though
the UI (`AttendantDashboard.jsx`) never renders them (it only shows
"At venue"/"Not checked in" badges). This contradicts the product principle
in §2 of the brief ("avoid exposing a customer's precise location to the
business unless there is a compelling reason"). Today, anyone opening
browser devtools on the staff console can read every checked-in customer's
exact lat/lng from the network tab. **This is a real, fixable gap**: the
`getLiveQueue` query should project away `last_lat`/`last_lng` (or the route
should strip them before responding) unless there's a specific reason staff
need raw coordinates.

---

## 8. Location-aware queue design validation (future scenario)

The brief's target workflow ("too far → approaching → next") is **directly
buildable on the existing primitives** without a rewrite:

- `is_checked_in` (boolean, geofence result) already exists.
- `live_eta_minutes` (from Distance Matrix or fallback) already exists.
- `isAtRisk()` already compares ETA against `expected_slot_at`.

What's missing is a **presentation layer**, not new data: today the system
computes a binary in/out-of-geofence flag plus a raw ETA number, but never
buckets it into the brief's desired states (`too far` / `approaching` /
`ready`). Adding a `presenceState` derived field (`far` if ETA > N min,
`approaching` if within 2×geofence radius, `ready` if `is_checked_in`) is a
pure function over existing columns — no schema or engine change required,
just a new derived value in `geofence.js` or a small new module.

The Maria/Juan/Pedro/Ana temporary-skip scenario is **already implemented**
in spirit via the two-slot-prior trigger and step-back/drop mechanics
(`queueCore.js:78-152`) — but today it's gated on **payment tier**, not on a
customer-declared "I'm not available" signal, and it only evaluates the
customer sitting *exactly two slots behind* whoever was just called, not the
whole line. Generalizing it to evaluate *every* waiting customer's presence
state on each call (not just the one at position N+2) would be a moderate,
not major, change to `evaluateTwoSlotPrior`.

**What would actually be required to reach the brief's vision:**
1. A `presence_state` enum/derived field (small, additive).
2. A customer-declared availability toggle (new column + endpoint — see §10).
3. Generalizing the trigger from "exactly two slots back" to "any at-risk
   waiting customer" (algorithm change, but isolated to `queueCore.js`,
   which is unit-tested in isolation — low blast radius).
4. A notification channel to actually *tell* the customer when their state
   changes (the big missing piece — see §11).

None of this requires touching the auth model, the tenant model, or the
database's core shape. **This is a "yes, with moderate changes" answer, not
a rewrite** (see §21).

---

## 9. Queue state machine audit

### What actually exists (implicit, not formalized as a single state field)

Composed of `queue_status` (`waiting|serving|served|dropped|cancelled` —
`cancelled` unused), plus three independent boolean/flag side-channels:
`is_checked_in`, `is_override_locked`, `last_automation_flag`
(`stepped_back|dropped|reinstated`). There is no single authoritative
"customer state" — a client has to combine four columns to know what's
really going on. This works today because the UI only needs a few
combinations, but it will not scale cleanly to the brief's richer state set
(`APPROACHING`, `READY`, `NOT_AVAILABLE`, `RETURNING`) without either (a)
adding more flag columns (continuing the current pattern, workable but messy)
or (b) introducing one real `customer_state` enum that the flags currently
approximate. Recommend (b) before this grows further.

### Brief's proposed happy path vs. current reality

`WAITING → APPROACHING → READY → CALLED → SERVING → SERVED`: only
`WAITING`, an implicit "at venue" (`is_checked_in=true`), `SERVING`, and
`SERVED` exist today. `APPROACHING`, `READY`, and a distinct `CALLED` (as
opposed to `SERVING`) do not exist.

### Brief's alternate path

`WAITING → NOT_AVAILABLE → SKIPPED → RETURNING → READY`: **`NOT_AVAILABLE`
does not exist as a customer-declared state at all** — the closest is the
system inferring "not checked in + ETA too slow," which is not the same
thing as a customer saying "I can't come right now." `SKIPPED` exists
(`last_automation_flag`), `RETURNING` does not, `READY` does not.

### `CALLED → NO_SHOW`

Does not exist — see §5's no-show finding.

**Conclusion**: the underlying data model is flexible enough to grow into
this (it's Postgres with a small number of tables and enums — adding columns
and enum values is cheap), but the current code has none of the specific
states the brief wants, and the algorithm (`queueCore.js`) would need new
branches, not just new schema.

---

## 10. Notification audit

**There is no notification infrastructure of any kind in this codebase.**
Confirmed by exhaustive grep across `backend/` and `frontend/src` for `sms`,
`twilio`, `push`, `Notification`, `vapid`, `messenger`, `whatsapp`,
`nodemailer`, `sendgrid`, `resend`, `postmark` — zero implementation hits.
(`phone.js` matches only because it's about phone-number *formatting* for
display/dialing, not sending anything; `routes.js` and
`auth.integration.test.js` match only on the word "location.")

None of the five example notifications in the brief can currently be sent:

| Notification | Can QPinoy send it today? |
|---|---|
| "You're #8 in the queue" | ❌ — customer must have the app open and polling |
| "You're #3, start making your way" | ❌ |
| "You're next, please return" | ❌ |
| "Your turn is ready" | ❌ |
| "You were temporarily skipped… tap here when ready" | ❌ — no skip notification, no tap-to-resume action exists |

What *does* exist is a foreground, in-app equivalent: `CustomerHome.jsx`
polls every 5 seconds and re-renders the position text while the tab is
open. That is a real, working "live status" feature — but it is not a
notification, and it stops working the moment the screen locks.

`DEPLOYMENT.md §4` (lines 148–200) already diagnoses this exact gap
correctly and unprompted, and lays out four real options (web push +
confirm tap; SMS magic link; foreground-only with honest copy; Capacitor
native background). This is the single most load-bearing piece of
unbuilt-but-well-understood work in the whole project.

---

## 11. Estimated waiting time audit

**Exists internally, not customer-facing.**

Computed once, at join time: `expectedSlotMinutes = active.length *
avgServiceMinutes` (`queueEngine.js:140-141`), stored as
`expected_slot_at`. It:

- Does NOT recompute as the queue reorders (a customer's `expected_slot_at`
  is frozen at join time even if three people in front of them are dropped).
- Does NOT account for multiple staff/doctors serving in parallel (the
  schema has no concept of concurrent servers — see §14).
- Does NOT account for service-type variation (`avg_service_minutes` is one
  number per venue, not per service).
- Is used ONLY internally, by `isAtRisk()`, to decide automation actions —
  it is never returned to the customer as "~15 minutes remaining."

**Minimum architecture to build this properly** (not implemented, described
only): recompute `expected_slot_at` for all waiting entries whenever the
active queue's composition changes (on serve/move/drop/reinstate), scoped
per concurrent server if multi-doctor support is added, and surface it in
`GET /me/queue`. This is a moderate, contained change — the query
(`authRoutes.js:223-247`) already computes `people_ahead`; multiplying by
`avg_service_minutes` at read time (rather than trusting a stale write-time
value) is a small addition.

---

## 12. Clinic-specific workflow walkthrough

Walking the brief's exact scenario (§14) against the real code:

| Step | Supported today? |
|---|---|
| Patient scans QR code | ✅ (but it's *staff* scanning the *patient's* QR, not the reverse — same effect) |
| Patient joins virtual queue | ⚠️ Only if physically present for the scan — not remote |
| Patient receives Queue #17 | ✅ (as `people_ahead + 1`, not a stable ticket number) |
| Patient leaves waiting room | ✅ nothing stops this |
| QPinoy monitors queue progress | ✅ via poll, foreground only |
| "5 patients ahead of you" | ✅ `CustomerHome.jsx:175` |
| "Approximately 15 minutes remaining" | ❌ not surfaced (see §11) |
| "Please return to the clinic" | ⚠️ in-app text only, no push |
| Patient arrives, receptionist confirms | ✅ — this is essentially the geofence check-in, or Lock-Back override |
| Patient is served | ✅ `call next` |

**Realistic assessment**: roughly the back two-thirds of this workflow (from
"leaves waiting room" onward) is functionally present in some form; the
front third (remote joining, proactive minute-based notification) is not.
For a 30-patient/day, 1-receptionist, 2-doctor clinic specifically, the
**2-doctor concurrency gap (§14 below)** is the sharper practical blocker —
the schema physically cannot represent "Dr. A is serving patient 5 while
Dr. B is serving patient 6" at the same venue.

---

## 13. Multi-tenant SaaS audit

This is the strongest part of the codebase.

- **Tenant model**: `venues` table, one row per business (`schema.sql:85-99`).
- **Isolation**: every queue/venue mutation route requires a `venue_members`
  row for that specific `venue_id` (`auth.js:83-101`), enforced server-side,
  independent of the frontend's own guard (`App.jsx:163,171` — client guard
  is UX-only, correctly not trusted as the boundary).
- **Cross-tenant leak protection, tested**: `auth.integration.test.js`
  covers a signed-in stranger getting 404 (not 403) on a venue they don't
  staff — deliberate, to avoid ID enumeration (`auth.js:78-82`); a customer
  cannot push location into a stranger's ticket
  (`routes.js:234-255`, tested per `README.md:280-287`); the `/location`
  endpoint's `UPDATE` is scoped by both `id` AND `venue_id`
  (`routes.js:288-292`) — a real bug (cross-venue overwrite) was caught and
  fixed here, per the README's own account, which is a good sign about how
  seriously isolation was taken.
- **DB-level enforcement, not just app code**: `idx_one_owner_per_venue`,
  `idx_one_serving_per_venue`, `idx_one_active_entry_per_user_per_venue` are
  all unique partial indexes — invariants that hold even if application code
  has a bug (`schema.sql:123-125,190-192,212-214`).

Four venues (Clinic A/B, Salon C, Restaurant D) could genuinely run on one
deployment today without their data mixing. **What's missing for a real
SaaS**, not tenant isolation: no plan/subscription/billing concept, no
per-tenant usage limits, no SaaS-administrator role to manage tenants
centrally (§4 above), no way to deactivate/suspend a venue.

---

## 14. Security audit

### Strong, verified points
- Password hashing: scrypt via `node:crypto`, per-row salt, self-describing
  parameter string so cost can be raised later without breaking old hashes
  (`password.js:14-22,38-50`).
- Token design deliberately avoids the classic JWT footguns: algorithm is
  never read from the token (always re-derives HMAC-SHA256), purpose (`typ`)
  is mandatory and checked, constant-time signature comparison
  (`tokens.js:16-29,114-151`).
- No default/fallback signing secret — the app refuses to boot without a
  32+ char `AUTH_SECRET` (`tokens.js:67-78`).
- Generic auth error messages (no user enumeration via login or password
  reset — though there's no password reset at all yet).
- Rate limiting correctly keyed to avoid the "lock out the real user"
  self-DoS (`rateLimit.js:184-221`, `authRoutes.js:94-108`) — the README
  documents this being caught by a failing test, which is a credible signal
  of real TDD discipline, not just retrofitted comments.
- Coordinate input validation exists specifically because a prior gap was
  found and fixed (`geofence.js:50-53`, `routes.js:258-263`).
- SQL injection: all queries are parameterized (`$1, $2...`) — no string
  concatenation into SQL found anywhere in the reviewed files.
- CORS: explicit allowlist, not `*` (`app.js:34-55`).

### Real, currently-open gaps (self-acknowledged in `DEPLOYMENT.md`, verified in code)
- **No password reset / email verification** — a user who forgets their
  password has no recovery path (`DEPLOYMENT.md:361-364`).
- **No session revocation** — tokens are stateless and valid 30 days; the
  only "log out everywhere" is rotating `AUTH_SECRET` globally
  (`DEPLOYMENT.md:366-368`).
- **Token stored in `localStorage`**, not an HttpOnly cookie — acknowledged
  tradeoff in `api.js:27-37`, real (XSS would leak the session token; no
  XSS vector was found in this review, but the risk is structural, not
  hypothetical).
- **Distributed brute force**: an attacker with many source IPs can still
  grind one account, since the per-account limiter is keyed to
  `(email, IP)` (`rateLimit.js:216-220`, acknowledged in the same file).
- **No rate limit on `/auth/register`** — nothing stops mass account
  creation (confirmed absent in `authRoutes.js:48-92`).
- **Raw GPS coordinates leak to the staff API response** — see §7 finding.
  This is the one privacy issue not already self-documented anywhere in the
  repo.

### Healthcare-specific privacy — stated as concerns, not compliance claims
Per the audit rules, no compliance claim is made. Concretely, if this is
sold to a clinic:
- The system stores customer full name, phone number, and precise GPS
  coordinates (`last_lat`, `last_lng`) tied to a specific clinic visit —
  this is presence/attendance data about a healthcare visit, which is
  sensitive even without storing any diagnosis or medical record.
- No data retention or deletion policy exists in code (served/dropped rows
  appear to be kept indefinitely — good for the load-tested index design,
  but there's no purge/anonymize job).
- No audit log of who (which staff member) viewed which customer's location
  or queue history.
- No documented data processing agreement, encryption-at-rest statement
  (relies entirely on the managed Postgres provider's defaults), or explicit
  consent flow beyond the browser's own geolocation permission prompt.
- **Unable to determine from the current source code** whether any hosting
  provider chosen for production carries a BAA-equivalent or PH Data Privacy
  Act-specific commitment — this is an infrastructure/contract question, not
  a code question.

---

## 15. Philippine market readiness

| Consideration | Status |
|---|---|
| Mobile-first | ✅ — PWA + Capacitor Android wrapper, no desktop-only assumptions |
| Low-cost Android phones | ✅ likely fine — React/Tailwind, no heavy client compute except QR camera scan; `BarcodeDetector` falls back to `jsQR` for older Chrome (`QrScanner.jsx:10-24`) |
| Intermittent connectivity | ⚠️ PARTIAL — service worker caches the app shell and falls back to a "showing last known state" offline response for `/api/*` reads (`sw.js:131-145`), but **all mutations (serve, move, enroll) require live connectivity** — no offline queue/replay, which is the right call for a queue-ordering system (replaying a stale action would be dangerous) but worth knowing it's not "works fully offline" |
| SMS fallback | ❌ Not built (see §10) |
| Philippine phone numbers | ✅ genuinely well done — `phone.js` handles every common local format (`0917...`, `9171234567`, `+63917...`) and normalizes to E.164 specifically because "the point of collecting it is being able to text someone" (`phone.js:9-33`) — ready for an SMS provider to be plugged in later |
| Philippine timezone | ⚠️ Not exercised — all timestamps are `TIMESTAMPTZ` (timezone-safe by construction), but no UI currently renders a wall-clock time to test against, so this is untested rather than broken |
| Philippine currency (PHP) | N/A — no billing/payment-processing exists at all (the "premium_secured" 50% deposit is a *label*/tier, not an actual payment integration — no Stripe/PayMongo/GCash code anywhere) |
| QR-code entry | ✅ strong — manual-entry fallback included specifically for cracked screens/denied camera permission (`QrScanner.jsx:180-209`) |
| Low technical literacy | ✅ reasonably considered — one QR scan, minimal text, in-app copy is plain English (no Filipino localization found, though) |

**Unnecessary complexity for this market found**: none. The stack is
deliberately thin (3 backend runtime dependencies, no ORM, no message
queue) — this is appropriately scoped, not overbuilt.

---

## 16. MVP classification

| Feature | Classification | Why |
|---|---|---|
| Staff-scanned QR enrollment | MUST HAVE | Already works, core loop |
| Live position for customer (poll-based) | MUST HAVE | Already works |
| Geofence check-in | MUST HAVE | Already works, differentiator |
| Call next / manual reorder | MUST HAVE | Already works |
| Multi-tenant venues + roles | MUST HAVE | Already works, needed to sell to >1 clinic |
| Remote (non-staff-scanned) joining | MUST HAVE, missing | Brief's core premise; currently the biggest functional gap |
| Push/SMS notification on "you're next" | MUST HAVE, missing | Without this, "virtual waiting room" is not credible to a clinic |
| Customer no-show vs served distinction | SHOULD HAVE, missing | Needed before any analytics claim is trustworthy |
| Cancel/leave-queue for customer | SHOULD HAVE, missing | Small, currently absent despite schema support |
| Estimated wait time, customer-facing | SHOULD HAVE, partially built | Data exists, just not surfaced |
| Multi-doctor / concurrent-serving support | SHOULD HAVE for clinics specifically | Currently architecturally impossible (one `serving` row per venue) |
| Payment-tier automation (step-back/drop) | LATER — interesting, not required to sell #1 | Real differentiator, but the "50% deposit" mechanic assumes a payments product that doesn't exist yet; can ship with automation simply off |
| GPS-radius states (approaching/ready) UI polish | LATER | Data's there; presentation layer isn't |
| Customer-declared availability toggle | LATER | Real gap vs. brief's vision, but not needed for a first sale |
| Analytics/reports for business admin | LATER | Nothing built |
| Billing/subscription management | LATER | Nothing built, fine for pre-revenue validation |
| SaaS administrator role | REMOVE/AVOID for now | Not needed until managing >~10 tenants by hand becomes painful |
| Native iOS app | REMOVE/AVOID | Explicitly deprioritized already (`DEPLOYMENT.md:205-206`) |
| Full EMR / billing / insurance / lab | REMOVE/AVOID | Not implied by any code here, correctly out of scope |

---

## 17. Differentiation audit

| Differentiator | Status |
|---|---|
| Philippine SME focus (phone formats, Android-first) | ALREADY IMPLEMENTED |
| Clinic vertical fit | PARTIALLY IMPLEMENTED — single-server-per-venue limitation hurts multi-doctor clinics specifically |
| Mobile-first / low-cost device support | ALREADY IMPLEMENTED |
| SMS | NOT CURRENTLY SUPPORTED |
| Messenger/WhatsApp | NOT CURRENTLY SUPPORTED |
| Location awareness (geofence + ETA) | ALREADY IMPLEMENTED — genuinely ahead of "does it have GPS at all" |
| Customer availability (self-declared) | NOT CURRENTLY SUPPORTED |
| Dynamic queue handling (step-back/drop) | ALREADY IMPLEMENTED, but tied to payment tier rather than availability |
| Waiting-room reduction | ARCHITECTURALLY POSSIBLE — the pieces exist, the "why would a patient trust this enough to leave" loop (notification) is the missing link |

---

## 18. Competitive feature model

| Capability | QPinoy Current | Required for MVP | Future |
|---|---|---|---|
| Remote queue join | ❌ Missing (staff-scan only) | ✅ Yes | — |
| QR join | ✅ Implemented | ✅ | — |
| Live queue position | ✅ Implemented (poll) | ✅ | Push-based |
| Estimated wait | ⚠️ Internal only | ✅ Surface it | Multi-server aware |
| SMS | ❌ Missing | Optional (nice-to-have) | ✅ For non-app users |
| Push notification | ❌ Missing | ✅ Critical | — |
| "Come back soon" | ⚠️ In-app text only | ✅ As a push | — |
| Customer availability | ❌ Missing | Not required for v1 | ✅ Phase 3 |
| GPS | ✅ Implemented | ✅ Already have it | — |
| Geofencing | ✅ Implemented | ✅ Already have it | — |
| ETA | ✅ Implemented | Nice-to-have for v1 | ✅ Multi-provider |
| Smart queue (auto reorder) | ✅ Implemented (payment-tier based) | Off by default is fine for v1 | Availability-based |
| Temporary skip | ⚠️ Partial (automatic, not customer-declared) | Not required for v1 | ✅ Phase 3 |
| Rejoin queue | ⚠️ Staff-only (Lock-Back) | Not required for v1 | Customer self-serve |
| Multi-tenant SaaS | ✅ Implemented, solid | ✅ Already have it | — |
| Subscription management | ❌ Missing | Not required for v1 | ✅ Phase 5 |
| Analytics | ❌ Missing | Not required for v1 | ✅ Phase 5 |

---

## 19. Technical debt audit

| Item | Severity | Evidence / reasoning |
|---|---|---|
| No-show recorded identically to served | HIGH | `queueEngine.js:80-82` — corrupts future analytics, and there's no way to fix retroactively without a schema change |
| Raw GPS coordinates returned in staff API response | MEDIUM | `queueEngine.js:30-38` `SELECT *`; product-principle violation per brief §2, easy fix |
| `cancelled` status defined but unreachable | LOW | Dead enum value, `schema.sql:29` — either wire it up or remove it |
| No password reset / session revocation | MEDIUM (rises to HIGH once real customer PII is in the system) | Self-documented in `DEPLOYMENT.md:359-368` |
| No rate limit on registration | LOW-MEDIUM | Mass account creation currently unthrottled |
| Single `serving` slot per venue (DB-enforced) | HIGH for clinic vertical specifically | Blocks the stated 2-doctor scenario entirely; not a bug, a deliberate simplification that needs revisiting before clinic sales |
| `expected_slot_at` frozen at join time, never recomputed | MEDIUM | Feeds `isAtRisk()` with increasingly stale data the longer someone waits |
| No maps UI despite having coordinates | LOW (deliberate, not urgent) | Reasonable MVP choice, not a defect |
| No dependency audit tooling in CI (`npm audit`, Dependabot) | LOW | Not present in `.github/workflows/ci.yml` |
| Test coverage | Not debt — a strength | 11 test files, ~2,100 lines, unit + integration + a real HTTP smoke test wired into CI (`ci.yml:44-47`) |

Nothing rated CRITICAL was found — there is no data-corruption or
security-bypass bug currently reachable in the reviewed code paths.

---

## 20. Architecture future-proofing

**Answer: YES, WITH MODERATE CHANGES.**

Reasoning, point by point per the brief's checklist:

- **Queue state modeling**: workable today via flag combinations; will need
  consolidation into a real `customer_state` enum once `APPROACHING` /
  `RETURNING` are added, but this is additive, not a rewrite (§9).
- **Customer state modeling**: same — the fields that matter
  (`is_checked_in`, `live_eta_minutes`, `expected_slot_at`) already exist and
  are exactly what a richer state machine would consume.
- **Tenant architecture**: no changes needed — already solid multi-tenant
  isolation (§13).
- **Notifications**: the biggest actual gap, but it's a bolt-on (a new
  module + a provider integration), not something the current architecture
  resists. `queueCore.js`'s pure-function design means "notify on state
  change" can hook in at the `queueEngine.js` call sites without touching
  the algorithm itself.
- **Location data**: already ahead of what's needed (§7–8).
- **Real-time updates**: currently polling-only. Moving to WebSockets/SSE
  would improve UX but isn't required to reach the brief's vision — push
  notifications solve the "phone is locked" problem that polling can't,
  regardless of polling interval.
- **Database design**: clean, well-indexed, uses Postgres features (partial
  unique indexes, enums, `FOR UPDATE`) correctly rather than working around
  them. The one real constraint to revisit is the one-`serving`-row-per-venue
  index if multi-doctor support is wanted — that's a schema + engine change,
  not a rewrite, but it does touch the hottest code path (`callNextCustomer`).
- **API design**: consistent, staff-gated by default, sensible error
  semantics (404 vs 403 discipline). Extending it for new states/roles
  follows existing patterns cleanly.

**No component of this system needs to be thrown away** to reach the
brief's vision. The work is additive: a notification provider, a
customer-declared availability field, a presence-state presentation layer,
and (for the clinic vertical specifically) multi-server concurrency.

---

## 21. Do not overengineer — explicit list

Confirmed absent, and correctly so — none of these should be built yet:
- Predictive/AI wait-time modeling (a simple recompute of the existing
  `avg_service_minutes × people_ahead` formula is sufficient for a long
  while).
- Full EMR, hospital ERP, billing, insurance, pharmacy, lab management —
  none of this exists in the code and none of it should before the first
  paying clinic.
- Complex route optimization — a straight-line/Distance-Matrix ETA is
  already more than most competitors bother with at this stage.
- Continuous background GPS tracking — actively avoided (`DEPLOYMENT.md
  §4` explains why, correctly).
- Native iOS app — correctly deprioritized in favor of the PWA + Android
  Capacitor wrapper already built.
- Real-time WebSocket infrastructure — polling is a fine stopgap; don't
  add this before push notifications exist, since push solves the more
  important problem (locked phone) that WebSockets don't.
- A SaaS admin portal / subscription billing — not needed until there are
  enough paying tenants that manual management becomes the bottleneck.

---

## 22. Product Validation Score (0–100)

| Category | Score | Reasoning |
|---|---|---|
| Product readiness | 45 | Core presence/queue loop works; the specific "remote join + notify" premise of the brief is unbuilt |
| Technical readiness | 78 | Clean architecture, real tests, sound security fundamentals, DB-enforced invariants |
| MVP readiness | 55 | Staff-run line works today; the customer-remote piece and notifications are the blockers to a credible pitch |
| Clinic readiness | 40 | Single-server-per-venue is a real blocker for any clinic with >1 doctor; everything else is close |
| SaaS readiness | 70 | Multi-tenant isolation is genuinely strong; billing/admin layer is simply absent (expected pre-revenue) |
| Location-awareness readiness | 80 | Ahead of the brief's own expectations — geofence, ETA, and risk logic are real and tested |
| Security readiness | 65 | Strong fundamentals, several self-documented and plausible gaps (password reset, session revocation, one real privacy leak found) |
| Philippine-market readiness | 72 | Phone formatting, Android-first, low-connectivity handling are genuinely well done; SMS/localization not built |

**Overall score: 63/100** (unweighted mean; technical foundation pulls the
average up, remote-join + notifications pull it down).

Read this as: **a technically credible foundation that is one specific,
well-understood feature (customer-initiated remote joining + a
notification channel) away from being demo-able as the product described
in the brief**, plus one clinic-specific schema constraint (multi-doctor)
worth resolving before targeting that vertical specifically.

---

## A. Executive summary

QPinoy today is a working, well-tested, multi-tenant queue-management
backend and PWA frontend for venues that already have a customer physically
in front of a staff member at enrollment time — a strong "smart digital
ticket + geofence + payment-tier automation" system, not yet the "join from
your couch, get pinged when it's time" virtual waiting room described in
this audit's brief. The gap between the two is smaller than it looks: the
hard infrastructure (geofencing, live ETA, risk evaluation, multi-tenant
isolation, signed QR tokens, rate-limited auth) is already built and
unit/integration tested at a level well beyond a typical early-stage
MVP — 136+ tests, real load-testing of the index design, and documented
self-caught bugs (a cross-venue location-overwrite bug, a login-lockout
self-DoS) suggest a genuinely careful build, not a prototype.

What it does well: tenant isolation is DB-enforced, not just checked in
app code; the fractional-index queue algorithm is a legitimately good
choice for O(1) reordering; the geofence/ETA pipeline is real and swappable
between providers; Philippine phone-number handling is specifically and
correctly built out; and the security fundamentals (token design, password
hashing, rate limiting) show real attention to the failure modes that
matter, not just the happy path.

What's missing, in order of how much it matters to the product story: (1)
a customer cannot join a queue remotely — every path into the queue
requires a staff member's QR scan, which contradicts the brief's central
premise; (2) there is no notification channel of any kind (no push, SMS, or
email), so "you're next, come back" only reaches a customer who happens to
have the tab open; (3) the schema can represent only one customer being
served at a time per venue, which blocks the brief's own 2-doctor clinic
example; (4) no-shows are recorded identically to completed visits, which
will quietly poison any future analytics; and (5) raw GPS coordinates leak
to the staff-facing API response even though the UI hides them, a real if
minor privacy gap worth a quick fix before pitching this to a healthcare
customer specifically.

The biggest weakness is not technical debt — there's remarkably little of
that — it's a mismatch between what the code optimizes for (a
staff-mediated, payment-tier-aware presence engine) and what the product
vision in this brief describes (a customer-initiated, availability-aware
virtual waiting room). Both are legitimate products; they are not
identical, and whoever owns this project should decide which one they're
actually selling before investing more engineering time, because the
payment-tier mechanic implies a payments product that doesn't exist yet.

The biggest opportunity is that the location-awareness work — usually the
hardest, riskiest part of a project like this to get right — is already
done and tested. Most of what remains (remote join, push notifications, a
no-show state, hiding raw coordinates from the staff API) is comparatively
mechanical, bounded, well-understood work rather than open research. The
multi-doctor concurrency limit is the one piece that would require touching
the hottest, most carefully-locked code path in the system
(`callNextCustomer`) and deserves deliberate design time before being
changed.

**Is it worth continuing?** Yes. This is not a codebase to rebuild — it is
a codebase to finish a specific, identifiable, bounded set of features on
top of. The foundation (auth, tenancy, queue algorithm, location math, test
discipline) is sound enough to build the brief's actual vision on without
architectural rework.

---

## B. Current feature matrix

| Feature | Status | Evidence | Priority |
|---|---|---|---|
| Multi-tenant venues + roles | IMPLEMENTED | `schema.sql:85-119`, `auth.js` | — |
| Staff-scanned QR enrollment | IMPLEMENTED | `routes.js:54-103`, `tokens.js` | — |
| Remote self-service queue join | MISSING | absent from `routes.js` entirely | MUST HAVE |
| Geofence check-in | IMPLEMENTED | `geofence.js`, `routes.js:264-295` | — |
| Live ETA via Distance Matrix | IMPLEMENTED | `distanceMatrixClient.js` | — |
| Two-slot-prior automation (step-back/drop) | IMPLEMENTED | `queueCore.js:78-152` | — |
| Lock-Back manual override | IMPLEMENTED | `queueCore.js:162-182` | — |
| Customer live position (poll) | IMPLEMENTED | `authRoutes.js:223-247`, `CustomerHome.jsx` | — |
| Estimated wait, customer-facing | MISSING (data exists, not surfaced) | `queueEngine.js:140-141` unused downstream | SHOULD HAVE |
| Push/SMS/email notifications | MISSING | confirmed by repo-wide grep | MUST HAVE |
| Customer confirm-availability action | MISSING | no such endpoint/UI | SHOULD HAVE (Phase 3) |
| Cancel / leave queue (customer) | MISSING | `cancelled` enum unused | SHOULD HAVE |
| No-show distinct from served | MISSING | `queueEngine.js:80-82` conflates them | MUST HAVE before analytics |
| Multi-doctor concurrent serving | MISSING | `idx_one_serving_per_venue` DB constraint | HIGH for clinic vertical |
| Raw coordinates hidden from staff API | BROKEN (leaks today) | `queueEngine.js:30-38` `SELECT *` | Quick fix, do before healthcare pilots |
| Password reset / email verification | MISSING | absent from `authRoutes.js` | SHOULD HAVE |
| Rate limiting (login, location) | IMPLEMENTED | `rateLimit.js` | — |
| PH phone number normalization | IMPLEMENTED | `phone.js` | — |
| Android PWA install + Capacitor wrapper | IMPLEMENTED | `InstallPrompt.jsx`, `frontend/android/` | — |
| Analytics / reporting | MISSING | no such route/table | LATER |
| Subscription/billing | MISSING | no such route/table | LATER |
| SaaS administrator role | MISSING | no cross-tenant role anywhere | LATER |

---

## C. Gap analysis

**1. Critical gaps** (block the core product premise or corrupt data)
- No remote/self-service queue join — contradicts the "virtual waiting
  room" premise outright.
- No notification channel — the "come back now" loop only works with the
  app open and unlocked.
- No-show conflated with served — silently poisons future analytics.

**2. High-priority gaps**
- One `serving` row per venue — blocks multi-doctor clinics specifically.
- Raw GPS coordinates exposed in the staff API response.
- Estimated wait time never reaches the customer.

**3. Medium-priority gaps**
- No password reset / session revocation.
- No customer-declared availability signal (the brief's actual
  "temporarily skipped / returning" concept).
- No rate limit on registration.
- `cancelled` status unreachable — no way for a customer or staff member to
  cancel a ticket.

**4. Future enhancements**
- Presentation-layer presence states (approaching/ready/too far).
- Analytics/reporting for business admins.
- Billing/subscription management, SaaS admin role.
- Real-time transport (WebSocket/SSE) to replace polling.
- Filipino-language localization.

---

## D. Recommended product roadmap

**Phase 0 — Validation.** Before writing more code: put the existing
staff-scan + geofence flow in front of 5 real front-desk staff and 15–20
real patients at 1–2 friendly clinics. Test specifically whether staff
actually complete the scan step reliably during a busy morning, and whether
patients understand "keep the tab open" well enough to make the current
foreground-only status page tolerable without push notifications yet.

**Phase 1 — Sellable MVP.** Fix the no-show conflation (`queueEngine.js`),
hide raw coordinates from the staff API response, add a "leave the queue"
action for customers (wire up the existing `cancelled` status), and decide
explicitly whether the payment-tier mechanic ships in v1 or is switched off
via the existing automation toggle for the first pilot clinics (recommend:
off, to sell "smart queue" without also having to sell "deposit payments,"
which is a separate, unbuilt payments integration).

**Phase 2 — Virtual Waiting Room.** Add self-service remote joining
(a customer requests a spot without a staff scan, subject to some
verification the business trusts — e.g., an appointment reference or a
staff-approved join request), surface estimated wait time to the customer,
and ship the notification channel (`DEPLOYMENT.md`'s own recommended
"pull, don't push" web-push-plus-confirm-tap design is the right starting
point).

**Phase 3 — Smart Queue.** Add a customer-declared availability state
("I'm not available right now" / "I'm ready"), generalize the automation
trigger beyond "exactly two slots back," and build the confirm-you're-
returning tap flow the brief specifically describes.

**Phase 4 — Location Awareness (polish, not foundation — foundation exists).**
Add the presentation-layer presence states (too far/approaching/ready),
consider a lightweight map view for staff, and revisit whether continuous
ETA polling frequency needs tuning under real traffic.

**Phase 5 — Scale.** Multi-doctor/multi-server concurrency (the schema
change that touches `callNextCustomer`'s locking — do this carefully, with
the same test discipline the rest of the codebase already has), analytics
for business admins, billing/subscriptions, and a SaaS-admin role once
there are enough tenants to justify one.

---

## E. First 5 features to build

1. **Fix no-show vs. served conflation.** Ranked first because it's cheap,
   contained to `queueEngine.js:callNextCustomer`, and every future
   analytics/reporting feature depends on this data being trustworthy from
   day one — retrofitting it later means historical data stays corrupt
   forever.
2. **Stop leaking raw coordinates to the staff API.** Ranked second because
   it's a five-line fix (`queueEngine.js`'s `getLiveQueue` query) that
   closes a real privacy gap before this is ever pitched to a healthcare
   customer, where that specific promise ("we never show your exact
   location") is a genuine selling point already implied by the UI design.
3. **Notification channel (web push + confirm tap).** Ranked third, not
   first, because it's the biggest lift of the five — but it's the single
   feature that turns "an in-app status page" into "a virtual waiting room
   a patient can actually trust enough to leave the building." Everything
   else in the roadmap is secondary to this working.
4. **Self-service remote queue joining.** Ranked fourth, paired
   conceptually with #3 — without a notification channel, letting people
   join remotely just means more people staring at a tab, which doesn't
   fix the core problem. Build this alongside or right after push.
5. **Customer-facing estimated wait time.** Ranked fifth because the data
   already exists (`expected_slot_at`, `avg_service_minutes`) — this is
   mostly a read-path change (recompute at query time instead of trusting
   the stale write-time value) plus a UI addition, and it's the detail that
   makes the whole "why would I leave the waiting room" pitch concrete for
   a skeptical clinic owner in a demo.

---

## F. Features to ignore for now

- Multi-doctor concurrency (real gap, but a bigger, riskier change — don't
  let it block getting a first single-doctor or single-line clinic live).
- Payment-tier / deposit automation as a customer-facing pitch (the
  mechanic exists in code, but there's no actual payment processor wired
  up — don't promise "secure your spot with a deposit" until that's real).
- Any map UI.
- SMS as a first-class channel (start with web push; SMS can be the
  fallback once there's a reason to pay per message).
- Analytics/reporting dashboards.
- Billing/subscription management.
- SaaS admin portal.
- Any AI/predictive wait-time modeling.
- iOS.

---

## G. Business validation plan — 5 clinics

**What to ask (before demoing anything):**
- How many patients/day, how many doctors seeing patients concurrently, one
  receptionist or more?
- What do they currently use for queue management (paper ticket, nothing,
  a whiteboard)?
- Would staff actually scan a patient's phone at check-in, or does the
  front desk prefer typing a name (walk-in path already supports this)?
- How would they feel about patients leaving the waiting room today,
  informally, without any system — is "people wander off already and we
  lose track of them" already a felt pain, or is this hypothetical?

**What to demonstrate:**
- The real staff console (`AttendantDashboard.jsx`) running against a
  seeded line, live on a laptop.
- A real phone doing the QR scan → geofence check-in → position update
  loop, in front of them, ideally with the receptionist's own phone as the
  "staff" device.
- Explicitly show the automation OFF by default (be honest that "smart
  reordering" and "deposits" are a later add-on, not the pitch today).

**What to measure:**
- Whether staff complete a full scan-to-serve cycle without help within
  the first 5 minutes of hands-on use.
- Whether patients who are shown the check-in QR actually understand what
  to do without a lengthy explanation.
- Time-to-first-successful-scan on the actual devices staff use daily (not
  a demo laptop) — this is where low-end Android and lighting/camera issues
  will actually show up.

**What indicates product-market fit:**
- A clinic asks when they can start using it for real patients, not just a
  demo.
- Staff independently ask for the walk-in path to be faster/simpler (a
  sign they're mentally already using it, not just watching a demo).
- A clinic asks specifically "can patients wait outside" unprompted — that
  validates the virtual-waiting-room premise is actually a felt need, not
  an assumption.

**What indicates the idea should change:**
- Staff prefer their current whiteboard/paper system because scanning adds
  friction they don't see value in.
- Patients don't trust leaving the building without a notification (this
  would specifically validate that Phase 2's push notification work is not
  optional — it's the gate).
- Clinics with multiple doctors treat the single-line limitation as a
  dealbreaker rather than a workaround (validates prioritizing Phase 5's
  concurrency work sooner than planned).

---

# FINAL VERDICT

1. **Is the current QPinoy codebase worth continuing?** Yes. The
   engineering foundation — auth, multi-tenancy, the queue algorithm, and
   the location/ETA pipeline — is sound, tested, and not something a rebuild
   would meaningfully improve on.

2. **Is it technically suitable as a foundation for a Micro-SaaS?** Yes.
   Tenant isolation is DB-enforced, the stack is deliberately thin (no
   unnecessary dependencies), and the deployment story (Netlify Functions +
   Neon, or Render + Neon) is realistic for a bootstrapped Philippine SME
   product.

3. **What is the biggest technical problem?** The single-`serving`-row-
   per-venue constraint, which makes the schema physically incapable of
   representing the brief's own 2-doctor clinic example. It's not a bug —
   it's a scoping decision that needs to be revisited deliberately, with
   the same care the rest of the locking code shows.

4. **What is the biggest product problem?** There is no way for a customer
   to join a queue without a staff member scanning their phone, and no way
   to notify them once they've left the building. Together, these mean the
   product does not yet do the one thing its own name and pitch promise —
   let someone wait somewhere else.

5. **What is the biggest opportunity?** The location-awareness engine
   (geofence + live ETA + risk evaluation) most competitors would spend
   months getting right is already built, tested, and swappable between
   providers. What remains is comparatively mechanical: a notification
   channel and a remote-join path.

6. **What should I build next?** In order: fix the no-show/served
   conflation, stop leaking raw coordinates to the staff API, then build
   the web-push notification channel and pair it with self-service remote
   joining — that combination is what turns this from a smart digital
   ticket into an actual virtual waiting room.

7. **What should I NOT build next?** Multi-doctor concurrency (real, but
   riskier and not needed to get a first single-line clinic live),
   payment/deposit processing (the tier label exists but no processor is
   wired up — don't promise it), any map UI, analytics dashboards, billing,
   or a SaaS admin portal.

8. **Can location-aware queueing realistically become a differentiator?**
   Yes — more so than the brief itself assumes, because it's already mostly
   built. The differentiator isn't "does QPinoy have GPS" (yes), it's
   "does QPinoy tell you the right thing at the right moment without you
   having to stare at the app" — which depends entirely on the notification
   work that doesn't exist yet.

9. **Should clinics be the first target market?** Conditionally yes, but
   prefer single-doctor or single-queue clinics/dental practices for the
   first pilots specifically, until the multi-doctor concurrency gap is
   closed — don't let the first pilot be the 2-doctor clinic in the brief's
   own example, or the schema limitation will surface immediately.

10. **What is the shortest path from the current codebase to the first
    paying customer?** Fix the no-show bug and the coordinate leak (days,
    not weeks), ship the notification channel and remote-join path
    (the real work — likely the bulk of the pre-launch effort), pilot with
    1–2 single-doctor clinics or a dental/salon vertical to sidestep the
    concurrency gap entirely for now, and defer payment-tier automation,
    analytics, and billing until after the first clinic is actually live.

---

AUDIT DATE: 2026-08-30
CODEBASE VERSION / GIT COMMIT: cc62c4a09fe71dae7bb4a0777e66e91b3400ee6c (branch `main`, clean working tree at time of audit)
OVERALL SCORE: 63 / 100
FINAL VERDICT: Continue — strong technical foundation, two feature gaps (remote join, notifications) block the actual product premise; fix a no-show data-integrity bug and a GPS-privacy leak before any healthcare pilot.
TOP 5 NEXT ACTIONS:
1. Fix no-show vs. served conflation in `queueEngine.js:callNextCustomer`.
2. Stop returning raw `last_lat`/`last_lng` in the staff-facing `GET /venues/:id/queue` response.
3. Build a web-push notification channel per `DEPLOYMENT.md §4`'s own recommended design ("pull, don't push" + confirm tap).
4. Add self-service remote queue joining (currently staff-QR-scan-only).
5. Surface estimated wait time to the customer (`GET /me/queue`) using data that already exists but isn't returned today.
