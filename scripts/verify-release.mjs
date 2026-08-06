#!/usr/bin/env node
/* THE release verification command (Fast-Track WS2 Phase 3).
 *
 *   node scripts/verify-release.mjs
 *
 * One command, run from the repository root, that executes every automated
 * control this release has. It is the thing a person runs before proposing a
 * merge and the thing CI would run if CI existed — see §5 of
 * docs/public-website-rebuild/28_RELEASE_QUALITY_GATES.md for why "would".
 *
 * FOUR PROPERTIES, EACH LOAD-BEARING
 *
 *   1. IT NEVER CONTACTS PRODUCTION. No ssh, no deploy, no database, no
 *      network call to any Veyora host. Every gate reads local files or runs a
 *      local process. The deploy-payload gate assembles the file list
 *      `deploy.sh` would ship and then stops.
 *
 *   2. IT FAILS NON-ZERO. Any failing gate sets the exit code to 1. Gates keep
 *      running after a failure by default, because a release check that stops
 *      at the first problem makes you run it five times to find five problems;
 *      `--fail-fast` restores the other behaviour.
 *
 *   3. IT RUNS ON WINDOWS. Everything is spawned through `process.execPath` or
 *      `git` with `shell: false` and array arguments. No `npm run`, no shell
 *      operators, no POSIX path assumptions, no `.cmd` shims — those are the
 *      three ways a verification script becomes "works on the author's
 *      machine".
 *
 *   4. ITS EXCEPTIONS ARE DECLARED, NOT TUNED. The host and secret scan carries
 *      an explicit allowlist with a written reason per entry, and prints every
 *      exception it applied on every run. A gate quietly narrowed until it
 *      passes is worse than no gate; one that says out loud what it is
 *      ignoring is a control.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, 'platform', 'server');
const API = path.join(SERVER, 'api');
const WEB = path.join(SERVER, 'web');

const args = new Set(process.argv.slice(2));
const FAIL_FAST = args.has('--fail-fast');
const ONLY = [...args].filter((a) => !a.startsWith('--'));

if (args.has('--help') || args.has('-h')) {
  process.stdout.write(`
verify-release — every automated control this release has, in one command

USAGE
  node scripts/verify-release.mjs [gate ...] [--fail-fast] [--list]

  With no gate names, every gate runs. Naming gates runs only those, which is
  for iterating on one failure — a release decision needs the full run.

OPTIONS
  --fail-fast   Stop at the first failing gate (default: run them all).
  --list        Print the gate names and exit.
  --help, -h    This text.

It contacts no production system, no VPS, no database and no network host.
`);
  process.exit(0);
}

/* ---------------------------------------------------------------------------
   Reporting
   --------------------------------------------------------------------------- */

const results = [];
const startedAt = Date.now();

function heading(text) {
  process.stdout.write(`\n=== ${text} ${'='.repeat(Math.max(0, 66 - text.length))}\n`);
}
const info = (text) => process.stdout.write(`    ${text}\n`);

/* ---------------------------------------------------------------------------
   Process helpers — array args, shell:false, always cross-platform
   --------------------------------------------------------------------------- */

/** Runs node with the given arguments. Never a shell, never an npm shim. */
function node(cwd, argv, { env = {}, quiet = false } = {}) {
  const result = spawnSync(process.execPath, argv, {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!quiet && result.stdout) process.stdout.write(indent(tailLines(result.stdout, 12)));
  if (result.stderr && result.status !== 0) process.stdout.write(indent(tailLines(result.stderr, 12)));
  return result;
}

function git(argv) {
  return spawnSync('git', argv, { cwd: ROOT, shell: false, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

const indent = (text) => text.split('\n').map((l) => (l ? `    | ${l}` : '')).join('\n') + '\n';
const tailLines = (text, n) => {
  const lines = text.trimEnd().split('\n');
  return lines.length <= n ? lines.join('\n') : ['…', ...lines.slice(-n)].join('\n');
};

/** Pulls node:test's summary out of TAP output so a gate reports counts. */
function testCounts(stdout) {
  const pick = (key) => {
    const m = stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

/* ---------------------------------------------------------------------------
   Tracked-file inventory — git is the authority on what is in the repository,
   so node_modules, dist and untracked scratch files are excluded for free.
   --------------------------------------------------------------------------- */

const trackedFiles = (() => {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
})();

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.zip', '.gz', '.mp4', '.webm']);

function readTracked(file) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return null;
  const full = path.join(ROOT, file);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    /* Line endings normalised on read. These files are edited on Windows and
       deployed to Linux, so a pattern written with \n must still match a file
       git checked out with \r\n. */
    return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   The gates
   --------------------------------------------------------------------------- */

const GATES = [];
const gate = (name, description, run) => GATES.push({ name, description, run });

/* ---- 1. whitespace ---- */
gate('diff-check', 'git diff --check finds no whitespace error', () => {
  const r = git(['diff', '--check']);
  if (r.status !== 0 || r.stdout.trim()) {
    return { ok: false, detail: r.stdout.trim() || 'git diff --check reported an error' };
  }
  const staged = git(['diff', '--cached', '--check']);
  if (staged.status !== 0 || staged.stdout.trim()) {
    return { ok: false, detail: staged.stdout.trim() || 'staged changes have whitespace errors' };
  }
  return { ok: true, detail: 'working tree and index are clean of whitespace errors' };
});

/* ---- 2. merge markers ---- */
gate('merge-markers', 'no conflict marker survives in a tracked file', () => {
  if (!trackedFiles) return { ok: false, detail: 'git ls-files failed — is this a repository?' };
  /* Anchored to the start of a line and requiring the full seven characters:
     a shorter or mid-line run appears legitimately in diffs, documentation and
     regular expressions. `=======` alone is excluded deliberately — it is a
     markdown heading underline, and flagging it would train people to ignore
     this gate. */
  const MARKER = /^(<{7}|>{7})(\s|$)/m;
  const hits = [];
  for (const file of trackedFiles) {
    if (file === path.posix.join('scripts', 'verify-release.mjs')) continue; // this file describes them
    const text = readTracked(file);
    if (text && MARKER.test(text)) hits.push(file);
  }
  return hits.length
    ? { ok: false, detail: `conflict markers in:\n${hits.map((f) => `  ${f}`).join('\n')}` }
    : { ok: true, detail: `${trackedFiles.length} tracked files scanned` };
});

/* ---- 3. secrets and production hostnames ---- */

/* The artefacts that are BUILT AND SHIPPED. A production hostname or a secret
   in one of these is a release defect; the same string in a document is
   documentation. Scoping the scan is what makes it enforceable rather than
   permanently red. */
const SHIPPED_PREFIXES = [
  'platform/server/web/src/', 'platform/server/web/scripts/', 'platform/server/web/astro.config.mjs',
  'platform/server/Caddyfile', 'platform/server/docker-compose.yml', 'platform/server/.env.example',
  'platform/server/api/src/', 'js/', 'css/', 'index.html',
];

/* Declared exceptions, each with a written reason and, where the occurrence is
   a known release blocker, the register item it belongs to.
 *
 * This list is a PIN, not a mute. Every entry is printed on every run, so
 * nobody has to read this file to know what the gate is ignoring, and anything
 * NOT on it fails the gate — so the set can only shrink deliberately. Several
 * of these are R-01's consequences: after the catch-all cutover, a link built
 * from a `veyora.design` fallback lands on the public site instead of the
 * portal. Fixing them is supervised work with live-email blast radius, which
 * is why they are pinned and reported rather than edited in an unattended run.
 */
const HOST_EXCEPTIONS = [
  {
    file: 'platform/server/docker-compose.yml',
    pattern: /SMTP_FROM:\s*\$\{SMTP_FROM:-Veyora <info@veyora\.com>\}/g,
    reason: 'pre-existing transactional-email sender fallback; changing it unattended could alter '
      + 'live sender identity (26_RELEASE_DEPLOYMENT_ARCHITECTURE.md §10)',
  },
  {
    file: 'platform/server/api/src/mail.js',
    pattern: /process\.env\.SMTP_FROM \|\| 'Veyora <info@veyora\.com>'/g,
    reason: 'the same sender fallback, in the code the compose default feeds',
  },
  /* The three R-01 link fallbacks that used to live here — in authmw.js,
     emails.js and routes/catalog.js — are GONE, not muted. Every one of them
     now builds its URL from the explicit origin contract in src/origins.js
     (finding SEC-004, Security Hardening Phase 1), so there is nothing left to
     except. The stale-exception rule below is what surfaced their removal:
     when the fix landed, the gate failed until the pins were deleted, which is
     exactly the behaviour a pin list should have. */
  {
    file: 'platform/server/docker-compose.yml',
    pattern: /\$\{PUBLIC_URL:-http:\/\/209\.46\.125\.226\}/g,
    reason: 'pre-existing bare-IP fallback for the deprecated PUBLIC_URL. Left alone deliberately: '
      + 'an existing .env always sets PUBLIC_URL (deploy.sh writes it on first run), so this default '
      + 'is unreachable in practice, and changing a live deployment default unattended is the kind '
      + 'of edit that breaks a server nobody is watching',
  },
  /* Comments and sample text. Not shipped behaviour, but pinned so the set
     stays closed and a new occurrence still fails. */
  {
    file: 'platform/server/Caddyfile',
    pattern: /# Serves on port 80 for IP access; when DOMAIN is set \(veyora\.design\) Caddy/g,
    reason: 'explanatory comment in the live routing file, which this release does not edit',
  },
  {
    file: 'platform/server/.env.example',
    pattern: /DOMAIN=veyora\.design[\s\S]{0,400}?PUBLIC_URL=https:\/\/veyora\.design/g,
    reason: 'pre-existing example values for the two variables that predate this release; every '
      + 'variable added since uses example.test, and PUBLIC_URL is now marked deprecated here',
  },
  {
    file: 'platform/server/api/src/emails.js',
    pattern: /Mirrors the old veyora\.com transactional look/g,
    reason: 'explanatory comment',
  },
  {
    file: 'platform/server/api/src/routes/catalog.js',
    pattern: /veyora\.design\/#\/list\/<slug>/g,
    reason: 'explanatory comment describing the legacy hash URL shape',
  },
  {
    file: 'platform/server/api/src/zoho.js',
    pattern: /`veyora\.design order \$\{o\.number\}`/g,
    reason: 'a human-readable label written into a Zoho note; not a URL and not routable',
  },
  {
    file: 'js/pages_customers.js',
    pattern: /https:\/\/veyora\.com\/activate\/…/g,
    reason: 'sample text in an email-template preview inside the admin panel',
  },
];

gate('secret-and-host-scan', 'no secret or production hostname in a shipped artefact', () => {
  if (!trackedFiles) return { ok: false, detail: 'git ls-files failed' };

  const HOSTS = [
    /\bveyora\.design\b/i, /\bveyora\.com\b/i, /\bveyora-vps\b/i, /\bwww\.veyora\./i,
    /* A bare routable IPv4 address is a production host by another name, and
       the name-based patterns above cannot see it. Loopback, link-local and
       the three RFC-1918 private ranges are excluded: they are legitimate in
       config and tests. This caught a real one — the compose fallback for the
       deprecated PUBLIC_URL — which the name patterns had missed entirely. */
    /\b(?!0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|255\.)(?:\d{1,3}\.){3}\d{1,3}\b/,
  ];
  /* Secret SHAPES, not secret names: an assignment of a long opaque literal to
     something called a secret/key/token/password. `${VAR}`, `${VAR:?}` and
     `process.env.X` are references, not secrets, and are not matched. */
  const SECRETS = [
    /\b(?:jwt_?secret|db_?password|api_?key|secret_?key|access_?token|private_?key)\s*[:=]\s*['"][^'"$\n]{12,}['"]/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];

  const violations = [];
  const applied = [];
  const scanned = [];

  for (const file of trackedFiles) {
    if (!SHIPPED_PREFIXES.some((p) => file === p || file.startsWith(p))) continue;
    let text = readTracked(file);
    if (text === null) continue;
    scanned.push(file);

    for (const exception of HOST_EXCEPTIONS) {
      if (exception.file === file && exception.pattern.test(text)) {
        applied.push(exception);
        text = text.replace(exception.pattern, ' [declared exception] ');
      }
    }

    for (const host of HOSTS) {
      const m = text.match(host);
      if (m) violations.push(`${file}: production hostname ${m[0]}`);
    }
    for (const secret of SECRETS) {
      if (secret.test(text)) violations.push(`${file}: literal that looks like a credential`);
    }
  }

  for (const e of applied) {
    info(`declared exception${e.blocker ? ` [${e.blocker}]` : ''} — ${e.file}: ${e.reason}`);
  }
  /* An exception that no longer matches anything has been fixed, and leaving
     it here would keep a hole open for whatever lands at that path next. */
  const stale = HOST_EXCEPTIONS.filter((e) => !applied.includes(e));
  if (stale.length) {
    return {
      ok: false,
      detail: stale.map((e) => `  stale exception (no longer matches — delete it): ${e.file} — ${e.reason}`).join('\n'),
    };
  }
  const blockers = applied.filter((e) => e.blocker);
  return violations.length
    ? { ok: false, detail: violations.map((v) => `  ${v}`).join('\n') }
    : {
        ok: true,
        detail: `${scanned.length} shipped artefacts scanned; ${applied.length} declared exception(s), `
          + `${blockers.length} of them open release blockers (${[...new Set(blockers.map((b) => b.blocker))].join(', ') || 'none'})`,
      };
});

/* ---- 4-6. the three test suites ---- */

function suiteGate(name, description, cwd, argv) {
  gate(name, description, () => {
    const r = node(cwd, argv, { env: { NODE_ENV: 'test' }, quiet: true });
    const counts = testCounts(r.stdout);
    if (r.status !== 0) {
      const failures = r.stdout.split('\n').filter((l) => l.startsWith('not ok')).slice(0, 20);
      return { ok: false, detail: [`${counts.fail ?? '?'} failing`, ...failures.map((f) => `  ${f}`)].join('\n') };
    }
    return { ok: true, detail: `${counts.pass ?? '?'} passing, ${counts.fail ?? 0} failing` };
  });
}

suiteGate('api-suite', 'the API suite passes', API, ['--test', 'test/*.test.js']);
suiteGate('admin-frontend-suite', 'the root admin panel suite passes', ROOT, ['--test', 'test/*.test.js']);
suiteGate('web-suite', 'the Astro site suite passes', WEB, ['--test', '--test-concurrency=1', 'test/**/*.test.ts']);

/* ---- 7-9. named controls, run again on their own ----
   These files already run inside the suites above. They are run again by name
   so the report says which CONTROL passed, not just that 1,691 assertions did.
   A release conversation is about "did the forbidden-data scan pass", and a
   number that only appears inside a total cannot answer that. */

suiteGate('deployment-config', 'the deployment configuration is valid',
  API, ['--test', 'test/deployment-config.test.js']);

suiteGate('forbidden-data', 'no commercial, stock or customer data can reach a public surface',
  API, ['--test', 'test/public-serialize.test.js', 'test/public-forbidden-keys.test.js',
        'test/public-router.test.js', 'test/admin-public-serialize.test.js']);

suiteGate('forbidden-data-rendered', 'no planted secret survives into rendered HTML',
  WEB, ['--test', '--test-concurrency=1', 'test/public-render.test.ts', 'test/public-types.test.ts']);

suiteGate('json-ld', 'structured data carries no forbidden key and no commercial fact',
  WEB, ['--test', '--test-concurrency=1', 'test/seo-controls.test.ts', 'test/seo.test.ts', 'test/indexing.test.ts']);

/* Drives a real headless browser at 375/768/1280 over the production server.
   Skips cleanly — and still exits zero — on a machine with no Chrome or Edge,
   which is why the gate reports "passing" rather than "browser verified". */
suiteGate('accessibility-responsive', 'the site passes the a11y and responsive audit at 375/768/1280',
  WEB, ['--test', '--test-concurrency=1', 'test/accessibility-responsive.test.ts']);

/* ---- 10. environment validation ---- */

const GOOD_ENV = {
  NODE_ENV: 'production',
  PUBLIC_API_ORIGIN: 'http://127.0.0.1:3000',
  PUBLIC_SITE_ORIGIN: 'https://site.example.test',
  PORTAL_ORIGIN: 'https://portal.example.test',
};

gate('env-validation', 'the environment contract accepts a valid env and rejects a broken one', () => {
  const validator = ['./scripts/validate-env.mjs'];
  const cases = [
    { name: 'a complete, valid environment', env: GOOD_ENV, expect: 0 },
    { name: 'PUBLIC_SITE_ORIGIN absent', env: { ...GOOD_ENV, PUBLIC_SITE_ORIGIN: '' }, expect: 1 },
    { name: 'PORTAL_ORIGIN absent', env: { ...GOOD_ENV, PORTAL_ORIGIN: '' }, expect: 1 },
    { name: 'PUBLIC_SITE_ORIGIN not a URL', env: { ...GOOD_ENV, PUBLIC_SITE_ORIGIN: 'not-a-url' }, expect: 1 },
    { name: 'PUBLIC_SITE_ORIGIN a wildcard', env: { ...GOOD_ENV, PUBLIC_SITE_ORIGIN: 'https://*.example.test' }, expect: 1 },
  ];
  const failures = [];
  for (const c of cases) {
    const r = node(WEB, validator, { env: c.env, quiet: true });
    const got = r.status === 0 ? 0 : 1;
    if (got !== c.expect) {
      failures.push(`  ${c.name}: expected ${c.expect ? 'rejection' : 'acceptance'}, got the opposite`);
    }
  }
  return failures.length
    ? { ok: false, detail: failures.join('\n') }
    : { ok: true, detail: `${cases.length} environment cases behaved as specified` };
});

/* ---- 11. production build ---- */

gate('astro-build', 'the public site builds for production', () => {
  const astro = path.join(WEB, 'node_modules', 'astro', 'astro.js');
  if (!fs.existsSync(astro)) {
    return { ok: false, detail: 'astro is not installed — run npm ci in platform/server/web' };
  }
  const r = node(WEB, [astro, 'build'], { env: GOOD_ENV, quiet: true });
  if (r.status !== 0) return { ok: false, detail: tailLines(r.stderr || r.stdout, 20) };
  const entry = path.join(WEB, 'dist', 'server', 'entry.mjs');
  if (!fs.existsSync(entry)) return { ok: false, detail: 'the build produced no dist/server/entry.mjs' };
  return { ok: true, detail: `built, ${dirSizeMb(path.join(WEB, 'dist'))} MB in dist/` };
});

/* ---- 12. the built output ---- */

gate('build-output-scan', 'the built site embeds no production hostname and no planted secret', () => {
  const dist = path.join(WEB, 'dist');
  if (!fs.existsSync(dist)) return { ok: false, detail: 'no dist/ — the build gate must run first' };

  /* The rendered-HTML and JSON-LD forbidden-data scans live in the web suite,
     where a mock API can plant adversarial values. This gate is the different
     question: did a hostname or a credential get BAKED INTO the artefact — the
     one thing a test against a mock cannot see, because the value would come
     from the build, not from the API. */
  const HOSTS = [/\bveyora\.design\b/i, /\bveyora\.com\b/i, /\bveyora-vps\b/i];
  const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/;
  const violations = [];
  let files = 0;

  for (const file of walk(dist)) {
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      if (fs.statSync(file).size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    files += 1;
    const rel = path.relative(ROOT, file);
    for (const host of HOSTS) {
      const m = text.match(host);
      if (m) violations.push(`  ${rel}: ${m[0]}`);
    }
    if (SECRET.test(text)) violations.push(`  ${rel}: literal that looks like a credential`);
  }
  return violations.length
    ? { ok: false, detail: violations.slice(0, 20).join('\n') }
    : { ok: true, detail: `${files} built files scanned` };
});

/* ---- 13. the catalogue chain ---- */

gate('catalogue-chain', 'the audit → plan chain runs offline and emits no executable SQL', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-verify-'));
  try {
    const failures = [];

    /* Every CLI must refuse to run with no arguments. A tool that defaults to
       "do something" is how a dry-run planner becomes a live one. */
    for (const script of ['audit-public-catalogue.js', 'export-public-catalogue.js', 'build-reviewed-plan.js']) {
      const r = node(API, [path.join('scripts', script)], { quiet: true });
      if (r.status === 0) failures.push(`  ${script} ran with no arguments instead of refusing`);
      const help = node(API, [path.join('scripts', script), '--help'], { quiet: true });
      if (help.status !== 0) failures.push(`  ${script} --help exited ${help.status}`);
    }

    /* A minimal, entirely synthetic export. No real catalogue data is read at
       any point — this fixture is invented here and thrown away below. */
    const exportFile = path.join(work, 'export.json');
    fs.writeFileSync(exportFile, JSON.stringify({
      exportedAt: '2026-08-06T00:00:00.000Z',
      source: 'verify-release synthetic fixture',
      brands: [{ id: 'brand_1', slug: 'example-brand', name: 'Example Brand',
                 publicationState: 'draft', verificationStatus: 'unverified', hasSourceReference: false }],
      products: [{ id: 'prod_1', sku: 'EX-001', name: 'Example Model', brand: 'Example Brand',
                   brandId: 'brand_1', categories: [], line: '', shape: '', segment: '',
                   publicSlug: '', hasPublicDescription: false, isActive: true, isPublished: false,
                   isFeatured: false, isDiscontinued: false, replacementProductId: null,
                   publicationState: 'draft', verificationStatus: 'unverified',
                   hasSourceReference: false, lastReviewedAt: null, scheduledReviewAt: null,
                   contentUpdatedAt: null }],
      variations: [{ id: 'var_1', productId: 'prod_1', sku: 'EX-001-BLK', colorName: 'Black',
                     colorCode: '', isActive: true, isPublished: false, hasSwatchMedia: false }],
      media: [],
    }));

    const outDir = path.join(work, 'reports');
    const audit = node(API, [path.join('scripts', 'audit-public-catalogue.js'),
      '--input', exportFile, '--output', outDir, '--quiet'], { quiet: true });
    if (audit.status !== 0) failures.push(`  the audit exited ${audit.status}: ${tailLines(audit.stderr || audit.stdout, 4)}`);

    const decisionsFile = path.join(work, 'decisions.json');
    fs.writeFileSync(decisionsFile, JSON.stringify({
      reviewedAt: '2026-08-06T00:00:00.000Z', reviewer: 'verify-release',
      notes: 'synthetic', brandDecisions: [], slugDecisions: [], fieldOverrides: [], exclusions: [],
    }));
    const planFile = path.join(work, 'plan.json');
    const plan = node(API, [path.join('scripts', 'build-reviewed-plan.js'),
      '--export', exportFile, '--decisions', decisionsFile, '--output', planFile], { quiet: true });
    if (plan.status !== 0) failures.push(`  the plan builder exited ${plan.status}: ${tailLines(plan.stderr || plan.stdout, 4)}`);

    /* THE point of the chain: nothing it produces may be executable. */
    const SQL = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|drop\s+table|create\s+table|truncate)\b/i;
    for (const file of walk(work)) {
      const text = fs.readFileSync(file, 'utf8');
      if (SQL.test(text)) failures.push(`  ${path.basename(file)} contains executable SQL`);
      if (path.extname(file) === '.sql') failures.push(`  ${path.basename(file)} is a .sql file`);
    }

    return failures.length
      ? { ok: false, detail: failures.join('\n') }
      : { ok: true, detail: 'audit and plan produced from a synthetic fixture; no SQL, no database' };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/* ---- 14. deploy payload ---- */

gate('deploy-payload', 'every artefact deploy.sh ships exists and assembles', () => {
  /* Read from deploy.sh rather than duplicated here: a second copy of the file
     list is a copy that drifts, and the drift is invisible until a deploy is
     missing a file. Nothing is shipped — this stops at "it is all present". */
  const script = fs.readFileSync(path.join(SERVER, 'deploy.sh'), 'utf8');
  const tarMatch = script.match(/tar czf - ([^|]+)\)/);
  if (!tarMatch) return { ok: false, detail: 'could not find the server tar invocation in deploy.sh' };

  const entries = tarMatch[1].replace(/\\\s*\n\s*/g, ' ').trim().split(/\s+/).filter(Boolean);
  const missing = entries.filter((e) => !fs.existsSync(path.join(SERVER, e)));
  if (missing.length) return { ok: false, detail: missing.map((m) => `  missing: ${m}`).join('\n') };

  const adminMatch = script.match(/tar czf - ([^|]+)\)\s*\\\s*\n\s*\| ssh \$HOST "tar xzf - -C \$DEST\/admin"/);
  const adminEntries = adminMatch ? adminMatch[1].trim().split(/\s+/) : ['index.html', 'css', 'js', 'assets'];
  const adminMissing = adminEntries.filter((e) => !fs.existsSync(path.join(ROOT, e)));
  if (adminMissing.length) return { ok: false, detail: adminMissing.map((m) => `  missing: ${m}`).join('\n') };

  /* The live Caddyfile must still be what ships by default. Phase 1's whole
     point is that the catch-all cutover is opt-in; a deploy that silently
     shipped Caddyfile.rc as the mounted config would arm R-01/R-02. */
  const compose = fs.readFileSync(path.join(SERVER, 'docker-compose.yml'), 'utf8');
  if (!/\$\{CADDYFILE:-\.\/Caddyfile\}/.test(compose)) {
    return { ok: false, detail: 'docker-compose.yml no longer defaults to the live Caddyfile' };
  }
  const size = entries.reduce((s, e) => s + dirSizeBytes(path.join(SERVER, e)), 0)
    + adminEntries.reduce((s, e) => s + dirSizeBytes(path.join(ROOT, e)), 0);

  return {
    ok: true,
    detail: `${entries.length + adminEntries.length} payload entries present, ~${(size / 1e6).toFixed(1)} MB; `
      + 'cutover still opt-in; nothing shipped',
  };
});

/* ---------------------------------------------------------------------------
   Small filesystem helpers
   --------------------------------------------------------------------------- */

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function dirSizeBytes(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.size;
  } catch { return 0; }
  let total = 0;
  for (const file of walk(target)) {
    try { total += fs.statSync(file).size; } catch { /* raced or unreadable */ }
  }
  return total;
}
const dirSizeMb = (target) => (dirSizeBytes(target) / 1e6).toFixed(1);

/* ---------------------------------------------------------------------------
   Run
   --------------------------------------------------------------------------- */

if (args.has('--list')) {
  for (const g of GATES) process.stdout.write(`${g.name.padEnd(24)} ${g.description}\n`);
  process.exit(0);
}

if (ONLY.length) {
  const unknown = ONLY.filter((n) => !GATES.some((g) => g.name === n));
  if (unknown.length) {
    process.stderr.write(`unknown gate(s): ${unknown.join(', ')}\nrun with --list to see them all\n`);
    process.exit(2);
  }
}

process.stdout.write(`verify-release — ${ONLY.length ? ONLY.length : GATES.length} gate(s)\n`);
process.stdout.write('no production system, VPS, database or network host is contacted\n');

let failed = 0;
for (const g of GATES) {
  if (ONLY.length && !ONLY.includes(g.name)) continue;
  heading(g.name);
  info(g.description);
  const began = Date.now();
  let outcome;
  try {
    outcome = g.run();
  } catch (err) {
    outcome = { ok: false, detail: `the gate itself threw: ${err && err.message ? err.message : err}` };
  }
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  results.push({ name: g.name, ok: outcome.ok, seconds });
  process.stdout.write(`    ${outcome.ok ? 'PASS' : 'FAIL'}  (${seconds}s)\n`);
  if (outcome.detail) info(outcome.detail.replace(/\n/g, '\n    '));
  if (!outcome.ok) {
    failed += 1;
    if (FAIL_FAST) break;
  }
}

heading('summary');
for (const r of results) {
  process.stdout.write(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(24)} ${r.seconds}s\n`);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
process.stdout.write(`\n    ${results.length - failed}/${results.length} gates passed in ${elapsed}s\n`);

if (failed) {
  process.stdout.write('\n    RELEASE VERIFICATION FAILED — do not propose this for merge.\n\n');
  process.exit(1);
}
process.stdout.write('\n    Release verification passed. This is a local check, not a deployment.\n\n');
process.exit(0);
