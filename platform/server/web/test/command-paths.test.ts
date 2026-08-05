/* Exercises the REAL `npm run build` and `npm run start` command paths via
   child-process environment injection — not just the resolveEnv() unit
   tested in env.test.ts. That pure-function test proves the validation
   logic is correct; this file proves it is actually wired into the
   commands an operator (or the Dockerfile) runs.

   All tests in this file share one file-scoped ordering guarantee: Node's
   test runner executes top-level tests within a single file sequentially,
   in declaration order, by default. The build tests run first and the
   final one produces a real `dist/`, which the startup tests then reuse —
   this is why build and startup assertions live in one file rather than
   two: splitting them would let node:test's cross-file parallelism start a
   startup test before (or while) a build test is writing dist/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// A port distinct from the documented dev defaults (4321/4322), so this
// suite never collides with a developer's own `astro dev` instance.
const TEST_PORT = 4319;

function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

function runNpm(args: string[], overrides: Record<string, string | undefined>) {
  return spawnSync('npm', args, {
    cwd: root,
    env: buildEnv(overrides),
    shell: true,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

function spawnNpmStart(overrides: Record<string, string | undefined>) {
  return spawn('npm', ['run', 'start'], {
    cwd: root,
    env: buildEnv(overrides),
    shell: true,
  });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitUntilPortOpen(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---------- build ----------

test('production build rejects missing PUBLIC_SITE_ORIGIN', () => {
  const result = runNpm(['run', 'build'], {
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: undefined,
    PORTAL_ORIGIN: 'http://127.0.0.1:4322',
    // B2.3: a third origin is now required in production.
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4399',
  });
  assert.notEqual(result.status, 0, 'build must exit non-zero');
  assert.match(result.stdout + result.stderr, /PUBLIC_SITE_ORIGIN/);
});

test('production build rejects missing PORTAL_ORIGIN', () => {
  const result = runNpm(['run', 'build'], {
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4321',
    PORTAL_ORIGIN: undefined,
  });
  assert.notEqual(result.status, 0, 'build must exit non-zero');
  assert.match(result.stdout + result.stderr, /PORTAL_ORIGIN/);
});

test('production build rejects a malformed, non-HTTP(S) origin', () => {
  const result = runNpm(['run', 'build'], {
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'not-a-url',
    PORTAL_ORIGIN: 'http://127.0.0.1:4322',
    // B2.3: a third origin is now required in production.
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4399',
  });
  assert.notEqual(result.status, 0, 'build must exit non-zero');
  assert.match(result.stdout + result.stderr, /PUBLIC_SITE_ORIGIN/);
});

test('production build succeeds with every required origin supplied', () => {
  const result = runNpm(['run', 'build'], {
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4321',
    PORTAL_ORIGIN: 'http://127.0.0.1:4322',
    // B2.3: a third origin is now required in production.
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4399',
  });
  assert.equal(result.status, 0, `build must succeed. output:\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    fs.existsSync(path.join(root, 'dist/server/entry.mjs')),
    'a successful build must produce the standalone server entrypoint'
  );
});

// ---------- entrypoint wiring (static) ----------

test('package.json build and start scripts run the validated entrypoint', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.build, /scripts\/validate-env\.mjs/, 'build script must run the env gate first');
  assert.match(pkg.scripts.start, /scripts\/validate-env\.mjs/, 'start script must run the env gate first');
});

test('Dockerfile CMD runs the validated entrypoint, not a bare node call', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const cmdLine = dockerfile.match(/^CMD .*$/m);
  assert.ok(cmdLine, 'no CMD instruction found');
  assert.match(cmdLine![0], /validate-env\.mjs/, 'CMD must invoke the env gate');
  assert.match(cmdLine![0], /entry\.mjs/, 'CMD must still start the standalone server after the gate');
});

// ---------- startup (uses the dist/ produced by the build test above) ----------

test('production startup rejects missing PUBLIC_SITE_ORIGIN before listening', async () => {
  const child = spawnNpmStart({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(TEST_PORT),
    PUBLIC_SITE_ORIGIN: undefined,
    PORTAL_ORIGIN: 'http://127.0.0.1:4322',
    // B2.3: a third origin is now required in production.
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4399',
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += String(d)));
  child.stderr?.on('data', (d) => (output += String(d)));

  const code = await waitForExit(child);
  assert.notEqual(code, 0, 'startup must exit non-zero');
  assert.doesNotMatch(output, /listening/i, 'the server must never report listening');
  assert.match(output, /PUBLIC_SITE_ORIGIN/);
  assert.equal(await portInUse(TEST_PORT), false, 'the port must never open on a rejected startup');
});

test('production startup rejects missing PORTAL_ORIGIN before listening', async () => {
  const child = spawnNpmStart({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(TEST_PORT),
    PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4321',
    PORTAL_ORIGIN: undefined,
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += String(d)));
  child.stderr?.on('data', (d) => (output += String(d)));

  const code = await waitForExit(child);
  assert.notEqual(code, 0, 'startup must exit non-zero');
  assert.doesNotMatch(output, /listening/i, 'the server must never report listening');
  assert.match(output, /PORTAL_ORIGIN/);
  assert.equal(await portInUse(TEST_PORT), false, 'the port must never open on a rejected startup');
});

test('production startup succeeds with valid explicit origins and serves /healthz', async () => {
  const overrides = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(TEST_PORT),
    PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4321',
    PORTAL_ORIGIN: 'http://127.0.0.1:4322',
    // B2.3: a third origin is now required in production.
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4399',
  };
  const env = buildEnv(overrides);

  // Two direct `node` invocations, not `npm run start` through a shell: on
  // Windows, spawning "npm run start" with shell:true and then killing the
  // returned handle only terminates the outer cmd.exe/npm.cmd wrapper — the
  // actual `node dist/server/entry.mjs` process (a grandchild) is left
  // running, still holding the port and its stdio pipes, which then keeps
  // this test file's own worker process alive indefinitely (an observed
  // hang in this suite's first run). Running the exact same two commands
  // package.json's "start" script chains — the env gate, then the server —
  // without the shell in between gives back the real server PID, so kill()
  // in the `finally` below actually frees the port.
  const gate = spawnSync('node', ['./scripts/validate-env.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(gate.status, 0, `env gate must pass for a valid, explicit configuration. output:\n${gate.stdout}${gate.stderr}`);

  const server = spawn('node', ['./dist/server/entry.mjs'], { cwd: root, env });
  let output = '';
  server.stdout?.on('data', (d) => (output += String(d)));
  server.stderr?.on('data', (d) => (output += String(d)));

  try {
    const up = await waitUntilPortOpen(TEST_PORT);
    assert.ok(up, `server never started listening. output so far:\n${output}`);

    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    const body = await response.json();
    assert.equal(body.ok, true);
  } finally {
    server.kill();
    await waitForExit(server, 5_000).catch(() => {
      /* best-effort cleanup */
    });
  }
});
