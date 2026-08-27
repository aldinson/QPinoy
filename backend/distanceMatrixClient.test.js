'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { haversineDistanceMeters } = require('./geofence');

test('no API key configured: falls back to distance / assumed speed, no network call', async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  // Re-require fresh each test so the module re-reads process.env at call time
  // (the function reads it live, not at require-time, so this isn't strictly
  // necessary — but keeping it explicit documents the intent).
  const { getLiveEtaMinutes } = require('./distanceMatrixClient');

  const origin = { originLat: 40.0, originLng: -74.0, destLat: 40.01, destLng: -74.0 };
  const distanceMeters = haversineDistanceMeters(origin.originLat, origin.originLng, origin.destLat, origin.destLng);
  const expectedMinutes = Math.ceil(distanceMeters / 400);

  const result = await getLiveEtaMinutes(origin);
  assert.equal(result, expectedMinutes);
});

test('missing origin coordinates return null immediately', async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  const { getLiveEtaMinutes } = require('./distanceMatrixClient');
  const result = await getLiveEtaMinutes({ originLat: null, originLng: null, destLat: 40, destLng: -74 });
  assert.equal(result, null);
});

test('API key configured + live-traffic duration present: converts seconds to rounded-up minutes', async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      rows: [{ elements: [{ status: 'OK', duration_in_traffic: { value: 610 }, duration: { value: 500 } }] }],
    }),
  });

  const { getLiveEtaMinutes } = require('./distanceMatrixClient');
  const result = await getLiveEtaMinutes({ originLat: 40, originLng: -74, destLat: 40.01, destLng: -74 });
  assert.equal(result, 11); // 610s -> ceil(10.16..) = 11, and prefers duration_in_traffic over duration
});

test('API key configured, no duration_in_traffic: falls back to plain duration', async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rows: [{ elements: [{ status: 'OK', duration: { value: 300 } }] }] }),
  });

  const { getLiveEtaMinutes } = require('./distanceMatrixClient');
  const result = await getLiveEtaMinutes({ originLat: 40, originLng: -74, destLat: 40.01, destLng: -74 });
  assert.equal(result, 5); // 300s -> 5 min exactly
});

test('API key configured, element status not OK: returns null rather than throwing', async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ rows: [{ elements: [{ status: 'NOT_FOUND' }] }] }),
  });

  const { getLiveEtaMinutes } = require('./distanceMatrixClient');
  const result = await getLiveEtaMinutes({ originLat: 40, originLng: -74, destLat: 40.01, destLng: -74 });
  assert.equal(result, null);
});

test('API key configured, HTTP error: throws rather than silently returning a wrong ETA', async (t) => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  global.fetch = async () => ({ ok: false, status: 500 });

  const { getLiveEtaMinutes } = require('./distanceMatrixClient');
  await assert.rejects(() => getLiveEtaMinutes({ originLat: 40, originLng: -74, destLat: 40.01, destLng: -74 }));
});
