import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
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
  FlaskConical,
  RotateCcw,
  ArrowRight,
  AlertTriangle,
} from 'lucide-react';

/**
 * QueueSimulator — live client-side mirror of backend/queueCore.js
 * ─────────────────────────────────────────────────────────────
 * Every rule here (two-slot-prior trigger, step-back midpoint math,
 * drop-to-back math, reinstate math, override-lock, automation
 * toggle) is the SAME algorithm implemented and unit-tested in the
 * real backend. This isn't a simplified toy version — it's the
 * actual rules, running against six in-memory customers so you can
 * click through every branch in real time.
 */

// ── Design tokens ────────────────────────────────────────────────
const COLORS = {
  ink: '#12141C',
  ink2: '#1B1E29',
  inkBorder: 'rgba(237,232,221,0.09)',
  paper: '#EFEAE0',
  paperBorder: 'rgba(34,37,46,0.12)',
  textOnInk: '#EDE8DD',
  textOnInkDim: '#9297A6',
  textOnPaper: '#22252E',
  textOnPaperDim: '#6B6F7B',
  brass: '#C98A3E',
  brassStrong: '#8A5A1E',
  jade: '#3F8168',
  rust: '#A6473A',
  indigo: '#6B5FA9',
};

const FONT_MONO = "'IBM Plex Mono', ui-monospace, 'Courier New', monospace";
const FONT_SANS = "'Manrope', ui-sans-serif, system-ui, -apple-system, sans-serif";

const GAP = 10;
const ROW_HEIGHT = 118;
const ROW_GAP = 14;

// ── Pure algorithm (mirrors backend/queueCore.js 1:1) ────────────
function midpoint(a, b) {
  return (a + b) / 2;
}

function sortActive(queue) {
  const serving = queue.filter((c) => c.status === 'serving');
  const waiting = queue
    .filter((c) => c.status === 'waiting')
    .slice()
    .sort((a, b) => a.weight - b.weight);
  return [...serving, ...waiting];
}

function isAtRisk(c, now = Date.now()) {
  if (c.checkedIn) return false;
  if (c.etaMinutes == null || c.expectedSlotAt == null) return false;
  return now + c.etaMinutes * 60000 > c.expectedSlotAt;
}

function evaluateTwoSlotPrior(sorted, servingId, automationEnabled, now = Date.now()) {
  if (!automationEnabled) return { mutated: false, reason: 'automation_disabled' };

  const idx = sorted.findIndex((c) => c.id === servingId);
  if (idx === -1) return { mutated: false, reason: 'serving_not_found' };

  const targetIdx = idx + 2;
  const target = sorted[targetIdx];
  if (!target) return { mutated: false, reason: 'no_target' };
  if (target.overrideLocked) return { mutated: false, reason: 'override_locked', targetId: target.id };
  if (!isAtRisk(target, now)) return { mutated: false, reason: 'on_track', targetId: target.id };

  return target.tier === 'premium' ? applyStepBack(sorted, targetIdx) : applyDrop(sorted, targetIdx);
}

function applyStepBack(sorted, targetIdx) {
  const target = sorted[targetIdx];
  const below = sorted[targetIdx + 1];
  if (!below) return { mutated: false, reason: 'already_last_in_line', targetId: target.id };
  const belowBelow = sorted[targetIdx + 2];
  const newWeight = belowBelow ? midpoint(below.weight, belowBelow.weight) : below.weight + GAP;
  return { mutated: true, reason: 'stepped_back', targetId: target.id, patch: { weight: newWeight, automationFlag: 'stepped_back' } };
}

function applyDrop(sorted, targetIdx) {
  const target = sorted[targetIdx];
  const maxWeight = Math.max(...sorted.map((c) => c.weight));
  return { mutated: true, reason: 'dropped', targetId: target.id, patch: { weight: maxWeight + GAP, automationFlag: 'dropped' } };
}

function computeReinstate(sorted, id) {
  const target = sorted.find((c) => c.id === id);
  if (!target) return { mutated: false, reason: 'not_found' };
  if (target.status === 'serving') return { mutated: false, reason: 'already_serving' };

  const serving = sorted.find((c) => c.status === 'serving');
  const nextInLine = sorted.find((c) => c.status === 'waiting' && c.id !== id);

  let newWeight;
  if (serving && nextInLine) newWeight = midpoint(serving.weight, nextInLine.weight);
  else if (nextInLine) newWeight = nextInLine.weight / 2;
  else if (serving) newWeight = serving.weight + GAP / 2;
  else newWeight = GAP;

  return { mutated: true, reason: 'reinstated', targetId: id, patch: { weight: newWeight, overrideLocked: true, automationFlag: 'reinstated' } };
}

function computeMove(waiting, id, direction) {
  const idx = waiting.findIndex((c) => c.id === id);
  if (idx === -1) return { mutated: false, reason: 'not_found' };

  if (direction === 'up') {
    if (idx === 0) return { mutated: false, reason: 'already_front' };
    const above = waiting[idx - 1];
    const aboveAbove = waiting[idx - 2];
    const newWeight = aboveAbove ? midpoint(aboveAbove.weight, above.weight) : above.weight / 2;
    return { mutated: true, reason: 'moved_up', targetId: id, patch: { weight: newWeight } };
  }
  if (idx === waiting.length - 1) return { mutated: false, reason: 'already_back' };
  const below = waiting[idx + 1];
  const belowBelow = waiting[idx + 2];
  const newWeight = belowBelow ? midpoint(below.weight, belowBelow.weight) : below.weight + GAP;
  return { mutated: true, reason: 'moved_down', targetId: id, patch: { weight: newWeight } };
}

// ── Seed data (mirrors backend/schema.sql's seed comment 1:1) ────
function makeInitialQueue() {
  const now = Date.now();
  const mk = (id, name, tier, weight, checkedIn, etaMinutes, slotOffsetMin, extra = {}) => ({
    id,
    name,
    tier, // 'premium' | 'free'
    weight,
    status: 'waiting',
    checkedIn,
    etaMinutes,
    expectedSlotAt: now + slotOffsetMin * 60000,
    overrideLocked: false,
    automationFlag: null,
    isTestCustomer: false,
    ...extra,
  });
  return [
    mk('alice', 'Alice Chen', 'premium', 10, true, 2, 0),
    mk('bob', 'Bob Martinez', 'free', 20, true, 3, 6),
    mk('charlie', 'Charlie Nguyen', 'free', 30, true, 2, 12, { isTestCustomer: true }),
    mk('dana', 'Dana Osei', 'premium', 40, false, 25, 18),
    mk('ethan', 'Ethan Brooks', 'free', 50, false, 20, 24),
    mk('fiona', 'Fiona Alvarez', 'free', 60, true, 4, 30),
  ];
}

const REASON_TONE = {
  stepped_back: 'brass',
  dropped: 'rust',
  on_track: 'jade',
  override_locked: 'indigo',
};

function toneColor(tone) {
  return { brass: COLORS.brass, rust: COLORS.rust, jade: COLORS.jade, indigo: COLORS.indigo }[tone] || COLORS.textOnInkDim;
}

// ── Small presentational pieces ──────────────────────────────────
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

function MiniToggle({ active, onClick, onIcon: OnIcon, offIcon: OffIcon, onLabel, offLabel }) {
  const Icon = active ? OnIcon : OffIcon;
  const color = active ? COLORS.jade : COLORS.rust;
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full transition-colors"
      style={{ backgroundColor: `${color}1a`, color, border: `1px solid ${color}55` }}
    >
      <Icon size={11} />
      {active ? onLabel : offLabel}
    </button>
  );
}

function TicketRow({ customer, rank, canMoveUp, canMoveDown, onReinstate, onMoveUp, onMoveDown, onToggleGps, onTogglePayment }) {
  const atRisk = isAtRisk(customer);
  const affected = customer.automationFlag === 'stepped_back' || customer.automationFlag === 'dropped';

  return (
    <div
      className="ticket-row-anim absolute left-0 right-0"
      style={{ top: rank * ROW_HEIGHT, height: ROW_HEIGHT - ROW_GAP, transition: 'top 480ms cubic-bezier(0.32, 1.15, 0.68, 1)' }}
    >
      <div
        className="h-full rounded-xl px-3.5 py-2.5 flex flex-col justify-between relative overflow-hidden"
        style={{
          backgroundColor: COLORS.paper,
          border: customer.isTestCustomer ? `2px dashed ${COLORS.indigo}88` : '2px solid transparent',
          boxShadow: '0 3px 10px rgba(0,0,0,0.28)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: -5,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: COLORS.ink,
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: -5,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: COLORS.ink,
          }}
        />

        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base font-bold tabular-nums shrink-0" style={{ fontFamily: FONT_MONO, color: COLORS.textOnPaperDim }}>
              {String(rank + 1).padStart(2, '0')}
            </span>
            <span className="text-sm font-semibold truncate" style={{ color: COLORS.textOnPaper }}>
              {customer.name}
            </span>
            {customer.isTestCustomer && <FlaskConical size={13} className="shrink-0" style={{ color: COLORS.indigo }} />}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge tone={customer.tier === 'premium' ? 'indigo' : 'neutral'}>{customer.tier === 'premium' ? '50% deposit' : 'Free walk-in'}</Badge>
          <Badge tone={customer.checkedIn ? 'jade' : 'rust'}>{customer.checkedIn ? 'At venue' : 'Not checked in'}</Badge>
          {customer.overrideLocked && (
            <Badge tone="indigo" icon={Lock}>
              Protected
            </Badge>
          )}
          {atRisk && !customer.overrideLocked && (
            <Badge tone="brass" icon={AlertTriangle}>
              At risk
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1.5 min-h-[24px]">
          {customer.isTestCustomer && (
            <>
              <MiniToggle active={customer.checkedIn} onClick={onToggleGps} onIcon={MapPin} offIcon={MapPinOff} onLabel="At venue" offLabel="Stuck in traffic" />
              <MiniToggle active={customer.tier === 'premium'} onClick={onTogglePayment} onIcon={CreditCard} offIcon={Wallet} onLabel="Deposit" offLabel="Free" />
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {affected ? (
              <button
                onClick={onReinstate}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full"
                style={{ backgroundColor: `${COLORS.indigo}22`, color: COLORS.indigo, border: `1px solid ${COLORS.indigo}66` }}
              >
                <Undo2 size={11} />
                Reinstate slot
              </button>
            ) : (
              <>
                <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1.5 rounded-lg disabled:opacity-20" style={{ color: COLORS.textOnPaperDim }} aria-label={`Move ${customer.name} up`}>
                  <ChevronUp size={15} />
                </button>
                <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1.5 rounded-lg disabled:opacity-20" style={{ color: COLORS.textOnPaperDim }} aria-label={`Move ${customer.name} down`}>
                  <ChevronDown size={15} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────
export default function QueueSimulator() {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(link);
    return () => {
      try {
        document.head.removeChild(link);
      } catch (e) {
        /* no-op */
      }
    };
  }, []);

  const [queue, setQueue] = useState(makeInitialQueue);
  const [automationEnabled, setAutomationEnabled] = useState(true);
  const [log, setLog] = useState([{ id: 0, text: 'Simulator ready. Six customers in line at Riverside Dermatology.', tone: 'neutral' }]);
  const logIdRef = useRef(1);

  const pushLog = useCallback((text, tone = 'neutral') => {
    setLog((prev) => [{ id: logIdRef.current++, text, tone }, ...prev].slice(0, 8));
  }, []);

  const servingCustomer = queue.find((c) => c.status === 'serving') || null;
  const waitingSorted = useMemo(() => queue.filter((c) => c.status === 'waiting').sort((a, b) => a.weight - b.weight), [queue]);

  const callNext = useCallback(() => {
    setQueue((prev) => {
      const active = sortActive(prev);
      const waiting = active.filter((c) => c.status === 'waiting');
      if (waiting.length === 0) {
        pushLog('Line is empty — nothing to call.', 'neutral');
        return prev;
      }

      const nextUp = waiting[0];
      const previouslyServing = active.find((c) => c.status === 'serving');

      let updated = prev.map((c) => {
        if (c.id === nextUp.id) return { ...c, status: 'serving' };
        if (previouslyServing && c.id === previouslyServing.id) return { ...c, status: 'served' };
        return c;
      });

      const postCallActive = sortActive(updated.filter((c) => c.status === 'waiting' || c.id === nextUp.id));
      const result = evaluateTwoSlotPrior(postCallActive, nextUp.id, automationEnabled);
      const targetName = result.targetId ? postCallActive.find((c) => c.id === result.targetId)?.name : null;

      if (result.mutated) {
        updated = updated.map((c) => (c.id === result.targetId ? { ...c, ...result.patch } : c));
      }

      const messages = {
        automation_disabled: `Called ${nextUp.name} next. Automation is paused — no background check ran.`,
        no_target: `Called ${nextUp.name} next. Fewer than three people in line — nothing to evaluate yet.`,
        override_locked: `Called ${nextUp.name} next. ${targetName} is protected by a Lock-Back override — skipped.`,
        on_track: `Called ${nextUp.name} next. ${targetName} is checked in and on pace — no action needed.`,
        stepped_back: `Called ${nextUp.name} next. ${targetName} (50% deposit) is unconfirmed and running late — stepped back one slot.`,
        dropped: `Called ${nextUp.name} next. ${targetName} (free walk-in) is unconfirmed and running late — dropped to the back.`,
        already_last_in_line: `Called ${nextUp.name} next. ${targetName} is already last in line — nothing further to cascade.`,
      };
      pushLog(messages[result.reason] || `Called ${nextUp.name} next.`, REASON_TONE[result.reason] || 'neutral');

      return updated;
    });
  }, [automationEnabled, pushLog]);

  const reinstate = useCallback(
    (id) => {
      setQueue((prev) => {
        const active = sortActive(prev);
        const target = active.find((c) => c.id === id);
        const result = computeReinstate(active, id);
        if (!result.mutated) return prev;
        pushLog(`${target.name} reinstated — guaranteed next in line and locked from further automation.`, 'indigo');
        return prev.map((c) => (c.id === id ? { ...c, ...result.patch } : c));
      });
    },
    [pushLog]
  );

  const moveCustomer = useCallback((id, direction) => {
    setQueue((prev) => {
      const waiting = prev.filter((c) => c.status === 'waiting').sort((a, b) => a.weight - b.weight);
      const result = computeMove(waiting, id, direction);
      if (!result.mutated) return prev;
      return prev.map((c) => (c.id === id ? { ...c, ...result.patch } : c));
    });
  }, []);

  const toggleGps = useCallback((id) => {
    setQueue((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const nowCheckedIn = !c.checkedIn;
        return { ...c, checkedIn: nowCheckedIn, etaMinutes: nowCheckedIn ? 2 : 25 };
      })
    );
  }, []);

  const togglePayment = useCallback((id) => {
    setQueue((prev) => prev.map((c) => (c.id === id ? { ...c, tier: c.tier === 'premium' ? 'free' : 'premium' } : c)));
  }, []);

  const resetSimulation = useCallback(() => {
    setQueue(makeInitialQueue());
    setAutomationEnabled(true);
    setLog([{ id: logIdRef.current++, text: 'Simulator reset. Six customers back in line.', tone: 'neutral' }]);
  }, []);

  return (
    <div className="min-h-screen w-full flex flex-col items-center px-4 py-6" style={{ backgroundColor: COLORS.ink, fontFamily: FONT_SANS }}>
      <style>{'@media (prefers-reduced-motion: reduce) { .ticket-row-anim { transition: none !important; } }'}</style>

      <div className="w-full max-w-md">
        {/* Header + Now Serving module */}
        <header className="mb-5">
          <p className="text-xs uppercase tracking-widest mb-0.5" style={{ color: COLORS.textOnInkDim }}>
            Riverside Dermatology
          </p>
          <h1 className="text-lg font-bold mb-3" style={{ color: COLORS.textOnInk }}>
            Front Desk Console
          </h1>

          <div className="rounded-2xl p-4" style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}` }}>
            <p className="text-xs uppercase tracking-widest mb-1.5" style={{ color: COLORS.textOnInkDim }}>
              Now serving
            </p>
            <div
              className="text-2xl font-bold tabular-nums truncate"
              style={{
                fontFamily: FONT_MONO,
                color: servingCustomer ? COLORS.brass : COLORS.textOnInkDim,
                textShadow: servingCustomer ? `0 0 20px ${COLORS.brass}44` : 'none',
              }}
            >
              {servingCustomer ? servingCustomer.name : '— NOT YET CALLED —'}
            </div>
          </div>
        </header>

        {/* Attendant console */}
        <section className="rounded-2xl p-4 mb-5" style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}` }}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.textOnInkDim }}>
              Attendant controls
            </span>
            <button
              onClick={() => setAutomationEnabled((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors"
              style={{
                backgroundColor: automationEnabled ? `${COLORS.jade}22` : `${COLORS.rust}22`,
                color: automationEnabled ? COLORS.jade : COLORS.rust,
                border: `1px solid ${automationEnabled ? COLORS.jade : COLORS.rust}55`,
              }}
            >
              <Power size={13} />
              {automationEnabled ? 'Automation on' : 'Automation paused'}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={callNext}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold py-2.5 rounded-xl active:scale-95 transition-transform"
              style={{ backgroundColor: COLORS.brass, color: COLORS.ink }}
            >
              Call next customer <ArrowRight size={15} />
            </button>
            <button
              onClick={resetSimulation}
              className="inline-flex items-center justify-center gap-1.5 text-sm font-medium px-3.5 py-2.5 rounded-xl transition-colors"
              style={{ color: COLORS.textOnInkDim, border: `1px solid ${COLORS.inkBorder}` }}
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>

          {!automationEnabled && (
            <p className="text-xs mt-2.5 leading-relaxed" style={{ color: COLORS.textOnInkDim }}>
              Background checks are frozen. Use the arrows on each ticket to reorder the line by hand.
            </p>
          )}
        </section>

        {/* Legend */}
        <p className="text-xs mb-3 leading-relaxed" style={{ color: COLORS.textOnInkDim }}>
          <FlaskConical size={11} className="inline -mt-0.5 mr-1" style={{ color: COLORS.indigo }} />
          marks the test ticket — toggle its status, then call the next customer to see the engine react.
        </p>

        {/* Queue list */}
        <section className="relative mb-5" style={{ height: Math.max(waitingSorted.length, 1) * ROW_HEIGHT }}>
          {waitingSorted.length === 0 && (
            <p className="text-sm text-center py-6" style={{ color: COLORS.textOnInkDim }}>
              No one's waiting — call next to keep the line moving, or reset the demo.
            </p>
          )}
          {waitingSorted.map((c, rank) => (
            <TicketRow
              key={c.id}
              customer={c}
              rank={rank}
              canMoveUp={rank > 0}
              canMoveDown={rank < waitingSorted.length - 1}
              onReinstate={() => reinstate(c.id)}
              onMoveUp={() => moveCustomer(c.id, 'up')}
              onMoveDown={() => moveCustomer(c.id, 'down')}
              onToggleGps={() => toggleGps(c.id)}
              onTogglePayment={() => togglePayment(c.id)}
            />
          ))}
        </section>

        {/* Activity log — receipt style */}
        <section className="rounded-2xl p-4" style={{ backgroundColor: COLORS.ink2, border: `1px dashed ${COLORS.inkBorder}` }}>
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: COLORS.textOnInkDim }}>
            Activity log
          </p>
          <div className="space-y-1.5">
            {log.map((entry) => (
              <p key={entry.id} className="text-xs leading-relaxed" style={{ fontFamily: FONT_MONO, color: toneColor(entry.tone) }}>
                › {entry.text}
              </p>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
