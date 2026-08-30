import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Wallet, CreditCard, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { COLORS, FONT_MONO } from './theme';
import { api } from './api';
import { Screen, Card, Button, Alert } from './ui';

/** ₱999.00, from 99900 centavos — the only place this app formats money for display. */
function formatCentavos(centavos) {
  return `₱${(centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysUntil(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function StatusBanner({ status, coverageEnd }) {
  const days = daysUntil(coverageEnd);
  if (status === 'past_due') {
    return (
      <Card style={{ marginBottom: 20, borderColor: `${COLORS.rust}55` }}>
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: COLORS.rust }}>
          <AlertTriangle size={16} /> Subscription needs renewal
        </div>
        <div className="text-xs mt-1" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
          New customers can't join your line until this is renewed. Anyone already in line is
          unaffected — you can still call, no-show, and serve them normally.
        </div>
      </Card>
    );
  }
  return (
    <Card style={{ marginBottom: 20 }}>
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: status === 'trialing' ? COLORS.brass : COLORS.jade }}>
        {status === 'trialing' ? <Clock size={16} /> : <CheckCircle2 size={16} />}
        {status === 'trialing' ? 'Free trial' : 'Active subscription'}
      </div>
      <div className="text-xs mt-1" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        {status === 'trialing'
          ? `${days} ${days === 1 ? 'day' : 'days'} left, until ${formatDate(coverageEnd)}.`
          : `Renews by ${formatDate(coverageEnd)}${days <= 5 ? ` — ${days} ${days === 1 ? 'day' : 'days'} left` : ''}.`}
      </div>
    </Card>
  );
}

function HistoryRow({ payment }) {
  const toneColor = { paid: COLORS.jade, pending: COLORS.brass, failed: COLORS.rust, cancelled: COLORS.textOnPaperDim }[payment.status];
  return (
    <Card style={{ marginBottom: 8 }}>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: COLORS.textOnPaper }}>
            {formatCentavos(payment.amount_centavos)}{' '}
            <span className="font-normal" style={{ color: COLORS.textOnPaperDim }}>
              via {payment.provider === 'paymongo' ? 'GCash/Maya/Card' : 'PayPal'}
            </span>
          </div>
          <div className="text-xs" style={{ color: COLORS.textOnPaperDim }}>
            {formatDate(payment.period_start)} – {formatDate(payment.period_end)}
          </div>
        </div>
        <span className="text-xs font-semibold capitalize shrink-0" style={{ color: toneColor }}>
          {payment.status}
        </span>
      </div>
    </Card>
  );
}

export default function Billing({ venueId, cancelledPaymentId, navigate }) {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [payingWith, setPayingWith] = useState(null);
  const [notice, setNotice] = useState(cancelledPaymentId ? 'Checkout cancelled — you can try again anytime.' : null);

  const load = useCallback(async () => {
    try {
      const data = await api.getBilling(venueId);
      setBilling(data);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load billing information');
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  // Tidy up the abandoned attempt's row (still 'pending' otherwise)
  // rather than leaving it dangling forever in the billing history.
  useEffect(() => {
    if (!cancelledPaymentId) return;
    api.cancelBillingPayment(venueId, cancelledPaymentId).then(load).catch(() => {});
    // Intentionally runs once on mount only — cancelledPaymentId comes
    // from the URL this screen was entered with and won't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pay(provider) {
    setPayingWith(provider);
    setError(null);
    try {
      const { redirectUrl } = await api.startCheckout(venueId, provider);
      // A full navigation, not a fetch — the payer has to actually land
      // on PayMongo's/PayPal's own hosted page to pay. billingRoutes.js
      // built this URL to send them back to /billing/return afterwards.
      window.location.href = redirectUrl;
    } catch (err) {
      setError(err.message || 'Could not start checkout');
      setPayingWith(null);
    }
  }

  return (
    <Screen subtitle="Billing" title="Subscription">
      <button
        onClick={() => navigate(`/console?venue=${venueId}`)}
        className="inline-flex items-center gap-1 text-sm font-semibold mb-4"
        style={{ color: COLORS.brass }}
      >
        <ArrowLeft size={14} /> Back to the line
      </button>

      <Alert>{error}</Alert>
      <Alert tone="brass">{notice}</Alert>

      {loading ? (
        <div className="text-sm" style={{ color: COLORS.textOnInkDim }}>
          Loading…
        </div>
      ) : billing && !billing.enabled ? (
        <div className="text-sm" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
          Subscription billing isn't enabled on this server yet.
        </div>
      ) : (
        billing && (
          <>
            <StatusBanner status={billing.status} coverageEnd={billing.coverageEnd} />

            <Card style={{ marginBottom: 20 }}>
              <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
                {billing.plan.name}
              </div>
              <div className="text-2xl font-bold mb-3" style={{ color: COLORS.textOnInk, fontFamily: FONT_MONO }}>
                {formatCentavos(billing.plan.priceCentavos)}
                <span className="text-sm font-normal" style={{ color: COLORS.textOnInkDim }}>
                  {' '}
                  / {billing.plan.periodDays} days
                </span>
              </div>

              {!billing.availableProviders.paymongo && !billing.availableProviders.paypal ? (
                <div className="text-xs" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
                  No payment method is configured on this server yet.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {billing.availableProviders.paymongo && (
                    <Button full disabled={payingWith != null} onClick={() => pay('paymongo')}>
                      <Wallet size={14} /> {payingWith === 'paymongo' ? 'Redirecting…' : 'Pay with GCash, Maya, or Card'}
                    </Button>
                  )}
                  {billing.availableProviders.paypal && (
                    <Button full variant="secondary" disabled={payingWith != null} onClick={() => pay('paypal')}>
                      <CreditCard size={14} /> {payingWith === 'paypal' ? 'Redirecting…' : 'Pay with PayPal'}
                    </Button>
                  )}
                </div>
              )}
            </Card>

            <div className="text-sm font-semibold mb-2" style={{ color: COLORS.textOnInk }}>
              Payment history
            </div>
            {billing.history.length === 0 ? (
              <div className="text-xs" style={{ color: COLORS.textOnInkDim }}>
                No payments yet.
              </div>
            ) : (
              billing.history.map((payment) => <HistoryRow key={payment.id} payment={payment} />)
            )}
          </>
        )
      )}
    </Screen>
  );
}
