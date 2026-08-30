import React, { useState } from 'react';
import { Star, MessageSquare, CheckCircle2 } from 'lucide-react';
import { COLORS } from './theme';
import { api } from './api';
import { Card, Button, Alert } from './ui';

const MAX_COMMENT_LENGTH = 2000; // matches feedbackRoutes.js

/**
 * "How are we doing?" — a star rating plus an optional note.
 *
 * Collapsed to a single line until tapped: this sits underneath the
 * things a customer actually came here to do, and an always-open form
 * would compete with them for attention on a small screen.
 *
 * `venueId` attaches the feedback to a specific venue when the
 * customer is in exactly one line — with none, or several, there is no
 * unambiguous answer to "which venue is this about", so it goes in as
 * general app feedback rather than guessing wrong.
 */
export default function FeedbackCard({ venueId, venueName }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    if (rating < 1) {
      setError('Pick a star rating first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.sendFeedback({ rating, comment: comment.trim() || undefined, venueId });
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not send your feedback');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Card style={{ marginBottom: 12 }}>
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: COLORS.jade }}>
          <CheckCircle2 size={15} /> Thanks — we got your feedback
        </div>
        <div className="text-xs mt-1" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
          It really does get read.
        </div>
      </Card>
    );
  }

  if (!open) {
    return (
      <Card style={{ marginBottom: 12 }}>
        <button onClick={() => setOpen(true)} className="flex items-center gap-2.5 text-left w-full">
          <div className="rounded-lg p-1.5 shrink-0" style={{ backgroundColor: `${COLORS.brass}22` }}>
            <MessageSquare size={15} color={COLORS.brass} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textOnInk }}>
              Rate your experience
            </div>
            <div className="text-xs mt-0.5" style={{ color: COLORS.textOnInkDim }}>
              Tell us how QPinoy is working for you.
            </div>
          </div>
        </button>
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 12 }}>
      <div className="text-sm font-semibold mb-1" style={{ color: COLORS.textOnInk }}>
        Rate your experience
      </div>
      <div className="text-xs mb-3" style={{ color: COLORS.textOnInkDim, lineHeight: 1.5 }}>
        {venueName ? `About your visit to ${venueName}.` : 'About the QPinoy app.'}
      </div>

      <Alert>{error}</Alert>

      <div className="flex items-center gap-1 mb-3" role="radiogroup" aria-label="Star rating">
        {[1, 2, 3, 4, 5].map((n) => {
          const lit = n <= (hovered || rating);
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              onClick={() => {
                setRating(n);
                setError(null);
              }}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(0)}
              className="p-1"
            >
              <Star
                size={26}
                color={lit ? COLORS.brass : COLORS.textOnInkDim}
                fill={lit ? COLORS.brass : 'none'}
              />
            </button>
          );
        })}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
        placeholder="Anything you'd like us to know? (optional)"
        rows={3}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none resize-none"
        style={{ backgroundColor: COLORS.ink, color: COLORS.textOnInk, border: `1px solid ${COLORS.inkBorder}` }}
      />
      <div className="text-right text-xs mt-1 mb-3" style={{ color: COLORS.textOnInkDim }}>
        {comment.length}/{MAX_COMMENT_LENGTH}
      </div>

      <div className="flex gap-2">
        <Button full onClick={submit} disabled={sending}>
          {sending ? 'Sending…' : 'Send feedback'}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={sending}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
