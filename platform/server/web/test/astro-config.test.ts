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
