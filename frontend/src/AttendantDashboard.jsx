import React, { useState, useEffect, useCallback, useRef } from 'react';
import QRCode from 'qrcode';
import {
  MapPin,
  MapPinOff,
  CreditCard,
  Wallet,
  Power,
  Undo2,
  ChevronUp,
  ChevronDown,
  Lock,
  ArrowRight,
  AlertTriangle,
  Plus,
  RefreshCw,
  QrCode,
  Users,
  LogOut,
  UserX,
  Link2,
  Copy,
  Check,
  Settings,
  Receipt,
} from 'lucide-react';
import { COLORS, FONT_MONO, FONT_SANS } from './theme';
import { api } from './api';
import { useAuth } from './auth';
import { Button, Alert, Card, Field, Select } from './ui';
import QrScanner from './QrScanner';

const POLL_MS = 4000;

function Badge({ tone = 'neutral', icon: Icon, children }) {
  const map = {
    jade: { bg: `${COLORS.jade}22`, fg: COLORS.jade, bd: `${COLORS.jade}55` },
    rust: { bg: `${COLORS.rust}22`, fg: COLORS.rust, bd: `${COLORS.rust}55` },
    brass: { bg: `${COLORS.brass}22`, fg: COLORS.brassStrong, bd: `${COLORS.brass}66` },
    indigo: { bg: `${COLORS.indigo}22`, fg: COLORS.indigo, bd: `${COLORS.indigo}55` },
    neutral: { bg: 'rgba(34,37,46,0.06)', fg: COLORS.textOnPaperDim, bd: COLORS.paperBorder },
  };
  const t = map[tone] || map.neutral;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ backgroundColor: t.bg, color: t.fg, border: `1px solid ${t.bd}` }}
    >
      {Icon && <Icon size={10} />}
      {children}
    </span>
  );
}

function IconButton({ icon: Icon, label, onClick, disabled, tone = 'neutral' }) {
  const toneColor = { jade: COLORS.jade, rust: COLORS.rust, brass: COLORS.brassStrong, neutral: COLORS.textOnPaper }[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1.5 rounded-lg transition-opacity disabled:opacity-30"
      style={{ backgroundColor: 'rgba(34,37,46,0.06)', color: toneColor, border: `1px solid ${COLORS.paperBorder}` }}
    >
      <Icon size={13} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function isAtRiskClient(entry, now = Date.now()) {
  if (entry.is_checked_in) return false;
  if (entry.live_eta_minutes == null || entry.expected_slot_at == null) return false;
  return now + entry.live_eta_minutes * 60000 > new Date(entry.expected_slot_at).getTime();
}

/**
 * Mirrors backend/subscriptions.js's getSubscriptionState() — same
 * "hand-port the pure rule to the client so the banner doesn't need an
 * extra request" reasoning as isAtRiskClient above. Only computes what
 * the banner actually needs; the full Billing.jsx screen gets the
 * authoritative version straight from GET /venues/:id/billing.
 */
function subscriptionStateClient(venue, now = Date.now()) {
  const hasEverPaid = venue.subscription_paid_until != null;
  const coverageEnd = new Date(hasEverPaid ? venue.subscription_paid_until : venue.trial_ends_at).getTime();
  const daysLeft = Math.ceil((coverageEnd - now) / (24 * 60 * 60 * 1000));
  return { isPastDue: now >= coverageEnd, isTrialing: !hasEverPaid, daysLeft };
}

/** Nudges owner/manager toward Billing before it becomes a problem — trial ending soon, or already past due. Renders nothing otherwise. */
function SubscriptionBanner({ venue, canManageStaff, navigate }) {
  if (!venue) return null;
  const state = subscriptionStateClient(venue);
  if (!state.isPastDue && !(state.isTrialing && state.daysLeft <= 3)) return null;

  return (
    <button
      onClick={() => canManageStaff && navigate(`/billing?venue=${venue.id}`)}
      className="w-full text-left rounded-xl px-3.5 py-2.5 mb-4 flex items-center gap-2"
      style={{
        backgroundColor: state.isPastDue ? `${COLORS.rust}22` : `${COLORS.brass}22`,
        border: `1px solid ${state.isPastDue ? COLORS.rust : COLORS.brass}55`,
        cursor: canManageStaff ? 'pointer' : 'default',
      }}
    >
      <AlertTriangle size={14} color={state.isPastDue ? COLORS.rust : COLORS.brass} />
      <span className="text-xs font-semibold" style={{ color: state.isPastDue ? COLORS.rust : COLORS.brass }}>
        {state.isPastDue
          ? "Subscription needs renewal — new customers can't join until then."
          : `Trial ends in ${state.daysLeft} ${state.daysLeft === 1 ? 'day' : 'days'}.`}
        {canManageStaff ? ' Tap to manage billing.' : ' Ask an owner/manager to renew.'}
      </span>
    </button>
  );
}

/**
 * The venue's shareable "join our line remotely" link and QR — the
 * counterpart to the customer's own personal enrollment QR
 * (CustomerHome.jsx). This one is static (no expiry, no per-customer
 * identity in it — it's just the venue id) and is meant to be printed at
 * the front desk, posted on the venue's site, or shared however the
 * business likes, so a customer can join before ever setting foot inside.
 */
function JoinLinkCard({ venueId }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  const joinUrl = `${window.location.origin}/join?venue=${venueId}`;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(joinUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#22252E', light: '#F4EEE3' },
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
      clearTimeout(copyTimerRef.current);
    };
  }, [joinUrl]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard API can be blocked (permissions, non-HTTPS) — the URL
         text below is still there to select and copy by hand */
    }
  }

  return (
    <Card style={{ marginBottom: 20 }}>
      <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnPaper }}>
        Let customers join remotely
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnPaperDim, lineHeight: 1.5 }}>
        Print this at the front desk, or share the link — anyone with it can join your line
        without a staff member scanning them in.
      </div>
      <div className="flex items-start gap-3">
        {dataUrl && (
          <img
            src={dataUrl}
            alt="QR code linking to this venue's remote join page"
            className="rounded-lg shrink-0"
            style={{ width: 110, height: 110, imageRendering: 'pixelated' }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-xs px-2 py-1.5 rounded-lg mb-2 truncate"
            style={{ backgroundColor: 'rgba(34,37,46,0.06)', color: COLORS.textOnPaperDim, fontFamily: FONT_MONO }}
          >
            {joinUrl}
          </div>
          <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy link'} tone={copied ? 'jade' : 'neutral'} onClick={copyLink} />
        </div>
      </div>
    </Card>
  );
}

// Presets for venues.enrollment_qr_ttl_seconds — mirrors the backend's
// bounds (60-3600s, venueRoutes.js) with round, explainable values
// rather than a raw number input.
const QR_TTL_PRESETS = [
  { label: '2 minutes', value: 120 },
  { label: '5 minutes', value: 300 },
  { label: '15 minutes (recommended)', value: 900 },
  { label: '30 minutes', value: 1800 },
  { label: '60 minutes', value: 3600 },
];

/**
 * Owner/manager control for how long a CUSTOMER'S check-in QR stays
 * valid when it was requested with this venue in mind (see the long
 * comment on GET /me/enrollment-token in authRoutes.js — the token
 * itself is venue-agnostic; this setting only takes effect because
 * CustomerHome.jsx passes venueId when the customer holds exactly one
 * active ticket).
 */
function EnrollmentTtlCard({ venueId, ttlSeconds, onChanged }) {
  const [value, setValue] = useState(ttlSeconds);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const savedTimerRef = useRef(null);

  useEffect(() => {
    setValue(ttlSeconds);
    return () => clearTimeout(savedTimerRef.current);
  }, [ttlSeconds]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await api.setEnrollmentQrTtl(venueId, value);
      onChanged(result.enrollment_qr_ttl_seconds);
      setSaved(true);
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  // Not one of the presets (e.g. set by an earlier version, or another
  // client) — still show it rather than silently snapping to the
  // nearest preset and pretending nothing changed.
  const options =
    ttlSeconds != null && !QR_TTL_PRESETS.some((p) => p.value === ttlSeconds)
      ? [...QR_TTL_PRESETS, { label: `${Math.round(ttlSeconds / 60)} minutes (current)`, value: ttlSeconds }]
      : QR_TTL_PRESETS;

  return (
    <Card style={{ marginBottom: 20 }}>
      <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnPaper }}>
        Check-in code validity
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnPaperDim, lineHeight: 1.5 }}>
        How long a customer's check-in QR stays scannable before it expires and their screen
        refreshes it. Shorter is safer — a photographed code goes stale sooner; longer is more
        forgiving if your line moves slowly.
      </div>
      <Alert>{error}</Alert>
      <Select value={value} onChange={(e) => setValue(Number(e.target.value))}>
        {options.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </Select>
      <Button onClick={save} disabled={saving || value === ttlSeconds}>
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
      </Button>
    </Card>
  );
}

function QueueRow({ entry, rank, isFirstWaiting, canMoveUp, canMoveDown, busy, onServe, onReinstate, onMove, onNoShow }) {
  const atRisk = isAtRiskClient(entry);
  const affected = entry.last_automation_flag === 'stepped_back' || entry.last_automation_flag === 'dropped';

  return (
    <div
      className="rounded-xl px-3.5 py-3 flex flex-col gap-2"
      style={{
        backgroundColor: COLORS.paper,
        border: entry.status === 'serving' ? `2px solid ${COLORS.jade}` : '2px solid transparent',
        boxShadow: '0 3px 10px rgba(0,0,0,0.20)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base font-bold tabular-nums shrink-0" style={{ fontFamily: FONT_MONO, color: COLORS.textOnPaperDim }}>
            {String(rank + 1).padStart(2, '0')}
          </span>
          <span className="text-sm font-semibold truncate" style={{ color: COLORS.textOnPaper }}>
            {entry.customer_name}
          </span>
        </div>
        {entry.status === 'serving' && <Badge tone="jade">Now serving</Badge>}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge tone={entry.payment_tier === 'premium_secured' ? 'indigo' : 'neutral'} icon={entry.payment_tier === 'premium_secured' ? CreditCard : Wallet}>
          {entry.payment_tier === 'premium_secured' ? '50% deposit' : 'Free walk-in'}
        </Badge>
        <Badge tone={entry.is_checked_in ? 'jade' : 'rust'} icon={entry.is_checked_in ? MapPin : MapPinOff}>
          {entry.is_checked_in ? 'At venue' : 'Not checked in'}
        </Badge>
        {/* A ticket with no linked account can't self-report location,
            so it's worth flagging to staff who may need to ask. */}
        {!entry.user_id && <Badge tone="neutral">Walk-in</Badge>}
        {entry.is_override_locked && (
          <Badge tone="indigo" icon={Lock}>
            Protected
          </Badge>
        )}
        {atRisk && !entry.is_override_locked && (
          <Badge tone="brass" icon={AlertTriangle}>
            At risk
          </Badge>
        )}
        {affected && (
          <Badge tone={entry.last_automation_flag === 'dropped' ? 'rust' : 'brass'}>
            {entry.last_automation_flag === 'dropped' ? 'Auto-dropped' : 'Auto-stepped-back'}
          </Badge>
        )}
      </div>

      {entry.status === 'waiting' && (
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          {isFirstWaiting && <IconButton icon={ArrowRight} label="Call next" tone="jade" onClick={onServe} disabled={busy} />}
          <IconButton icon={ChevronUp} label="Move up" onClick={() => onMove('up')} disabled={busy || !canMoveUp} />
          <IconButton icon={ChevronDown} label="Move down" onClick={() => onMove('down')} disabled={busy || !canMoveDown} />
          {affected && !entry.is_override_locked && <IconButton icon={Undo2} label="Reinstate" tone="brass" onClick={onReinstate} disabled={busy} />}
        </div>
      )}

      {entry.status === 'serving' && (
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          {/* Mark BEFORE calling the next customer — otherwise the next
              "call next" silently records this person as served. */}
          <IconButton icon={UserX} label="No-show" tone="rust" onClick={onNoShow} disabled={busy} />
        </div>
      )}
    </div>
  );
}

export default function AttendantDashboard({ venueId, navigate }) {
  const { signOut, memberships } = useAuth();
  const membership = memberships.find((m) => m.venue_id === venueId);

  const [queue, setQueue] = useState([]);
  const [venue, setVenue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [scanning, setScanning] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [scanTier, setScanTier] = useState('standard_free');

  const [showJoinLink, setShowJoinLink] = useState(false);
  const [showQrSettings, setShowQrSettings] = useState(false);

  const [showWalkIn, setShowWalkIn] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [walkInTier, setWalkInTier] = useState('standard_free');

  const [billingEnabled, setBillingEnabled] = useState(false);

  const load = useCallback(async () => {
    try {
      const { queue: rows } = await api.getQueue(venueId);
      setQueue(rows);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  // Venue detail is fetched once (not on the poll): it carries the
  // real automation flag, so the toggle reflects the server's state
  // instead of an optimistic guess.
  useEffect(() => {
    api
      .getVenue(venueId)
      .then(({ venue: v }) => setVenue(v))
      .catch(() => {});
  }, [venueId]);

  // Feature flag, not per-venue — fetched once. Keeps the Billing
  // button and trial/past-due banner hidden entirely while
  // SUBSCRIPTION_ENABLE is off, rather than showing UI for a feature
  // that isn't live yet.
  useEffect(() => {
    api
      .getBillingConfig()
      .then(({ enabled }) => setBillingEnabled(enabled))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function runAction(entryId, fn) {
    setBusyId(entryId);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  /** Called by QrScanner with the decoded string from the customer's screen. */
  const handleScan = useCallback(
    async (enrollmentToken) => {
      setScanBusy(true);
      setScanStatus(null);
      try {
        const { entry } = await api.enroll(venueId, enrollmentToken, scanTier);
        setScanStatus({ tone: 'success', text: `${entry.customer_name} added to the line.` });
        await load();
      } catch (err) {
        setScanStatus({ tone: 'error', text: err.message || 'Could not add that customer' });
      } finally {
        setScanBusy(false);
      }
    },
    [venueId, scanTier, load]
  );

  async function addWalkIn(e) {
    e.preventDefault();
    try {
      await api.joinQueue(venueId, {
        customerName: walkInName.trim(),
        customerPhone: walkInPhone.trim() || undefined,
        paymentTier: walkInTier,
      });
      setWalkInName('');
      setWalkInPhone('');
      setWalkInTier('standard_free');
      setShowWalkIn(false);
      await load();
    } catch (err) {
      setError(err.message || 'Could not add customer');
    }
  }

  async function toggleAutomation() {
    if (!venue) return;
    try {
      const result = await api.setAutomation(venueId, !venue.is_automation_enabled);
      setVenue((v) => ({ ...v, is_automation_enabled: result.is_automation_enabled }));
    } catch (err) {
      setError(err.message || 'Could not toggle automation');
    }
  }

  const waiting = queue.filter((e) => e.status === 'waiting');
  const firstWaitingId = waiting[0]?.id;
  const automationOn = venue?.is_automation_enabled;
  const canManageStaff = membership?.role === 'owner' || membership?.role === 'manager';

  return (
    <div className="min-h-screen" style={{ backgroundColor: COLORS.ink, fontFamily: FONT_SANS }}>
      <div className="max-w-lg mx-auto px-4 pt-6 pb-24">
        <header className="flex items-start justify-between mb-4 gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-wide uppercase truncate" style={{ fontFamily: FONT_MONO, color: COLORS.brass }}>
              {venue?.name || 'Attendant console'}
            </div>
            <div className="text-lg font-bold" style={{ color: COLORS.textOnInk }}>
              Live line
            </div>
          </div>
          <button
            onClick={toggleAutomation}
            disabled={!venue}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full disabled:opacity-50 shrink-0"
            style={{
              backgroundColor: !venue ? 'rgba(146,151,166,0.15)' : automationOn ? `${COLORS.jade}22` : `${COLORS.rust}22`,
              color: !venue ? COLORS.textOnInkDim : automationOn ? COLORS.jade : COLORS.rust,
              border: `1px solid ${!venue ? COLORS.textOnInkDim : automationOn ? COLORS.jade : COLORS.rust}55`,
            }}
          >
            <Power size={13} />
            {!venue ? 'Automation…' : `Automation ${automationOn ? 'on' : 'off'}`}
          </button>
        </header>

        <Alert>{error}</Alert>
        {billingEnabled && <SubscriptionBanner venue={venue} canManageStaff={canManageStaff} navigate={navigate} />}

        {/* Scanning is the primary way customers join, so it gets the
            primary button and sits above the line itself. */}
        {!scanning ? (
          <div className="flex flex-wrap gap-2 mb-5">
            <Button onClick={() => { setScanning(true); setScanStatus(null); }}>
              <QrCode size={15} /> Scan customer
            </Button>
            <Button variant="secondary" onClick={() => setShowWalkIn((v) => !v)}>
              <Plus size={14} /> Walk-in
            </Button>
            <Button variant="secondary" onClick={() => setShowJoinLink((v) => !v)}>
              <Link2 size={14} /> Join link
            </Button>
            {canManageStaff && (
              <Button variant="secondary" onClick={() => setShowQrSettings((v) => !v)}>
                <Settings size={14} /> QR settings
              </Button>
            )}
            {canManageStaff && billingEnabled && (
              <Button variant="secondary" onClick={() => navigate(`/billing?venue=${venueId}`)}>
                <Receipt size={14} /> Billing
              </Button>
            )}
            {canManageStaff && (
              <Button variant="secondary" onClick={() => navigate(`/staff?venue=${venueId}`)}>
                <Users size={14} /> Staff
              </Button>
            )}
          </div>
        ) : (
          <Card style={{ marginBottom: 20 }}>
            <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
              Scan the customer's code
            </div>
            <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
              Ask them to open QPinoy and show their check-in code.
            </div>
            <Select label="Add them as" value={scanTier} onChange={(e) => setScanTier(e.target.value)}>
              <option value="standard_free">Standard (free walk-in)</option>
              <option value="premium_secured">Premium (50% deposit)</option>
            </Select>
            <QrScanner
              onScan={handleScan}
              onCancel={() => setScanning(false)}
              busy={scanBusy}
              statusMessage={scanStatus}
            />
          </Card>
        )}

        {showJoinLink && <JoinLinkCard venueId={venueId} />}

        {showQrSettings && venue && (
          <EnrollmentTtlCard
            venueId={venueId}
            ttlSeconds={venue.enrollment_qr_ttl_seconds}
            onChanged={(sec) => setVenue((v) => ({ ...v, enrollment_qr_ttl_seconds: sec }))}
          />
        )}

        {showWalkIn && (
          <Card style={{ marginBottom: 20 }}>
            <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
              Add a walk-in
            </div>
            <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
              For someone without the app. They won't be able to share their location,
              so you'll need to track their arrival yourself.
            </div>
            <form onSubmit={addWalkIn}>
              <Field label="Name" value={walkInName} onChange={(e) => setWalkInName(e.target.value)} required />
              <Field label="Phone (optional)" type="tel" value={walkInPhone} onChange={(e) => setWalkInPhone(e.target.value)} />
              <Select label="Tier" value={walkInTier} onChange={(e) => setWalkInTier(e.target.value)}>
                <option value="standard_free">Standard (free walk-in)</option>
                <option value="premium_secured">Premium (50% deposit)</option>
              </Select>
              <Button type="submit" full disabled={!walkInName.trim()}>
                Add to line
              </Button>
            </form>
          </Card>
        )}

        {loading ? (
          <div className="text-sm" style={{ color: COLORS.textOnInkDim }}>
            Loading queue…
          </div>
        ) : queue.length === 0 ? (
          <div className="text-sm" style={{ color: COLORS.textOnInkDim }}>
            No one's in line yet. Scan a customer's code to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {queue.map((entry, i) => (
              <QueueRow
                key={entry.id}
                entry={entry}
                rank={i}
                isFirstWaiting={entry.id === firstWaitingId}
                canMoveUp={waiting.findIndex((w) => w.id === entry.id) > 0}
                canMoveDown={waiting.findIndex((w) => w.id === entry.id) < waiting.length - 1}
                busy={busyId === entry.id}
                onServe={() => runAction(entry.id, () => api.serve(venueId, entry.id))}
                onReinstate={() => runAction(entry.id, () => api.reinstate(venueId, entry.id))}
                onMove={(direction) => runAction(entry.id, () => api.move(venueId, entry.id, direction))}
                onNoShow={() => runAction(entry.id, () => api.noShow(venueId, entry.id))}
              />
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => runAction('__rebalance__', () => api.rebalance(venueId))}>
            <RefreshCw size={14} /> Rebalance
          </Button>
          <Button variant="secondary" onClick={signOut}>
            <LogOut size={14} /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
