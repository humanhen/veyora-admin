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
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi, PLANTED_SECRETS, type MockApi } from './helpers/mock-public-api.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_PORT = 4320; // distinct from other suites' ports and dev defaults
/* Must match the port the server actually listens on. Astro validates the
   request Host against `security.allowedDomains` (derived from this origin in
   astro.config.mjs); a mismatch makes it fall back to `http://localhost`,
   which then fails the CSRF origin check on every form POST. Declaring a
   different port here was a harness artefact that hid that behaviour. */
const SITE_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const PORTAL_ORIGIN = 'http://127.0.0.1:4322';

/* B2.3: several of the representative routes below are now backed by the
   read-only /public/* API, so this suite starts a controlled local mock of
   it (test/helpers/mock-public-api.ts) and points PUBLIC_API_ORIGIN at it.
   Without one, /brands/ and /collections/* would correctly answer 503 —
   the "upstream unavailable" path — and this suite would be asserting the
   failure behaviour rather than the route contract it exists to check.
   No real API is contacted. */
let mockApi: MockApi | undefined;

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(TEST_PORT),
    PUBLIC_SITE_ORIGIN: SITE_ORIGIN,
    PORTAL_ORIGIN,
    // Falls back to an unused port only for the build step, which never
    // issues a request; the server start below uses the real mock origin.
    PUBLIC_API_ORIGIN: mockApi?.origin ?? 'http://127.0.0.1:4399',
  };
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
  // Start the mock public API first so buildEnv() picks up its origin.
  mockApi = await startMockApi();

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

/* Fast-Track Phase 2: the filter interface is server-rendered HTML. These
   assertions run against the real standalone server with no client
   JavaScript involved at all — a fetch() has no DOM and runs no scripts, so
   anything asserted here is what a crawler or a JS-disabled visitor sees. */

test('the catalogue filter form is server-rendered as a GET form with real controls', async () => {
  const response = await get('/collections/');
  assert.equal(response.status, 200);
  const body = await response.text();

  assert.match(body, /<form[^>]+method="get"[^>]+action="\/collections\/"/);
  // Choices come from the mock API's facet fixture, not from invented values.
  assert.match(body, /<select[^>]+id="filter-brand"[^>]+name="brand"/);
  // Astro appends a data-astro-cid-* scoping attribute to every styled
  // element, so assertions must tolerate extra attributes.
  assert.match(body, /<option value="example-brand"[^>]*>Example Brand<\/option>/);
  assert.match(body, /<select[^>]+id="filter-shape"[^>]+name="shape"/);
  assert.match(body, /<select[^>]+id="filter-sort"[^>]+name="sort"/);
  assert.match(body, /<label[^>]+for="filter-brand"/);
  // No page input: submitting always lands on page 1.
  assert.doesNotMatch(body, /<input[^>]+name="page"/);
  // Still exactly one H1.
  assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1);
});

test('an applied filter renders an active chip with a working clear link', async () => {
  const response = await get('/collections/?brand=example-brand&sort=name');
  assert.equal(response.status, 200);
  const body = await response.text();

  assert.match(body, /Active filters/);
  assert.match(body, /Brand: Example Brand/);
  // Clearing the brand keeps the sort, and vice versa.
  assert.match(body, /href="\/collections\/\?sort=name"/);
  assert.match(body, /href="\/collections\/\?brand=example-brand"/);
  // Clear-all returns to the bare path.
  assert.match(body, /class="filters__clear-all" href="\/collections\/"/);
});

test('a category route renders no category control and cannot be re-categorised by query', async () => {
  const response = await get('/collections/sun/?category=Optical');
  assert.equal(response.status, 200);
  const body = await response.text();

  assert.doesNotMatch(body, /<select[^>]+name="category"/);
  assert.doesNotMatch(body, /category=Optical/, 'the overridden category must not appear in any link');
  assert.match(body, /action="\/collections\/sun\/"/);
  assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1);
});

test('the filter interface renders no price, stock or availability control', async () => {
  for (const route of ['/collections/', '/collections/sun/', '/collections/?shape=round']) {
    const body = await (await get(route)).text();
    assert.doesNotMatch(body, /name="(price|stock|availability|qty|cost)"/i, route);
    assert.doesNotMatch(body, /in stock|out of stock/i, route);
  }
});

/* Fast-Track Phase 3: enquiry forms, exercised as a browser with scripting
   disabled would. `fetch` runs no scripts, so a POST of url-encoded form data
   is exactly what a plain <form> submission produces. */

interface RawResponse { status: number; body: string }

/**
 * Submits a form the way a browser does.
 *
 * Uses node:http rather than fetch because `Origin` is a FORBIDDEN HEADER
 * NAME in the Fetch spec — `fetch()` silently refuses to set it. Astro 5
 * enables `security.checkOrigin` for SSR by default, so a form-encoded POST
 * whose Origin does not match `context.url.origin` is rejected with 403.
 * A real browser sets Origin automatically on a same-origin form submission;
 * a test has to use a client that can.
 *
 * Passing `origin: null` omits the header and exercises the rejection path.
 */
function postForm(
  routePath: string,
  fields: Record<string, string>,
  { origin = SITE_ORIGIN }: { origin?: string | null } = {}
): Promise<RawResponse> {
  const payload = new URLSearchParams(fields).toString();
  const headers: Record<string, string | number> = {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(payload),
  };
  if (origin) headers.origin = origin;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: TEST_PORT, path: routePath, method: 'POST', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const CONTACT_FIELDS = {
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  message: 'Please send a catalogue.',
  consent: 'on',
};

test('an enquiry form renders server-side with real controls and no action attribute', async () => {
  for (const route of ['/contact/', '/request-b2b-account/', '/private-label-enquiry/']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    const body = await response.text();

    assert.match(body, /<form class="enquiry" method="post"/, route);
    assert.doesNotMatch(body, /<form class="enquiry"[^>]+action=/, route);
    assert.match(body, /<label class="enquiry-label" for="field-email"/, route);
    assert.match(body, /<input[^>]+id="field-email"[^>]+name="email"/, route);
    assert.match(body, /id="field-consent"[^>]+name="consent"/, route);
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, route);
    // The API origin must never reach the browser.
    assert.ok(!body.includes(mockApi!.origin), `${route} leaked the API origin`);
    assert.doesNotMatch(body, /\/forms\//, route);
  }
});

/* The overnight placeholder that stood here is gone: end-to-end form POSTs
   are now exercised for real in test/enquiry-e2e.test.ts, through a Node-core
   reverse proxy that reproduces the production header contract.

   The reason a POST cannot succeed in THIS suite is now understood and is
   correct behaviour rather than a gap: this file requests the standalone
   server directly on its internal port, and `security.allowedDomains` names
   only the public origin — so the internal host cannot reconstruct a matching
   origin and Astro refuses the submission. That is the intended production
   boundary (25_SEO_AND_STRUCTURED_DATA.md and 24_PUBLIC_ENQUIRY_FORMS.md §7),
   and the test below pins it. */

test('a cross-origin POST is rejected outright by the CSRF origin check', async () => {
  /* Not something this batch added — Astro's own `security.checkOrigin` —
     but worth pinning, because the forms are the first POST surface on this
     site and a future config change that disabled it would be silent. */
  const noOrigin = await postForm('/contact/', CONTACT_FIELDS, { origin: null });
  assert.equal(noOrigin.status, 403);

  const foreign = await postForm('/contact/', CONTACT_FIELDS, { origin: 'https://evil.test' });
  assert.equal(foreign.status, 403);

  const before = mockApi!.submissions.length;
  assert.equal(mockApi!.submissions.length, before, 'a rejected POST must reach no API');
});

/* Fast-Track Phase 4: robots.txt, the XML sitemap, JSON-LD, and a scan of
   real rendered output for planted private values. The mock API's fixtures
   deliberately carry price, cost, stock, warehouse, Zoho and fact-owner
   fields the real API would never send — so anything that survives into HTML
   or JSON-LD here would survive a compromised or version-skewed upstream. */

test('robots.txt disallows everything on a non-production origin and advertises no sitemap', async () => {
  /* The harness serves on a loopback origin, which is exactly what
     looksNonProduction() is for. A staging copy inviting indexing is how it
     ends up outranking the real site, so this is the important branch to
     pin at HTTP level; the production branch is asserted at unit level in
     seo-controls.test.ts. */
  const response = await get('/robots.txt');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/);

  const body = await response.text();
  assert.match(body, /^User-agent: \*/m);
  assert.match(body, /^Disallow: \/$/m);
  assert.match(body, /Non-production origin/);
  assert.doesNotMatch(body, /Sitemap:/, 'a non-production origin must not advertise a sitemap');
  assert.doesNotMatch(body, /veyora\.(design|com)/i);
});

test('the XML sitemap is well-formed, absolute, and free of non-canonical states', async () => {
  const response = await get('/sitemap.xml');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/xml/);

  const body = await response.text();
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(body, /<\/urlset>/);

  const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 5, 'the sitemap should carry the static routes at minimum');
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${SITE_ORIGIN}/`), `not absolute: ${loc}`);
    assert.ok(!loc.includes('?'), `query state in sitemap: ${loc}`);
    assert.ok(!loc.includes('#'), `fragment in sitemap: ${loc}`);
    assert.ok(!/\/(404|500)\//.test(loc), `error route in sitemap: ${loc}`);
    assert.ok(!/\/(admin|api|s3)\//.test(loc), `private namespace in sitemap: ${loc}`);
  }
  // Published records from the mock appear alongside the static routes.
  assert.ok(locs.some((l) => l.includes('/brands/example-brand/')), 'no published brand in the sitemap');
});

test('JSON-LD is valid JSON, and breadcrumbs match the visible trail', async () => {
  const body = await (await get('/brands/example-brand/')).text();
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, 'expected at least WebSite and BreadcrumbList');

  const nodes = blocks.map((raw) => JSON.parse(raw.replace(/\\u003c/g, '<')));
  for (const node of nodes) assert.equal(node['@context'], 'https://schema.org');

  const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList');
  assert.ok(crumbs, 'no BreadcrumbList emitted');
  const names: string[] = crumbs.itemListElement.map((i: { name: string }) => i.name);
  // Every structured crumb label also appears in the rendered breadcrumb nav.
  const nav = body.slice(body.indexOf('<nav'), body.indexOf('</nav>') + 6);
  for (const name of names) assert.ok(body.includes(name), `crumb "${name}" is not visible on the page`);
  assert.ok(nav.length > 0);
});

test('product JSON-LD carries no offer, price or availability', async () => {
  const body = await (await get('/collections/example-brand/example-model/')).text();
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const nodes = blocks.map((raw) => JSON.parse(raw.replace(/\\u003c/g, '<')));

  const product = nodes.find((n) => n['@type'] === 'Product');
  assert.ok(product, 'no Product node emitted');
  assert.equal(product.name, 'Example Model');
  for (const key of ['offers', 'price', 'priceCurrency', 'availability', 'aggregateRating', 'review']) {
    assert.ok(!(key in product), `Product JSON-LD emitted "${key}"`);
  }
});

test('a noindex page emits no structured data', async () => {
  const body = await (await get('/collections/?brand=example-brand')).text();
  assert.match(body, /<meta name="robots" content="noindex, follow"/);
  assert.doesNotMatch(body, /application\/ld\+json/, 'a noindex page must not assert structured data');
});

test('no planted private value reaches rendered HTML or JSON-LD on any public route', async () => {
  const routes = [
    '/', '/brands/', '/brands/example-brand/', '/collections/',
    '/collections/sun/', '/collections/example-brand/example-model/',
    '/global-presence/', '/sitemap.xml',
  ];
  for (const route of routes) {
    const body = await (await get(route)).text();
    for (const [name, planted] of Object.entries(PLANTED_SECRETS)) {
      assert.ok(!body.includes(planted), `${route} leaked ${name} (${planted})`);
    }
    // The nested private object in the fixture must not survive either.
    assert.ok(!body.includes('"internal"'), `${route} rendered the nested internal object`);
    assert.doesNotMatch(body, /label:internal/, `${route} rendered an internal label tag`);
  }
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

test('teardown: stop the server and mock API cleanly, leaving no orphaned process', async () => {
  if (serverProcess) {
    serverProcess.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      serverProcess!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (mockApi) await mockApi.close();
});
