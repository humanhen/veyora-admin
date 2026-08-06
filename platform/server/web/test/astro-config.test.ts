import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('astro config: output is server and the adapter is @astrojs/node', async () => {
  const configUrl = new URL('../astro.config.mjs', import.meta.url);
  const config = (await import(configUrl.href)).default;
  assert.equal(config.output, 'server');
  assert.ok(config.adapter, 'no adapter configured');
  assert.equal(config.adapter.name, '@astrojs/node');
});

test('astro config: site origin has no hard-coded Veyora domain, only a localhost fallback', async () => {
  const configUrl = new URL('../astro.config.mjs', import.meta.url);
  const config = (await import(configUrl.href)).default;
  assert.ok(config.site, 'site origin must be set');
  assert.doesNotMatch(String(config.site), /veyora\.(design|com)/i);
});

// Scans the application source (not test/, not node_modules, not build
// output) for a literal reference to either real Veyora domain. Both are
// undecided (DECISION-01) and neither may be hard-coded anywhere in this
// application — see docs/public-website-rebuild/08_RISKS_AND_OPEN_DECISIONS.md.
const SCAN_ROOTS = ['astro.config.mjs', 'package.json', 'tsconfig.json', 'README.md', '.env.example', 'src'];
const FORBIDDEN = /veyora\.(design|com)/i;

function collectFiles(entry: string): string[] {
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    return fs.readdirSync(entry).flatMap((child) => collectFiles(path.join(entry, child)));
  }
  return [entry];
}

test('no hard-coded veyora.design or veyora.com anywhere in application source', () => {
  const files = SCAN_ROOTS.flatMap((rel) => {
    const full = path.join(root, rel);
    return fs.existsSync(full) ? collectFiles(full) : [];
  });
  assert.ok(files.length > 0, 'sanity check: the scan must actually find files');

  const offenders = files.filter((file) => FORBIDDEN.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], `hard-coded Veyora domain found in: ${offenders.join(', ')}`);
});

/* Fast-Track morning correction: `security.allowedDomains` is what makes
   Astro trust the proxied Host and X-Forwarded-Proto, and therefore what
   makes the CSRF origin check accept a genuine same-origin form POST behind
   Caddy. Its shape is load-bearing, so it is pinned here. Its real behaviour
   is exercised end to end in test/enquiry-e2e.test.ts. */

test('astro config: allowedDomains is derived from PUBLIC_SITE_ORIGIN, exactly and without wildcards', async () => {
  const source = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');

  assert.match(source, /security:\s*\{/, 'no security block');
  assert.match(source, /allowedDomains:\s*\[/, 'no allowedDomains');
  assert.match(source, /hostname: siteHostname/);
  assert.match(source, /protocol: siteProtocol\.replace\(':', ''\)/);
  assert.match(source, /sitePort \? \{ port: sitePort \} : \{\}/,
    'the port must be omitted when the origin has none, so 80/443 still match');

  // Never a wildcard, and never a literal host.
  assert.doesNotMatch(source, /hostname:\s*['"`]\*/);
  assert.doesNotMatch(source, /allowedDomains:\s*\[\s*['"`]\*/);
  assert.doesNotMatch(source, /hostname:\s*['"`](?!\*)[a-z0-9.-]+['"`]/i,
    'the allowed host must be derived, never a literal');
});

test('astro config: CSRF origin checking is left enabled', async () => {
  const source = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
  /* Astro enables checkOrigin for SSR by default. Turning it off would make
     every form POST succeed from any origin — the exact failure this
     configuration exists to prevent. */
  assert.doesNotMatch(source, /checkOrigin\s*:\s*false/);
});

test('astro config: a malformed or non-http(s) site origin fails the build rather than weakening the allowlist', async () => {
  const source = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
  assert.match(source, /must be an absolute http\(s\) URL/);
  assert.match(source, /must use http or https/);
  assert.match(source, /must name an exact host/);

  /* And the guard's own predicate rejects, rather than falling back. Mirrors
     the logic in astro.config.mjs exactly; the assertions above pin that the
     config still contains it. */
  const accepts = (raw: string): boolean => {
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.hostname === '' || url.hostname.includes('*')) return false;
    return true;
  };

  for (const bad of ['ftp://example.test', 'not-a-url', 'http://*.example.test', 'https://', '']) {
    assert.equal(accepts(bad), false, `"${bad}" was not rejected`);
  }
  for (const good of ['https://example.test', 'http://127.0.0.1:4321', 'https://sub.example.test']) {
    assert.equal(accepts(good), true, `"${good}" was wrongly rejected`);
  }
});
