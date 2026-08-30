import React, { useState, useEffect } from 'react';
import { Store, LogIn, UserPlus, CheckCircle2, Users } from 'lucide-react';
import { COLORS } from './theme';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { Screen, Card, Button, Alert } from './ui';

/**
 * JoinVenue — the "join our line remotely" landing page.
 *
 * This is what a shareable link/QR (e.g. printed at the front desk, on
 * the venue's website, or posted to social media) resolves to:
 * `/join?venue=<id>`. It complements, not replaces, the staff-scan
 * enrollment in AttendantDashboard.jsx — this is the entry point for a
 * customer who isn't standing in front of a staff member yet, which is
 * the whole point of a "virtual waiting room."
 *
 * Reachable signed-out (like /demo): a visitor who taps a venue's join
 * link with no account yet sees what they're joining and how busy it is
 * before being asked to sign in. `PENDING_JOIN_KEY` is how the sign-in/
 * register flow (AuthScreens.jsx) finds its way back here afterwards.
 */
export const PENDING_JOIN_KEY = 'qpinoy_pending_join_venue';

export default function JoinVenue({ venueId, navigate }) {
  const { user } = useAuth();
  const [venue, setVenue] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getVenuePublic(venueId)
      .then((res) => {
        if (!cancelled) setVenue(res.venue);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load that venue');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  function goAuth(path) {
    try {
      sessionStorage.setItem(PENDING_JOIN_KEY, venueId);
    } catch {
      /* private-mode/embedded webviews can throw here — non-fatal, the
         visitor just lands on '/' after signing in instead of back here */
    }
    navigate(path);
  }

  async function join() {
    setJoining(true);
    setError(null);
    try {
      await api.selfJoin(venueId);
      setJoined(true);
    } catch (err) {
      // Already holding a ticket here is a fine outcome to land on, not
      // an error to surface — send them straight to it.
      if (err instanceof ApiError && err.status === 409) {
        setJoined(true);
      } else {
        setError(err.message || 'Could not join this line');
      }
    } finally {
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <Screen subtitle="Join a line" title="Loading…">
        <div className="text-sm" style={{ color: COLORS.textOnInkDim }}>
          One moment…
        </div>
      </Screen>
    );
  }

  if (!venue) {
    return (
      <Screen subtitle="Join a line" title="Venue not found">
        <Alert>{error || "That link doesn't point to a real venue — ask the venue for a fresh one."}</Alert>
        <Button variant="secondary" onClick={() => navigate('/')}>
          Back to QPinoy
        </Button>
      </Screen>
    );
  }

  if (joined) {
    return (
      <Screen subtitle="You're in" title={venue.name}>
        <Card>
          <div className="flex items-center gap-2 text-sm font-semibold mb-1" style={{ color: COLORS.jade }}>
            <CheckCircle2 size={16} /> You're in the line
          </div>
          <div className="text-xs" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
            Wait wherever you like — your live position is on your home screen.
          </div>
        </Card>
        <div className="mt-4">
          <Button full onClick={() => navigate('/')}>
            See my place in line
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen subtitle="Join a line" title={venue.name}>
      <Alert>{error}</Alert>

      <Card style={{ marginBottom: 20 }}>
        <div className="flex items-start gap-3">
          <div className="rounded-lg p-2 shrink-0" style={{ backgroundColor: `${COLORS.brass}22` }}>
            <Store size={18} color={COLORS.brass} />
          </div>
          <div>
            {venue.address && (
              <div className="text-xs mb-1" style={{ color: COLORS.textOnInkDim }}>
                {venue.address}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textOnInkDim }}>
              <Users size={12} />
              {venue.people_in_line === 0
                ? 'No one waiting right now'
                : `${venue.people_in_line} ${venue.people_in_line === 1 ? 'person' : 'people'} in line`}
            </div>
          </div>
        </div>
      </Card>

      {user ? (
        <Button full onClick={join} disabled={joining}>
          {joining ? 'Joining…' : 'Join this line'}
        </Button>
      ) : (
        <>
          <div className="text-sm mb-4" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
            Sign in (or create a free account) to hold your place — we need somewhere to
            send you when your turn is close.
          </div>
          <Button full onClick={() => goAuth('/login')}>
            <LogIn size={14} /> Sign in and join
          </Button>
          <div className="mt-2">
            <Button full variant="secondary" onClick={() => goAuth('/register')}>
              <UserPlus size={14} /> Create an account and join
            </Button>
          </div>
        </>
      )}
    </Screen>
  );
}
