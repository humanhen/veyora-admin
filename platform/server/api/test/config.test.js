/* Feature-flag parsing. Run: node --test test/ (from platform/server/api) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowCustomerBackorders, orderAlertRecipients, publicFeatures } from '../src/config.js';

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
