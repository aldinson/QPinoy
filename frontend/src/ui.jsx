import React from 'react';
import { COLORS, FONT_MONO, FONT_SANS } from './theme';

/**
 * Small shared building blocks. Extracted because the auth screens,
 * the staff console, and the customer view were otherwise going to
 * grow three slightly different versions of the same dark-on-ink
 * input and button.
 */

export function Screen({ title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: COLORS.ink, fontFamily: FONT_SANS }}>
      <div className="max-w-md w-full mx-auto px-5 pt-10 pb-24 flex-1">
        {subtitle && (
          <div className="text-xs font-semibold tracking-wide uppercase mb-1" style={{ fontFamily: FONT_MONO, color: COLORS.brass }}>
            {subtitle}
          </div>
        )}
        {title && (
          <h1 className="text-2xl font-bold mb-6" style={{ color: COLORS.textOnInk }}>
            {title}
          </h1>
        )}
        {children}
        {footer && <div className="mt-6">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, ...inputProps }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-semibold mb-1.5" style={{ color: COLORS.textOnInkDim }}>
        {label}
      </span>
      <input
        {...inputProps}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
        style={{
          backgroundColor: COLORS.ink2,
          color: COLORS.textOnInk,
          border: `1px solid ${COLORS.inkBorder}`,
        }}
      />
      {hint && (
        <span className="block text-xs mt-1" style={{ color: COLORS.textOnInkDim }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function Select({ label, children, ...props }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-semibold mb-1.5" style={{ color: COLORS.textOnInkDim }}>
        {label}
      </span>
      <select
        {...props}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none"
        style={{ backgroundColor: COLORS.ink2, color: COLORS.textOnInk, border: `1px solid ${COLORS.inkBorder}` }}
      >
        {children}
      </select>
    </label>
  );
}

export function Button({ variant = 'primary', full, children, ...props }) {
  const styles = {
    primary: { backgroundColor: COLORS.brass, color: COLORS.ink, border: '1px solid transparent' },
    secondary: { backgroundColor: 'transparent', color: COLORS.textOnInkDim, border: `1px solid ${COLORS.inkBorder}` },
    danger: { backgroundColor: 'transparent', color: COLORS.rust, border: `1px solid ${COLORS.rust}55` },
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3.5 py-2.5 rounded-lg disabled:opacity-40 ${
        full ? 'w-full' : ''
      }`}
      style={styles}
    >
      {children}
    </button>
  );
}

export function Alert({ tone = 'error', children }) {
  if (!children) return null;
  const color = tone === 'error' ? COLORS.rust : tone === 'success' ? COLORS.jade : COLORS.brass;
  return (
    <div
      className="mb-4 px-3 py-2 rounded-lg text-sm"
      style={{ backgroundColor: `${color}1a`, color, border: `1px solid ${color}55` }}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Card({ children, style }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}`, ...style }}
    >
      {children}
    </div>
  );
}

export function LinkButton({ children, ...props }) {
  return (
    <button {...props} className="text-sm font-semibold underline" style={{ color: COLORS.brass }}>
      {children}
    </button>
  );
}
