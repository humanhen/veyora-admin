/* Builds once with valid explicit origins, starts the standalone server
   directly (no npm/shell wrapper — see test/command-paths.test.ts for why
   that matters on Windows), and requests a representative set of the 25
   routes. Node's test runner executes top-level tests within this file
   sequentially by default, so the build below is guaranteed to finish
   before the server-start test runs.

   This proves the route SHAPE (200, HTML, one H1, header/footer present,
   reachable by direct request with no hash routing) for B1.2. It does not
   and cannot prove final route behaviour: arbitrary dynamic slugs
   returning 200 here is temporary skeleton behaviour, not the real
   publication/404 logic deferred to B2/B4 — see routes.test.ts and
   09_FIRST_BUILD_PACKAGE.md's B1.2 result. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_PORT = 4320; // distinct from other suites' ports and dev defaults

const ENV = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(TEST_PORT),
  PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4321',
  PORTAL_ORIGIN: 'http://127.0.0.1:4322',
} as const;

function buildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...ENV };
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
  test(`direct request to ${route} returns 200 HTML with one H1 and header/footer`, async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}${route}`);
    assert.equal(response.status, 200, `${route} did not return 200`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);

    const body = await response.text();
    const h1Count = (body.match(/<h1[ >]/g) ?? []).length;
    assert.equal(h1Count, 1, `${route} rendered ${h1Count} <h1> elements`);
    assert.match(body, /class="site-header"/, `${route} is missing the header`);
    assert.match(body, /class="site-footer"/, `${route} is missing the footer`);
    // No hash-routed navigation — every link found is a real path.
    assert.doesNotMatch(body, /href="#\//, `${route} contains a #/ link`);
  });
}

test('teardown: stop the server cleanly', async () => {
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
