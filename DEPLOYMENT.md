# QPinoy — Deploying to the Internet & Onto Phones

Short answer to "how do people get this as an app on their phone":
**they install it straight from your website — no App Store required.**
A PWA served over HTTPS can be added to the home screen on both iOS
and Android, where it gets its own icon, launches full-screen with no
browser chrome, and is indistinguishable from a native app to most
users.

But there is one constraint that affects this app specifically and
you should decide about it before you build any further. It's in
section 4. Read that one first.

---

## 1. The non-negotiable requirement: HTTPS

Service workers, the Geolocation API, and home-screen install **all
refuse to work over plain HTTP.** The only exception is `localhost`,
which is why everything works in local development and then silently
breaks on a bare IP address or an `http://` domain.

Practically: you need a real domain with a TLS certificate. Every host
below issues one automatically and free via Let's Encrypt. Don't try
to skip this step — there is no workaround.

---

## 2. What you need to deploy

Three pieces:

| Piece | What it is | Notes |
|---|---|---|
| **Postgres** | Managed database | Neon, Supabase, Render Postgres, or Railway. Free tiers are fine to start. |
| **Backend API** | Node/Express container | Render, Railway, or Fly.io. A `Dockerfile` is included. |
| **Frontend** | Static files from `npm run build` | Any static host, or serve from the same box as the API. |

### Recommended: single origin

Serve the frontend and API from **one domain**
(`qpinoy.example.com`, with the API at `/api/*`). This means:

- No CORS configuration at all
- Service worker scope covers everything cleanly
- Cookies/auth work without `SameSite` headaches later
- Matches the Vite dev proxy, so dev and prod behave identically

If you must split them across domains, set `CORS_ORIGINS` on the API
(explicit allowlist — see `.env.example`) and `VITE_API_BASE_URL` on
the frontend.

---

## 3. Concrete deployment (Render, ~15 minutes)

Any of Render/Railway/Fly work the same way. Render as the example:

**Database**
1. New → Postgres. Copy the *internal* connection string.
2. Apply the schema once:
   ```bash
   psql "$DATABASE_URL" -f backend/schema.sql
   psql "$DATABASE_URL" -f backend/seed.sql   # demo data, optional
   ```

**API**
3. New → Web Service, point at the repo, root directory `backend/`.
4. Environment: `DATABASE_URL`, `NODE_ENV=production`,
   `TRUST_PROXY=1`, and optionally `GOOGLE_MAPS_API_KEY`.
5. Render detects the `Dockerfile` automatically. Health check
   path: `/health`.

**Frontend**
6. New → Static Site, root directory `frontend/`,
   build command `npm ci && npm run build`, publish directory `dist`.
7. Add a rewrite so the SPA and API coexist on one origin:
   - `/api/*` → your API service (proxy)
   - `/*` → `/index.html` (SPA fallback, **excluding** `/sw.js`)

> Important: do **not** let the SPA fallback swallow `/sw.js`. If
> requests for the service worker return `index.html`, the browser
> gets HTML where it expects JavaScript and registration fails with a
> confusing MIME-type error.

**Then**
8. Add your custom domain; TLS is issued automatically.

---

## 4. ⚠️ The constraint that matters for *this* app

**PWAs cannot read location in the background.** On iOS especially,
background execution for web apps is heavily restricted — service
workers handle caching and push, not general background tasks, and
Background Sync isn't supported at all.

Your queue engine depends on `is_checked_in` and `live_eta_minutes`
being *current*. But a customer who joins the queue and then locks
their phone stops sending location updates entirely. When the
two-slot-prior trigger fires, it reads whatever was last written —
possibly 20 minutes stale — and may drop someone who is actually
parking outside.

This isn't a bug in the code. It's a platform limit, and you have to
design around it. Four options, roughly in order of effort:

**A. Pull, don't push (recommended).** Invert the flow: instead of
passively trusting stored coordinates, *actively ask* when it matters.
When someone reaches the two-slot-prior mark, send them a web push:
"You're next in ~10 minutes — tap to confirm you're on the way." The
tap opens the app, which takes a fresh location reading. The tap
itself is a strong presence signal. This fits your existing
architecture almost exactly — the trigger already knows the right
moment to ask. Give them a response window before treating silence as
absence.

Web Push works on Android, and on iOS 16.4+ **only when the user has
installed the PWA to their home screen** — a real caveat worth
designing around, since it means push is unavailable to anyone using
it as a plain browser tab.

**B. SMS a magic link.** Zero install friction, works on every phone
including old ones. Text a link at the two-slots-prior moment; tapping
it opens the page, grants location once, and pings. Costs a few cents
per message via Twilio.

**C. Foreground-only, and say so.** Keep polling while the app is
open, and be explicit in the UI: "Keep this screen open so we can hold
your place." Honest and simple. Plenty of people waiting for an
appointment do keep the app open.

**D. Wrap it natively with Capacitor.** The only route to true
background geofencing. Same web codebase, wrapped for App Store and
Play Store. Costs: $99/yr Apple + $25 one-time Google, app review, and
background-location permission gets extra scrutiny from Apple —
expect to justify it.

Also worth knowing: your existing **Lock-Back override already
mitigates this**. It's exactly the manual escape hatch an attendant
needs when GPS is stale or wrong, which is precisely the failure mode
these platform limits create. That was a good instinct.

---

## 5. Installing on a phone

**Android (Chrome):** an install prompt appears automatically once the
PWA criteria are met (HTTPS, manifest, service worker, icons — all
already satisfied here). Also available via ⋮ → "Add to Home screen".

**iOS (Safari):** Share → "Add to Home Screen". Note that **iOS gives
no automatic prompt** — users will not discover this on their own. Add
a dismissible in-app hint for iOS Safari visitors explaining the two
taps, or most of them will never install it.

Once installed, both platforms launch it full-screen with your icon,
using the `display: standalone` and `theme_color` already set in
`manifest.json`.

### Other iOS caveats worth knowing

- Push notifications require **iOS 16.4+ and home-screen install**.
- Cache/IndexedDB can be **evicted after roughly 7 days of non-use**,
  so never treat cached queue state as durable — always re-fetch on
  launch, which the network-first `/api` strategy already does.
- Cache quota is small (~50MB). Not a problem at this app's size.
- Home-screen web apps in the EU are fine — Apple removed them briefly
  in an iOS 17.4 beta in early 2024, then reversed that decision after
  regulatory pushback.

---

## 6. App Store / Play Store presence

Only needed if store discoverability matters to you.

- **Google Play:** wrap the PWA in a Trusted Web Activity (Bubblewrap).
  Straightforward, and it stays your real web app underneath.
- **Apple App Store:** Apple rejects thin website wrappers under
  guideline 4.2. You need genuine native capability to pass review —
  which points back to Capacitor (option D above) rather than a
  wrapper.

For a B2B2C venue queue, most people reach it from a QR code at the
front desk or an SMS link, not by searching an app store. Start with
the PWA.

---

## 7. Before you go live

- [ ] HTTPS with a real certificate
- [ ] `/sw.js` served as JavaScript, excluded from SPA fallback
- [ ] `DATABASE_URL` uses SSL (`?sslmode=require` on most hosts)
- [ ] `GOOGLE_MAPS_API_KEY` set, and **restricted** to your server IP
      in Google Cloud Console — an unrestricted key will get scraped
      and billed to you
- [ ] Nightly cron hitting `POST /api/venues/:id/rebalance`
- [ ] Automated database backups turned on
- [ ] `npm ci --omit=dev` in the production build (the Dockerfile does this)
- [ ] Decide on your answer to section 4

### Not yet built — you will need these

This codebase has no **authentication or rate limiting.** As shipped,
anyone who knows a venue UUID can call the next customer or drop
someone from the line. Before real venues touch it:

- Attendant auth on every mutating endpoint (`/serve`, `/reinstate`,
  `/move`, `/automation`)
- A customer-scoped token so people can only update *their own*
  location
- Rate limiting on `/location`, which is the endpoint an attacker
  would hammer

The layered architecture makes this a contained change — auth is
middleware in `routes.js`, and none of the queue logic in
`queueCore.js` has to know about it.
