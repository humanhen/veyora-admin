/* Startup must FAIL CLOSED.

   It used to be ensureSchema().catch(log).finally(() => { listen(); zoho(); }),
   so a failed migration was logged and the API started anyway. /health only
   runs `select 1`, so it passed, the deploy looked healthy, and the API served
   traffic against a schema it did not have.

   startServer() takes its dependencies as arguments, so both outcomes are
   exercised here without binding a port or killing the test runner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/startup.js';

function harness({ schemaFails = false } = {}) {
  const calls = { ensureSchema: 0, listen: [], schedule: 0, exit: [], errors: [], logs: [] };
  return {
    calls,
    deps: {
      ensureSchema: async () => {
        calls.ensureSchema++;
        if (schemaFails) throw new Error('relation "backorders" has no column "currency"');
      },
      listen: async port => { calls.listen.push(port); },
      startSchedule: () => { calls.schedule++; },
      port: 3000,
      logger: { log: m => calls.logs.push(String(m)), error: (...a) => calls.errors.push(a.join(' ')) },
      exit: code => { calls.exit.push(code); },
    },
  };
}

test('successful migration starts the API and the scheduler', async () => {
  const { calls, deps } = harness();
  const r = await startServer(deps);
  assert.deepEqual(r, { ok: true, listening: true, scheduled: true, error: null });
  assert.equal(calls.ensureSchema, 1);
  assert.deepEqual(calls.listen, [3000]);
  assert.equal(calls.schedule, 1);
  assert.deepEqual(calls.exit, [], 'a healthy boot never exits');
  assert.ok(calls.logs.some(l => /listening on :3000/.test(l)));
});

test('FAILED migration starts NEITHER the API nor the scheduler', async () => {
  const { calls, deps } = harness({ schemaFails: true });
  const r = await startServer(deps);
  assert.equal(r.ok, false);
  assert.equal(r.listening, false);
  assert.equal(r.scheduled, false);
  assert.deepEqual(calls.listen, [], 'the port is never bound');
  assert.equal(calls.schedule, 0, 'no Zoho sync against an unknown schema');
});

test('FAILED migration exits non-zero so the deploy fails loudly', async () => {
  const { calls, deps } = harness({ schemaFails: true });
  await startServer(deps);
  assert.deepEqual(calls.exit, [1], 'exit code 1, not 0');
});

test('the fatal log names the cause and says the API will not start', async () => {
  const { calls, deps } = harness({ schemaFails: true });
  await startServer(deps);
  assert.equal(calls.errors.length, 1);
  const msg = calls.errors[0];
  assert.match(msg, /FATAL/);
  assert.match(msg, /will NOT start/i);
  assert.match(msg, /has no column "currency"/, 'the underlying cause is kept');
});

test('the schema error is returned to the caller, not swallowed', async () => {
  const { deps } = harness({ schemaFails: true });
  const r = await startServer(deps);
  assert.ok(r.error instanceof Error);
  assert.match(r.error.message, /backorders/);
});

test('listen is awaited, so a bind failure is not reported as a healthy start', async () => {
  const { calls, deps } = harness();
  deps.listen = async () => { throw new Error('EADDRINUSE'); };
  await assert.rejects(() => startServer(deps), /EADDRINUSE/);
  assert.equal(calls.schedule, 0, 'the scheduler never starts if listening failed');
});

test('ordering is strict: schema, then listen, then schedule', async () => {
  const order = [];
  await startServer({
    ensureSchema: async () => { order.push('schema'); },
    listen: async () => { order.push('listen'); },
    startSchedule: () => { order.push('schedule'); },
    logger: { log() {}, error() {} },
    exit: () => {},
  });
  assert.deepEqual(order, ['schema', 'listen', 'schedule']);
});

test('health can only be reachable after a successful start', async () => {
  // /health is served by the express app, which is only bound by listen().
  // With a failed schema, listen is never called, so nothing answers at all —
  // which is the point: an unmigrated API must not look healthy.
  const { calls, deps } = harness({ schemaFails: true });
  await startServer(deps);
  assert.equal(calls.listen.length, 0,
    'no listener means no /health, rather than a passing /health on a broken schema');
});
