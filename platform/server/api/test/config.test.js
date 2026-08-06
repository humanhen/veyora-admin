/* Feature-flag parsing. Run: node --test test/ (from platform/server/api) */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allowCustomerBackorders, enquiryAlertRecipients, notificationWorkerSettings,
  orderAlertRecipients, publicFeatures,
} from '../src/config.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('ALLOW_CUSTOMER_BACKORDERS defaults to true when unset or blank', () => {
  withEnv({ ALLOW_CUSTOMER_BACKORDERS: undefined }, () =>
    assert.equal(allowCustomerBackorders(), true));
  withEnv({ ALLOW_CUSTOMER_BACKORDERS: '' }, () =>
    assert.equal(allowCustomerBackorders(), true));
  withEnv({ ALLOW_CUSTOMER_BACKORDERS: '   ' }, () =>
    assert.equal(allowCustomerBackorders(), true));
});

test('ALLOW_CUSTOMER_BACKORDERS accepts the documented true/false spellings', () => {
  for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'on', 'y']) {
    withEnv({ ALLOW_CUSTOMER_BACKORDERS: v }, () =>
      assert.equal(allowCustomerBackorders(), true, `${v} should be true`));
  }
  for (const v of ['false', 'FALSE', ' False ', '0', 'no', 'off', 'n']) {
    withEnv({ ALLOW_CUSTOMER_BACKORDERS: v }, () =>
      assert.equal(allowCustomerBackorders(), false, `${v} should be false`));
  }
});

test('an unrecognised value falls back to the safe default rather than disabling ordering', () => {
  withEnv({ ALLOW_CUSTOMER_BACKORDERS: 'maybe' }, () =>
    assert.equal(allowCustomerBackorders(), true));
});

test('publicFeatures exposes the flag and nothing else', () => {
  withEnv({ ALLOW_CUSTOMER_BACKORDERS: 'false' }, () =>
    assert.deepEqual(publicFeatures(), { allowBackorders: false }));
});

test('ORDER_ALERT_EMAILS: unset or blank means the alert is simply off', () => {
  withEnv({ ORDER_ALERT_EMAILS: undefined }, () =>
    assert.deepEqual(orderAlertRecipients(), []));
  withEnv({ ORDER_ALERT_EMAILS: '' }, () =>
    assert.deepEqual(orderAlertRecipients(), []));
  withEnv({ ORDER_ALERT_EMAILS: ' , ,, ' }, () =>
    assert.deepEqual(orderAlertRecipients(), []));
});

test('ORDER_ALERT_EMAILS: multiple recipients are split, trimmed and de-blanked', () => {
  withEnv({ ORDER_ALERT_EMAILS: ' ops@veyora.test ,warehouse@veyora.test,, sales@veyora.test ' }, () =>
    assert.deepEqual(orderAlertRecipients(),
      ['ops@veyora.test', 'warehouse@veyora.test', 'sales@veyora.test']));
});

test('ORDER_ALERT_EMAILS: the example placeholder never receives mail', () => {
  withEnv({ ORDER_ALERT_EMAILS: 'orders@example.com' }, () =>
    assert.deepEqual(orderAlertRecipients(), []));
  // ...and it is dropped without taking the real recipients with it
  withEnv({ ORDER_ALERT_EMAILS: 'orders@example.com, ops@veyora.test' }, () =>
    assert.deepEqual(orderAlertRecipients(), ['ops@veyora.test']));
});

test('ORDER_ALERT_EMAILS: malformed entries are ignored', () => {
  withEnv({ ORDER_ALERT_EMAILS: 'not-an-email, ops@veyora.test, @nope, also@bad' }, () =>
    assert.deepEqual(orderAlertRecipients(), ['ops@veyora.test']));
});

/* ---------------------------------------------------------------------------
   Enquiry alert recipients and worker tuning (Final Handover Phase 1)
   --------------------------------------------------------------------------- */

test('ENQUIRY_ALERT_EMAILS falls back to ORDER_ALERT_EMAILS when unset', () => {
  withEnv({ ENQUIRY_ALERT_EMAILS: undefined, ORDER_ALERT_EMAILS: 'ops@veyora.test' }, () =>
    assert.deepEqual(enquiryAlertRecipients(), ['ops@veyora.test']));
});

test('ENQUIRY_ALERT_EMAILS overrides the order alert list when set', () => {
  withEnv({ ENQUIRY_ALERT_EMAILS: 'sales@veyora.test', ORDER_ALERT_EMAILS: 'ops@veyora.test' }, () =>
    assert.deepEqual(enquiryAlertRecipients(), ['sales@veyora.test']));
});

test('no configured recipient anywhere is an empty list, not a placeholder', () => {
  /* This is the "not configured" state the enquiry screen renders. It must be
     reachable and empty — never a fabricated address, and never a throw that
     would take the submission down with it. */
  withEnv({ ENQUIRY_ALERT_EMAILS: '', ORDER_ALERT_EMAILS: 'orders@example.com' }, () =>
    assert.deepEqual(enquiryAlertRecipients(), []));
});

test('worker tuning defaults when unset', () => {
  withEnv({ NOTIFICATION_POLL_SECONDS: undefined, NOTIFICATION_BATCH_SIZE: undefined }, () =>
    assert.deepEqual(notificationWorkerSettings(), { intervalMs: 30_000, batchSize: 20 }));
});

test('worker tuning accepts sane values', () => {
  withEnv({ NOTIFICATION_POLL_SECONDS: '60', NOTIFICATION_BATCH_SIZE: '5' }, () =>
    assert.deepEqual(notificationWorkerSettings(), { intervalMs: 60_000, batchSize: 5 }));
});

test('worker tuning refuses values that would spin or monopolise the table', () => {
  /* A 0-second poll would run the claim query as fast as PostgreSQL answers
     it; a 100000-row batch would hold a claim on the whole table while one
     slow provider timed out. Both fall back rather than failing boot. */
  for (const bad of ['0', '-1', '0.001', '999999', 'soon', '', '  ']) {
    withEnv({ NOTIFICATION_POLL_SECONDS: bad }, () =>
      assert.equal(notificationWorkerSettings().intervalMs, 30_000, `poll=${bad}`));
  }
  for (const bad of ['0', '-5', '201', '100000', 'lots', '']) {
    withEnv({ NOTIFICATION_BATCH_SIZE: bad }, () =>
      assert.equal(notificationWorkerSettings().batchSize, 20, `batch=${bad}`));
  }
});

test('the worker is started with the bounded settings, not with raw env', () => {
  /* A tuning helper nothing calls is decoration. This asserts index.js passes
     it, so a future edit that drops the argument fails here rather than
     silently reverting every deployment to the library defaults. */
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /startNotificationWorker\([\s\S]{0,200}notificationWorkerSettings\(\)/);
  assert.doesNotMatch(index, /process\.env\.NOTIFICATION_/);
});
