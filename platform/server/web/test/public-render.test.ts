/* End-to-end rendered-output tests (B2.3).

   Builds the real Astro server once, starts it against a controlled local
   mock API, and requests real routes over HTTP. This is the only layer
   that can prove the thing that actually matters: that adversarial fields
   present in an API payload do not reach RENDERED HTML — not merely that
   they are absent from a validated object.

   Nothing here contacts a real API, database or external network. The
   mock listens on 127.0.0.1 and the Astro server is told to use it via
   PUBLIC_API_ORIGIN.

   Node's test runner executes top-level tests within one file
   sequentially, so the build/start setup below is guaranteed to complete
   before any request test runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi, PLANTED_SECRETS, type MockApi, type MockApiOptions } from './helpers/mock-public-api.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_PORT = 4325; // distinct from every other suite's port and the dev defaults
const SITE_ORIGIN = 'http://127.0.0.1:4321';
const PORTAL_ORIGIN = 'http://127.0.0.1:4322';

let mock: MockApi | undefined;
let server: ReturnType<typeof spawn> | undefined;

function webEnv(apiOrigin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(WEB_PORT),
    PUBLIC_SITE_ORIGIN: SITE_ORIGIN,
    PORTAL_ORIGIN,
    PUBLIC_API_ORIGIN: apiOrigin,
  };
}

async function get(routePath: string): Promise<{ status: number; body: string; contentType: string }> {
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}${routePath}`, { redirect: 'manual' });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  };
}

/** Restarts the Astro server pointed at a mock configured differently
 * (e.g. failing, or empty) so failure paths can be exercised over real
 * HTTP rather than only at the unit level. */
async function restartWith(options: MockApiOptions) {
  if (server) {
    server.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (mock) await mock.close();

  mock = await startMockApi(options);
  server = spawn('node', ['./dist/server/entry.mjs'], { cwd: root, env: webEnv(mock.origin) });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`);
      if (response.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Astro server never became reachable');
}

function countH1(html: string): number {
  return (html.match(/<h1[\s>]/g) ?? []).length;
}

/** Asserts no planted secret appears in rendered HTML. Uses the distinctive
 * planted literals rather than generic words, so a legitimate word like
 * "discontinued" or "Ordering Guide" can never trip it. */
function assertNoSecretsInHtml(html: string, label: string) {
  for (const [name, secret] of Object.entries(PLANTED_SECRETS)) {
    assert.ok(!html.includes(secret), `${label} rendered ${name} ("${secret}")`);
  }
}

// ---------- setup ----------

test('setup: production build succeeds', () => {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    env: webEnv('http://127.0.0.1:1'),
    shell: true,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
});

test('setup: start the Astro server against a healthy mock API', async () => {
  await restartWith({});
});

// ---------- brand routes ----------

test('/brands/ renders published fixture brands with exactly one H1 and no private data', async () => {
  const { status, body, contentType } = await get('/brands/');
  assert.equal(status, 200);
  assert.match(contentType, /text\/html/);
  assert.equal(countH1(body), 1);
  assert.ok(body.includes('Example Brand'), 'the fixture brand should be rendered');
  assert.ok(body.includes('/brands/example-brand/'), 'the brand should link to its detail page');
  assertNoSecretsInHtml(body, '/brands/');
});

test('/brands/example-brand/ renders dynamic metadata, breadcrumbs and no private data', async () => {
  const { status, body } = await get('/brands/example-brand/');
  assert.equal(status, 200);
  assert.equal(countH1(body), 1);
  // H1 and <title> come from the validated API record, not a humanised slug.
  assert.ok(body.includes('<h1>Example Brand</h1>'), 'H1 should be the API-supplied brand name');
  assert.match(body, /<title>Example Brand Wholesale Eyewear[^<]*<\/title>/);
  // The approved summary becomes the meta description.
  assert.match(body, /<meta name="description" content="A premium eyewear brand[^"]*"/);
  // Breadcrumbs use the real name, not "Example-brand".
  assert.match(body, /aria-label="Breadcrumb"/);
  assert.ok(body.includes('>Example Brand<'), 'breadcrumb should carry the record name');
  assertNoSecretsInHtml(body, '/brands/example-brand/');
});

test('/brands/missing-brand/ returns a real 404, not a humanised-slug page', async () => {
  const { status, body } = await get('/brands/missing-brand/');
  assert.equal(status, 404);
  assert.equal(countH1(body), 1);
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
  // It must NOT invent a brand called "Missing Brand".
  assert.ok(!body.includes('<h1>Missing Brand</h1>'), 'a missing brand must not render as a real brand page');
});

// ---------- collections routes ----------

test('/collections/ renders published models with one H1, pagination and no private data', async () => {
  const { status, body } = await get('/collections/');
  assert.equal(status, 200);
  assert.equal(countH1(body), 1);
  assert.ok(body.includes('Example Model'), 'the fixture model should render');
  assert.ok(body.includes('/collections/example-brand/example-model/'), 'model should link to its detail page');
  // The fixture reports hasMore: true, so a next link must exist.
  assert.match(body, /rel="next"/);
  assertNoSecretsInHtml(body, '/collections/');
});

test('/collections/?page=2 keeps a previous link and remains 200', async () => {
  const { status, body } = await get('/collections/?page=2');
  assert.equal(status, 200);
  assert.match(body, /rel="prev"/);
  assertNoSecretsInHtml(body, '/collections/?page=2');
});

test('/collections/?sort=name is accepted and forwarded', async () => {
  const { status } = await get('/collections/?sort=name');
  assert.equal(status, 200);
  const forwarded = mock!.requests.map((r) => r.url).filter((u) => u.startsWith('/public/models'));
  assert.ok(
    forwarded.some((u) => new URL(u, 'http://x').searchParams.get('sort') === 'name'),
    'sort=name should have been forwarded to the API'
  );
});

test('/collections/?page=abc returns 400 without querying the API', async () => {
  const before = mock!.requests.length;
  const { status, body } = await get('/collections/?page=abc');
  assert.equal(status, 400);
  assert.equal(countH1(body), 1, 'even an error page keeps exactly one H1');
  assert.equal(mock!.requests.length, before, 'a locally-invalid query must not reach the API');
});

test('/collections/?sort=nonsense returns 400 without querying the API', async () => {
  const before = mock!.requests.length;
  const { status } = await get('/collections/?sort=nonsense');
  assert.equal(status, 400);
  assert.equal(mock!.requests.length, before);
});

test('an unsupported query parameter is ignored, never forwarded', async () => {
  await get('/collections/?colour=red&limit=9999');
  const last = mock!.requests.at(-1)!;
  const forwarded = new URL(last.url, 'http://x');
  assert.equal(forwarded.searchParams.has('colour'), false);
  assert.equal(forwarded.searchParams.has('limit'), false);
});

test('a category route injects its category and keeps it out of its own pagination links', async () => {
  const { status, body } = await get('/collections/optical/');
  assert.equal(status, 200);
  assert.equal(countH1(body), 1);
  const modelRequests = mock!.requests.filter((r) => r.url.startsWith('/public/models?'));
  const last = new URL(modelRequests.at(-1)!.url, 'http://x');
  assert.equal(last.searchParams.get('category'), 'Optical', 'the category must be injected');
  // Its own next link must not repeat the category as a query param.
  const nextMatch = body.match(/rel="next" href="([^"]+)"/);
  if (nextMatch) {
    const nextUrl = new URL(nextMatch[1], 'http://x');
    assert.equal(nextUrl.pathname, '/collections/optical/');
    assert.equal(nextUrl.searchParams.has('category'), false);
  }
});

test('a category route cannot be repointed to another category by query parameter', async () => {
  await get('/collections/optical/?category=Sun');
  const modelRequests = mock!.requests.filter((r) => r.url.startsWith('/public/models?'));
  const last = new URL(modelRequests.at(-1)!.url, 'http://x');
  assert.equal(last.searchParams.get('category'), 'Optical');
});

// ---------- model detail ----------

test('/collections/example-brand/example-model/ renders safe public fields only', async () => {
  const { status, body } = await get('/collections/example-brand/example-model/');
  assert.equal(status, 200);
  assert.equal(countH1(body), 1);
  assert.ok(body.includes('<h1>Example Brand Example Model</h1>'));
  assert.ok(body.includes('A classic aviator silhouette.'), 'approved description should render');
  assert.ok(body.includes('20894'), 'public display SKU should render');
  assert.ok(body.includes('Matte Black'), 'published colour should render');
  assert.ok(body.includes('polarized'), 'lens type should render');
  assert.ok(body.includes('Related Model'), 'related model should render');
  assertNoSecretsInHtml(body, '/collections/example-brand/example-model/');
});

test('the model detail page renders no availability, order control or login-dependent UI', async () => {
  const { body } = await get('/collections/example-brand/example-model/');
  const lower = body.toLowerCase();
  assert.ok(!lower.includes('add to cart'));
  assert.ok(!lower.includes('in stock'));
  assert.ok(!lower.includes('out of stock'));
  assert.ok(!/<form\b/.test(body), 'no order form should be present');
});

test('an unsafe media URL from the API is never rendered as an image src', async () => {
  const { body } = await get('/collections/example-brand/example-model/');
  assert.ok(!body.includes('javascript:alert(1)'), 'an unsafe media path reached the HTML');
});

test('/collections/example-brand/missing-model/ returns a real 404', async () => {
  const { status, body } = await get('/collections/example-brand/missing-model/');
  assert.equal(status, 404);
  assert.equal(countH1(body), 1);
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
});

// ---------- locations ----------

test('/global-presence/ renders published locations without address, contact or coordinates', async () => {
  const { status, body } = await get('/global-presence/');
  assert.equal(status, 200);
  assert.equal(countH1(body), 1);
  assert.ok(body.includes('Italy Supply Base'));
  assert.ok(body.includes('Supply base'), 'the function label should render');
  assert.ok(!body.includes('Via Roma'), 'an address must never render');
  assert.ok(!body.includes('45.46'), 'coordinates must never render');
  assertNoSecretsInHtml(body, '/global-presence/');
});

// ---------- no hash routing anywhere ----------

test('no integrated route emits a legacy #/ link', async () => {
  for (const route of ['/brands/', '/brands/example-brand/', '/collections/', '/collections/example-brand/example-model/', '/global-presence/']) {
    const { body } = await get(route);
    assert.ok(!body.includes('href="#/'), `${route} contains a #/ link`);
  }
});

// ---------- empty states (200, distinct from failure) ----------

test('an empty but successful API response renders a 200 empty state, not a failure', async () => {
  await restartWith({ empty: true });
  for (const route of ['/brands/', '/collections/', '/global-presence/']) {
    const { status, body } = await get(route);
    assert.equal(status, 200, `${route} should stay 200 when the API returns an empty collection`);
    assert.equal(countH1(body), 1);
    assert.match(body, /no published/i, `${route} should render the empty state`);
    assert.ok(!/Temporarily unavailable/i.test(body), `${route} must not claim an outage for an empty result`);
  }
});

// ---------- upstream failure (non-200, never a false empty/404) ----------

test('an upstream 500 renders 503 with an unavailable state, never an empty catalogue', async () => {
  await restartWith({ failWith: { status: 500 } });
  for (const route of ['/brands/', '/collections/', '/global-presence/']) {
    const { status, body } = await get(route);
    assert.equal(status, 503, `${route} should surface upstream unavailability as 503`);
    assert.equal(countH1(body), 1);
    assert.match(body, /Temporarily unavailable/i);
    assert.ok(!/no published/i.test(body), `${route} must not present an outage as an empty result`);
  }
});

test('upstream failure on a detail route does NOT become a false 404', async () => {
  const brand = await get('/brands/example-brand/');
  assert.equal(brand.status, 503, 'an outage must not be reported as "brand not found"');
  const model = await get('/collections/example-brand/example-model/');
  assert.equal(model.status, 503);
});

test('a malformed upstream payload renders 502, distinct from both 404 and 503', async () => {
  await restartWith({ malformedShape: true });
  const { status, body } = await get('/brands/');
  assert.equal(status, 502);
  assert.equal(countH1(body), 1);
  assert.match(body, /Temporarily unavailable/i);
});

test('no failure page leaks the internal API origin, a stack trace or SQL detail', async () => {
  const { body } = await get('/brands/');
  // The INTERNAL api origin (mock.origin, a distinct host:port) must never
  // appear. The public site/portal origins legitimately do appear — they
  // are the canonical URL and the B2B login link — so this checks the
  // specific internal origin rather than the shared 127.0.0.1 host.
  assert.ok(!body.includes(mock!.origin), 'the internal API origin leaked into rendered HTML');
  assert.ok(!/at\s+\w+\s+\(/.test(body), 'a stack trace leaked into rendered HTML');
  assert.ok(!/\bselect\b[\s\S]{0,80}\bfrom\b/i.test(body), 'SQL detail leaked into rendered HTML');
});

// ---------- teardown ----------

test('teardown: stop the Astro server and the mock API cleanly', async () => {
  if (server) {
    server.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (mock) await mock.close();
});
