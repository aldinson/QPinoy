import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  MapPin,
  MapPinOff,
  Lock,
  AlertTriangle,
  Navigation,
  LogOut,
  RefreshCw,
  Bell,
  BellOff,
  Search,
  Store,
  Users,
  ListOrdered,
  QrCode,
  CheckCircle2,
} from 'lucide-react';
import { COLORS, FONT_MONO } from './theme';
import { api, ApiError } from './api';
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

/**
 * "Join a line remotely" — search-as-you-type over every venue on the
 * platform, then one tap to request a spot. This is the entry point
 * for a customer who does NOT already have a venue-specific link/QR
 * (that case is JoinVenue.jsx, reached via /join?venue=<id>); this one
 * lives right on the customer's own home screen instead.
 *
 * `joinedVenueIds` comes from the caller's real tickets (/me/queue),
 * NOT from local state set at the moment of tapping Join. An earlier
 * version tracked "joined" in this component and got it wrong twice
 * over: the badge vanished on remount even though the ticket was still
 * live, and a line joined any other way (staff scan, a /join link)
 * still advertised a Join button. Server state is the only thing that
 * actually knows.
 */
function FindBusinessCard({ joinedVenueIds, onJoined }) {
  const [venues, setVenues] = useState(null); // null = still loading
  const [query, setQuery] = useState('');
  const [joiningId, setJoiningId] = useState(null);
  const [errorById, setErrorById] = useState({});
  const [loadError, setLoadError] = useState(null);

  /**
   * Re-fetched after every join, not just on mount: the headcount
   * beside each business ("7 waiting") is live data, and leaving it
   * frozen at whatever it was when the screen opened made a successful
   * join look like it had done nothing at all.
   */
  const loadVenues = useCallback(async () => {
    try {
      const { venues: rows } = await api.listVenues();
      setVenues(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message || 'Could not load businesses');
    }
  }, []);

  useEffect(() => {
    loadVenues();
  }, [loadVenues]);

  const filtered = (venues || []).filter((v) => v.name.toLowerCase().includes(query.trim().toLowerCase()));

  async function requestJoin(venue) {
    setJoiningId(venue.id);
    setErrorById((s) => ({ ...s, [venue.id]: null }));
    try {
      await api.selfJoin(venue.id);
      await Promise.all([onJoined(), loadVenues()]);
    } catch (err) {
      // Already holding a ticket here is a fine outcome to land on,
      // not an error to alarm over — same reasoning as JoinVenue.jsx.
      if (err instanceof ApiError && err.status === 409) {
        await Promise.all([onJoined(), loadVenues()]);
      } else {
        setErrorById((s) => ({ ...s, [venue.id]: err.message || 'Could not join this line' }));
      }
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <Card>
      <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
        Join a line remotely
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        Search for a business on QPinoy and request a spot in their line from wherever you are.
      </div>

      <Alert>{loadError}</Alert>

      <div className="relative mb-2">
        <Search
          size={14}
          color={COLORS.textOnInkDim}
          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search businesses…"
          className="w-full pl-8 pr-3 py-2.5 rounded-lg text-sm outline-none"
          style={{ backgroundColor: COLORS.ink, color: COLORS.textOnInk, border: `1px solid ${COLORS.inkBorder}` }}
        />
      </div>

      {venues === null ? (
        <div className="text-xs" style={{ color: COLORS.textOnInkDim }}>
          Loading businesses…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-xs" style={{ color: COLORS.textOnInkDim }}>
          {venues.length === 0 ? 'No businesses are on QPinoy yet.' : 'No businesses match that search.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
          {filtered.map((venue) => {
            const alreadyIn = joinedVenueIds.has(venue.id);
            const errorMsg = errorById[venue.id];
            return (
              <div key={venue.id}>
                <div
                  className="rounded-lg p-2.5 flex items-center gap-2.5"
                  style={{ backgroundColor: COLORS.ink, border: `1px solid ${COLORS.inkBorder}` }}
                >
                  <div className="rounded-lg p-1.5 shrink-0" style={{ backgroundColor: `${COLORS.brass}22` }}>
                    <Store size={14} color={COLORS.brass} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: COLORS.textOnInk }}>
                      {venue.name}
                    </div>
                    <div className="flex items-center gap-1 text-xs" style={{ color: COLORS.textOnInkDim }}>
                      <Users size={11} />
                      {venue.people_in_line === 0 ? 'No one waiting' : `${venue.people_in_line} waiting`}
                    </div>
                  </div>
                  {alreadyIn ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-semibold shrink-0"
                      style={{ color: COLORS.jade }}
                    >
                      <CheckCircle2 size={12} /> In line
                    </span>
                  ) : (
                    <Button onClick={() => requestJoin(venue)} disabled={joiningId === venue.id}>
                      {joiningId === venue.id ? 'Joining…' : 'Join'}
                    </Button>
                  )}
                </div>
                {errorMsg && (
                  <div className="text-xs mt-1 px-1" style={{ color: COLORS.rust }}>
                    {errorMsg}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * Two ways into a line, presented as a choice rather than stacked on
 * top of each other: join remotely from wherever you are, or walk in
 * and have the front desk scan you. They're alternatives, and showing
 * both at once read as one long confusing form.
 */
function CheckInModeTabs({ mode, onChange }) {
  const tabs = [
    { id: 'remote', label: 'Join remotely', icon: Search },
    { id: 'walkin', label: 'Walk-in QR', icon: QrCode },
  ];
  return (
    <div
      className="flex gap-1 p-1 rounded-xl mb-3"
      style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}` }}
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = mode === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
            style={{
              backgroundColor: active ? COLORS.brass : 'transparent',
              color: active ? COLORS.ink : COLORS.textOnInkDim,
            }}
          >
            <Icon size={13} /> {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The rest of the line, in serve order — every OTHER name arrives
 * already masked from the server (see backend/names.js); only the
 * caller's own row is ever their real name, which is what makes it
 * possible to actually find yourself in the list.
 */
function RosterList({ roster }) {
  if (!roster || roster.length === 0) return null;
  return (
    <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.inkBorder}` }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ color: COLORS.textOnInkDim }}>
        <ListOrdered size={13} /> The line right now
      </div>
      <div className="flex flex-col gap-1">
        {roster.map((row) => (
          <div
            key={row.position}
            className="flex items-center justify-between text-xs rounded-md px-2 py-1.5"
            style={{
              backgroundColor: row.isMe ? `${COLORS.brass}1a` : 'transparent',
              color: row.isMe ? COLORS.textOnInk : COLORS.textOnInkDim,
              fontWeight: row.isMe ? 700 : 400,
            }}
          >
            <span style={{ fontFamily: FONT_MONO }}>#{row.position}</span>
            <span className="truncate ml-2">
              {row.name}
              {row.isMe ? ' (you)' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
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

      {/* Two DIFFERENT facts, previously blurred into one line that just
          said "Not checked in yet" — which read as "your join didn't
          work" when it actually meant "we can't see you at the venue".
          Holding a spot is settled the moment you join; being at the
          venue is a live geofence signal that starts out false for
          every remote join, by definition. */}
      <div className="flex items-center gap-2 text-sm font-semibold mb-1" style={{ color: COLORS.jade }}>
        <CheckCircle2 size={15} /> You're in this line
      </div>
      <div className="flex items-center gap-2 text-sm" style={{ color: COLORS.textOnInk }}>
        {entry.is_checked_in ? <MapPin size={15} color={COLORS.jade} /> : <MapPinOff size={15} color={COLORS.textOnInkDim} />}
        {entry.is_checked_in ? "We can see you're at the venue" : 'Not at the venue yet'}
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

      <RosterList roster={entry.roster} />
    </Card>
  );
}

export default function CustomerHome() {
  const { user, signOut } = useAuth();
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // 'remote' (search and join) | 'walkin' (show the check-in QR)
  const [mode, setMode] = useState('remote');
  const ticketsRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { entries: rows } = await api.myQueue();
      setEntries(rows);
      setError(null);
      return rows;
    } catch (err) {
      setError(err.message || 'Could not load your place in line');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Tickets render above the check-in section, so a join made while
   * scrolled down to the business list would land entirely off-screen
   * — the join worked, but nothing visibly happened where the customer
   * was looking. Scroll the new ticket into view so the answer to
   * "am I in?" is the thing they see next.
   */
  const handleJoined = useCallback(async () => {
    const rows = await load();
    if (rows && rows.length > 0) {
      // Wait for the ticket to actually be in the DOM before scrolling to it.
      requestAnimationFrame(() => {
        ticketsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [load]);

  const joinedVenueIds = new Set(entries.map((e) => e.venue_id));

  return (
    <Screen subtitle={`Hi, ${user.full_name.split(' ')[0]}`} title={entries.length ? 'Your lines' : 'Ready to check in'}>
      <Alert>{error}</Alert>

      <div ref={ticketsRef}>
        {entries.map((entry) => (
          <TicketCard key={entry.id} entry={entry} onChanged={load} />
        ))}
      </div>

      {!loading && entries.length === 0 && (
        <div className="text-sm mb-4" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
          You're not in any line right now. Pick how you'd like to check in.
        </div>
      )}

      <div className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.textOnInkDim, fontFamily: FONT_MONO }}>
        Join a line
      </div>
      <CheckInModeTabs mode={mode} onChange={setMode} />
      {mode === 'remote' ? (
        <FindBusinessCard joinedVenueIds={joinedVenueIds} onJoined={handleJoined} />
      ) : (
        /* Exactly one active ticket is the only case where "which
           venue's TTL setting applies" is unambiguous — zero or several
           fall back to the system-wide default inside EnrollmentQr. */
        <EnrollmentQr venueId={entries.length === 1 ? entries[0].venue_id : undefined} />
      )}

      <div className="mt-3">
        <NotificationsCard />
      </div>

      <div className="mt-6">
        <Button variant="secondary" onClick={signOut}>
          <LogOut size={14} /> Sign out
        </Button>
      </div>
    </Screen>
  );
}
