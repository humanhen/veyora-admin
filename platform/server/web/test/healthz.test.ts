import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/pages/healthz.ts';

test('healthz: responds 200 with JSON ok:true and a noindex robots header', async () => {
  // The handler takes no context, so it can be invoked directly — no HTTP
  // server, no browser, no fixture setup.
  const response = await GET({} as any);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');

  const body = await response.json();
  assert.equal(body.ok, true);
});

test('healthz: response body carries no environment or secret detail', async () => {
  const response = await GET({} as any);
  const bodyText = await response.text();
  const parsed = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(parsed), ['ok'], 'body must contain nothing beyond {ok:true}');
});
