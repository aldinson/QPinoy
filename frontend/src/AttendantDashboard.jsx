import React, { useState, useEffect, useCallback } from 'react';
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

function QueueRow({ entry, rank, isFirstWaiting, canMoveUp, canMoveDown, busy, onServe, onReinstate, onMove }) {
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

  const [showWalkIn, setShowWalkIn] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [walkInTier, setWalkInTier] = useState('standard_free');

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
