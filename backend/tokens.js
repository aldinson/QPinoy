'use strict';

/**
 * tokens.js
 * ─────────────────────────────────────────────────────────────
 * Stateless signed tokens (HMAC-SHA256 over base64url JSON — the
 * JWT wire shape, minus the parts of JWT that cause CVEs).
 *
 * Why stateless: the production target is Netlify Functions, where
 * there is no process to hold a session table and every request may
 * hit a cold container. A signed token needs no server-side lookup,
 * so auth costs zero extra database round-trips per request.
 *
 * Two deliberate departures from a general-purpose JWT library:
 *
 *  1. THE ALGORITHM IS NEVER READ FROM THE TOKEN. Verification always
 *     recomputes HMAC-SHA256 with the server secret. The classic JWT
 *     attacks — `alg: none`, or swapping RS256 for HS256 so the public
 *     key becomes the HMAC secret — both work by getting the verifier
 *     to trust an attacker-supplied `alg` header. There is nothing
 *     here to trust: the header is signed input like anything else,
 *     and a modified one simply fails the signature check.
 *
 *  2. EVERY TOKEN CARRIES A PURPOSE (`typ`) THAT THE CALLER MUST
 *     DECLARE UP FRONT. verify() takes the expected purpose as a
 *     required argument, so a 90-second enrollment QR code can never
 *     be replayed as a 30-day login session, or vice versa. Getting
 *     this wrong is otherwise easy and silent.
 */

const crypto = require('crypto');

const ALGORITHM = 'HS256';

/** Login/session token — sent as `Authorization: Bearer <token>`. */
const PURPOSE_SESSION = 'session';
/**
 * Enrollment token — what a customer's phone renders as a QR code for
 * staff to scan. Deliberately short-lived: it is displayed on a screen
 * in public, so anyone standing behind the customer can photograph it.
 * 90 seconds means a stolen photo is worthless almost immediately, and
 * the customer's screen re-renders a fresh one well before expiry.
 */
const PURPOSE_ENROLLMENT = 'enroll';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const ENROLLMENT_TTL_SECONDS = 90;

class TokenError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

/**
 * The signing secret. Read on every call rather than cached at module
 * load so tests (and `netlify dev`) can set it after require().
 *
 * There is deliberately NO development fallback value. A default
 * secret is the kind of thing that quietly survives all the way to
 * production and forges every session in the system; failing to boot
 * with an actionable message is strictly better than starting up
 * insecure.
 */
function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (need at least 32 characters).\n' +
        'Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'then set it in backend/.env locally, and in your host\'s environment variables in production.'
    );
  }
  return secret;
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(signingInput) {
  return crypto.createHmac('sha256', getSecret()).update(signingInput).digest('base64url');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create a signed token.
 * @param {object} claims   Arbitrary payload (e.g. `{ sub: userId }`).
 * @param {string} purpose  PURPOSE_SESSION or PURPOSE_ENROLLMENT.
 * @param {number} ttlSeconds
 */
function createToken(claims, purpose, ttlSeconds) {
  const issuedAt = nowSeconds();
  const header = b64urlJson({ alg: ALGORITHM, typ: 'JWT' });
  const payload = b64urlJson({ ...claims, typ: purpose, iat: issuedAt, exp: issuedAt + ttlSeconds });
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/**
 * Verify a token and return its payload.
 * Throws TokenError on anything suspicious — never returns a partially
 * trusted result.
 *
 * @param {string} token
 * @param {string} expectedPurpose  Required. See the `typ` note above.
 */
function verifyToken(token, expectedPurpose) {
  if (!expectedPurpose) throw new Error('verifyToken requires an explicit expected purpose');
  if (typeof token !== 'string') throw new TokenError('malformed token', 'malformed');

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token', 'malformed');

  const [header, payload, providedSignature] = parts;
  const expectedSignature = sign(`${header}.${payload}`);

  // Compare as bytes, in constant time. The length guard is required
  // because timingSafeEqual throws on unequal lengths instead of
  // returning false — and an attacker controls the provided length.
  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new TokenError('bad signature', 'bad_signature');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed token', 'malformed');
  }
  if (!claims || typeof claims !== 'object') throw new TokenError('malformed token', 'malformed');

  // Purpose is checked AFTER the signature, so this can only ever
  // reject a genuinely-issued token being used in the wrong place.
  if (claims.typ !== expectedPurpose) {
    throw new TokenError('token is not valid for this operation', 'wrong_purpose');
  }
  if (typeof claims.exp !== 'number' || nowSeconds() >= claims.exp) {
    throw new TokenError('token expired', 'expired');
  }

  return claims;
}

const createSessionToken = (userId) => createToken({ sub: userId }, PURPOSE_SESSION, SESSION_TTL_SECONDS);
const verifySessionToken = (token) => verifyToken(token, PURPOSE_SESSION);

const createEnrollmentToken = (userId) => createToken({ sub: userId }, PURPOSE_ENROLLMENT, ENROLLMENT_TTL_SECONDS);
const verifyEnrollmentToken = (token) => verifyToken(token, PURPOSE_ENROLLMENT);

module.exports = {
  TokenError,
  createToken,
  verifyToken,
  createSessionToken,
  verifySessionToken,
  createEnrollmentToken,
  verifyEnrollmentToken,
  PURPOSE_SESSION,
  PURPOSE_ENROLLMENT,
  SESSION_TTL_SECONDS,
  ENROLLMENT_TTL_SECONDS,
};
