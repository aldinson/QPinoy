import React, { useState, useEffect, useCallback } from 'react';
import { Trash2, UserPlus, ArrowLeft, ShieldCheck, Shield } from 'lucide-react';
import { COLORS } from './theme';
import { api } from './api';
import { useAuth } from './auth';
import { Screen, Card, Button, Alert, Field, Select } from './ui';

const ROLE_LABEL = {
  owner: 'Owner',
  manager: 'Manager — can add and remove staff',
  attendant: 'Attendant — can run the line',
};

/**
 * The staff roster for one venue.
 *
 * Owners and managers can edit it; attendants can see it but get no
 * controls. The server enforces the same rule (venueRoutes.js), so
 * hiding the buttons here is a UX courtesy, not the security boundary.
 */
export default function StaffMembers({ venueId, navigate }) {
  const { user, memberships } = useAuth();
  const myRole = memberships.find((m) => m.venue_id === venueId)?.role;
  const canManage = myRole === 'owner' || myRole === 'manager';

  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('attendant');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { members: rows } = await api.getMembers(venueId);
      setMembers(rows);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load the staff list');
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addMember(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { member } = await api.addMember(venueId, email.trim(), role);
      setNotice(`${member.full_name} can now work at this venue as ${member.role}.`);
      setEmail('');
      setRole('attendant');
      await load();
    } catch (err) {
      setError(err.message || 'Could not add that person');
    } finally {
      setBusy(false);
    }
  }

  async function remove(member) {
    setError(null);
    setNotice(null);
    try {
      await api.removeMember(venueId, member.user_id);
      setNotice(`${member.full_name}'s access was removed.`);
      await load();
    } catch (err) {
      setError(err.message || 'Could not remove that person');
    }
  }

  return (
    <Screen subtitle="Staff" title="Who works here">
      <button
        onClick={() => navigate(`/console?venue=${venueId}`)}
        className="inline-flex items-center gap-1 text-sm font-semibold mb-4"
        style={{ color: COLORS.brass }}
      >
        <ArrowLeft size={14} /> Back to the line
      </button>

      <Alert>{error}</Alert>
      <Alert tone="success">{notice}</Alert>

      <div className="flex flex-col gap-2 mb-6">
        {members.map((m) => (
          <Card key={m.user_id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: COLORS.textOnInk }}>
                  {m.full_name}
                  {m.user_id === user.id && (
                    <span className="text-xs font-normal" style={{ color: COLORS.textOnInkDim }}>
                      {' '}
                      (you)
                    </span>
                  )}
                </div>
                <div className="text-xs truncate" style={{ color: COLORS.textOnInkDim }}>
                  {m.email}
                </div>
                <div
                  className="inline-flex items-center gap-1 text-xs font-semibold mt-1.5 px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: m.role === 'owner' ? `${COLORS.brass}22` : `${COLORS.indigo}22`,
                    color: m.role === 'owner' ? COLORS.brass : COLORS.indigo,
                    border: `1px solid ${m.role === 'owner' ? COLORS.brass : COLORS.indigo}55`,
                  }}
                >
                  {m.role === 'owner' ? <ShieldCheck size={11} /> : <Shield size={11} />}
                  {m.role}
                </div>
              </div>
              {canManage && m.role !== 'owner' && m.user_id !== user.id && (
                <Button variant="danger" onClick={() => remove(m)}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {canManage ? (
        <Card>
          <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
            Authorize someone
          </div>
          <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
            They need a QPinoy account first — ask them to sign up, then add the email
            they used. Managers can add and remove staff; attendants can only run the line.
          </div>
          <form onSubmit={addMember}>
            <Field
              label="Their email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="attendant">{ROLE_LABEL.attendant}</option>
              <option value="manager">{ROLE_LABEL.manager}</option>
            </Select>
            <Button type="submit" full disabled={busy || !email.trim()}>
              <UserPlus size={14} /> {busy ? 'Adding…' : 'Authorize'}
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          <div className="text-xs" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
            Only the owner and managers can change who works here.
          </div>
        </Card>
      )}
    </Screen>
  );
}
