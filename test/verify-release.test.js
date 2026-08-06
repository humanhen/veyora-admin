/* The release verification command itself (Fast-Track WS2 Phase 3).

   A verification command is a control, and an untested control is a claim.
   These tests cover the properties that make it one: that it contacts nothing,
   that it fails non-zero, that it cannot be quietly narrowed, and that it runs
   the same way on Windows as anywhere else.

   The expensive gates are not re-run here — they are the suites this file is
   part of. What is asserted is the harness. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers/dom.js');

const SCRIPT = path.join(ROOT, 'scripts', 'verify-release.mjs');
const source = fs.readFileSync(SCRIPT, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const code = stripComments(source);

const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, shell: false, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const gateNames = () =>
  run('--list').stdout.trim().split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean);

// ---------------------------------------------------------------------------
// it exists and is discoverable
// ---------------------------------------------------------------------------

test('the command runs from the repository root and lists its gates', () => {
  const r = run('--list');
  assert.equal(r.status, 0);
  const names = gateNames();
  assert.ok(names.length >= 12, `expected a full gate list, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'gate names must be unique');
});

test('every gate the brief names is present', () => {
  const names = gateNames();
  for (const required of [
    'diff-check',            // git diff --check
    'merge-markers',
    'secret-and-host-scan',
    'api-suite', 'admin-frontend-suite', 'web-suite',
    'deployment-config',
    'forbidden-data', 'forbidden-data-rendered',
    'json-ld',
    'env-validation',
    'astro-build',
    'catalogue-chain',
    'deploy-payload',
  ]) {
    assert.ok(names.includes(required), `missing gate: ${required}`);
  }
});

test('--help explains itself and exits zero', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /verify-release/);
  assert.match(r.stdout, /contacts no production system/i);
});

// ---------------------------------------------------------------------------
// it fails, and fails loudly
// ---------------------------------------------------------------------------

test('an unknown gate name is refused rather than silently skipped', () => {
  const r = run('not-a-gate');
  assert.notEqual(r.status, 0, 'an unknown gate must not exit zero');
  assert.match(r.stderr, /unknown gate/i);
});

test('a failing gate sets a non-zero exit code', () => {
  /* Driven through the real harness by pointing it at a gate that must fail:
     `git diff --check` cannot be made to fail on demand without dirtying the
     tree, so this asserts the mechanism instead — the exit path exists, is
     unconditional, and is reached from the failure branch. */
  assert.match(code, /if \(failed\) \{[\s\S]*process\.exit\(1\)/, 'a failing run must exit 1');
  assert.match(code, /RELEASE VERIFICATION FAILED/);
  assert.match(code, /failed \+= 1/);
});

test('gates keep running after a failure unless --fail-fast is given', () => {
  assert.match(code, /if \(!outcome\.ok\) \{\s*failed \+= 1;\s*if \(FAIL_FAST\) break;/);
});

test('a gate that throws is a failure, not a crash', () => {
  assert.match(code, /catch \(err\) \{\s*outcome = \{ ok: false/);
});

// ---------------------------------------------------------------------------
// it contacts nothing
// ---------------------------------------------------------------------------

test('the command spawns only node and git — nothing that could reach a host', () => {
  /* The definitive check: enumerate what is actually executed. `ssh` appears
     in this file's source exactly once, inside a regular expression that
     PARSES deploy.sh to learn its payload list — reading the deploy script is
     not running it, and this assertion is what tells the two apart. */
  const commands = [...code.matchAll(/spawnSync\(\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(commands.length >= 2, 'expected spawnSync calls to inspect');
  for (const command of commands) {
    assert.ok(
      command === 'process.execPath' || command === "'git'",
      `verify-release spawns something other than node or git: ${command}`
    );
  }
});

test('the command reaches no network and no database', () => {
  /* Production hostnames are deliberately NOT on this list: the script
     contains them as scan PATTERNS, because finding them is its job. What
     matters is that it has no way to reach one — no HTTP client, no socket,
     no database driver, no connection string. */
  for (const forbidden of [
    /\bfetch\(/, /node:https?['"]/, /require\(['"]https?['"]\)/, /node:net['"]/,
    /node:dns['"]/, /new\s+(?:WebSocket|XMLHttpRequest)/,
    /DATABASE_URL/, /from ['"]pg['"]/, /\bconnect\(/,
  ]) {
    assert.ok(!forbidden.test(code), `verify-release must not reference ${forbidden}`);
  }
});

test('it deploys nothing and mutates no deployment target', () => {
  for (const forbidden of [/\bup -d\b/, /--build\b/, /\bdown -v\b/, /volume\s+rm/, /\bprune\b/]) {
    assert.ok(!forbidden.test(code), `verify-release must not run ${forbidden}`);
  }
  /* It reads deploy.sh to learn the payload list; it must never execute it. */
  assert.ok(!/spawnSync\(\s*['"]sh['"]/.test(code));
  assert.ok(!/deploy\.sh['"]\s*\]/.test(code.replace(/path\.join\(SERVER, 'deploy\.sh'\)/g, '')));
});

// ---------------------------------------------------------------------------
// it runs on Windows
// ---------------------------------------------------------------------------

test('every spawn is shell-free with array arguments', () => {
  const spawns = [...code.matchAll(/spawnSync\([\s\S]{0,240}?\)/g)].map((m) => m[0]);
  assert.ok(spawns.length >= 2, 'expected spawnSync calls to inspect');
  for (const call of spawns) {
    assert.match(call, /shell:\s*false/, `a spawn without shell:false: ${call.slice(0, 80)}`);
  }
  assert.ok(!/shell:\s*true/.test(code));
});

test('no npm shim and no POSIX-only path is used', () => {
  /* `&&` and `||` are deliberately NOT checked: they are JavaScript operators
     here, not shell ones, and every spawn already passes shell:false with an
     argument array — so there is no string for a shell to interpret. */
  for (const forbidden of [/'npm'/, /"npm"/, /npm\.cmd/, /\bnpx\b/, /'\/tmp\//, /\/dev\/null/, /\bC:\\\\/]) {
    assert.ok(!forbidden.test(code), `not portable: ${forbidden}`);
  }
  // Node is invoked through the running interpreter, not by name.
  assert.match(code, /spawnSync\(process\.execPath/);
  assert.ok(!/spawnSync\(\s*['"]node['"]/.test(code));
});

test('temporary files go to the OS temp directory, not a hard-coded path', () => {
  assert.match(code, /os\.tmpdir\(\)/);
  assert.match(code, /mkdtempSync/);
  assert.match(code, /rmSync\([^)]*recursive: true/, 'the temp directory must be cleaned up');
});

// ---------------------------------------------------------------------------
// the exception list is a pin, not a mute
// ---------------------------------------------------------------------------

/* Read as source rather than imported: the script is a CLI that runs its
   gates and calls process.exit() on load, so importing it here would end the
   test process. Its runtime behaviour is covered by actually running it, in
   the end-to-end tests below. */
test('every declared host exception carries a written reason', () => {
  const block = source.slice(source.indexOf('const HOST_EXCEPTIONS'), source.indexOf("gate('secret-and-host-scan'"));
  const entries = [...block.matchAll(/\{\s*file:/g)];
  assert.ok(entries.length >= 5, 'expected the declared exceptions to be present');
  assert.equal(
    (block.match(/reason:/g) ?? []).length, entries.length,
    'every exception must carry a reason'
  );
});

test('a stale exception fails the gate rather than lingering', () => {
  assert.match(code, /stale exception/);
  assert.match(code, /stale\.length/);
});

test('the exception list cannot be widened into a blanket skip', () => {
  const block = source.slice(source.indexOf('const HOST_EXCEPTIONS'), source.indexOf("gate('secret-and-host-scan'"));
  // Each exception pins ONE file and ONE pattern. No directory prefixes, no
  // catch-alls, no bare /.*/ pattern.
  assert.ok(!/file:\s*['"][^'"]*\*/.test(block), 'an exception must name an exact file');
  assert.ok(!/pattern:\s*\/\.\*\//.test(block), 'a catch-all pattern is not an exception');
});

test('open release blockers are reported by register id, not hidden', () => {
  assert.match(code, /blocker/);
  const r = run('secret-and-host-scan');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /declared exception \[R-01\]/, 'R-01 consequences must be named on every run');
  assert.match(r.stdout, /open release blockers/);
});

// ---------------------------------------------------------------------------
// the cheap gates actually work end to end
// ---------------------------------------------------------------------------

test('the whitespace, merge-marker and payload gates pass on this tree', () => {
  const r = run('diff-check', 'merge-markers', 'deploy-payload');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /3\/3 gates passed/);
  assert.match(r.stdout, /nothing shipped/, 'the payload gate must state that it shipped nothing');
});

test('the payload gate reads deploy.sh rather than keeping a second copy of the list', () => {
  assert.match(code, /deploy\.sh/);
  assert.match(code, /tar czf - /, 'the file list must be parsed out of deploy.sh');
  /* If it kept its own list, removing a file from deploy.sh would leave the
     gate green while the deploy was broken. */
  const r = run('deploy-payload');
  assert.match(r.stdout, /payload entries present/);
});

test('the payload gate refuses a compose file that no longer defaults to the live Caddyfile', () => {
  assert.ok(code.includes('CADDYFILE:-'), 'the gate must check the compose default');
  assert.match(code, /no longer defaults to the live Caddyfile/);
});
