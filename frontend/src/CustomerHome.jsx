import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { MapPin, MapPinOff, Lock, AlertTriangle, Navigation, LogOut, RefreshCw, Bell, BellOff } from 'lucide-react';
import { COLORS, FONT_MONO } from './theme';
import { api } from './api';
import { useAuth } from './auth';
import { Screen, Card, Button, Alert } from './ui';

const QUEUE_POLL_MS = 5000;
const MIN_PING_INTERVAL_MS = 15000;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * "Enable notifications" — the customer-facing half of the push channel
 * DEPLOYMENT.md (§4) recommends in place of trusting a phone's last
 * stored location once its screen locks: the server pushes at the exact
 * moment it matters, and the tap itself is a fresh presence signal.
 *
 * Renders nothing at all — not even a disabled state — when there's
 * nothing to offer: no browser push support, or the backend has no
 * VAPID keys configured (self-hosted/local dev without them).
 */
function NotificationsCard() {
  const [publicKey, setPublicKey] = useState(null);
  // checking | unsupported | denied | off | on
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!cancelled) setStatus('unsupported');
        return;
      }
      try {
        const { publicKey: key } = await api.getVapidPublicKey();
        if (!key) {
          if (!cancelled) setStatus('unsupported');
          return;
        }
        if (cancelled) return;
        setPublicKey(key);

        if (Notification.permission === 'denied') {
          setStatus('denied');
          return;
        }
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setStatus(existing ? 'on' : 'off');
      } catch {
        if (!cancelled) setStatus('unsupported');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.subscribePush(subscription.toJSON());
      setStatus('on');
    } catch (err) {
      // A permission prompt the visitor dismissed/denied surfaces here
      // as a rejected subscribe() call, not a thrown error worth
      // showing raw — check the resulting permission state instead.
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') setStatus('denied');
      else setError(err.message || 'Could not enable notifications');
    }
  }

  async function disable() {
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.unsubscribePush(subscription.endpoint).catch(() => {});
        await subscription.unsubscribe();
      }
      setStatus('off');
    } catch (err) {
      setError(err.message || 'Could not turn off notifications');
    }
  }

  if (status === 'checking' || status === 'unsupported') return null;

  return (
    <Card style={{ marginBottom: 12 }}>
      <div className="flex items-center gap-2 text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
        {status === 'on' ? <Bell size={15} color={COLORS.jade} /> : <BellOff size={15} color={COLORS.textOnInkDim} />}
        Notifications {status === 'on' ? 'on' : 'off'}
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        Get a tap-to-confirm alert when you're next — even with the app closed.
      </div>
      <Alert>{error}</Alert>
      {status === 'denied' ? (
        <div className="text-xs" style={{ color: COLORS.rust }}>
          Notifications are blocked for this site. Allow them in your browser's site settings to turn this on.
        </div>
      ) : status === 'on' ? (
        <Button full variant="secondary" onClick={disable}>
          <BellOff size={14} /> Turn off
        </Button>
      ) : (
        <Button full onClick={enable}>
          <Bell size={14} /> Turn on notifications
        </Button>
      )}
    </Card>
  );
}

/**
 * The customer's home screen: their check-in QR code, plus their live
 * place in any line they've been scanned into.
 *
 * The QR encodes a short-lived signed enrollment token, NOT the
 * user's ID — see backend/tokens.js. Because the token eventually
 * expires, this component refreshes it on a timer well before that, so
 * the code on screen is always scannable.
 *
 * `venueId`, when known (the customer holds exactly one active
 * ticket — see the default export below), sizes the token to THAT
 * venue's own configured validity window instead of the system-wide
 * default; owner/manager can tune it in AttendantDashboard.jsx.
 */
function EnrollmentQr({ venueId }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { enrollmentToken, expiresInSeconds } = await api.getEnrollmentToken(venueId);
      // Rendered to a data URL rather than a canvas ref so React owns
      // the DOM node and there's no imperative cleanup to get wrong.
      const url = await QRCode.toDataURL(enrollmentToken, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M',
        // Deliberately light-on-dark inverted: phone cameras read a
        // dark-on-light code far more reliably, so the code itself
        // stays conventional even though the app is dark.
        color: { dark: '#12141C', light: '#EFEAE0' },
      });
      setDataUrl(url);
      setError(null);

      // Refresh at two-thirds of the lifetime: comfortably before
      // expiry even if the device clock or network is a little off.
      const refreshInMs = Math.max(15, Math.floor(expiresInSeconds * 0.66)) * 1000;
      setSecondsLeft(Math.floor(refreshInMs / 1000));
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(refresh, refreshInMs);
    } catch (err) {
      setError(err.message || 'Could not load your check-in code');
    }
  }, [venueId]);

  useEffect(() => {
    refresh();
    return () => clearTimeout(timerRef.current);
  }, [refresh]);

  // Purely cosmetic countdown so the code visibly looks "live".
  useEffect(() => {
    if (secondsLeft == null) return undefined;
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [secondsLeft != null]);

  return (
    <Card>
      <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
        Your check-in code
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        Show this to the front desk. They'll scan it to add you to the line.
      </div>

      <Alert>{error}</Alert>

      <div className="flex justify-center">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Your QPinoy check-in QR code"
            className="rounded-xl"
            style={{ width: '100%', maxWidth: 260, imageRendering: 'pixelated' }}
          />
        ) : (
          <div
            className="rounded-xl flex items-center justify-center"
            style={{ width: 260, height: 260, backgroundColor: COLORS.ink, border: `1px solid ${COLORS.inkBorder}` }}
          >
            <span className="text-xs" style={{ color: COLORS.textOnInkDim }}>
              Loading…
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs" style={{ color: COLORS.textOnInkDim, fontFamily: FONT_MONO }}>
          {secondsLeft > 0 ? `refreshes in ${secondsLeft}s` : 'refreshing…'}
        </span>
        <button
          onClick={refresh}
          className="inline-flex items-center gap-1 text-xs font-semibold"
          style={{ color: COLORS.brass }}
        >
          <RefreshCw size={12} /> New code
        </button>
      </div>
    </Card>
  );
}

/** One live ticket, with position and the location-sharing control. */
function TicketCard({ entry, onChanged }) {
  const [sharing, setSharing] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const watchIdRef = useRef(null);
  const lastPingRef = useRef(0);

  useEffect(
    () => () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    },
    []
  );

  function startSharing() {
    if (!('geolocation' in navigator)) {
      setLocationError('This browser has no location support.');
      return;
    }
    setLocationError(null);
    setSharing(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        // watchPosition can fire many times a second; the server only
        // needs a fresh fix every so often.
        if (now - lastPingRef.current < MIN_PING_INTERVAL_MS) return;
        lastPingRef.current = now;
        api
          .pingLocation(entry.venue_id, entry.id, pos.coords.latitude, pos.coords.longitude)
          .then(onChanged)
          .catch((err) => setLocationError(err.message));
      },
      (err) => setLocationError(err.message || 'Location permission denied'),
      { enableHighAccuracy: false, maximumAge: 10000, timeout: 20000 }
    );
  }

  function stopSharing() {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setSharing(false);
  }

  const serving = entry.status === 'serving';

  return (
    <Card style={{ marginBottom: 12 }}>
      <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: COLORS.brass, fontFamily: FONT_MONO }}>
        {entry.venue_name}
      </div>
      <div className="text-4xl font-bold mb-1" style={{ color: COLORS.textOnInk, fontFamily: FONT_MONO }}>
        {serving ? "You're up!" : `#${entry.people_ahead + 1}`}
      </div>
      <div className="text-sm mb-3" style={{ color: COLORS.textOnInkDim }}>
        {serving
          ? 'Head to the counter now.'
          : entry.people_ahead === 0
          ? "You're next — stay nearby."
          : `${entry.people_ahead} ${entry.people_ahead === 1 ? 'person' : 'people'} ahead of you.`}
      </div>

      <div className="flex items-center gap-2 text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
        {entry.is_checked_in ? <MapPin size={15} color={COLORS.jade} /> : <MapPinOff size={15} color={COLORS.rust} />}
        {entry.is_checked_in ? 'Checked in at venue' : 'Not checked in yet'}
      </div>
      {entry.is_override_locked && (
        <div className="flex items-center gap-1.5 text-xs mt-1" style={{ color: COLORS.indigo }}>
          <Lock size={12} /> Your spot is protected by the attendant.
        </div>
      )}
      {!entry.is_checked_in && !entry.is_override_locked && !serving && (
        <div className="flex items-center gap-1.5 text-xs mt-1" style={{ color: COLORS.brass }}>
          <AlertTriangle size={12} /> Share your location so we know you're on the way.
        </div>
      )}

      <p className="text-xs mt-3 mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        Location only updates while this screen is open — keep the app in the
        foreground so your spot stays accurate.
      </p>

      {!sharing ? (
        <Button full onClick={startSharing}>
          <Navigation size={14} /> Share my location
        </Button>
      ) : (
        <Button full variant="secondary" onClick={stopSharing}>
          Stop sharing
        </Button>
      )}
      <Alert>{locationError}</Alert>
    </Card>
  );
}

export default function CustomerHome() {
  const { user, signOut } = useAuth();
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { entries: rows } = await api.myQueue();
      setEntries(rows);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load your place in line');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Screen subtitle={`Hi, ${user.full_name.split(' ')[0]}`} title={entries.length ? 'Your lines' : 'Ready to check in'}>
      <Alert>{error}</Alert>

      {entries.map((entry) => (
        <TicketCard key={entry.id} entry={entry} onChanged={load} />
      ))}

      {!loading && entries.length === 0 && (
        <div className="text-sm mb-4" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
          You're not in any line right now. Show your code below at the front desk to join one.
        </div>
      )}

      <NotificationsCard />
      {/* Exactly one active ticket is the only case where "which
          venue's TTL setting applies" is unambiguous — zero or several
          fall back to the system-wide default inside EnrollmentQr. */}
      <EnrollmentQr venueId={entries.length === 1 ? entries[0].venue_id : undefined} />

      <div className="mt-6">
        <Button variant="secondary" onClick={signOut}>
          <LogOut size={14} /> Sign out
        </Button>
      </div>
    </Screen>
  );
}
