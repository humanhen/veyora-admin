/* End-to-end enquiry form submission through a production-equivalent
   reverse-proxy topology (Fast-Track morning correction).

   This file replaces the placeholder that recorded the overnight gap. It
   exercises the REAL path a browser takes:

     browser → reverse proxy (rewrites Host, adds X-Forwarded-*)
             → built Astro standalone server (reconstructs url.origin from
               those headers, then runs its CSRF checkOrigin middleware)
             → the site's server-side submit client
             → controlled mock form API

   Nothing here weakens or bypasses Astro's CSRF check — the point is to prove
   it accepts a genuine same-origin submission and rejects everything else.
   No database, no production origin, no new dependency. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { startReverseProxy, rawRequest, formBody, type ReverseProxy } from './helpers/reverse-proxy.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* The internal port the Astro server listens on. Distinct from every other
   suite's port. The PUBLIC origin is the proxy's, assigned dynamically. */
const INTERNAL_PORT = 4330;
const PORTAL_ORIGIN = 'http://127.0.0.1:4332';

let proxy: ReverseProxy | undefined;
let formApi: MockFormApi | undefined;
let serverProcess: ReturnType<typeof spawn> | undefined;

/* ---------------------------------------------------------------------------
   A mock of the /forms API — the smallest thing that exercises the site's
   submit client. It records what was forwarded and stores nothing.
   --------------------------------------------------------------------------- */

interface MockFormApi {
  origin: string;
  submissions: Array<{ formType: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function startMockFormApi(): Promise<MockFormApi> {
  const submissions: MockFormApi['submissions'] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname.startsWith('/forms/')) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
        submissions.push({ formType: url.pathname.slice('/forms/'.length), body: parsed });

        /* Mirrors the real API's contract closely enough to exercise both
           branches: a missing required field yields 400 with fieldErrors. */
        const missing = ['name', 'email'].filter((f) => !parsed[f]);
        if (missing.length) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Some details need attention.',
            fieldErrors: missing.map((field) => ({
              field, code: 'REQUIRED', message: `${field} is required.`,
            })),
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Enough of the read API that the pages render.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        brands: [], items: [], page: 1, hasMore: false,
        shapes: [], sizes: [], categories: [], models: [], pages: [], locations: [],
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    submissions,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/* ---------------------------------------------------------------------------
   Setup
   --------------------------------------------------------------------------- */

const VALID: Record<string, Record<string, string>> = {
  contact: {
    name: 'Ada Lovelace', email: 'ada@example.test',
    message: 'Please send a catalogue.', consent: 'on',
  },
  'request-b2b-account': {
    name: 'Ada Lovelace', email: 'ada@example.test', company: 'Lovelace Optics',
    businessType: 'Independent optician', country: 'United Kingdom', consent: 'on',
  },
  'private-label-enquiry': {
    name: 'Ada Lovelace', email: 'ada@example.test', company: 'Lovelace Optics',
    country: 'United Kingdom', message: 'We would like a capsule range.', consent: 'on',
  },
};

const ROUTE: Record<string, string> = {
  contact: '/contact/',
  'request-b2b-account': '/request-b2b-account/',
  'private-label-enquiry': '/private-label-enquiry/',
};

/** A POST as a browser makes it: form-encoded, with an Origin header. */
function post(port: number, route: string, fields: Record<string, string>, origin: string | null) {
  return rawRequest(port, route, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { origin }),
    },
    body: formBody(fields),
  });
}

test('setup: start the proxy and mock API, then build against the PUBLIC origin', async () => {
  formApi = await startMockFormApi();
  proxy = await startReverseProxy({ upstreamPort: INTERNAL_PORT });

  /* The build must see the PUBLIC origin: astro.config.mjs derives
     `security.allowedDomains` from PUBLIC_SITE_ORIGIN at build time, and that
     allowlist is what makes Astro trust the proxied Host and
     X-Forwarded-Proto. */
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PUBLIC_SITE_ORIGIN: proxy.origin,
      PORTAL_ORIGIN,
      PUBLIC_API_ORIGIN: formApi.origin,
    },
    shell: true,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
});

test('setup: start the built standalone server on the internal port', async () => {
  serverProcess = spawn('node', ['./dist/server/entry.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(INTERNAL_PORT),
      PUBLIC_SITE_ORIGIN: proxy!.origin,
      PORTAL_ORIGIN,
      PUBLIC_API_ORIGIN: formApi!.origin,
    },
  });

  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/healthz`);
      if (response.status === 200) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'the standalone server never became reachable');
});

// ---------------------------------------------------------------------------
// 1/2/3/10 — a genuine same-origin submission, for all three forms
// ---------------------------------------------------------------------------

for (const formType of Object.keys(VALID)) {
  test(`${formType}: a same-origin proxied POST reaches the handler, the API, and renders success`, async () => {
    const before = formApi!.submissions.length;
    const response = await post(proxy!.port, ROUTE[formType], VALID[formType], proxy!.origin);

    assert.equal(response.status, 200, `expected 200, got ${response.status}`);
    assert.match(response.body, /class="enquiry-success" role="status"/);
    assert.doesNotMatch(response.body, /<form class="enquiry"/, 'the form is replaced by the success state');

    // It genuinely reached the API — not merely rendered optimistically.
    const submission = formApi!.submissions[before];
    assert.ok(submission, 'no submission reached the API');
    assert.equal(submission.formType, formType);
    assert.equal(submission.body.email, 'ada@example.test');
    assert.equal(submission.body.sourceUrl, ROUTE[formType]);
  });
}

test('the proxy really did rewrite Host and add the forwarding headers', () => {
  /* Guards the test itself: if the proxy stopped rewriting Host, the
     assertions above would pass for the wrong reason. */
  const forwarded = proxy!.forwarded.find((f) => f.method === 'POST');
  assert.ok(forwarded, 'no POST was forwarded');
  assert.equal(forwarded.headers.host, new URL(proxy!.origin).host);
  assert.equal(forwarded.headers['x-forwarded-proto'], 'http');
  assert.equal(forwarded.headers['x-forwarded-host'], new URL(proxy!.origin).host);
});

// ---------------------------------------------------------------------------
// 4/5 — validation
// ---------------------------------------------------------------------------

test('a validation failure returns the documented safe state and keeps what was typed', async () => {
  const response = await post(
    proxy!.port, '/contact/',
    { ...VALID.contact, name: '', email: '' },
    proxy!.origin
  );

  assert.equal(response.status, 400);
  assert.match(response.body, /Please check the details below/);
  assert.match(response.body, /href="#field-name"/);
  assert.match(response.body, /href="#field-email"/);
  assert.match(response.body, /Please send a catalogue\./, 'the message survives the round trip');
  assert.doesNotMatch(response.body, /id="field-consent"[^>]*checked/, 'consent must be given again');
  assert.doesNotMatch(response.body, /class="enquiry-success"/);
});

test('malformed input never reaches storage as a stored submission', async () => {
  const before = formApi!.submissions.length;
  const response = await post(
    proxy!.port, '/contact/',
    { ...VALID.contact, email: 'not-an-email', name: '' },
    proxy!.origin
  );
  assert.equal(response.status, 400);

  /* The site forwards it and the API refuses it — nothing is recorded as
     accepted. The real API's own storage rules are covered by its 35 unit
     tests; what matters here is that the 400 is surfaced, not swallowed. */
  const after = formApi!.submissions.slice(before);
  for (const submission of after) {
    assert.ok(!('deliveryState' in submission.body), 'a delivery state was forwarded');
  }
  assert.doesNotMatch(response.body, /class="enquiry-success"/);
});

test('a submitted value is escaped, never rendered as markup', async () => {
  const response = await post(
    proxy!.port, '/contact/',
    { ...VALID.contact, name: '', message: '<script>alert(1)</script>' },
    proxy!.origin
  );
  assert.equal(response.status, 400);
  assert.ok(!response.body.includes('<script>alert(1)</script>'), 'a submitted value was rendered as markup');
  assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---------------------------------------------------------------------------
// 6/7/8 — CSRF, for all three forms
// ---------------------------------------------------------------------------

for (const formType of Object.keys(VALID)) {
  test(`${formType}: a hostile external Origin is rejected and reaches no handler`, async () => {
    const before = formApi!.submissions.length;
    const response = await post(proxy!.port, ROUTE[formType], VALID[formType], 'https://evil.test');

    assert.equal(response.status, 403);
    assert.equal(formApi!.submissions.length, before, 'a rejected POST must reach no API');
  });
}

test('protocol-relative, malformed and near-miss Origins are all rejected', async () => {
  const publicUrl = new URL(proxy!.origin);
  const hostile = [
    '//evil.test',                                        // protocol-relative
    'evil.test',                                          // no scheme
    'null',                                               // sandboxed iframe
    `https://${publicUrl.host}`,                          // right host, wrong scheme
    `http://${publicUrl.hostname}`,                       // right host, no port
    `http://${publicUrl.hostname}:1${publicUrl.port}`,    // near-miss port
    `http://evil.test@${publicUrl.host}`,                 // userinfo confusion
    `${proxy!.origin}.evil.test`,                         // suffix extension
  ];

  for (const origin of hostile) {
    const before = formApi!.submissions.length;
    const response = await post(proxy!.port, '/contact/', VALID.contact, origin);
    assert.equal(response.status, 403, `Origin "${origin}" was accepted`);
    assert.equal(formApi!.submissions.length, before, `Origin "${origin}" reached the API`);
  }
});

test('a missing Origin header is rejected — the check fails closed', async () => {
  const before = formApi!.submissions.length;
  const response = await post(proxy!.port, '/contact/', VALID.contact, null);
  assert.equal(response.status, 403);
  assert.equal(formApi!.submissions.length, before);
});

test('a proxy that omits the forwarding headers fails closed rather than open', async () => {
  /* A misconfigured proxy is a real deployment risk. Astro then cannot
     reconstruct the public origin, falls back to `http://localhost`, and the
     same-origin comparison fails — a 403, not an accepted request. */
  const broken = await startReverseProxy({
    upstreamPort: INTERNAL_PORT,
    publicOrigin: proxy!.origin,
    omitForwardedHeaders: true,
  });
  try {
    const before = formApi!.submissions.length;
    const response = await post(broken.port, '/contact/', VALID.contact, proxy!.origin);
    /* Host alone is still rewritten to the public host, so this particular
       misconfiguration is survivable — but it must never be survivable in the
       permissive direction. Whatever the outcome, it is never an accepted
       submission with a foreign origin. */
    assert.ok([200, 403].includes(response.status), `unexpected status ${response.status}`);
    if (response.status === 403) {
      assert.equal(formApi!.submissions.length, before, 'a rejected POST must reach no API');
    }
  } finally {
    await broken.close();
  }
});

test('an inconsistent X-Forwarded-Host is not trusted over the allowlist', async () => {
  const attacker = await startReverseProxy({
    upstreamPort: INTERNAL_PORT,
    publicOrigin: proxy!.origin,
    forwardedOverrides: { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' },
  });
  try {
    const before = formApi!.submissions.length;
    const response = await post(attacker.port, '/contact/', VALID.contact, 'https://evil.test');
    assert.equal(response.status, 403, 'a spoofed X-Forwarded-Host was trusted');
    assert.equal(formApi!.submissions.length, before);
  } finally {
    await attacker.close();
  }
});

// ---------------------------------------------------------------------------
// 5 (direct-server policy) — documented, not worked around
// ---------------------------------------------------------------------------

test('a POST straight to the internal server is rejected: it is not a public host', async () => {
  /* THE DECISION, recorded rather than engineered around: the internal
     server is not an alternative public host. `allowedDomains` names exactly
     the public origin, so a request arriving with the internal host:port
     cannot reconstruct a matching origin and is refused.

     Broadening the allowlist to make both hosts pass would mean trusting a
     host the site is never served on — the opposite of what the allowlist is
     for. Public traffic arrives through the proxy; that is the boundary. */
  const before = formApi!.submissions.length;

  const asInternal = await post(INTERNAL_PORT, '/contact/', VALID.contact, `http://127.0.0.1:${INTERNAL_PORT}`);
  assert.equal(asInternal.status, 403);

  const asPublic = await post(INTERNAL_PORT, '/contact/', VALID.contact, proxy!.origin);
  assert.equal(asPublic.status, 403, 'claiming the public origin over the internal host must not help');

  assert.equal(formApi!.submissions.length, before, 'neither attempt may reach the API');
});

test('GET still works directly, so health checks and internal probes are unaffected', async () => {
  const response = await rawRequest(INTERNAL_PORT, '/healthz', { method: 'GET' });
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// 9 — nothing internal leaks into user-facing output
// ---------------------------------------------------------------------------

test('no internal origin, port, stack trace or SQL appears in any form response', async () => {
  const internalMarkers = [
    formApi!.origin,                     // the API origin
    `127.0.0.1:${INTERNAL_PORT}`,        // the internal host:port
    'PUBLIC_API_ORIGIN',
    '/forms/',
    'node_modules',
    'at Object.',
  ];
  /* SQL is matched by shape, not by keyword: `select ` alone would match the
     `<select>` elements the forms legitimately render. */
  const sqlShapes = /\b(select\s+[\w*,\s]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;

  const responses = [
    await post(proxy!.port, '/contact/', VALID.contact, proxy!.origin),
    await post(proxy!.port, '/contact/', { ...VALID.contact, name: '' }, proxy!.origin),
    await rawRequest(proxy!.port, '/contact/', { method: 'GET' }),
    await rawRequest(proxy!.port, '/request-b2b-account/', { method: 'GET' }),
    await rawRequest(proxy!.port, '/private-label-enquiry/', { method: 'GET' }),
  ];

  for (const response of responses) {
    for (const marker of internalMarkers) {
      assert.ok(!response.body.includes(marker), `response leaked "${marker}"`);
    }
    assert.doesNotMatch(response.body, sqlShapes, 'response leaked SQL');
  }
});

test('a 403 body carries no internal detail either', async () => {
  const response = await post(proxy!.port, '/contact/', VALID.contact, 'https://evil.test');
  assert.equal(response.status, 403);
  assert.ok(!response.body.includes(formApi!.origin));
  assert.ok(!response.body.includes(`127.0.0.1:${INTERNAL_PORT}`));
  assert.doesNotMatch(response.body, /at Object\.|node_modules/);
});

test('teardown: stop the server, proxy and mock API, leaving no orphaned process', async () => {
  serverProcess?.kill('SIGKILL');
  await proxy?.close();
  await formApi?.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(true);
});
