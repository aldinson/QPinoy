import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { Camera, X, Keyboard } from 'lucide-react';
import { COLORS } from './theme';
import { Button, Alert, Field } from './ui';

/**
 * QrScanner — camera-based QR reading for the staff console.
 *
 * Two decoding paths, in order of preference:
 *
 *  1. `BarcodeDetector`, the browser's own native decoder. It is
 *     available in Chrome on Android, which is this app's stated
 *     target platform, and it is markedly faster and better at odd
 *     angles and low light than anything running in JS.
 *  2. `jsQR` in a canvas loop, for every other browser (including
 *     desktop Chrome, where BarcodeDetector is not enabled by
 *     default). Slower, but it works everywhere and keeps the feature
 *     from being Android-Chrome-only during development.
 *
 * There is also a manual-entry fallback. That is not decoration: a
 * cracked lens, a denied camera permission, or a customer whose
 * screen won't brighten all produce a front desk that cannot serve
 * someone, and a code they can read aloud gets them moving.
 */

const SCAN_INTERVAL_MS = 250;

export default function QrScanner({ onScan, onCancel, busy, statusMessage }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const loopRef = useRef(null);
  const detectorRef = useRef(null);
  // Guards against the same code firing repeatedly while the frame
  // loop keeps seeing it during the enroll round-trip.
  const lastCodeRef = useRef({ value: null, at: 0 });

  const [cameraError, setCameraError] = useState(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState('');

  const handleCode = useCallback(
    (value) => {
      const now = Date.now();
      if (!value) return;
      if (lastCodeRef.current.value === value && now - lastCodeRef.current.at < 4000) return;
      lastCodeRef.current = { value, at: now };
      onScan(value);
    },
    [onScan]
  );

  const stop = useCallback(() => {
    clearInterval(loopRef.current);
    loopRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser cannot open a camera. Enter the code manually instead.');
      setManualMode(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The rear camera is the one pointed at the customer's phone.
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // iOS/Safari refuse to autoplay without this; harmless elsewhere.
      video.setAttribute('playsinline', 'true');
      await video.play();

      if ('BarcodeDetector' in window) {
        try {
          detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detectorRef.current = null; // fall through to jsQR
        }
      }

      loopRef.current = setInterval(scanFrame, SCAN_INTERVAL_MS);
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      setCameraError(
        denied
          ? 'Camera permission was denied. Allow it in your browser settings, or enter the code manually.'
          : 'Could not open the camera. Enter the code manually instead.'
      );
      setManualMode(true);
    }
    // scanFrame is stable via refs; excluded deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scanFrame() {
    const video = videoRef.current;
    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

    if (detectorRef.current) {
      try {
        const codes = await detectorRef.current.detect(video);
        if (codes.length) handleCode(codes[0].rawValue);
        return;
      } catch {
        // A detector that starts throwing mid-session (it happens on
        // some Android builds) shouldn't kill scanning — drop to jsQR
        // permanently and keep going.
        detectorRef.current = null;
      }
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    if (found?.data) handleCode(found.data);
  }

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  return (
    <div>
      {!manualMode && (
        <div
          className="relative rounded-xl overflow-hidden mb-3"
          style={{ backgroundColor: '#000', aspectRatio: '1 / 1', border: `1px solid ${COLORS.inkBorder}` }}
        >
          <video ref={videoRef} muted playsInline className="w-full h-full" style={{ objectFit: 'cover' }} />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          {/* Framing guide — purely visual, helps staff aim. */}
          <div
            className="absolute inset-0 pointer-events-none flex items-center justify-center"
            aria-hidden="true"
          >
            <div
              style={{
                width: '65%',
                aspectRatio: '1 / 1',
                border: `3px solid ${COLORS.brass}`,
                borderRadius: 16,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
              }}
            />
          </div>
          {busy && (
            <div
              className="absolute inset-x-0 bottom-0 py-2 text-center text-xs font-semibold"
              style={{ backgroundColor: COLORS.brass, color: COLORS.ink }}
            >
              Adding to line…
            </div>
          )}
        </div>
      )}

      <Alert>{cameraError}</Alert>
      {statusMessage && <Alert tone={statusMessage.tone}>{statusMessage.text}</Alert>}

      {manualMode ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manualValue.trim()) onScan(manualValue.trim());
          }}
        >
          <Field
            label="Check-in code"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            placeholder="Paste the code from the customer's screen"
            autoFocus
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !manualValue.trim()}>
              Add to line
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setManualMode(false);
                start();
              }}
            >
              <Camera size={14} /> Use camera
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setManualMode(true)}>
            <Keyboard size={14} /> Enter manually
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            <X size={14} /> Close
          </Button>
        </div>
      )}
    </div>
  );
}
