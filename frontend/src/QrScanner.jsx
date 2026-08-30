import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { Camera, X, Keyboard, Upload } from 'lucide-react';
import { COLORS } from './theme';
import { Button, Alert, Field } from './ui';

/**
 * QrScanner — camera-based QR reading for the staff console.
 *
 * Three ways to get a customer's check-in code in, in order of how
 * often they'll actually get used:
 *
 *  1. Live camera scan. `BarcodeDetector` (the browser's own native
 *     decoder — available in Chrome on Android, this app's stated
 *     target platform, and markedly faster/more tolerant of odd angles
 *     than anything running in JS) when available, falling back to
 *     `jsQR` in a canvas loop everywhere else (including desktop
 *     Chrome, where BarcodeDetector isn't enabled by default).
 *  2. Upload a QR image. Covers the case a live scan can't: a customer
 *     who isn't physically in front of staff — they screenshot or
 *     photograph their check-in QR and send it over (chat app, email,
 *     AirDrop), and staff upload that image file instead. Same two
 *     decoders as the camera path, just run once against a still image
 *     instead of a video frame loop.
 *  3. Manual text entry. Not decoration: a cracked lens, a denied
 *     camera permission, or a customer whose screen won't brighten all
 *     produce a front desk that cannot serve someone, and a code they
 *     can read aloud gets them moving.
 *
 * Worth knowing about path 2 specifically: the enrollment QR is a
 * signed token that expires in 90 seconds (see backend/tokens.js) by
 * design — a static code would be a permanent credential visible on a
 * public screen. That means "send me a screenshot" only works if the
 * whole screenshot → send → upload round trip finishes inside that
 * window; a stale one fails with the same "expired" message staff
 * already see from a stale live scan (routes.js's enroll handler), not
 * a confusing image-decode error.
 */

const SCAN_INTERVAL_MS = 250;

/**
 * Decode a QR code out of a still image file. Same detector preference
 * as the live camera loop (native BarcodeDetector first, jsQR fallback),
 * just run once against a full-resolution bitmap instead of a video
 * frame, so it's worth trying harder per attempt (`attemptBoth` inversion)
 * than the live loop bothers to at 4 scans/second.
 */
async function decodeQrFromImageFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    if ('BarcodeDetector' in window) {
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const codes = await detector.detect(bitmap);
        if (codes.length) return codes[0].rawValue;
      } catch {
        // Fall through to jsQR — same reasoning as the live-scan path.
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
    return found?.data || null;
  } finally {
    bitmap.close?.();
  }
}

export default function QrScanner({ onScan, onCancel, busy, statusMessage }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const loopRef = useRef(null);
  const detectorRef = useRef(null);
  const fileInputRef = useRef(null);
  // Guards against the same code firing repeatedly while the frame
  // loop keeps seeing it during the enroll round-trip.
  const lastCodeRef = useRef({ value: null, at: 0 });

  const [cameraError, setCameraError] = useState(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const [uploadError, setUploadError] = useState(null);
  const [decodingUpload, setDecodingUpload] = useState(false);

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

  const handleFileChange = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      // Reset the input so choosing the SAME file again (e.g. after an
      // expired-token error, once the customer sends a fresh screenshot
      // saved under the same name) still fires a change event.
      e.target.value = '';
      if (!file) return;

      setUploadError(null);
      setDecodingUpload(true);
      try {
        const value = await decodeQrFromImageFile(file);
        if (!value) {
          setUploadError("Couldn't find a QR code in that image — try a clearer photo or crop closer to the code.");
          return;
        }
        handleCode(value);
      } catch {
        setUploadError('Could not read that image file.');
      } finally {
        setDecodingUpload(false);
      }
    },
    [handleCode]
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

      {/* Shared by both modes below — a one-shot action, not a mode of
          its own, so it doesn't need a third branch in the toggle. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      <Alert>{cameraError}</Alert>
      <Alert>{uploadError}</Alert>
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
          <div className="flex gap-2 flex-wrap">
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
            <Button
              type="button"
              variant="secondary"
              disabled={decodingUpload}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} /> {decodingUpload ? 'Reading…' : 'Upload QR image'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" onClick={() => setManualMode(true)}>
            <Keyboard size={14} /> Enter manually
          </Button>
          <Button
            variant="secondary"
            disabled={decodingUpload}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} /> {decodingUpload ? 'Reading…' : 'Upload QR image'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            <X size={14} /> Close
          </Button>
        </div>
      )}
    </div>
  );
}
