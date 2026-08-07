/* Analytics in the authenticated portal: DISABLED BY DEFAULT.

   A Meta Pixel used to load in `storefront/index.html`. It initialised on every
   page load and fired a PageView on every in-app route change, so a signed-in
   trade customer's whole session — which frames they viewed, what they ordered,
   how often they returned — went to a third party. No consent gate, a
   hard-coded production pixel id, and a third-party script with full access to
   the DOM of an authenticated page.

   It was REMOVED rather than switched off, and nothing replaced it. These
   assertions are written so that adding any of it back fails — including via a
   dormant configuration hook holding an id, which is one line away from
   executing again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = path.resolve(HERE, '..', '..', 'storefront');
const WEB = path.resolve(HERE, '..', '..', 'web', 'src');
const ADMIN = path.resolve(HERE, '..', '..', '..', '..');

/** Every file a browser executes on an authenticated surface. */
function authenticatedSources() {
  const files = [];
  files.push(['storefront/index.html', fs.readFileSync(path.join(STOREFRONT, 'index.html'), 'utf8')]);
  for (const f of fs.readdirSync(path.join(STOREFRONT, 'js')).filter((x) => x.endsWith('.js'))) {
    files.push([`storefront/js/${f}`, fs.readFileSync(path.join(STOREFRONT, 'js', f), 'utf8')]);
  }
  files.push(['index.html', fs.readFileSync(path.join(ADMIN, 'index.html'), 'utf8')]);
  for (const f of fs.readdirSync(path.join(ADMIN, 'js')).filter((x) => x.endsWith('.js'))) {
    files.push([`js/${f}`, fs.readFileSync(path.join(ADMIN, 'js', f), 'utf8')]);
  }
  return files;
}

/* Comments are stripped: the replacement comment in index.html NAMES the thing
   it records the removal of, and a check that trips on its own explanation is
   the recurring way this suite has produced false failures. */
const strip = (s) => s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ============ nothing loads ============ */

test('no authenticated page loads a Meta Pixel', () => {
  for (const [name, raw] of authenticatedSources()) {
    const code = strip(raw);
    for (const marker of [
      /\bfbq\b/, /connect\.facebook\.net/, /fbevents/, /_fbq/,
      /facebook\.com\/tr\b/, /\bMeta Pixel\b/i,
    ]) {
      assert.ok(!marker.test(code), `${name} still references ${marker}`);
    }
  }
});

test('no authenticated page loads any other analytics or tag manager', () => {
  /* Removing one vendor and adding another would satisfy the letter of this
     and none of the point. */
  for (const [name, raw] of authenticatedSources()) {
    const code = strip(raw);
    for (const marker of [
      /googletagmanager/, /google-analytics/, /\bgtag\s*\(/, /\bdataLayer\b/,
      /\bga\s*\(\s*['"]create/, /segment\.com\/analytics/, /\banalytics\.track\s*\(/,
      /hotjar/i, /mixpanel/i, /plausible\.io/, /\bclarity\.ms/,
    ]) {
      assert.ok(!marker.test(code), `${name} references ${marker}`);
    }
  }
});

test('no hard-coded production pixel id survives anywhere in the repository', () => {
  /* Not even dormant. An id that only something else prevents from executing
     is one line away from executing again — and the id is recoverable from
     Veyora's own Meta account if an integration is ever approved. */
  const ID = '1800415057342259';
  const roots = [STOREFRONT, WEB, path.join(ADMIN, 'js'), path.join(ADMIN, 'css'),
    path.join(ADMIN, 'platform', 'docs')];
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules|\.git|dist|\.astro/.test(p)) walk(p);
        continue;
      }
      if (!/\.(js|mjs|ts|astro|html|css|json|md|yml|yaml|env|example)$/i.test(entry.name)) continue;
      if (fs.readFileSync(p, 'utf8').includes(ID)) offenders.push(p);
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], 'the production pixel id must not be in the tree');
});

test('the storefront shell loads only its own scripts', () => {
  /* The positive form of the checks above: an allowlist of what may execute,
     so a NEW third-party tag is caught even if it is a vendor nobody has heard
     of yet. */
  const html = fs.readFileSync(path.join(STOREFRONT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const src = /src="([^"]+)"/.exec(m[1]);
    if (!src) continue;
    assert.match(src[1], /^js\//,
      `the shell must only load its own scripts — found ${src[1]}`);
  }
  /* And no inline script survives either: the pixel WAS an inline script, so
     "no external src" alone would not have caught it. */
  const inline = [...strip(html).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(inline, [], 'no inline script runs in the portal shell');
});

test('no route change emits a tracking event', () => {
  /* The specific behaviour that made this worse than an ordinary marketing
     pixel: every in-app navigation was reported. */
  for (const [name, raw] of authenticatedSources()) {
    const code = strip(raw);
    const hashListeners = [...code.matchAll(/hashchange['"]?\s*,\s*([\s\S]{0,200}?)\)/g)];
    for (const [, body] of hashListeners) {
      assert.ok(!/fbq|gtag|track\s*\(|dataLayer/.test(body),
        `${name} emits a tracking event on navigation`);
    }
  }
});

test('nothing was silently moved to the public marketing site instead', () => {
  /* The public Astro site is a different privacy question from the portal, but
     relocating the pixel there would not be a decision anyone took here. */
  const offenders = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(astro|ts|js|html)$/.test(entry.name)) continue;
      const code = strip(fs.readFileSync(p, 'utf8'));
      if (/\bfbq\b|connect\.facebook\.net|fbevents/.test(code)) offenders.push(p);
    }
  };
  walk(WEB);
  assert.deepEqual(offenders, []);
});

/* ============ the decision is recorded where the next person will look ============ */

test('the shell records that analytics is disabled by default, and why', () => {
  const html = fs.readFileSync(path.join(STOREFRONT, 'index.html'), 'utf8');
  assert.match(html, /ANALYTICS: DISABLED BY DEFAULT/,
    'so the next person does not re-add it assuming it was an oversight');
  assert.match(html, /consent/i, 'and knows a consent decision is part of any future one');
});
