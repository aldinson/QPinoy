# QPinoy — Local Setup & Deployment

Everything below was run end-to-end on a clean machine before being
written down. Versions listed are the ones actually verified, not
guesses at what "should" work.

---

## 1. Tech stack

### Required

| Component | Version | Why this floor |
|---|---|---|
| **Node.js** | **20.x or newer** (verified on 22.22.2) | The test suite uses `node:test` hooks (`test.before`, `test.beforeEach`), which need 18.8.0+, and global `fetch`, which isn't stable until 21. Node 18 went end-of-life in April 2025. 20 is the realistic floor; 22 LTS is what this was built and tested against. |
| **npm** | 10.x (ships with Node 20/22) | No special requirement — yarn/pnpm work fine too. |
| **PostgreSQL** | **16.x** (verified on 16.15) | Needs the `pgcrypto` extension for `gen_random_uuid()`, `CREATE TYPE ... AS ENUM`, partial indexes, and `FOR UPDATE` row locking. 14+ will very likely work; 16 is what was tested. |

### Optional

| Component | Why |
|---|---|
| **Docker + Compose** | One-command Postgres. Skip it if you already run Postgres natively. |
| **Google Maps API key** | Only for real live-traffic ETAs. Without it, `distanceMatrixClient.js` falls back to a straight-line distance estimate — everything works offline and no key is needed for development or tests. |

### Runtime dependencies

Backend (3 direct — deliberately thin):
- `express` 4.22.2 — HTTP layer
- `pg` 8.23.0 — Postgres client, used for real transactions and row locks
- `dotenv` 16.6.1 — env loading

Frontend:
- `react` / `react-dom` 18.3.1
- `lucide-react` 0.383.0 — icons
- `vite` 5.4.21 + `@vitejs/plugin-react` — dev server and build
- `tailwindcss` 3.4.19 + `postcss` + `autoprefixer` — styling

**There is no ORM, no query builder, and no test framework dependency.**
Tests run on Node's built-in `node:test`. The queue algorithm itself
(`queueCore.js`) has zero imports of any kind.

---

## 2. Repository layout

```
qpinoy/
├── docker-compose.yml        Postgres, with schema + seed auto-applied
├── backend/
│   ├── queueCore.js           Pure algorithm — no DB, no HTTP, no imports
│   ├── queueEngine.js         Transactions + row locking
│   ├── routes.js              Express endpoints
│   ├── server.js              Entry point, graceful shutdown
│   ├── geofence.js            Haversine presence math
│   ├── distanceMatrixClient.js  ETA adapter (Google, or offline fallback)
│   ├── schema.sql             DDL + indexes
│   ├── seed.sql               Demo data (full reset, idempotent)
│   ├── smoke.js               End-to-end scripted walkthrough
│   └── *.test.js              64 tests
├── frontend/                  Vite + React + Tailwind app
│   ├── src/QueueSimulator.jsx  The interactive simulator
│   ├── src/sw.js               Service worker (precache injected at build time)
│   ├── public/                 manifest.json, offline.html, icons
│   └── test/                   Service worker install tests
├── .github/workflows/ci.yml   CI: real Postgres + frontend build
└── DEPLOYMENT.md              Hosting, HTTPS, phone install
```

---

## 3. Setup — Path A: Docker (recommended)

```bash
# 1. Start Postgres. schema.sql and seed.sql are applied automatically
#    on first boot.
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
#   set: DATABASE_URL=postgres://qpinoy:qpinoy@localhost:5433/qpinoy
npm install
npm run dev                    # http://localhost:4000

# 3. Frontend (separate terminal)
cd frontend
npm install
npm run dev                    # http://localhost:5173
```

Note the port: Compose maps Postgres to **5433**, not 5432, so it won't
collide with a Postgres you may already have running locally.

---

## 4. Setup — Path B: Native Postgres

```bash
createdb qpinoy

cd backend
cp .env.example .env
#   set: DATABASE_URL=postgres://localhost:5432/qpinoy
npm install
npm run db:setup               # applies schema.sql, then seed.sql
npm run dev

cd ../frontend && npm install && npm run dev
```

---

## 5. Verifying it works

```bash
cd backend

npm test                       # all 64 tests
npm run test:unit              # 43 tests, no database needed
npm run test:integration       # 21 tests, needs DATABASE_URL
npm run smoke                  # scripted end-to-end walkthrough
```

`npm run smoke` boots the API in-process and prints the queue
rearranging step by step — calling a customer, the automation firing,
a spoofed check-in being rejected, and the Lock-Back override. It's the
fastest way to confirm the whole stack is wired up correctly.

A few things worth knowing about the test suite:

- **The unit tests need no database.** Run `npm run test:unit` anywhere.
  The full `npm test` self-skips the 21 DB-dependent tests if
  `DATABASE_URL` is unset rather than failing.
- **Tests seed and clean up their own fixtures.** You can run the suite
  repeatedly with no manual reset. It was verified green across three
  consecutive runs against a completely empty database.
- **Tests won't clobber your demo data.** The integration suites use
  their own venue IDs (`...097`, `...099`), separate from the demo
  venue (`...001`), so `npm test` leaves your seeded line intact.

---

## 6. Trying the queue logic

The frontend simulator at `localhost:5173` runs the real algorithm
client-side — no backend needed to explore it. Charlie (flask icon) is
the test ticket: toggle her GPS/payment state, then hit **Call next
customer**.

To exercise the actual backend instead:

```bash
VENUE=00000000-0000-0000-0000-000000000001
ALICE=10000000-0000-0000-0000-000000000001
DANA=10000000-0000-0000-0000-000000000004

# See the line
curl -s localhost:4000/api/venues/$VENUE/queue | jq '.queue[] | {customer_name, status, order_weight}'

# Call the next customer (fires the two-slot-prior trigger)
curl -s -X POST localhost:4000/api/venues/$VENUE/queue/$ALICE/serve

# Send a location ping. Note you send ONLY lat/lng — the server decides
# whether that counts as checked in. Sending isCheckedIn:true is ignored.
curl -s -X PATCH localhost:4000/api/venues/$VENUE/queue/$DANA/location \
  -H 'Content-Type: application/json' -d '{"lat":40.7128,"lng":-74.0060}'

# Lock-Back override
curl -s -X POST localhost:4000/api/venues/$VENUE/queue/$DANA/reinstate

# Reset the demo line at any time
npm run db:seed
```

---

## 7. Deployment notes

**Service worker precache is handled automatically.** `frontend/src/sw.js`
receives its precache list at build time via `vite-plugin-pwa` in
`injectManifest` mode, so it always matches Vite's content-hashed
filenames. Nothing to configure — but if you restructure the build,
CI asserts the manifest is still being injected, because a hardcoded
path that 404s would silently prevent the worker from ever activating
(`cache.addAll()` is atomic).

**Weight rebalancing.** Fractional indexing eventually approaches
double-precision limits after very many reorders in the same gap. Wire
`POST /api/venues/:id/rebalance` to a nightly cron per venue. It resets
weights to evenly-spaced integers without changing order.

**Serve the frontend and API from one origin** (or set CORS explicitly).
The Vite dev server already proxies `/api` → `localhost:4000`, so dev
matches that shape.

**Set `GOOGLE_MAPS_API_KEY`** in production. Without it the ETA falls
back to straight-line distance, which ignores traffic and will
under-estimate arrival times.

**`npm ci --omit=dev`** for production installs.

---

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| `Cannot find module 'pg'` | `npm install` wasn't run in `backend/`. |
| `role "qpinoy" does not exist` | Native Postgres path — create the role, or use the Docker path. |
| 21 tests skip | `DATABASE_URL` isn't set. Expected; unit tests still run. |
| Schema didn't apply under Docker | Init scripts only run on **first** volume creation. `docker compose down -v` then `up -d`. |
| `duplicate key ... idx_one_serving_per_venue` | Working as designed — the DB enforces one serving customer per venue. Complete the current one first. |
| Port 5432 in use | Compose already uses 5433 to avoid this; make sure `DATABASE_URL` points at 5433. |
| Service worker not updating | Hard-reload, or Application → Service Workers → Unregister in devtools. Bump `CACHE_VERSION` in `sw.js` on deploy. |
