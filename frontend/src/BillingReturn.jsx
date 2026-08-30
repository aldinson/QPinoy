import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { COLORS } from './theme';
import { api, ApiError } from './api';
import { Screen, Card, Button, Alert } from './ui';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30000;

/**
 * Where PayMongo/PayPal send the payer back after checkout
 * (backingRoutes.js built this URL as the success_url/return_url) —
 * `/billing/return?venue=<id>&payment=<id>&provider=paymongo|paypal`.
 *
 * The two providers need genuinely different handling here, not just
 * different copy:
 *
 *   PayPal    — capture happens SYNCHRONOUSLY, right now, on this page:
 *               the payer approved on PayPal's site but nothing has
 *               actually been charged yet until we call capture.
 *   PayMongo  — there is no equivalent step. The checkout already
 *               completed on PayMongo's hosted page; this page can only
 *               poll for the webhook (billingRoutes.js's
 *               /webhooks/paymongo) to have confirmed it, which usually
 *               lands within a couple of seconds but isn't instant.
 */
export default function BillingReturn({ venueId, paymentId, provider, navigate }) {
  const [status, setStatus] = useState('working'); // working | paid | pending | failed
  const [error, setError] = useState(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode/re-render guard — this must run exactly once
    startedRef.current = true;

    if (provider === 'paypal') {
      capturePaypal();
    } else {
      pollPaymongo();
    }

    async function capturePaypal() {
      try {
        await api.capturePaypalPayment(venueId, paymentId);
        setStatus('paid');
      } catch (err) {
        setError(err.message || 'Could not confirm your PayPal payment');
        setStatus('failed');
      }
    }

    async function pollPaymongo() {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const { payment } = await api.getBillingPayment(venueId, paymentId);
          if (payment.status === 'paid') {
            setStatus('paid');
            return;
          }
          if (payment.status === 'failed' || payment.status === 'cancelled') {
            setStatus('failed');
            return;
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            setStatus('failed');
            return;
          }
          // Transient network hiccup — keep polling rather than
          // failing the whole confirmation over one dropped request.
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      // Timed out waiting, but that does NOT mean the payment failed —
      // webhook delivery can legitimately lag. Tell the truth: still
      // processing, not "failed."
      setStatus('pending');
    }
  }, [venueId, paymentId, provider]);

  return (
    <Screen subtitle="Billing" title="Confirming payment">
      <Alert>{error}</Alert>

      <Card>
        {status === 'working' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: COLORS.textOnInk }}>
            <Loader2 size={16} className="animate-spin" /> Confirming your payment…
          </div>
        )}
        {status === 'paid' && (
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: COLORS.jade }}>
            <CheckCircle2 size={16} /> Payment confirmed — your subscription is active.
          </div>
        )}
        {status === 'pending' && (
          <div className="text-sm" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
            Still confirming — this can take a minute to finish on the payment provider's side.
            Your subscription will update automatically once it does; check back shortly.
          </div>
        )}
        {status === 'failed' && (
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: COLORS.rust }}>
            <XCircle size={16} /> Could not confirm this payment.
          </div>
        )}
      </Card>

      <div className="mt-4">
        <Button full onClick={() => navigate(`/billing?venue=${venueId}`)}>
          Back to billing
        </Button>
      </div>
    </Screen>
  );
}
