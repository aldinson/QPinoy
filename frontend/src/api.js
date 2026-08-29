/**
 * api.js — thin fetch wrapper over the real backend.
 * ─────────────────────────────────────────────────────────────
 * Always calls relative /api/* paths, never an absolute host: the
 * Vite dev proxy forwards those to localhost:4000 in development
 * (vite.config.js), and netlify.toml redirects them to the Function
 * in production. Same code, same requests, both environments.
 */

const TOKEN_STORAGE_KEY = 'qpinoy_token';

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The session token lives in localStorage rather than a cookie.
 *
 * The tradeoff, stated plainly: a cookie with HttpOnly would be
 * immune to XSS reading it, which localStorage is not. What buys back
 * the difference here is that the API is stateless and same-origin
 * (netlify.toml proxies /api/* onto the same domain), so there are no
 * cookies to be sent automatically and therefore no CSRF surface to
 * defend either. If this ever moves to cookie auth, CSRF protection
 * has to arrive in the same change.
 */
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private-mode Safari and some embedded webviews throw on access.
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* non-fatal: the session just won't survive a reload */
  }
}

// Set by AuthProvider so a 401 from anywhere can drop the app back to
// the login screen instead of leaving a dead session on screen.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);

  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) {
    throw new ApiError(json?.error || `Request failed (${res.status})`, res.status, json);
  }
  return json;
}

export const api = {
  // ── Accounts ────────────────────────────────────────────────
  register: (payload) => request('POST', '/auth/register', payload),
  login: (email, password) => request('POST', '/auth/login', { email, password }),
  me: () => request('GET', '/auth/me'),

  // ── Customer-side ───────────────────────────────────────────
  getEnrollmentToken: () => request('GET', '/me/enrollment-token'),
  myQueue: () => request('GET', '/me/queue'),

  // ── Venues & staff ──────────────────────────────────────────
  myVenues: () => request('GET', '/venues/mine'),
  getVenue: (venueId) => request('GET', `/venues/${venueId}`),
  createVenue: (payload) => request('POST', '/venues', payload),
  getMembers: (venueId) => request('GET', `/venues/${venueId}/members`),
  addMember: (venueId, email, role) => request('POST', `/venues/${venueId}/members`, { email, role }),
  removeMember: (venueId, userId) => request('DELETE', `/venues/${venueId}/members/${userId}`),

  // ── The line ────────────────────────────────────────────────
  getQueue: (venueId) => request('GET', `/venues/${venueId}/queue`),
  enroll: (venueId, enrollmentToken, paymentTier) =>
    request('POST', `/venues/${venueId}/queue/enroll`, { enrollmentToken, paymentTier }),
  joinQueue: (venueId, { customerName, customerPhone, paymentTier }) =>
    request('POST', `/venues/${venueId}/queue`, { customerName, customerPhone, paymentTier }),
  serve: (venueId, entryId) => request('POST', `/venues/${venueId}/queue/${entryId}/serve`),
  reinstate: (venueId, entryId) => request('POST', `/venues/${venueId}/queue/${entryId}/reinstate`),
  move: (venueId, entryId, direction) => request('POST', `/venues/${venueId}/queue/${entryId}/move`, { direction }),
  setAutomation: (venueId, enabled) => request('PATCH', `/venues/${venueId}/automation`, { enabled }),
  pingLocation: (venueId, entryId, lat, lng) => request('PATCH', `/venues/${venueId}/queue/${entryId}/location`, { lat, lng }),
  rebalance: (venueId) => request('POST', `/venues/${venueId}/rebalance`),
};

export { ApiError };
