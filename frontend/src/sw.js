/**
 * QPinoy Service Worker (production source)
 * ─────────────────────────────────────────────────────────────
 * This is the build-time version of pwa/sw.js. The difference that
 * matters: the precache list is INJECTED AT BUILD TIME by
 * vite-plugin-pwa via `self.__WB_MANIFEST`, rather than hardcoded.
 *
 * Why that's necessary: Vite emits content-hashed filenames
 * (assets/index-DMf-ofw4.js). Any hardcoded /static/js/main.js would
 * 404 in production. And because `cache.addAll()` is atomic, a single
 * 404 rejects the whole install — the service worker never activates,
 * and offline support silently doesn't exist with no visible error.
 * Injecting the real manifest removes that entire failure class.
 *
 * Runtime strategy is unchanged and deliberately hand-written (no
 * workbox runtime dependency): cache-first for the app shell,
 * network-first for /api/*, and mutations are never cached.
 */

// Injected at build time — an array of { url, revision } for every
// hashed asset Vite produced.
const PRECACHE_MANIFEST = self.__WB_MANIFEST || [];

const CACHE_VERSION = 'qpinoy-v1';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// The offline fallback must always be cached or offline mode is
// meaningless, so it's listed explicitly in addition to the manifest.
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL_CACHE);

      // The injected manifest uses paths relative to the worker's
      // scope ("offline.html"), while our own constants are absolute
      // ("/offline.html"). Normalise both to absolute before dedup,
      // or the same file gets fetched twice on install.
      const toAbsolute = (u) => new URL(u, self.registration.scope).pathname;
      const urls = [
        ...new Set([...PRECACHE_MANIFEST.map((e) => toAbsolute(e.url)), toAbsolute(OFFLINE_URL), '/']),
      ];

      // Cached individually rather than via addAll(): one unexpected
      // 404 shouldn't be able to abort the entire install.
      await Promise.all(
        urls.map((url) =>
          cache.add(url).catch((err) => console.warn(`[sw] could not precache ${url}`, err))
        )
      );

      // Verify the offline fallback specifically — if this one is
      // missing, fail loudly, because it's the whole safety net.
      const offlineCached = await cache.match(OFFLINE_URL);
      if (!offlineCached) throw new Error('[sw] offline.html failed to precache — offline mode would be broken');

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('qpinoy-') && k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never cache mutations. Calling the next customer, reinstating a
  // slot, or toggling automation must hit the network or fail
  // visibly — silently replaying a stale queue action would be worse
  // than an error.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigations fall back to the offline page rather than a browser
  // error when the network is gone.
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return Response.error();
  }
}

async function navigationHandler(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ offline: true, message: 'Showing the last known queue state.' }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    );
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * Web Push — the "pull, don't push" channel DEPLOYMENT.md (§4)
 * recommended in place of trusting a phone's last stored location once
 * its screen locks. The server (backend/push.js) decides WHEN to notify
 * ("you're next," "you were skipped"); this worker's only job is to
 * render whatever payload it sent and route a tap back into the app.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'QPinoy', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'QPinoy';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Same tag as a later notification about the SAME ticket replaces
    // this one instead of stacking a duplicate — e.g. a fresh "you're
    // next" shouldn't leave a stale "you're #3" notification sitting
    // in the tray underneath it.
    tag: data.tag || 'qpinoy',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = allClients.find((c) => c.url.startsWith(self.location.origin));
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(url);
      } else {
        await self.clients.openWindow(url);
      }
    })()
  );
});
