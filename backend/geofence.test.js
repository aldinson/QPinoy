'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { haversineDistanceMeters, isWithinGeofence, isPlausibleCoordinate } = require('./geofence');

test('haversine: distance from a point to itself is zero', () => {
  assert.equal(haversineDistanceMeters(40.7128, -74.006, 40.7128, -74.006), 0);
});

test('haversine: a pure latitude delta matches R * radians(delta) exactly (spherical law)', () => {
  const R = 6371000;
  const deltaDeg = 1;
  const expected = R * (deltaDeg * Math.PI) / 180;
  const actual = haversineDistanceMeters(0, 0, deltaDeg, 0);
  assert.ok(Math.abs(actual - expected) < 0.01, `expected ~${expected}m, got ${actual}m`);
});

test('haversine: distance is symmetric', () => {
  const a = haversineDistanceMeters(40.71, -74.0, 40.72, -74.01);
  const b = haversineDistanceMeters(40.72, -74.01, 40.71, -74.0);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('isWithinGeofence: same point as venue center is always inside', () => {
  const venue = { geofence_lat: 40.7128, geofence_lng: -74.006, geofence_radius_meters: 150 };
  assert.equal(isWithinGeofence(40.7128, -74.006, venue), true);
});

test('isWithinGeofence: ~50m away is inside a 150m radius', () => {
  const venue = { geofence_lat: 40.0, geofence_lng: -74.0, geofence_radius_meters: 150 };
  const fiftyMetersOfLat = 50 / 111320; // ~meters-per-degree latitude
  assert.equal(isWithinGeofence(40.0 + fiftyMetersOfLat, -74.0, venue), true);
});

test('isWithinGeofence: ~5km away is outside a 150m radius', () => {
  const venue = { geofence_lat: 40.0, geofence_lng: -74.0, geofence_radius_meters: 150 };
  const fiveKmOfLat = 5000 / 111320;
  assert.equal(isWithinGeofence(40.0 + fiveKmOfLat, -74.0, venue), false);
});

test('isWithinGeofence: missing coordinates are never considered checked in', () => {
  const venue = { geofence_lat: 40.0, geofence_lng: -74.0, geofence_radius_meters: 150 };
  assert.equal(isWithinGeofence(null, null, venue), false);
  assert.equal(isWithinGeofence(undefined, -74.0, venue), false);
});

test('isWithinGeofence: exactly at the radius boundary counts as inside (<=)', () => {
  // Construct a point at (very close to) exactly the radius distance by
  // solving the pure-latitude case: distance = R * radians(delta).
  const venue = { geofence_lat: 0, geofence_lng: 0, geofence_radius_meters: 100 };
  const R = 6371000;
  const deltaDeg = (100 / R) * (180 / Math.PI);
  assert.equal(isWithinGeofence(deltaDeg, 0, venue), true);
});

test('isPlausibleCoordinate: absent (null/undefined) is plausible — no location shared yet is not an error', () => {
  assert.equal(isPlausibleCoordinate(null, -90, 90), true);
  assert.equal(isPlausibleCoordinate(undefined, -90, 90), true);
});

test('isPlausibleCoordinate: a real number in range is plausible', () => {
  assert.equal(isPlausibleCoordinate(40.7128, -90, 90), true);
  assert.equal(isPlausibleCoordinate(-90, -90, 90), true);
  assert.equal(isPlausibleCoordinate(90, -90, 90), true);
});

test('isPlausibleCoordinate: out-of-range, non-numeric, and non-finite values are all rejected', () => {
  assert.equal(isPlausibleCoordinate(200, -90, 90), false);
  assert.equal(isPlausibleCoordinate(-200, -90, 90), false);
  assert.equal(isPlausibleCoordinate('40.7', -90, 90), false);
  assert.equal(isPlausibleCoordinate(NaN, -90, 90), false);
  assert.equal(isPlausibleCoordinate(Infinity, -90, 90), false);
});

