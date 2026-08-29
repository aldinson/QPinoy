import React, { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { COLORS, FONT_SANS } from './theme';

/**
 * Android-only install banner.
 * ─────────────────────────────────────────────────────────────
 * Chrome on Android fires `beforeinstallprompt` once the PWA install
 * criteria are met (HTTPS, manifest, service worker, icons — this app
 * already satisfies all of them). Capturing that event lets us show
 * our own styled "Install" button instead of relying purely on
 * Chrome's own mini-infobar, and lets us call .prompt() from a user
 * gesture at a moment we choose (e.g. not the instant the page loads).
 *
 * iOS Safari never fires this event at all (it has no automatic
 * install prompt — deliberately out of scope here, see DEPLOYMENT.md),
 * so on iOS this component silently never renders anything. Once
 * installed (standalone display mode), `appinstalled` fires and the
 * banner is dismissed for good via localStorage.
 */
const DISMISSED_KEY = 'qpinoy_install_dismissed';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) return;
    if (localStorage.getItem(DISMISSED_KEY)) return;

    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!visible || !deferredPrompt) return null;

  async function install() {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setVisible(false);
  }

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  }

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-50 px-4 pb-4"
      style={{ fontFamily: FONT_SANS }}
    >
      <div
        className="max-w-md mx-auto rounded-xl px-4 py-3 flex items-center gap-3"
        style={{ backgroundColor: COLORS.ink2, border: `1px solid ${COLORS.inkBorder}`, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: COLORS.textOnInk }}>
            Install QPinoy
          </div>
          <div className="text-xs" style={{ color: COLORS.textOnInkDim }}>
            Add it to your home screen for full-screen, app-like access.
          </div>
        </div>
        <button
          onClick={install}
          className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-2 rounded-lg shrink-0"
          style={{ backgroundColor: COLORS.brass, color: COLORS.ink }}
        >
          <Download size={13} />
          Install
        </button>
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0" style={{ color: COLORS.textOnInkDim }}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
