/* ============ Administering a customer's credit limit ============

   The one way a credit limit is set, changed or cleared.

   THREE THINGS THIS IS NOT:

     - It is not the generic `/admin/sync`. `credit_limit` is deliberately
       absent from the `users` collection in `shape.js`, so the whole-row diff
       a browser posts cannot carry it. A credit limit is a commercial decision,
       not a profile field that rides along with a name change.

     - It is not reachable by a customer. The route lives under `/admin` behind
       `requireAuth()` and the `finance.credit_limit` capability, and there is
       no customer-facing counterpart anywhere.

     - It is not implied by any other finance capability. Recording a payment
       and issuing a credit note both record something that already happened;
       setting a limit commits Veyora to future risk.

   EVERY CHANGE LEAVES EVIDENCE. The previous value, the new value, the actor,
   the customer, the reason and the time go into `audit_log`, which is
   append-only by database trigger — no UPDATE, no DELETE, enforced below the
   application. A credit limit that changed with no record of what it replaced
   is the situation this exists to prevent. */

import { Router } from 'express';
import { pool, tx as realTx, auditIn } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission } from '../permissions.js';
import {
  CREDIT_LIMIT_CAPABILITY, CREDIT_REVIEW_CAPABILITY, CREDIT_REVIEW_STATES,
  CreditError, applyCreditReviewDecision, creditPosition, validateCreditLimit,
} from '../credit.js';

const r = Router();
r.use(requireAuth());

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof CreditError) return res.status(err.status).json(err.body);
      next(err);
    });
}

/** Only an account holding the capability. No role satisfies it. */
const canSetLimit = () => requirePermission(CREDIT_LIMIT_CAPABILITY);

/**
 * Read one customer's credit position.
 *
 * Gated on the same capability as changing it: knowing how close a customer is
 * to their ceiling is commercially sensitive, and this is the screen from which
 * somebody decides to move it.
 */
r.get('/customers/:customerId/credit', canSetLimit(), (req, res, next) =>
  send(res, next, creditPosition(liveDb, req.params.customerId), (position) => ({ position })));

/**
 * Set, change or clear the limit.
 *
 * `creditLimit: null` or `''` CLEARS it back to *not configured*, which is a
 * different statement from zero and must remain reachable — a limit set in
 * error has to be removable to "we have not decided" rather than only to "they
 * may order nothing".
 *
 * `expectedCurrentLimit` is optional optimistic concurrency, matching the
 * convention used elsewhere in the admin surface: if supplied and the stored
 * value has moved on, the write is refused rather than silently overwriting a
 * decision somebody else made while this screen was open.
 */
r.put('/customers/:customerId/credit-limit', canSetLimit(), (req, res, next) =>
  send(res, next, setCreditLimit(liveDb, req.params.customerId, req.body || {}, req.user),
    (result) => result));

/* ---------------------------------------------------------------------------
   Credit reviews
   --------------------------------------------------------------------------- */

/** Only an account holding the review capability. Not implied by the other. */
const canReview = () => requirePermission(CREDIT_REVIEW_CAPABILITY);

/** Explicit allowlist. An order row is never spread into a response. */
function reviewRow(row) {
  const review = row.credit_review || {};
  return {
    orderId: String(row.id),
    orderNumber: String(row.number || ''),
    orderTotal: String(row.total ?? '0'),
    orderStatus: String(row.status || ''),
    submittedAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    customerId: String(row.customer_id || ''),
    customerBusiness: String(row.business || ''),
    paymentTerms: String(row.payment_terms || ''),
    /* The snapshot AS TAKEN AT SUBMISSION. Not recomputed: the question this
       answers is "what did the system work out at the time", and re-deriving
       it from data that has since moved would answer a different one. */
    state: String(review.state || CREDIT_REVIEW_STATES.pending),
    decision: String(review.decision || ''),
    currency: String(review.currency || ''),
    orderTotalMinor: Number(review.orderTotalMinor ?? 0),
    projectedExposureMinor: Number(review.projectedExposureMinor ?? 0),
    creditLimitMinor: review.creditLimitMinor ?? null,
    overLimitByMinor: Number(review.overLimitByMinor ?? 0),
    evaluatedAt: review.evaluatedAt ?? null,
    resolution: review.resolution ?? null,
    resolutionReason: review.resolutionReason ?? null,
    resolvedByName: review.resolvedByName ?? null,
    resolvedAt: review.resolvedAt ?? null,
  };
}

const REVIEW_SELECT = `
  select o.id, o.number, o.total, o.status, o.created_at, o.customer_id,
         o.credit_review, u.business, u.payment_terms
    from orders o
    left join users u on u.id = o.customer_id
   where o.credit_review is not null`;

/**
 * Orders carrying a credit decision.
 *
 * `state=pending` — the queue that needs action. Anything else is history, and
 * stays readable: a decision nobody can look up afterwards is not auditable in
 * any useful sense.
 */
r.get('/reviews', canReview(), (req, res, next) =>
  send(res, next, listCreditReviews(liveDb, req.query?.state), (reviews) => ({ reviews })));

export async function listCreditReviews(db, state) {
  const wanted = String(state ?? CREDIT_REVIEW_STATES.pending).toLowerCase();
  const known = Object.values(CREDIT_REVIEW_STATES);
  if (wanted !== 'all' && !known.includes(wanted)) {
    throw new CreditError(400, {
      error: 'Unknown credit review state.', code: 'INVALID_STATE',
    });
  }
  const { rows } = wanted === 'all'
    ? await db.query(`${REVIEW_SELECT} order by o.created_at desc limit 200`)
    : await db.query(
      `${REVIEW_SELECT} and o.credit_review->>'state' = $1
        order by o.created_at desc limit 200`, [wanted]);
  return rows.map(reviewRow);
}

/**
 * Approve or decline ONE order's credit review.
 *
 * APPROVING IS AN EXCEPTION FOR THIS ORDER AND NOTHING ELSE. It does not touch
 * `users.credit_limit`, so the customer's ceiling is exactly what it was and
 * the next order is evaluated against it afresh. Raising the ceiling is a
 * different act needing a different capability.
 */
r.post('/reviews/:orderId/decision', canReview(), (req, res, next) =>
  send(res, next,
    decideCreditReview(liveDb, req.params.orderId, req.body || {}, req.user),
    (result) => result));

export async function decideCreditReview(db, orderId, body, actor) {
  const resolution = String(body?.resolution ?? '').trim().toLowerCase();

  const outcome = await db.tx(async (c) => {
    /* Locked, so two people deciding at once cannot both read `pending` and
       both write. The second waits, sees the first decision and is refused. */
    const { rows } = await c.query(
      `select o.id, o.number, o.customer_id, o.credit_review, o.total,
              u.business
         from orders o
         left join users u on u.id = o.customer_id
        where (o.id = $1 or o.number = $1) limit 1 for update of o`, [orderId]);
    if (!rows.length) {
      throw new CreditError(404, {
        error: 'That order could not be found.', code: 'NO_ORDER',
      });
    }
    const order = rows[0];

    /* The stored review is the ONLY input to the merge besides the decision
       and the reason. Nothing about the credit position comes from the
       request — a caller cannot restate the limit, the exposure or the
       shortfall to make an approval look justified. */
    const updated = applyCreditReviewDecision(order.credit_review, {
      resolution,
      reason: body?.reason,
      actor,
    });

    await c.query(
      `update orders set credit_review = $2, updated_at = now() where id = $1`,
      [order.id, JSON.stringify(updated)]);

    /* In the same transaction: a decision without its record, or a record
       without its decision, are both worse than neither. */
    await auditIn(c,
      { id: actor?.id, name: actor?.business || actor?.email || 'unknown', role: actor?.role || '' },
      `order credit review ${updated.resolution}`,
      order.number,
      `${updated.resolution} — exposure ${updated.projectedExposureMinor} vs limit `
        + `${updated.creditLimitMinor ?? 'not configured'} (minor units)`,
      'web',
      JSON.stringify({
        orderId: order.id,
        customerId: order.customer_id,
        resolution: updated.resolution,
        reason: updated.resolutionReason,
        capability: CREDIT_REVIEW_CAPABILITY,
        /* The original calculation, repeated into the audit payload so the
           evidence survives even if the order row is later archived. */
        snapshotAtSubmission: {
          decision: updated.decision,
          projectedExposureMinor: updated.projectedExposureMinor,
          creditLimitMinor: updated.creditLimitMinor,
          overLimitByMinor: updated.overLimitByMinor,
          orderTotalMinor: updated.orderTotalMinor,
          currency: updated.currency,
          evaluatedAt: updated.evaluatedAt,
        },
      }));

    return { order, review: updated };
  });

  return {
    ok: true,
    orderId: String(outcome.order.id),
    orderNumber: String(outcome.order.number || ''),
    state: outcome.review.state,
    resolution: outcome.review.resolution,
    resolvedAt: outcome.review.resolvedAt,
    /* Stated explicitly in the response so no caller can conclude otherwise. */
    creditLimitChanged: false,
  };
}

export async function setCreditLimit(db, customerId, body, actor) {
  const { limit } = validateCreditLimit(body?.creditLimit);

  /* A reason is required for a discretionary commercial act, exactly as it is
     for a credit note. "Why is this customer's ceiling $40,000?" must have an
     answer that is not "somebody typed it". */
  const reason = String(body?.reason ?? '').trim();
  if (!reason) {
    throw new CreditError(400, {
      error: 'A reason is required when setting or clearing a credit limit.',
      code: 'REASON_REQUIRED',
    });
  }
  if (reason.length > 500) {
    throw new CreditError(400, {
      error: 'That reason is too long.', code: 'REASON_TOO_LONG',
    });
  }

  const changed = await db.tx(async (c) => {
    /* Locked, so two administrators cannot both read the same starting value
       and both write from it — the second would otherwise record a "previous
       value" that was never current. */
    const { rows } = await c.query(
      `select id, business, email, credit_limit, role
         from users where id = $1 limit 1 for update`, [customerId]);
    if (!rows.length) {
      throw new CreditError(404, {
        error: 'That customer could not be found.', code: 'NO_CUSTOMER',
      });
    }
    const before = rows[0].credit_limit === null || rows[0].credit_limit === undefined
      ? null
      : String(rows[0].credit_limit);

    /* Optimistic concurrency, when the caller asked for it. Compared as the
       stored decimal string, and `null` compared as null — so "I expected it
       to be unset" is expressible and is not the same as "I expected zero". */
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'expectedCurrentLimit')) {
      const expectedRaw = body.expectedCurrentLimit;
      const expected = expectedRaw === null || expectedRaw === undefined
        || String(expectedRaw).trim() === ''
        ? null
        : validateCreditLimit(expectedRaw).limit;
      const same = expected === null ? before === null : (before !== null && Number(before) === Number(expected));
      if (!same) {
        throw new CreditError(409, {
          error: 'The credit limit changed while you were editing it. '
            + 'Reload and check the current value before saving.',
          code: 'STALE_CREDIT_LIMIT',
          currentLimit: before,
        });
      }
    }

    /* No-op writes are refused rather than logged. An audit trail full of
       "changed from 5000 to 5000" is one nobody reads. */
    const unchanged = before === null ? limit === null
      : (limit !== null && Number(before) === Number(limit));
    if (unchanged) {
      throw new CreditError(409, {
        error: limit === null
          ? 'That account already has no credit limit configured.'
          : `That account's credit limit is already ${limit}.`,
        code: 'NO_CHANGE',
      });
    }

    await c.query(`update users set credit_limit = $2 where id = $1`, [customerId, limit]);

    /* The evidence is written INSIDE the transaction, on the same client.
       Writing it afterwards on the pool would allow the two to come apart in
       both directions: a limit that changed with no record of what it replaced
       — the precise thing this exists to prevent — or a record of a change
       that rolled back. Either or neither. */
    await auditIn(c,
      { id: actor?.id, name: actor?.business || actor?.email || 'unknown', role: actor?.role || '' },
      'credit limit changed',
      rows[0].business || rows[0].email || customerId,
      `${before === null ? 'not configured' : before}`
        + ` → ${limit === null ? 'not configured' : limit}`,
      'web',
      JSON.stringify({
        customerId,
        previousLimit: before,
        newLimit: limit,
        reason,
        capability: CREDIT_LIMIT_CAPABILITY,
      }),
    );

    return { customer: rows[0], before, after: limit };
  });

  return {
    ok: true,
    customerId,
    previousLimit: changed.before,
    creditLimit: changed.after,
    creditLimitConfigured: changed.after !== null,
  };
}

export default r;
