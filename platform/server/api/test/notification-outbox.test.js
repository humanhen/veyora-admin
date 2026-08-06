/* Durable notification outbox (Final Handover, Phase 1).

   Findings ENQ-006 / NOT-006: an accepted enquiry was stored and nothing ever
   told anybody.

   The worker takes an injected clock, store and adapter, so retry schedules,
   claim expiry and terminal failure are exercised deterministically rather
   than by sleeping. Nothing here contacts a network or a database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_TTL_MS, MAX_ATTEMPTS, NOTIFICATION_STATUSES, NOTIFICATION_TYPES,
  RETRY_SCHEDULE_MINUTES, OutboxError,
  claimDue, counters, enqueue, findBySource, getById, idempotencyKeyFor,
  markAttemptFailed, markDelivered, maskAddress, requeue, serializeNotification,
} from '../src/notifications/outbox.js';
import {
  DELIVERY_CODES, createMemoryAdapter, createSmtpAdapter,
  createUnconfiguredAdapter, selectAdapter,
} from '../src/notifications/delivery.js';
import { runOnce } from '../src/notifications/worker.js';
import { TEMPLATE_KEYS, buildEnquiryTemplateData, render } from '../src/notifications/templates.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migration = fs.readFileSync(path.join(MIGRATIONS, '0011_notification_outbox.sql'), 'utf8');
const migrateJs = read('migrate.js');

const T0 = new Date('2026-08-07T09:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);

/* ---------------------------------------------------------------------------
   An in-memory outbox table with real claim semantics
   --------------------------------------------------------------------------- */

function makeDb({ rows = [] } = {}) {
  let table = rows.map((r) => ({ ...r }));
  let seq = 0;

  async function query(sql, params = []) {
    if (/^\s*insert into notification_outbox/is.test(sql)) {
      const [type, sourceType, sourceId, address, name, key, version, data, idem] = params;
      if (table.some((r) => r.idempotency_key === idem)) return { rows: [] }; // on conflict do nothing
      const row = {
        id: `ntf_${++seq}`, notification_type: type, source_type: sourceType, source_id: sourceId,
        recipient_address: address, recipient_name: name, template_key: key,
        template_version: version, template_data: JSON.parse(data), status: 'pending',
        attempt_count: 0, next_attempt_at: T0, claimed_at: null, claim_expires_at: null,
        last_attempted_at: null, delivered_at: null, failed_at: null, last_error: '',
        provider_reference: '', idempotency_key: idem, created_at: T0, updated_at: T0,
      };
      table.push(row);
      return { rows: [{ ...row }] };
    }

    if (/^\s*update notification_outbox\s+set status = 'processing'/is.test(sql)) {
      const [limit, now, expiry] = params;
      const due = table
        .filter((r) => ((r.status === 'pending' || r.status === 'retry_scheduled') && r.next_attempt_at <= now)
          || (r.status === 'processing' && r.claim_expires_at && r.claim_expires_at <= now))
        .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
        .slice(0, limit);
      for (const r of due) { r.status = 'processing'; r.claimed_at = now; r.claim_expires_at = expiry; }
      return { rows: due.map((r) => ({ ...r })) };
    }

    if (/set status = 'delivered'/is.test(sql)) {
      const [id, now, reference] = params;
      const r = table.find((x) => x.id === id);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'delivered', delivered_at: now, last_attempted_at: now,
        attempt_count: r.attempt_count + 1, provider_reference: reference, last_error: '',
        claimed_at: null, claim_expires_at: null });
      return { rows: [{ ...r }] };
    }

    if (/select attempt_count from notification_outbox/is.test(sql)) {
      const r = table.find((x) => x.id === params[0]);
      return { rows: r ? [{ attempt_count: r.attempt_count }] : [] };
    }

    if (/set status = 'failed'/is.test(sql)) {
      const [id, now, attempts, error] = params;
      const r = table.find((x) => x.id === id);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'failed', failed_at: now, last_attempted_at: now,
        attempt_count: attempts, last_error: error, claimed_at: null, claim_expires_at: null });
      return { rows: [{ ...r }] };
    }

    if (/set status = 'retry_scheduled'/is.test(sql)) {
      const [id, nextAttempt, now, attempts, error] = params;
      const r = table.find((x) => x.id === id);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'retry_scheduled', next_attempt_at: nextAttempt,
        last_attempted_at: now, attempt_count: attempts, last_error: error,
        claimed_at: null, claim_expires_at: null });
      return { rows: [{ ...r }] };
    }

    if (/set status = 'pending'/is.test(sql)) {
      const [id, now] = params;
      const r = table.find((x) => x.id === id
        && ['failed', 'retry_scheduled', 'cancelled'].includes(x.status));
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'pending', next_attempt_at: now, attempt_count: 0,
        failed_at: null, last_error: '', claimed_at: null, claim_expires_at: null });
      return { rows: [{ ...r }] };
    }

    if (/where source_type = \$1 and source_id = \$2/is.test(sql)) {
      return { rows: table.filter((r) => r.source_type === params[0] && r.source_id === params[1]).map((r) => ({ ...r })) };
    }
    if (/from notification_outbox where id = \$1/is.test(sql)) {
      const r = table.find((x) => x.id === params[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/group by status/is.test(sql)) {
      const m = {};
      for (const r of table) m[r.status] = (m[r.status] || 0) + 1;
      return { rows: Object.entries(m).map(([status, count]) => ({ status, count })) };
    }
    return { rows: [] };
  }

  return { query, get table() { return table; }, async tx(fn) { return fn({ query }); } };
}

const ENQUEUE = {
  notificationType: 'enquiry_received',
  sourceType: 'form_submission',
  sourceId: 'fsub_1',
  recipientAddress: 'ops@example.test',
  templateKey: 'enquiry_received',
  templateData: buildEnquiryTemplateData({ formType: 'contact', submittedAt: T0.toISOString() }),
};

// ===========================================================================
// 1-8 — schema
// ===========================================================================

test('1 — every required outbox field exists in the migration and the mirror', () => {
  for (const field of [
    'id', 'notification_type', 'source_type', 'source_id', 'recipient_address', 'recipient_name',
    'template_key', 'template_version', 'template_data', 'status', 'attempt_count',
    'next_attempt_at', 'claimed_at', 'claim_expires_at', 'last_attempted_at', 'delivered_at',
    'failed_at', 'provider_reference', 'idempotency_key', 'created_at', 'updated_at',
  ]) {
    assert.ok(migration.includes(field), `migration missing ${field}`);
    assert.ok(migrateJs.includes(field), `ensureSchema missing ${field}`);
  }
});

test('2 — the status set is exactly the six specified', () => {
  assert.deepEqual([...NOTIFICATION_STATUSES],
    ['pending', 'processing', 'retry_scheduled', 'delivered', 'failed', 'cancelled']);
  for (const status of NOTIFICATION_STATUSES) {
    assert.ok(migration.includes(`'${status}'`), `CHECK missing ${status}`);
    assert.ok(migrateJs.includes(`'${status}'`), `mirror missing ${status}`);
  }
});

test('3 — a delivered row must carry its evidence, enforced by the database', () => {
  assert.match(migration, /notification_outbox_delivered_evidenced/);
  assert.match(migration, /delivered_at is not null and provider_reference <> ''/);
  assert.ok(migrateJs.includes('notification_outbox_delivered_evidenced'));
});

test('4 — idempotency_key is unique', () => {
  assert.match(migration, /idempotency_key\s+text not null unique/);
  assert.match(migrateJs, /idempotency_key\s+text not null unique/);
});

test('5 — the migration is additive and non-destructive', () => {
  const statements = migration.replace(/^\s*--[^\n]*$/gm, ' ');
  for (const destructive of [/drop\s+table/i, /drop\s+column/i, /alter\s+column/i,
                             /truncate/i, /delete\s+from/i, /alter table form_submissions/i]) {
    assert.ok(!destructive.test(statements), `migration must not contain ${destructive}`);
  }
});

test('6 — the notification types are constrained', () => {
  assert.deepEqual([...NOTIFICATION_TYPES],
    ['enquiry_received', 'order_confirmation', 'statement_delivery']);
  for (const type of NOTIFICATION_TYPES) assert.ok(migration.includes(`'${type}'`));
});

test('7 — the worker\'s hot query and the claim sweep are both indexed', () => {
  assert.match(migration, /notification_outbox_due_idx/);
  assert.match(migration, /notification_outbox_claim_idx/);
  assert.ok(migrateJs.includes('notification_outbox_due_idx'));
});

test('8 — form_submissions is untouched', () => {
  assert.ok(!/alter table form_submissions/i.test(migration),
    'delivery_state keeps its current meaning; the outbox owns attempt history');
});

// ===========================================================================
// 9-16 — enqueue and idempotency
// ===========================================================================

test('9 — enqueue stores a pending notification', async () => {
  const db = makeDb();
  const row = await enqueue(db, ENQUEUE);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 0);
  assert.equal(row.recipient_address, 'ops@example.test');
});

test('10 — the idempotency key is deterministic', () => {
  const a = idempotencyKeyFor({ notificationType: 'enquiry_received', sourceType: 'form_submission', sourceId: 'x', recipient: 'Ops@Example.Test' });
  const b = idempotencyKeyFor({ notificationType: 'enquiry_received', sourceType: 'form_submission', sourceId: 'x', recipient: 'ops@example.test' });
  assert.equal(a, b, 'case and whitespace must not produce a different key');
  assert.match(a, /^[0-9a-f]{40}$/);
  /* Hashed, so a recipient address never appears in an index or a log. */
  assert.ok(!a.includes('example'));
});

test('11 — a repeated enqueue creates no second notification', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const second = await enqueue(db, ENQUEUE);
  assert.equal(second, null, 'a duplicate is a no-op, not an error');
  assert.equal(db.table.length, 1);
});

test('12 — different recipients get different notifications', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  await enqueue(db, { ...ENQUEUE, recipientAddress: 'sales@example.test' });
  assert.equal(db.table.length, 2);
});

test('13 — an unknown notification type is refused', async () => {
  await assert.rejects(() => enqueue(makeDb(), { ...ENQUEUE, notificationType: 'anything' }), OutboxError);
});

test('14 — a missing recipient or template is refused', async () => {
  await assert.rejects(() => enqueue(makeDb(), { ...ENQUEUE, recipientAddress: '' }), OutboxError);
  await assert.rejects(() => enqueue(makeDb(), { ...ENQUEUE, templateKey: '' }), OutboxError);
});

test('15 — template data is the explicit allowlist, never a submission row', () => {
  const data = buildEnquiryTemplateData({
    formType: 'contact', submittedAt: T0.toISOString(), region: 'IE', businessType: 'Distributor',
  });
  assert.deepEqual(Object.keys(data).sort(),
    ['adminUrl', 'businessType', 'formLabel', 'formType', 'region', 'submittedAt']);
  /* The builder takes named arguments — there is no code path that could
     spread a row into it. */
  assert.match(code('notifications/templates.js'), /export function buildEnquiryTemplateData\(\{/);
  assert.ok(!/\.\.\.(row|submission)/.test(code('notifications/templates.js')));
});

test('16 — an enquiry alert carries no enquirer detail', () => {
  const rendered = render('enquiry_received', buildEnquiryTemplateData({
    formType: 'contact', submittedAt: T0.toISOString(), region: 'IE',
  }));
  const all = `${rendered.subject} ${rendered.html} ${rendered.text}`;
  for (const leak of ['Sam Example', 'sam@example.test', 'Do you ship', '+353']) {
    assert.ok(!all.includes(leak), `an alert must not contain ${leak}`);
  }
  assert.match(all, /deliberately not included/);
});

// ===========================================================================
// 17-24 — claim, lease and recovery
// ===========================================================================

test('17 — claiming marks rows processing with an expiring lease', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const claimed = await claimDue(db, { now: T0 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, 'processing');
  assert.ok(claimed[0].claim_expires_at > T0);
});

test('18 — a claimed row is not claimed again while its lease holds', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  await claimDue(db, { now: T0 });
  const second = await claimDue(db, { now: at(1000) });
  assert.equal(second.length, 0, 'two workers must not process the same notification');
});

test('19 — an expired lease is reclaimed — crashed-worker recovery', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  await claimDue(db, { now: T0 });          // a worker claims, then dies
  const reclaimed = await claimDue(db, { now: at(CLAIM_TTL_MS + 1000) });
  assert.equal(reclaimed.length, 1, 'a crash must not park a notification forever');
});

test('20 — the claim is one atomic statement using skip locked', () => {
  const src = code('notifications/outbox.js');
  assert.match(src, /for update skip locked/,
    'skip locked is what makes a second worker step over rather than block');
  assert.match(src, /update notification_outbox\s+set status = 'processing'/);
});

test('21 — a not-yet-due retry is not claimed', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const [row] = await claimDue(db, { now: T0 });
  await markAttemptFailed(db, row.id, { code: 'X', retryable: true, now: T0 });
  assert.equal((await claimDue(db, { now: at(30_000) })).length, 0, 'backoff must be respected');
  assert.equal((await claimDue(db, { now: at(120_000) })).length, 1, 'and then it is due');
});

test('22 — claiming is bounded by batch size', async () => {
  const db = makeDb();
  for (let i = 0; i < 25; i += 1) await enqueue(db, { ...ENQUEUE, sourceId: `fsub_${i}` });
  const claimed = await claimDue(db, { limit: 10, now: T0 });
  assert.equal(claimed.length, 10, 'a large backlog is drained in bounded steps');
});

test('23 — retries follow a bounded exponential schedule and then stop', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const [row] = await claimDue(db, { now: T0 });

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const settled = await markAttemptFailed(db, row.id, { code: 'PROVIDER_ERROR', retryable: true, now: T0 });
    assert.equal(settled.status, 'retry_scheduled', `attempt ${attempt} should schedule a retry`);
    assert.equal(settled.attempt_count, attempt);
    const waited = (settled.next_attempt_at - T0) / 60_000;
    assert.equal(waited, RETRY_SCHEDULE_MINUTES[attempt - 1]);
  }
  const terminal = await markAttemptFailed(db, row.id, { code: 'PROVIDER_ERROR', retryable: true, now: T0 });
  assert.equal(terminal.status, 'failed', 'retries are bounded, not endless');
  assert.ok(terminal.failed_at);
});

test('24 — a non-retryable failure is terminal immediately', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const [row] = await claimDue(db, { now: T0 });
  const settled = await markAttemptFailed(db, row.id, {
    code: DELIVERY_CODES.INVALID_RECIPIENT, retryable: false, now: T0,
  });
  assert.equal(settled.status, 'failed', 'a malformed address does not become deliverable by waiting');
  assert.equal(settled.attempt_count, 1);
});

// ===========================================================================
// 25-32 — delivery: no success without confirmation
// ===========================================================================

test('25 — the unconfigured adapter never reports success', async () => {
  const adapter = createUnconfiguredAdapter();
  assert.equal(adapter.configured, false);
  const result = await adapter.send({ to: 'ops@example.test', subject: 's', text: 't' });
  assert.equal(result.ok, false);
  assert.equal(result.code, DELIVERY_CODES.NOT_CONFIGURED);
  assert.equal(result.retryable, true, 'the queue holds rather than discarding');
});

test('26 — the unconfigured adapter logs nothing', () => {
  const src = code('notifications/delivery.js');
  const unconfigured = src.slice(src.indexOf('createUnconfiguredAdapter'), src.indexOf('createSmtpAdapter'));
  assert.ok(!/console\./.test(unconfigured),
    'mail.js logs the whole body when unconfigured; this must not');
});

test('27 — SMTP without a message reference is NOT delivered', async () => {
  /* No reference means no confirmation, so no claim of delivery. */
  const adapter = createSmtpAdapter({ async sendMail() { return {}; } });
  const result = await adapter.send({ to: 'ops@example.test' });
  assert.equal(result.ok, false);
  assert.equal(result.code, DELIVERY_CODES.NO_REFERENCE);
});

test('28 — SMTP with a message id is delivered, and carries the reference', async () => {
  const adapter = createSmtpAdapter({ async sendMail() { return { messageId: '<abc@mail>' }; } });
  const result = await adapter.send({ to: 'ops@example.test' });
  assert.equal(result.ok, true);
  assert.equal(result.providerReference, '<abc@mail>');
});

test('29 — a provider error surfaces its message, never the payload', async () => {
  const adapter = createSmtpAdapter({ async sendMail() { throw new Error('550 mailbox unavailable'); } });
  const result = await adapter.send({ to: 'ops@example.test', text: 'SECRET-BODY' });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('SECRET-BODY'));
  assert.match(result.message, /550/);
});

test('30 — a malformed recipient is rejected and not retried', async () => {
  for (const adapter of [createMemoryAdapter(), createSmtpAdapter({ async sendMail() { return { messageId: 'x' }; } })]) {
    const result = await adapter.send({ to: 'not-an-address' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
  }
});

test('31 — selectAdapter falls back to unconfigured without SMTP_HOST', () => {
  assert.equal(selectAdapter({}, { createTransport: () => ({}) }).name, 'unconfigured');
  assert.equal(selectAdapter({ SMTP_HOST: 'smtp.example.test' }, {}).name, 'unconfigured',
    'no transport factory means no delivery, not a pretend one');
  assert.equal(selectAdapter({ SMTP_HOST: 'smtp.example.test' }, { createTransport: () => ({}) }).name, 'smtp');
});

test('32 — markDelivered refuses to record delivery without evidence', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const [row] = await claimDue(db, { now: T0 });
  await assert.rejects(() => markDelivered(db, row.id, ''), OutboxError);
  await assert.rejects(() => markDelivered(db, row.id, null), OutboxError);
});

// ===========================================================================
// 33-40 — the worker
// ===========================================================================

test('33 — a successful tick delivers and records the provider reference', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const adapter = createMemoryAdapter();
  const counts = await runOnce(db, adapter, { now: () => T0 });

  assert.deepEqual(counts, { claimed: 1, delivered: 1, retried: 0, failed: 0, skipped: 0 });
  assert.equal(db.table[0].status, 'delivered');
  assert.equal(db.table[0].provider_reference, 'memory-1');
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].to, 'ops@example.test');
});

test('34 — a failing provider schedules a retry, and the message is not lost', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const adapter = createMemoryAdapter({ failTimes: 1 });
  const first = await runOnce(db, adapter, { now: () => T0 });
  assert.equal(first.retried, 1);
  assert.equal(db.table[0].status, 'retry_scheduled');

  const second = await runOnce(db, adapter, { now: () => at(RETRY_SCHEDULE_MINUTES[0] * 60_000) });
  assert.equal(second.delivered, 1);
  assert.equal(db.table[0].status, 'delivered');
});

test('35 — an unconfigured provider queues rather than failing silently', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const counts = await runOnce(db, createUnconfiguredAdapter(), { now: () => T0 });
  assert.equal(counts.delivered, 0);
  assert.equal(db.table[0].status, 'retry_scheduled');
  assert.match(db.table[0].last_error, /NOT_CONFIGURED/);
  assert.equal(db.table[0].delivered_at, null, 'nothing may look delivered');
});

test('36 — an adapter that throws does not stop the queue', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  await enqueue(db, { ...ENQUEUE, sourceId: 'fsub_2' });
  let calls = 0;
  const adapter = {
    name: 'flaky', configured: true,
    async send() { calls += 1; if (calls === 1) throw new Error('boom'); return { ok: true, providerReference: 'ok-2' }; },
  };
  const counts = await runOnce(db, adapter, { now: () => T0 });
  assert.equal(counts.claimed, 2);
  assert.equal(counts.delivered, 1, 'the second row still went out');
  assert.equal(counts.retried, 1);
});

test('37 — an unknown template fails terminally rather than sending nothing', async () => {
  const db = makeDb();
  await enqueue(db, { ...ENQUEUE, templateKey: 'no_such_template' });
  const counts = await runOnce(db, createMemoryAdapter(), { now: () => T0 });
  assert.equal(counts.failed, 1);
  assert.equal(db.table[0].status, 'failed');
  assert.match(db.table[0].last_error, /TEMPLATE_ERROR/);
});

test('38 — the worker logs counts only, never a recipient or template data', () => {
  const src = code('notifications/worker.js');
  const logs = [...src.matchAll(/console\.\w+\(([^;]+)\)/g)].map((m) => m[1]);
  for (const line of logs) {
    for (const forbidden of ['recipient', 'template_data', 'templateData', 'message.to', '.html', '.text']) {
      assert.ok(!line.includes(forbidden), `a log line must not carry ${forbidden}`);
    }
  }
});

test('39 — counters are counts only', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const c = await counters(db);
  assert.deepEqual(Object.keys(c).sort(), [...NOTIFICATION_STATUSES].sort());
  assert.ok(Object.values(c).every((v) => typeof v === 'number'));
  assert.ok(!JSON.stringify(c).includes('example.test'));
});

test('40 — a manual retry re-queues a failed notification with a full schedule', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const [row] = await claimDue(db, { now: T0 });
  await markAttemptFailed(db, row.id, { code: 'X', retryable: false, now: T0 });
  assert.equal(db.table[0].status, 'failed');

  const requeued = await requeue(db, row.id, { now: at(60_000) });
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attempt_count, 0, 'an operator gets a full schedule, not one last try');
  assert.equal(requeued.failed_at, null);

  /* A delivered notification is not re-sendable through this path. */
  await markDelivered(db, row.id, 'ref-1', { now: at(70_000) });
  assert.equal(await requeue(db, row.id, { now: at(80_000) }), null);
});

// ===========================================================================
// 41-46 — the enquiry transaction and what staff see
// ===========================================================================

test('41 — storage and the notification are one transaction', () => {
  const src = code('routes/public-forms.js');
  assert.match(src, /return db\.tx\(async \(c\) => \{/);
  const tx = src.slice(src.indexOf('db.tx('));
  assert.ok(tx.indexOf('insert into form_submissions') < tx.indexOf('enqueue(c,'),
    'the submission is written first, and the notification joins the same transaction');
  assert.match(tx, /enqueue\(c,/, 'the notification must use the TRANSACTION client');
});

test('42 — rejected, honeypot and throttled submissions create no notification', () => {
  /* Structural: handleSubmission returns before storeSubmission in all three
     cases, and storeSubmission is the only enqueue site. */
  const src = code('routes/public-forms.js');
  const handler = src.slice(src.indexOf('export async function handleSubmission'));
  const validationReturn = handler.indexOf('return { status: 400');
  const honeypotReturn = handler.indexOf('honeypotTripped');
  const store = handler.indexOf('await storeSubmission');
  assert.ok(validationReturn < store && honeypotReturn < store);
  assert.equal((src.match(/enqueue\(/g) || []).length, 1, 'exactly one enqueue site');
  /* The throttle refuses before the handler is called at all. */
  assert.match(src, /if \(throttled\(key\)\) \{/);
});

test('43 — the serializer masks the recipient and never returns template data', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  const serialized = serializeNotification(db.table[0]);
  assert.deepEqual(Object.keys(serialized).sort(), [
    'attemptCount', 'createdAt', 'deliveredAt', 'failedAt', 'id', 'lastAttemptedAt',
    'lastError', 'nextAttemptAt', 'notificationType', 'recipientMasked', 'status',
  ]);
  assert.equal(serialized.recipientMasked, 'op…@example.test');
  assert.ok(!('templateData' in serialized));
  assert.ok(!('idempotencyKey' in serialized));
});

test('44 — masking keeps the domain and drops the local part', () => {
  assert.equal(maskAddress('alex.hardy@example.test'), 'al…@example.test');
  assert.equal(maskAddress(''), '');
  assert.equal(maskAddress('nonsense'), '…');
});

test('45 — the enquiry detail reports delivery state, and "not configured" is visible', async () => {
  const db = makeDb();
  const none = await findBySource(db, 'form_submission', 'fsub_none');
  assert.deepEqual(none, [], 'no notification means no recipient is configured');

  await enqueue(db, ENQUEUE);
  const found = await findBySource(db, 'form_submission', 'fsub_1');
  assert.equal(found.length, 1);
  const src = code('routes/admin-enquiries.js');
  assert.match(src, /configured: notifications\.length > 0/);
});

test('46 — a retry cannot reach a notification belonging to another enquiry', () => {
  /* Without the ownership check the id alone would let a holder of
     enquiries.manage re-send any notification, including a customer
     statement. */
  const src = code('routes/admin-enquiries.js');
  assert.match(src, /notification\.source_type !== 'form_submission' \|\| notification\.source_id !== enquiryId/);
  assert.match(src, /r\.post\('\/:id\/notifications\/:notificationId\/retry', canManage\(\)/);
});

test('47 — every template renders, and the key set is closed', () => {
  assert.ok(TEMPLATE_KEYS.length >= 2);
  for (const key of TEMPLATE_KEYS) {
    const rendered = render(key, {});
    assert.ok(rendered.subject && rendered.html && rendered.text, `${key} must render all three parts`);
  }
  assert.throws(() => render('nope', {}), /Unknown notification template/);
});

test('48 — getById returns the row or null', async () => {
  const db = makeDb();
  await enqueue(db, ENQUEUE);
  assert.ok(await getById(db, db.table[0].id));
  assert.equal(await getById(db, 'ntf_missing'), null);
});
