/* The notification outbox: enqueue, claim, settle (Final Handover, Phase 1).
 *
 * The transactional-outbox pattern. `enqueue()` takes the caller's
 * transaction client, so a submission and its notification commit together or
 * not at all — the property that makes "an accepted enquiry always produces a
 * notification" true rather than hoped for.
 *
 * Everything here is pure SQL over an injected client. No driver is imported,
 * so every rule is testable against a controlled double.
 */

import crypto from 'node:crypto';

export const NOTIFICATION_STATUSES = Object.freeze([
  'pending', 'processing', 'retry_scheduled', 'delivered', 'failed', 'cancelled',
]);

export const NOTIFICATION_TYPES = Object.freeze([
  'enquiry_received', 'order_confirmation', 'statement_delivery',
]);

/** Bounded exponential backoff, in minutes, one entry per attempt.
 *
 *  Five attempts over roughly two hours, then terminal. Deliberately bounded:
 *  a queue that retries forever is a queue nobody looks at, and a failure
 *  nobody is told about is the problem this system exists to solve. */
export const RETRY_SCHEDULE_MINUTES = Object.freeze([1, 5, 15, 60, 120]);
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MINUTES.length;

/** How long a worker's claim is good for. A claim older than this is assumed
 *  to belong to a crashed worker and is reclaimable — which is what stops one
 *  crash parking a notification forever. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

const COLUMNS = `id, notification_type, source_type, source_id, recipient_address, recipient_name,
  template_key, template_version, template_data, status, attempt_count, next_attempt_at,
  claimed_at, claim_expires_at, last_attempted_at, delivered_at, failed_at, last_error,
  provider_reference, idempotency_key, created_at, updated_at`;

export class OutboxError extends Error {}

/** A deterministic idempotency key.
 *
 *  Same inputs always produce the same key, and the column is UNIQUE, so a
 *  retried enqueue cannot create a second notification. Hashed rather than
 *  concatenated so a recipient address never appears in an index or a log. */
export function idempotencyKeyFor({ notificationType, sourceType, sourceId, recipient, discriminator = '' }) {
  const material = [notificationType, sourceType, sourceId, String(recipient || '').trim().toLowerCase(), discriminator]
    .join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 40);
}

/* ---------------------------------------------------------------------------
   Enqueue
   --------------------------------------------------------------------------- */

/**
 * Queues one notification. MUST be called with the caller's transaction
 * client so it commits with whatever caused it.
 *
 * `on conflict do nothing` on the unique idempotency key makes a repeat a
 * no-op rather than an error: the caller's intent ("ensure this notification
 * exists") is satisfied either way.
 *
 * @returns the row, or null when an identical notification already existed.
 */
export async function enqueue(client, {
  notificationType, sourceType = '', sourceId = '', recipientAddress, recipientName = '',
  templateKey, templateVersion = 'v1', templateData = {}, discriminator = '',
}) {
  if (!NOTIFICATION_TYPES.includes(notificationType)) {
    throw new OutboxError(`Unknown notification type: ${notificationType}`);
  }
  const address = String(recipientAddress || '').trim();
  if (!address) throw new OutboxError('A recipient address is required.');
  if (!templateKey) throw new OutboxError('A template key is required.');

  const key = idempotencyKeyFor({
    notificationType, sourceType, sourceId, recipient: address, discriminator,
  });

  const { rows } = await client.query(
    `insert into notification_outbox
       (notification_type, source_type, source_id, recipient_address, recipient_name,
        template_key, template_version, template_data, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     on conflict (idempotency_key) do nothing
     returning ${COLUMNS}`,
    [notificationType, sourceType, sourceId, address, recipientName,
     templateKey, templateVersion, JSON.stringify(templateData || {}), key]
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   Claim
   --------------------------------------------------------------------------- */

/**
 * Atomically claims up to `limit` due notifications.
 *
 * One statement, so two workers cannot claim the same row: the `update ...
 * where id in (select ... for update skip locked)` form has PostgreSQL hand
 * each worker a disjoint set. `skip locked` is what makes a second worker
 * step over a row rather than block on it.
 *
 * A `processing` row whose claim has expired is reclaimed here too — that is
 * the crashed-worker recovery path.
 */
export async function claimDue(client, { limit = 10, now = new Date(), claimTtlMs = CLAIM_TTL_MS } = {}) {
  const expiry = new Date(now.getTime() + claimTtlMs);
  const { rows } = await client.query(
    `update notification_outbox
        set status = 'processing', claimed_at = $2, claim_expires_at = $3
      where id in (
        select id from notification_outbox
         where (status in ('pending', 'retry_scheduled') and next_attempt_at <= $2)
            or (status = 'processing' and claim_expires_at is not null and claim_expires_at <= $2)
         order by next_attempt_at
         limit $1
         for update skip locked
      )
      returning ${COLUMNS}`,
    [limit, now, expiry]
  );
  return rows;
}

/* ---------------------------------------------------------------------------
   Settle
   --------------------------------------------------------------------------- */

/** Marks a notification delivered. REQUIRES a provider reference — the
 *  database also refuses a delivered row without one, so a caller that
 *  forgot the evidence fails loudly rather than recording a fiction. */
export async function markDelivered(client, id, providerReference, { now = new Date() } = {}) {
  const reference = String(providerReference || '').trim();
  if (!reference) {
    throw new OutboxError('Cannot mark delivered without a provider reference.');
  }
  const { rows } = await client.query(
    `update notification_outbox
        set status = 'delivered', delivered_at = $2, last_attempted_at = $2,
            attempt_count = attempt_count + 1, provider_reference = $3,
            last_error = '', claimed_at = null, claim_expires_at = null
      where id = $1
      returning ${COLUMNS}`,
    [id, now, reference]
  );
  return rows[0] || null;
}

/**
 * Records a failed attempt, and decides whether to retry.
 *
 * Terminal when retries are exhausted OR the failure is not retryable — a
 * malformed address does not become deliverable by waiting.
 */
export async function markAttemptFailed(client, id, { code = '', message = '', retryable = true, now = new Date() } = {}) {
  const { rows: current } = await client.query(
    `select attempt_count from notification_outbox where id = $1 limit 1`, [id]);
  if (!current[0]) return null;

  const attempts = Number(current[0].attempt_count) + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const terminal = exhausted || !retryable;

  /* The error is truncated and carries the provider's message only. It is
     shown to staff on the enquiry screen, so it must not become a place
     provider internals or payload fragments accumulate. */
  const error = `${code}${code && message ? ': ' : ''}${message}`.slice(0, 300);

  if (terminal) {
    const { rows } = await client.query(
      `update notification_outbox
          set status = 'failed', failed_at = $2, last_attempted_at = $2,
              attempt_count = $3, last_error = $4,
              claimed_at = null, claim_expires_at = null
        where id = $1
        returning ${COLUMNS}`,
      [id, now, attempts, error]
    );
    return rows[0] || null;
  }

  const waitMinutes = RETRY_SCHEDULE_MINUTES[attempts - 1] ?? RETRY_SCHEDULE_MINUTES[RETRY_SCHEDULE_MINUTES.length - 1];
  const nextAttempt = new Date(now.getTime() + waitMinutes * 60_000);

  const { rows } = await client.query(
    `update notification_outbox
        set status = 'retry_scheduled', next_attempt_at = $2, last_attempted_at = $3,
            attempt_count = $4, last_error = $5,
            claimed_at = null, claim_expires_at = null
      where id = $1
      returning ${COLUMNS}`,
    [id, nextAttempt, now, attempts, error]
  );
  return rows[0] || null;
}

/** Puts a failed notification back in the queue. Used by the admin screen's
 *  manual retry: attempts reset so the operator gets a full schedule, not one
 *  last try. */
export async function requeue(client, id, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `update notification_outbox
        set status = 'pending', next_attempt_at = $2, attempt_count = 0,
            failed_at = null, last_error = '', claimed_at = null, claim_expires_at = null
      where id = $1 and status in ('failed', 'retry_scheduled', 'cancelled')
      returning ${COLUMNS}`,
    [id, now]
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

export async function findBySource(client, sourceType, sourceId) {
  const { rows } = await client.query(
    `select ${COLUMNS} from notification_outbox
      where source_type = $1 and source_id = $2
      order by created_at desc`,
    [sourceType, sourceId]
  );
  return rows;
}

export async function getById(client, id) {
  const { rows } = await client.query(
    `select ${COLUMNS} from notification_outbox where id = $1 limit 1`, [id]);
  return rows[0] || null;
}

/** Operational counters. Counts only — no address, no payload, nothing that
 *  would make a metrics endpoint a PII surface. */
export async function counters(client) {
  const { rows } = await client.query(
    `select status, count(*)::int as count from notification_outbox group by status`);
  const out = Object.fromEntries(NOTIFICATION_STATUSES.map((s) => [s, 0]));
  for (const row of rows) out[row.status] = row.count;
  return out;
}

/* ---------------------------------------------------------------------------
   Serializer — explicit allowlist, never a spread row
   --------------------------------------------------------------------------- */

const isoOrNull = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** What staff may see about a notification.
 *
 *  Deliberately ABSENT: `template_data` (it carries the enquirer's own words),
 *  `idempotency_key`, and the raw recipient address — only a masked form is
 *  returned, because an operations screen needs to know *that* it went to the
 *  right place, not to be another copy of the address book. */
export function serializeNotification(row) {
  return {
    id: row.id,
    notificationType: row.notification_type,
    status: row.status,
    recipientMasked: maskAddress(row.recipient_address),
    attemptCount: Number(row.attempt_count) || 0,
    lastAttemptedAt: isoOrNull(row.last_attempted_at),
    nextAttemptAt: isoOrNull(row.next_attempt_at),
    deliveredAt: isoOrNull(row.delivered_at),
    failedAt: isoOrNull(row.failed_at),
    /* The provider's failure reason, which staff need in order to act. Never
       a payload fragment: markAttemptFailed builds it from the code and the
       provider message only. */
    lastError: row.last_error || '',
    createdAt: isoOrNull(row.created_at),
  };
}

/** `alex.hardy@example.test` → `al…@example.test`. Enough to confirm the
 *  destination, not enough to be a mailing list. */
export function maskAddress(address) {
  const value = String(address || '');
  const at = value.indexOf('@');
  if (at <= 0) return value ? '…' : '';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}…${domain}`;
}
