'use strict';

/**
 * feedbackRoutes.js
 * ─────────────────────────────────────────────────────────────
 * "How are we doing?" — a star rating plus an optional comment from a
 * signed-in customer.
 *
 * The row is written first and the email attempted after. That order
 * is the whole design: SMTP is optional (see mailer.js) and is the
 * likeliest thing in this app to be unconfigured or briefly broken,
 * and feedback someone took the trouble to type must survive that.
 * Storing first also means the feature is useful the moment it ships,
 * before any mail server exists.
 */

const express = require('express');
const { requireAuth, isUuid } = require('./auth');
const { LIMITS, bucketKey, rateLimitGate } = require('./rateLimit');
const { sendFeedbackEmail } = require('./mailer');

const MAX_COMMENT_LENGTH = 2000;

function buildFeedbackRouter(pool) {
  const router = express.Router();

  /**
   * Bounded because this endpoint causes an outbound email. Without a
   * limit it is a free way to make the app send mail on demand — an
   * inbox flood aimed at the operator, and a fast route to getting the
   * sending address classified as spam.
   *
   * Charged per accepted submission, not per request: a rejected
   * rating sends no mail, so it costs the budget nothing. Same
   * reasoning as the self-join gate in routes.js.
   */
  const feedbackRateLimit = rateLimitGate(pool, {
    ...LIMITS.FEEDBACK,
    key: (req) => (req.user ? bucketKey('feedback', 'user', req.user.id) : null),
    message: 'thanks — you have sent several notes recently, please try again a little later',
  });

  router.post('/feedback', requireAuth, feedbackRateLimit, async (req, res, next) => {
    const { rating, comment, venueId } = req.body || {};

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a whole number from 1 to 5' });
    }
    if (comment !== undefined && comment !== null && typeof comment !== 'string') {
      return res.status(400).json({ error: 'comment must be a string' });
    }
    const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
    if (trimmedComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `comment must be ${MAX_COMMENT_LENGTH} characters or fewer` });
    }
    // Optional — absent means "about the app", not an error.
    if (venueId !== undefined && venueId !== null && !isUuid(venueId)) {
      return res.status(400).json({ error: 'venueId must be a UUID' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO feedback (user_id, venue_id, rating, comment)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [req.user.id, venueId || null, rating, trimmedComment || null]
      );
      const saved = rows[0];

      let venueName = null;
      if (venueId) {
        const { rows: venueRows } = await pool.query(`SELECT name FROM venues WHERE id = $1`, [venueId]);
        venueName = venueRows[0]?.name || null;
      }

      // Past this point the customer's feedback is safely stored, so
      // nothing below may turn into an error they see.
      const emailed = await sendFeedbackEmail({
        rating,
        comment: trimmedComment,
        fromName: req.user.full_name,
        fromEmail: req.user.email,
        venueName,
        submittedAt: new Date(saved.created_at),
      });

      if (emailed) {
        await pool
          .query(`UPDATE feedback SET email_sent_at = now() WHERE id = $1`, [saved.id])
          .catch((err) => console.error('[feedback] could not mark email_sent_at', err));
      }

      // A stored submission is the thing being bounded, whether or not
      // the notification made it out.
      await req.spendRateLimit();
      res.status(201).json({ id: saved.id, received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildFeedbackRouter, MAX_COMMENT_LENGTH };
