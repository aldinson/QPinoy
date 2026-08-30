import React, { useState, useEffect } from 'react';
import { FlaskConical, Store } from 'lucide-react';
import { COLORS, FONT_MONO, FONT_SANS } from './theme';
import { AuthProvider, useAuth } from './auth';
import { LoginScreen, RegisterScreen } from './AuthScreens';
import CustomerHome from './CustomerHome';
import JoinVenue from './JoinVenue';
import VenueSetup from './VenueSetup';
import AttendantDashboard from './AttendantDashboard';
import StaffMembers from './StaffMembers';
import Billing from './Billing';
import BillingReturn from './BillingReturn';
import QueueSimulator from './QueueSimulator';
import InstallPrompt from './InstallPrompt';
import { Screen, Card, Button } from './ui';
import FeedbackCard from './FeedbackCard';

/**
 * Deliberately no router dependency — a handful of static paths and
 * one query param don't earn one. history.pushState plus a popstate
 * listener is the entire routing surface this app needs.
 */
function useLocation() {
  const [loc, setLoc] = useState({ path: window.location.pathname, search: window.location.search });
  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to) => {
    window.history.pushState({}, '', to);
    const url = new URL(to, window.location.origin);
    setLoc({ path: url.pathname, search: url.search });
  };
  return [loc, navigate];
}

function Loading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: COLORS.ink, fontFamily: FONT_SANS }}
    >
      <span className="text-sm" style={{ color: COLORS.textOnInkDim, fontFamily: FONT_MONO }}>
        Loading…
      </span>
    </div>
  );
}

/** Signed-out landing: sign in, register, or poke at the algorithm demo. */
function Welcome({ navigate }) {
  return (
    <Screen subtitle="QPinoy" title="Smart line management">
      <div className="text-sm mb-6" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
        Virtual queuing for clinics, spas, barbershops and salons. Customers wait where
        they like; the line keeps itself honest.
      </div>
      <Button full onClick={() => navigate('/register')}>
        Create an account
      </Button>
      <div className="mt-2">
        <Button full variant="secondary" onClick={() => navigate('/login')}>
          I already have one
        </Button>
      </div>
      <Card style={{ marginTop: 24 }}>
        <button onClick={() => navigate('/demo')} className="flex items-start gap-3 text-left w-full">
          <div className="rounded-lg p-2 shrink-0" style={{ backgroundColor: `${COLORS.brass}22` }}>
            <FlaskConical size={18} color={COLORS.brass} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textOnInk }}>
              See how the queue thinks
            </div>
            <div className="text-xs mt-0.5" style={{ color: COLORS.textOnInkDim }}>
              An interactive demo of the ordering rules — no account needed.
            </div>
          </div>
        </button>
      </Card>
    </Screen>
  );
}

/** A staff member with more than one venue picks which line to run. */
function VenuePicker({ navigate }) {
  const { memberships, signOut } = useAuth();
  return (
    <Screen subtitle="Your venues" title="Which line?">
      <div className="flex flex-col gap-2.5">
        {memberships.map((m) => (
          <button
            key={m.venue_id}
            onClick={() => navigate(`/console?venue=${m.venue_id}`)}
            className="text-left rounded-xl p-4 flex items-start gap-3"
            style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}` }}
          >
            <div className="rounded-lg p-2 shrink-0" style={{ backgroundColor: `${COLORS.brass}22` }}>
              <Store size={18} color={COLORS.brass} />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: COLORS.textOnInk }}>
                {m.venue_name}
              </div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.textOnInkDim }}>
                You are {m.role} here
              </div>
            </div>
          </button>
        ))}
      </div>
      {/* Several venues here, so which one this is about is
          ambiguous — files as general app feedback. */}
      <div className="mt-6">
        <FeedbackCard />
      </div>

      <div className="mt-2">
        <Button variant="secondary" onClick={signOut}>
          Sign out
        </Button>
      </div>
    </Screen>
  );
}

/**
 * Where a signed-in user lands on '/'. Staff go to their line;
 * a business account that hasn't created a venue yet goes to setup;
 * everyone else is a customer and gets their QR code.
 */
function Home({ navigate }) {
  const { user, memberships } = useAuth();

  if (memberships.length === 1) {
    return <AttendantDashboard venueId={memberships[0].venue_id} navigate={navigate} />;
  }
  if (memberships.length > 1) {
    return <VenuePicker navigate={navigate} />;
  }
  if (user.account_type === 'business') {
    return <VenueSetup navigate={navigate} />;
  }
  return <CustomerHome />;
}

function Routes() {
  const [loc, navigate] = useLocation();
  const { user, loading, memberships } = useAuth();
  const params = new URLSearchParams(loc.search);

  // The algorithm demo is deliberately reachable without an account —
  // it talks to no backend and is the best way to explain the product.
  if (loc.path === '/demo') return <QueueSimulator />;

  if (loading) return <Loading />;

  // Reachable both signed-in and signed-out, like /demo: a "join our
  // line" link/QR has to work for a visitor who has never opened the app
  // before. JoinVenue itself handles the signed-out case (sign in/
  // register, then come back here).
  if (loc.path === '/join') {
    const venueId = params.get('venue');
    if (!venueId) return <Welcome navigate={navigate} />;
    return <JoinVenue venueId={venueId} navigate={navigate} />;
  }

  if (!user) {
    if (loc.path === '/register') return <RegisterScreen navigate={navigate} />;
    if (loc.path === '/login') return <LoginScreen navigate={navigate} />;
    return <Welcome navigate={navigate} />;
  }

  // Signed in: /login and /register have nothing left to offer.
  if (loc.path === '/login' || loc.path === '/register') return <Home navigate={navigate} />;

  if (loc.path === '/console') {
    const venueId = params.get('venue');
    // Guard client-side too, so a stale bookmark shows the picker
    // rather than a console full of 404s. The server enforces this
    // independently — see auth.js requireVenueRole.
    const allowed = memberships.some((m) => m.venue_id === venueId);
    if (!allowed) return <Home navigate={navigate} />;
    return <AttendantDashboard venueId={venueId} navigate={navigate} />;
  }

  if (loc.path === '/staff') {
    const venueId = params.get('venue');
    const allowed = memberships.some((m) => m.venue_id === venueId);
    if (!allowed) return <Home navigate={navigate} />;
    return <StaffMembers venueId={venueId} navigate={navigate} />;
  }

  if (loc.path === '/billing') {
    const venueId = params.get('venue');
    const allowed = memberships.some((m) => m.venue_id === venueId);
    if (!allowed) return <Home navigate={navigate} />;
    // The cancel_url billingRoutes.js builds carries the abandoned
    // payment's id as `cancelled` so Billing.jsx can mark that row
    // cancelled instead of leaving it 'pending' forever.
    return <Billing venueId={venueId} cancelledPaymentId={params.get('cancelled')} navigate={navigate} />;
  }

  if (loc.path === '/billing/return') {
    const venueId = params.get('venue');
    const paymentId = params.get('payment');
    const provider = params.get('provider');
    const allowed = memberships.some((m) => m.venue_id === venueId);
    if (!allowed || !paymentId || !provider) return <Home navigate={navigate} />;
    return <BillingReturn venueId={venueId} paymentId={paymentId} provider={provider} navigate={navigate} />;
  }

  return <Home navigate={navigate} />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes />
      <InstallPrompt />
    </AuthProvider>
  );
}
