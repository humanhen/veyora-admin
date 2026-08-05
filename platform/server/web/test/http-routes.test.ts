/* Builds once with valid explicit origins, starts the standalone server
   directly (no npm/shell wrapper — see test/command-paths.test.ts for why
   that matters on Windows), and requests a representative set of routes,
   query-state variations, the two static-redirect kinds, /healthz, and an
   unknown path. Node's test runner executes top-level tests within this
   file sequentially by default, so the build below is guaranteed to
   finish before the server-start test runs, and the server-start test
   before every request test.

   This proves the route SHAPE (200, HTML, one H1, title/description/
   canonical/robots, header/footer present, reachable by direct request
   with no hash routing) at the HTTP level — the live-server companion to
   test/route-contract.test.ts's source-level walk of all 25 routes.
   Arbitrary dynamic slugs returning 200 is documented, temporary B1.2/B1.3
   skeleton behaviour, not final publication/404 logic (B2/B4/B5). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_PORT = 4320; // distinct from other suites' ports and dev defaults
const SITE_ORIGIN = 'http://127.0.0.1:4321';
const PORTAL_ORIGIN = 'http://127.0.0.1:4322';

const ENV = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(TEST_PORT),
  PUBLIC_SITE_ORIGIN: SITE_ORIGIN,
  PORTAL_ORIGIN,
} as const;

function buildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...ENV };
}

async function get(routePath: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}${routePath}`, { redirect: 'manual' });
}

const REPRESENTATIVE_ROUTES = [
  '/',
  '/why-veyora/',
  '/brands/',
  '/brands/example-brand/',
  '/collections/',
  '/collections/example-brand/example-model/',
  '/contact/',
  '/privacy-policy/',
  '/sitemap/',
];

let serverProcess: ReturnType<typeof spawn> | undefined;

test('setup: production build succeeds so a real dist/ exists', () => {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    env: buildEnv(),
    shell: true,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
});

test('setup: start the validated standalone server directly', async () => {
  const gate = spawnSync('node', ['./scripts/validate-env.mjs'], {
    cwd: root,
    env: buildEnv(),
    encoding: 'utf8',
  });
  assert.equal(gate.status, 0, `env gate failed:\n${gate.stdout}${gate.stderr}`);

  serverProcess = spawn('node', ['./dist/server/entry.mjs'], { cwd: root, env: buildEnv() });

  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/healthz`);
      if (response.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'server never became reachable');
});

for (const route of REPRESENTATIVE_ROUTES) {
  test(`direct request to ${route} returns 200 HTML with full metadata, one H1, header/footer`, async () => {
    const response = await get(route);
    assert.equal(response.status, 200, `${route} did not return 200`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);

    const body = await response.text();
    const h1Count = (body.match(/<h1[ >]/g) ?? []).length;
    assert.equal(h1Count, 1, `${route} rendered ${h1Count} <h1> elements`);
    assert.match(body, /class="site-header"/, `${route} is missing the header`);
    assert.match(body, /class="site-footer"/, `${route} is missing the footer`);
    // No hash-routed navigation — every link found is a real path.
    assert.doesNotMatch(body, /href="#\//, `${route} contains a #/ link`);

    assert.match(body, /<title>[^<]+<\/title>/, `${route} has no title`);
    assert.match(body, /<meta name="description" content="[^"]+"/, `${route} has no description`);
    assert.match(body, /<meta name="robots" content="index, follow"/, `${route} is not index, follow`);
    assert.match(
      body,
      new RegExp(`<link rel="canonical" href="${SITE_ORIGIN.replace(/\//g, '\\/')}${route.replace(/\//g, '\\/')}"`),
      `${route} canonical does not match the expected absolute URL`
    );
    assert.doesNotMatch(body, /veyora\.(design|com)/i, `${route} hard-codes a real Veyora domain`);
  });
}

test('/collections/?page=2 is index, follow with a self-canonical including the page number', async () => {
  const response = await get('/collections/?page=2');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<meta name="robots" content="index, follow"/);
  assert.match(body, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN.replace(/\//g, '\\/')}\\/collections\\/\\?page=2"`));
});

test('/collections/?brand=example is noindex, follow, canonical to the clean unfiltered path', async () => {
  const response = await get('/collections/?brand=example');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
  assert.match(body, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN.replace(/\//g, '\\/')}\\/collections\\/"`));
});

test('/collections/?sort=name is noindex, follow, canonical to the unsorted path', async () => {
  const response = await get('/collections/?sort=name');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
  assert.match(body, new RegExp(`<link rel="canonical" href="${SITE_ORIGIN.replace(/\//g, '\\/')}\\/collections\\/"`));
});

test('/healthz remains 200, application/json, X-Robots-Tag noindex nofollow, unaffected by the new middleware', async () => {
  const response = await get('/healthz');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const body = await response.json();
  assert.equal(body.ok, true);
});

test('an unknown path returns a real 404 with noindex, follow — not a 200 skeleton or the homepage', async () => {
  const response = await get('/this-path-does-not-exist/');
  assert.equal(response.status, 404);
  const body = await response.text();
  const h1Count = (body.match(/<h1[ >]/g) ?? []).length;
  assert.equal(h1Count, 1);
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
  assert.match(body, /href="\/brands\/"/);
  assert.match(body, /href="\/collections\/"/);
  assert.match(body, /href="\/contact\/"/);
});

test('/500/ reports a real 500 status with noindex, nofollow when requested directly', async () => {
  const response = await get('/500/');
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /<meta name="robots" content="noindex, nofollow"/);
  const h1Count = (body.match(/<h1[ >]/g) ?? []).length;
  assert.equal(h1Count, 1);
});

test('known legacy static redirects resolve in exactly one hop', async () => {
  const cases: Array<[string, string]> = [
    ['/about-us/', '/why-veyora/'],
    ['/contact-us/', '/contact/'],
    ['/shop/', '/collections/'],
    ['/index.php', '/'],
  ];
  for (const [from, to] of cases) {
    const response = await get(from);
    assert.equal(response.status, 301, `${from} did not redirect`);
    assert.equal(response.headers.get('location'), to, `${from} redirected to the wrong location`);

    // One hop: following the redirect must not redirect again.
    const followUp = await get(to);
    assert.equal(followUp.status, 200, `${to} (the redirect target) did not resolve directly`);
  }
});

test('trailing-slash normalisation redirects a bare public path in one hop', async () => {
  const response = await get('/collections');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/collections/');

  const followUp = await get('/collections/');
  assert.equal(followUp.status, 200);
});

test('/healthz is never redirected by the trailing-slash rule', async () => {
  const response = await get('/healthz');
  assert.equal(response.status, 200);
});

test('a static asset is never redirected', async () => {
  const response = await get('/logo-black.svg');
  assert.equal(response.status, 200);
});

test('the legacy hash-bridge script and its portal-origin meta tag are present on /', async () => {
  const response = await get('/');
  const body = await response.text();
  assert.match(body, new RegExp(`<meta name="portal-origin" content="${PORTAL_ORIGIN.replace(/\//g, '\\/')}"`));
  // The bridge's own logic (see src/lib/legacy-hash-bridge.ts) is bundled
  // into the page's module script; these fragments of its compiled output
  // are stable across the minifier's naming choices.
  assert.match(body, /getAttribute\("content"\)/);
  assert.match(body, /location\.replace/);
});

test('teardown: stop the server cleanly, leaving no orphaned process', async () => {
  if (!serverProcess) return;
  serverProcess.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    serverProcess!.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});
