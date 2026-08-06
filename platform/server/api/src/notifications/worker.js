/* The notification worker (Final Handover, Phase 1).
 *
 * Bounded, injectable and safe to run in one process. It claims a batch,
 * delivers each through the adapter, and settles the row from the ADAPTER'S
 * ANSWER — never from the fact that a send function returned.
 *
 * WHAT MAKES IT SAFE TO RUN
 *
 *   - Every tick claims at most `batchSize`, so a large backlog is drained in
 *     bounded steps rather than one enormous transaction.
 *   - A claim is a lease. A worker that dies mid-batch leaves rows whose
 *     lease expires; the next tick reclaims them. No row is stuck forever.
 *   - The whole tick is guarded, so one poisonous row cannot stop the loop.
 *   - Nothing is logged but counts. Recipient addresses and template data —
 *     which for an enquiry is somebody's enquiry — never reach a log line.
 *
 * It does not schedule itself. `startNotificationWorker()` wires the interval,
 * and `runOnce()` is what tests drive, deterministically, with an injected
 * clock.
 */

import {
  CLAIM_TTL_MS, claimDue, markAttemptFailed, markDelivered,
} from './outbox.js';
import { render } from './templates.js';

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Processes one batch.
 *
 * @param db something with `.query()`.
 * @param adapter a delivery adapter (see delivery.js).
 * @returns counts only: `{ claimed, delivered, retried, failed, skipped }`.
 */
export async function runOnce(db, adapter, {
  batchSize = DEFAULT_BATCH_SIZE, now = () => new Date(), claimTtlMs = CLAIM_TTL_MS,
} = {}) {
  const counts = { claimed: 0, delivered: 0, retried: 0, failed: 0, skipped: 0 };

  const batch = await claimDue(db, { limit: batchSize, now: now(), claimTtlMs });
  counts.claimed = batch.length;

  for (const row of batch) {
    let message;
    try {
      const rendered = render(row.template_key, row.template_data || {});
      message = {
        to: row.recipient_address,
        name: row.recipient_name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      };
    } catch (err) {
      /* An unknown or broken template is not retryable — the next attempt
         renders the same nothing. Fail it terminally so somebody is told. */
      const settled = await markAttemptFailed(db, row.id, {
        code: 'TEMPLATE_ERROR',
        message: err && err.message ? err.message : 'render failed',
        retryable: false,
        now: now(),
      });
      if (settled && settled.status === 'failed') counts.failed += 1; else counts.retried += 1;
      continue;
    }

    let result;
    try {
      result = await adapter.send(message);
    } catch (err) {
      /* An adapter that throws is treated as a retryable provider failure. It
         is a bug in the adapter — every adapter is specified to RETURN a
         result — but the queue must survive it. */
      result = { ok: false, retryable: true, code: 'ADAPTER_THREW',
                 message: err && err.message ? err.message : 'adapter threw' };
    }

    if (result && result.ok) {
      /* Only ever from the adapter's own reference. markDelivered refuses an
         empty one, and the database refuses a delivered row without it. */
      await markDelivered(db, row.id, result.providerReference, { now: now() });
      counts.delivered += 1;
      continue;
    }

    const settled = await markAttemptFailed(db, row.id, {
      code: (result && result.code) || 'UNKNOWN',
      message: (result && result.message) || '',
      retryable: !result || result.retryable !== false,
      now: now(),
    });
    if (settled && settled.status === 'failed') counts.failed += 1; else counts.retried += 1;
  }

  return counts;
}

/**
 * Starts the interval loop. Returns a stop function.
 *
 * Ticks never overlap: a slow batch delays the next tick rather than stacking
 * a second one on top of it, which would double the effective claim rate for
 * no benefit.
 */
export function startNotificationWorker(db, adapter, {
  intervalMs = DEFAULT_INTERVAL_MS, batchSize = DEFAULT_BATCH_SIZE,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, onTick = null,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await runOnce(db, adapter, { batchSize });
      /* Counts only — never a recipient, never template data. */
      if (counts.failed > 0) {
        console.warn(`[notifications] ${counts.failed} notification(s) failed terminally`);
      }
      if (onTick) onTick(counts);
    } catch (err) {
      console.error('[notifications] worker tick failed:', err && err.message ? err.message : err);
    } finally {
      running = false;
    }
  };

  const handle = setIntervalFn(tick, intervalMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return () => clearIntervalFn(handle);
}
