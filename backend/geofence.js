'use strict';

/**
 * geofence.js
 * ─────────────────────────────────────────────────────────────
 * Pure distance math. This is the piece that was missing before:
 * the original /location route just accepted an `isCheckedIn`
 * boolean straight from the request body, which means a phone (or
 * anyone scripting the API) could simply claim to be checked in.
 * "The backend must immediately evaluate" the location, per the
 * spec, means the server computes presence itself from raw
 * coordinates against the venue's geofence — the client only ever
 * supplies lat/lng, never the checked-in verdict.
 */

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters. */
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Is (lat, lng) within a venue's geofence?
 * `venue` needs geofence_lat, geofence_lng, geofence_radius_meters.
 */
function isWithinGeofence(lat, lng, venue) {
  if (lat == null || lng == null) return false;
  const distance = haversineDistanceMeters(lat, lng, venue.geofence_lat, venue.geofence_lng);
  return distance <= venue.geofence_radius_meters;
}

/**
 * Is this a plausible coordinate value if present at all?
 * Deliberately permissive about ABSENCE (null/undefined just means
 * "no location shared yet," which isWithinGeofence already treats as
 * not-checked-in) but strict about a PRESENT value that isn't a real
 * coordinate — a string, NaN, or something out of range shouldn't be
 * allowed to silently corrupt the geofence math.
 */
function isPlausibleCoordinate(value, min, max) {
  if (value === undefined || value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

module.exports = { haversineDistanceMeters, isWithinGeofence, isPlausibleCoordinate, EARTH_RADIUS_METERS };
