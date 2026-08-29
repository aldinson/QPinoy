import React, { useState } from 'react';
import { COLORS } from './theme';
import { useAuth } from './auth';
import { Screen, Field, Button, Alert, LinkButton, Card } from './ui';

export function LoginScreen({ navigate }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen subtitle="QPinoy" title="Sign in">
      <Alert>{error}</Alert>
      <form onSubmit={submit}>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" full disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <div className="mt-5 text-sm" style={{ color: COLORS.textOnInkDim }}>
        No account yet? <LinkButton onClick={() => navigate('/register')}>Create one</LinkButton>
      </div>
    </Screen>
  );
}

export function RegisterScreen({ navigate }) {
  const { register } = useAuth();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    accountType: 'customer',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
        accountType: form.accountType,
      });
      // Business accounts land on venue setup; customers go to their
      // QR code. App.jsx picks the right home from account_type, so
      // both just go to '/'.
      navigate('/');
    } catch (err) {
      setError(err.message || 'Could not create your account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen subtitle="QPinoy" title="Create your account">
      <Alert>{error}</Alert>

      {/* The account-type choice only decides where you land after
          signup — it grants no permissions on its own. */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        {[
          { value: 'customer', label: "I'm a customer", hint: 'Join lines at venues' },
          { value: 'business', label: 'I run a business', hint: 'Manage my own line' },
        ].map((opt) => {
          const active = form.accountType === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setForm((f) => ({ ...f, accountType: opt.value }))}
              className="text-left rounded-xl p-3"
              style={{
                backgroundColor: active ? `${COLORS.brass}22` : COLORS.ink2,
                border: `1px solid ${active ? COLORS.brass : COLORS.inkBorder}`,
              }}
            >
              <div className="text-sm font-semibold" style={{ color: active ? COLORS.brass : COLORS.textOnInk }}>
                {opt.label}
              </div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.textOnInkDim }}>
                {opt.hint}
              </div>
            </button>
          );
        })}
      </div>

      <form onSubmit={submit}>
        <Field label="Full name" value={form.fullName} onChange={set('fullName')} autoComplete="name" required />
        <Field
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={form.email}
          onChange={set('email')}
          required
        />
        <Field
          label="Mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0917 123 4567"
          value={form.phone}
          onChange={set('phone')}
          hint="So the venue can reach you when your turn is coming up."
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          hint="At least 8 characters."
          required
        />
        <Button type="submit" full disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>

      <div className="mt-5 text-sm" style={{ color: COLORS.textOnInkDim }}>
        Already registered? <LinkButton onClick={() => navigate('/login')}>Sign in</LinkButton>
      </div>

      <Card style={{ marginTop: 20 }}>
        <div className="text-xs" style={{ color: COLORS.textOnInkDim, lineHeight: 1.6 }}>
          Signing up doesn't put you in any line. When you arrive at a venue, show the
          QR code on your home screen and their staff will scan you in.
        </div>
      </Card>
    </Screen>
  );
}
