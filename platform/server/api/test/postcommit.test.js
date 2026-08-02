/* Once the transaction has committed, no side effect may turn a real order into
   an apparent failure — the customer would retry and order twice. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCommit, afterCommitDetached } from '../src/postcommit.js';

/** Capture console.error so we can assert the failure was actually reported.
    Must AWAIT the work before restoring: afterCommit logs asynchronously, so
    restoring synchronously would miss the line entirely. */
async function captureErrors(fn) {
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args.join(' '));
  try { return { result: await fn(), seen }; } finally { console.error = original; }
}

test('a successful side effect returns its value', async () => {
  assert.equal(await afterCommit('ok', () => 'value'), 'value');
  assert.equal(await afterCommit('ok', async () => 42), 42);
});

test('post-commit AUDIT failure does not propagate', async () => {
  const { result, seen } = await captureErrors(() =>
    afterCommit('audit order SO11890', async () => {
      throw new Error('audit_log insert failed: connection terminated');
    }));
  assert.equal(result, null, 'resolves instead of rejecting');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /audit order SO11890/, 'log names the failed step');
  assert.match(seen[0], /already[\s\S]*committed/, 'log says the transaction stands');
  assert.match(seen[0], /connection terminated/, 'log keeps the underlying cause');
});

test('post-commit EMAIL failure does not propagate', async () => {
  const { result, seen } = await captureErrors(() =>
    afterCommit('order confirmation SO11890', async () => {
      throw Object.assign(new Error('SMTP 535 auth failed'), { code: 'EAUTH' });
    }));
  assert.equal(result, null);
  assert.match(seen[0], /order confirmation SO11890/);
  assert.match(seen[0], /SMTP 535/);
});

test('staff-notification and Zoho failures behave the same way', async () => {
  for (const step of ['staff order alert', 'zoho order push SO11890']) {
    const { result, seen } = await captureErrors(() =>
      afterCommit(step, async () => { throw new Error('upstream unavailable'); }));
    assert.equal(result, null, `${step} must not reject`);
    assert.match(seen[0], new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a SYNCHRONOUS throw is caught too (e.g. cache invalidation)', async () => {
  const { result, seen } = await captureErrors(() =>
    afterCommit('catalog cache invalidation', () => {
      throw new TypeError('cache is not iterable');
    }));
  assert.equal(result, null);
  assert.match(seen[0], /catalog cache invalidation/);
  assert.match(seen[0], /cache is not iterable/);
});

test('a caller-supplied fallback is used instead of null', async () => {
  const { result } = await captureErrors(() =>
    afterCommit('read recipients', () => { throw new Error('boom'); }, []));
  assert.deepEqual(result, [], 'the caller can keep going with a safe default');
});

test('a thrown non-Error does not break the logger', async () => {
  const { result, seen } = await captureErrors(() =>
    afterCommit('odd throw', () => { throw 'just a string'; }));
  assert.equal(result, null);
  assert.match(seen[0], /odd throw/);
});

test('the detached variant never produces an unhandled rejection', async () => {
  const rejections = [];
  const onUnhandled = r => rejections.push(r);
  process.on('unhandledRejection', onUnhandled);
  // Drain INSIDE the capture — the detached work logs after it is kicked off.
  const { seen } = await captureErrors(async () => {
    afterCommitDetached('detached zoho push', async () => { throw new Error('nope'); });
    await new Promise(r => setTimeout(r, 20));
    return null;
  });
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(rejections, [], 'nothing escapes to the process');
  assert.match(seen[0], /detached zoho push/);
});

test('afterCommit never rejects, whatever the work does', async () => {
  for (const fn of [() => undefined, () => null, async () => { throw new Error('x'); },
                    () => { throw 'string'; }]) {
    const original = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(() => afterCommit('any', fn));
    } finally { console.error = original; }
  }
});
