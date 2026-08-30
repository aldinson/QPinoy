import React, { useState } from 'react';
import { Crosshair, Store, LogOut } from 'lucide-react';
import { COLORS } from './theme';
import { api } from './api';
import { useAuth } from './auth';
import { Screen, Card, Button, Alert, Field } from './ui';
import FeedbackCard from './FeedbackCard';

/**
 * First-run setup for a business account: create the venue, which
 * makes you its owner.
 *
 * The geofence centre is required rather than optional. Every
 * presence decision in the engine measures distance from this point,
 * so a venue without one would silently mark nobody as checked in —
 * a failure that looks like a bug in the queue rather than missing
 * setup. "Use my current location" is offered because the person
 * doing this is almost always standing in the shop.
 */
export default function VenueSetup({ navigate }) {
  const { refresh, signOut, user } = useAuth();
  const [form, setForm] = useState({
    name: '',
    address: '',
    geofenceLat: '',
    geofenceLng: '',
    geofenceRadiusMeters: '150',
    avgServiceMinutes: '15',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setError('This browser has no location support — enter the coordinates manually.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          geofenceLat: pos.coords.latitude.toFixed(6),
          geofenceLng: pos.coords.longitude.toFixed(6),
        }));
        setLocating(false);
      },
      (err) => {
        setError(err.message || 'Could not read your location');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 20000 }
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { venue } = await api.createVenue({
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        geofenceLat: Number(form.geofenceLat),
        geofenceLng: Number(form.geofenceLng),
        geofenceRadiusMeters: Number(form.geofenceRadiusMeters),
        avgServiceMinutes: Number(form.avgServiceMinutes),
      });
      // Memberships changed — the app shell needs to know this user is
      // now staff somewhere before it will route to the console.
      await refresh();
      navigate(`/console?venue=${venue.id}`);
    } catch (err) {
      setError(err.message || 'Could not create your venue');
    } finally {
      setBusy(false);
    }
  }

  const coordsMissing = !form.geofenceLat || !form.geofenceLng;

  return (
    <Screen subtitle="Set up" title="Create your venue">
      <div className="text-sm mb-5" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
        Hi {user.full_name.split(' ')[0]} — one step before you can run a line. You'll be
        the owner, and you can authorize staff afterwards.
      </div>

      <Alert>{error}</Alert>

      <form onSubmit={submit}>
        <Field label="Business name" value={form.name} onChange={set('name')} placeholder="Riverside Dermatology" required />
        <Field label="Address (optional)" value={form.address} onChange={set('address')} placeholder="120 Riverside Dr" />

        <Card style={{ marginBottom: 12 }}>
          <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
            Where is your front door?
          </div>
          <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
            Customers count as "here" when they're inside this radius. Stand in your shop
            and tap the button for the most accurate result.
          </div>
          <Button type="button" variant="secondary" full onClick={useMyLocation} disabled={locating}>
            <Crosshair size={14} /> {locating ? 'Locating…' : 'Use my current location'}
          </Button>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <Field label="Latitude" value={form.geofenceLat} onChange={set('geofenceLat')} inputMode="decimal" required />
            <Field label="Longitude" value={form.geofenceLng} onChange={set('geofenceLng')} inputMode="decimal" required />
          </div>
          <Field
            label="Check-in radius (metres)"
            value={form.geofenceRadiusMeters}
            onChange={set('geofenceRadiusMeters')}
            inputMode="numeric"
            hint="150m suits most storefronts. Bigger for a mall unit."
          />
        </Card>

        <Field
          label="Average service time (minutes)"
          value={form.avgServiceMinutes}
          onChange={set('avgServiceMinutes')}
          inputMode="numeric"
          hint="Used to estimate when each customer's turn will come up."
        />

        <Button type="submit" full disabled={busy || coordsMissing || !form.name.trim()}>
          <Store size={14} /> {busy ? 'Creating…' : 'Create venue'}
        </Button>
      </form>

      {/* No venue yet, so nothing to attach this to — general
          feedback about the app. */}
      <div className="mt-6">
        <FeedbackCard />
      </div>

      <div className="mt-2">
        <Button variant="secondary" onClick={signOut}>
          <LogOut size={14} /> Sign out
        </Button>
      </div>
    </Screen>
  );
}
