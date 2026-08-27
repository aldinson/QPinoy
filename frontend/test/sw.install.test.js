/**
 * sw.install.test.js
 * ─────────────────────────────────────────────────────────────
 * Runs the REAL production service worker (src/sw.js) inside a mock
 * Service Worker environment to verify its install behaviour.
 *
 * This targets the file that actually ships, including the
 * `self.__WB_MANIFEST` placeholder that vite-plugin-pwa replaces at
 * build time with the true hashed-asset list.
 *
 * Why this test exists: `cache.addAll()` is atomic per spec. A single
 * 404 rejects the whole install, the worker never activates, and
 * offline support silently doesn't exist — with no error anywhere
 * obvious. That failure is invisible in a browser until a user goes
 * offline and gets nothing. Hence: assert it explicitly.
 *
 * Run: npm test   (from frontend/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// __dirname isn't defined in ES modules; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(__dirname, '..', 'src', 'sw.js');

/**
 * Build a mock ServiceWorkerGlobalScope.
 *
 * @param {string[]} missingUrls  URLs that should 404 on fetch.
 * @param {object[]} manifest     Stand-in for the build-injected __WB_MANIFEST.
 */
function makeSandbox(missingUrls = [], manifest = null) {
  const cached = new Set();
  const listeners = {};
  const warnings = [];

  const defaultManifest = [
    { url: 'index.html', revision: 'abc' },
    { url: 'offline.html', revision: 'def' },
    // Relative + hashed, exactly as vite-plugin-pwa emits them.
    { url: 'assets/index-DIGZYB46.js', revision: null },
    { url: 'assets/index-CAp9nIE3.css', revision: null },
  ];

  const mockCache = {
    async add(url) {
      if (missingUrls.includes(url)) throw new Error(`404 fetching ${url}`);
      cached.add(url);
    },
    async addAll(urls) {
      for (const url of urls) {
        if (missingUrls.includes(url)) throw new Error(`404 fetching ${url}`);
      }
      urls.forEach((u) => cached.add(u));
    },
    async put() {},
    async match(url) {
      const key = typeof url === 'string' ? url : url.url;
      return cached.has(key) ? { url: key } : undefined;
    },
  };

  const sandbox = {
    self: {
      __WB_MANIFEST: manifest === null ? defaultManifest : manifest,
      location: { origin: 'https://qpinoy.example.com' },
      registration: { scope: 'https://qpinoy.example.com/' },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => mockCache,
      keys: async () => [],
      delete: async () => true,
      match: async (u) => mockCache.match(u),
    },
    fetch: async () => ({ ok: true, clone: () => ({}) }),
    console: {
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
      log: () => {},
    },
    Response: class {
      static error() {
        return { error: true };
      }
    },
    URL,
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox);

  return { listeners, cached, warnings };
}

async function runInstall(listeners) {
  let promise;
  await listeners.install({ waitUntil: (p) => { promise = p; } });
  await promise;
}

test('install caches every asset from the build-injected manifest', async () => {
  const { listeners, cached } = makeSandbox([]);
  await runInstall(listeners);

  assert.ok(cached.has('/index.html'), 'index.html cached');
  assert.ok(cached.has('/offline.html'), 'offline.html cached');
  assert.ok(cached.has('/assets/index-DIGZYB46.js'), 'hashed JS bundle cached');
  assert.ok(cached.has('/assets/index-CAp9nIE3.css'), 'hashed CSS bundle cached');
});

test('relative manifest URLs are normalised to absolute paths', async () => {
  // vite-plugin-pwa emits "assets/index-x.js" (relative). If those
  // aren't normalised against the worker scope, they won't dedup
  // against our own absolute constants and offline.html gets fetched
  // twice on every install.
  const { listeners, cached } = makeSandbox([]);
  await runInstall(listeners);

  const relatives = [...cached].filter((u) => !u.startsWith('/'));
  assert.deepEqual(relatives, [], `all cached URLs should be absolute, found: ${relatives}`);
});

test('install SURVIVES a missing hashed bundle (atomic-addAll bug guard)', async () => {
  const { listeners, cached, warnings } = makeSandbox(['/assets/index-DIGZYB46.js']);

  // Must not throw — one stale manifest entry cannot be allowed to
  // prevent the worker from ever activating.
  await runInstall(listeners);

  assert.ok(cached.has('/offline.html'), 'offline fallback still cached');
  assert.ok(cached.has('/index.html'), 'shell still cached');
  assert.ok(
    warnings.some((w) => w.includes('index-DIGZYB46.js')),
    'the missing asset should be warned about, not silently swallowed'
  );
});

test('install FAILS LOUDLY when offline.html is missing', async () => {
  // Without the offline fallback, "offline support" is a lie. Better
  // to fail the install than to ship a worker that pretends.
  const { listeners } = makeSandbox(['/offline.html']);
  await assert.rejects(() => runInstall(listeners), /offline\.html failed to precache/);
});

test('handles an empty manifest without crashing (e.g. sw run pre-build)', async () => {
  const { listeners, cached } = makeSandbox([], []);
  await runInstall(listeners);
  // Falls back to the explicit constants only.
  assert.ok(cached.has('/offline.html'));
  assert.ok(cached.has('/'));
});
