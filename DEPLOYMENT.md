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
| **Postgres** | Managed database | Neon (recommended — see below), Supabase, Render Postgres, or Railway. Free tiers are fine to start. |
| **Backend API** | The Express app in `backend/` | Either as a Netlify Function (recommended, see §3) or as a normal always-on service on Render/Railway/Fly (§3b). A `Dockerfile` is included for the latter. |
| **Frontend** | Static files from `npm run build` | Netlify, or any static host. |

### Recommended: single origin

Serve the frontend and API from **one domain** (the API at `/api/*`).
This means:

- No CORS configuration at all
- Service worker scope covers everything cleanly
- Cookies/auth work without `SameSite` headaches later
- Matches the Vite dev proxy, so dev and prod behave identically

The Netlify + Netlify Functions setup below gets you this automatically
— `netlify.toml` redirects `/api/*` to the Function, so the browser
never sees two origins. If you split the frontend and API across two
different hosts instead, set `CORS_ORIGINS` on the API (explicit
allowlist — see `backend/.env.example`).

---

## 3. Recommended free path: Netlify + Neon (~15 minutes)

Everything on one platform (Netlify) plus one free serverless Postgres
(Neon). No card required for either at this scale.

**Database — Neon**
1. Create a free project at neon.tech. Copy the connection string it
   gives you (it already includes `?sslmode=require` — `backend/db.js`
   auto-enables TLS for any non-`localhost` host, so nothing else to
   configure).
2. Apply the schema once, from your machine:
   ```bash
   psql "$DATABASE_URL" -f backend/schema.sql
   psql "$DATABASE_URL" -f backend/seed.sql   # optional demo data
   ```
   (No local `psql`? Neon's own SQL editor in its dashboard can run
   both files' contents just as well.)

**Site — Netlify**
3. New site → connect this repo. Netlify reads `netlify.toml` at the
   repo root automatically:
   - build command `cd frontend && npm ci && npm run build`
   - publish directory `frontend/dist`
   - functions directory `netlify/functions`
   - `/api/*` and `/health` redirected to the Function; everything
     else falls back to `index.html` for the client-side router in
     `frontend/src/App.jsx` — except `/sw.js`, `/manifest.json`, and
     `/icons/*`, which are deliberately excluded from that fallback
     (see the comment in `netlify.toml` for why).
4. Site settings → Environment variables, add:
   - `DATABASE_URL` — the Neon connection string from step 1
   - `AUTH_SECRET` — **required.** Signs login sessions and QR
     check-in codes. Generate a fresh one (do not reuse your local
     dev value):
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
     The API refuses to start without it, by design — a default
     signing secret would let anyone forge any user's session.
   - `GOOGLE_MAPS_API_KEY` — optional, for live-traffic ETAs
5. Deploy. Netlify issues HTTPS on your `*.netlify.app` subdomain
   automatically; add a custom domain in Site settings whenever you
   want one (also auto-TLS via Let's Encrypt).

That's the whole deploy. `netlify/functions/api.js` wraps the same
`backend/app.js` that runs locally with `serverless-http`, using a
single pooled connection per warm function instance
(`backend/db.js`'s `createPool({ isServerless: true })`).

**Verify it worked:**
```bash
curl https://<your-site>.netlify.app/health
curl https://<your-site>.netlify.app/api/venues/00000000-0000-0000-0000-000000000001/queue
```

---

## 3b. Alternative: Render (backend) + Neon (DB) — no serverless rewrite

If you'd rather run the Express app exactly as-is, as a normal
always-on process (simpler mental model, but Render's free tier spins
down after ~15 min idle, so the next request eats a cold start):

**Database** — same as §3, Neon.

**API**
1. Render → New → Web Service, point at this repo, root directory
   `backend/`.
2. Environment: `DATABASE_URL` (the Neon string), `NODE_ENV=production`,
   `TRUST_PROXY=1`, optionally `GOOGLE_MAPS_API_KEY`.
3. Render detects the `Dockerfile` automatically. Health check path:
   `/health`.

**Frontend**
4. Netlify (or Render Static Site) → root directory `frontend/`,
   build command `npm ci && npm run build`, publish directory `dist`.
5. Add a rewrite so the SPA and API coexist on one origin:
   - `/api/*` → your Render API service (proxy)
   - `/*` → `/index.html` (SPA fallback, **excluding** `/sw.js`,
     `/manifest.json`, `/icons/*`)

> Important: do **not** let the SPA fallback swallow `/sw.js`. If
> requests for the service worker return `index.html`, the browser
> gets HTML where it expects JavaScript and registration fails with a
> confusing MIME-type error.

**Then**
6. Add your custom domain; TLS is issued automatically.

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

**This build targets Android first** — the iOS subsection below is
kept as reference for later, not something to act on now.

**Android (Chrome):** Chrome fires `beforeinstallprompt` automatically
once the PWA criteria are met (HTTPS, manifest, service worker, icons
— all already satisfied here). `frontend/src/InstallPrompt.jsx`
captures that event and shows QPinoy's own styled "Install" banner
(bottom of screen, dismissible, remembers the dismissal in
`localStorage`) instead of relying purely on Chrome's own mini-infobar
— it calls `.prompt()` on a real user tap. Manual fallback is always
available too, via ⋮ → "Add to Home screen".

**iOS (Safari, reference only — not in scope right now):** Share →
"Add to Home Screen". iOS never fires `beforeinstallprompt` at all —
`InstallPrompt.jsx` simply renders nothing there, which is the correct
behavior for it — and gives no automatic prompt of its own either, so
if you do target iOS later you'd need a hand-built hint explaining the
two taps, or most visitors will never discover it.

Once installed, it launches full-screen with your icon, using the
`display: standalone` and `theme_color` already set in `manifest.json`.

### iOS caveats worth knowing if you revisit this later

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

- [ ] HTTPS with a real certificate (automatic on Netlify/Render)
- [ ] `/sw.js`, `/manifest.json`, `/icons/*` excluded from the SPA
      fallback (already set up in `netlify.toml`)
- [ ] `DATABASE_URL` uses SSL — automatic via `backend/db.js` for any
      non-`localhost` host, including Neon
- [ ] `GOOGLE_MAPS_API_KEY` set, and restricted in Google Cloud
      Console. On Render/Fly you can restrict by server IP; on Netlify
      Functions there's no fixed outbound IP to restrict by, so
      restrict by **API** (Distance Matrix only) and set a billing
      quota/alert instead — an unrestricted key will get scraped and
      billed to you either way
- [ ] A cron hitting `POST /api/venues/:id/rebalance` nightly per
      venue — a free option on Netlify is a
      [Scheduled Function](https://docs.netlify.com/functions/scheduled-functions/);
      cron-job.org hitting the endpoint directly also works on any host
- [ ] Automated database backups turned on (Neon keeps point-in-time
      restore on its free tier for a short window — check current
      limits before relying on it for anything you can't afford to lose)
- [ ] `npm ci --omit=dev` in the production build (the Dockerfile does
      this for the Render path; Netlify's own build doesn't ship dev
      dependencies to the Function bundle either)
- [ ] Decide on your answer to section 4

### Authentication — built

Accounts, roles, and per-venue authorization are now in place:

- Every queue endpoint (`/queue`, `/serve`, `/reinstate`, `/move`,
  `/automation`, `/rebalance`) requires a signed-in user who holds a
  `venue_members` row for that venue. A signed-in stranger gets a
  404, not a 403 — confirming a venue exists would let anyone
  enumerate venue IDs.
- `/location` is customer-scoped: a customer may update only the
  ticket linked to their own `user_id`; venue staff may update any
  ticket at their own venue; everyone else gets a 403.
- Roles are `owner` → `manager` → `attendant`. Owners and managers
  edit the staff list; attendants run the line only. The owner row
  cannot be demoted or removed through the staff endpoints.

### Rate limiting — built

Counters live in Postgres (`rate_limits`), **not in process memory**.
On Netlify Functions each request may land on a different or
cold-started container, so an in-memory counter resets constantly and
is bypassed by simply spreading requests — a counter is only a limit
if every instance can see it. The cost is one extra query on limited
requests, which both endpoints were already making anyway.

| Endpoint | Limit | Keyed on |
|---|---|---|
| `POST /auth/login` | 10 **failed** attempts / 15 min | (email, IP) pair |
| `POST /auth/login` | 60 **failed** attempts / 15 min | IP, across all accounts |
| `PATCH …/location` | 30 requests / min | user id |

Three decisions worth knowing about:

- **Only failed logins count, and the account counter includes the
  IP.** Keying it on the email alone is the obvious implementation and
  it is a self-inflicted denial of service: anyone could burn a
  stranger's budget with ten wrong guesses and lock that person out of
  their own account. (Note that "a success clears the counter" does
  *not* fix this on its own — the limit is checked before the password
  is verified, so the victim never gets that far.) NIST SP 800-63B
  makes the same recommendation: throttle, don't lock accounts.
- **A successful login does not refill the broad per-IP counter.** If
  it did, an attacker who owns any valid account would have a free
  reset button between spraying rounds.
- **The limiter fails open.** If the counter query itself errors,
  requests are allowed rather than refused — a database blip must not
  lock every user out of the product. This widens no real window,
  since neither endpoint can do anything useful without that same
  database.

Old windows are swept opportunistically on ~1% of requests, so the
table stays proportional to live traffic with no cron to schedule.

**Upgrading a database that already exists:** the `rate_limits` block
in `schema.sql` uses `IF NOT EXISTS`, so you can paste just that part
into an already-deployed database instead of re-running the whole
schema:

```sql
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket        TEXT PRIMARY KEY,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
    hits          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
```

Until that table exists the limiter fails open, so an out-of-date
database degrades to "no throttling" rather than to an outage — but
it also means you get no protection, so run it.

**Known gap, stated plainly:** an attacker with many source IPs can
still grind a single account, because each IP gets its own per-account
budget. Closing that needs a CAPTCHA or step-up challenge after
repeated failures. Worth adding when there is something worth
stealing; it is not there today.

### Still not built — you will want these

- **Password reset / email verification.** There is no way for a user
  to recover a forgotten password, and nothing proves an email
  address belongs to the person who typed it. Both need an email
  provider (Resend and Postmark both have usable free tiers).
- **Session revocation.** Tokens are stateless and valid for 30 days;
  there is no server-side "log out everywhere". Rotating
  `AUTH_SECRET` invalidates every session at once, which is the blunt
  version of this.
