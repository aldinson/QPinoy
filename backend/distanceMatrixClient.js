'use strict';

/**
 * distanceMatrixClient.js
 * ─────────────────────────────────────────────────────────────
 * Adapter boundary for live traffic ETA. In production this calls
 * Google's Distance Matrix API; every place in this codebase that
 * needs a customer's ETA calls THIS module, never Google's API
 * directly — so swapping providers, or mocking it in tests, touches
 * exactly one file.
 *
 * Falls back to a straight-line-distance estimate (no network call,
 * no API key required) whenever GOOGLE_MAPS_API_KEY isn't set, so
 * local dev and the test suite never need real network access.
 */

const { haversineDistanceMeters } = require('./geofence');

// ~24 km/h — a deliberately conservative city/traffic estimate for the
// no-API-key fallback. Underestimating a late arrival is the failure
// mode that actually costs a customer their slot, so this errs slow.
const ASSUMED_URBAN_SPEED_METERS_PER_MINUTE = 400;

async function getLiveEtaMinutes({ originLat, originLng, destLat, destLng }) {
  if (originLat == null || originLng == null) return null;

  if (process.env.GOOGLE_MAPS_API_KEY) {
    return getEtaFromGoogleDistanceMatrix({ originLat, originLng, destLat, destLng });
  }

  const distanceMeters = haversineDistanceMeters(originLat, originLng, destLat, destLng);
  return Math.ceil(distanceMeters / ASSUMED_URBAN_SPEED_METERS_PER_MINUTE);
}

/** Real integration point — swap `fetch` below for your preferred HTTP client if needed. */
async function getEtaFromGoogleDistanceMatrix({ originLat, originLng, destLat, destLng }) {
  const params = new URLSearchParams({
    origins: `${originLat},${originLng}`,
    destinations: `${destLat},${destLng}`,
    departure_time: 'now', // enables live-traffic-aware duration
    key: process.env.GOOGLE_MAPS_API_KEY,
  });

  const response = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params}`);
  if (!response.ok) throw new Error(`Distance Matrix request failed: ${response.status}`);

  const data = await response.json();
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') return null;

  const seconds = (element.duration_in_traffic ?? element.duration)?.value;
  return seconds != null ? Math.ceil(seconds / 60) : null;
}

module.exports = { getLiveEtaMinutes };
