/* Client feedback item A — emoji are not icons.

   The portal shipped emoji as functional controls: 🛒 for the cart, 👤 for the
   account, 🗑 to remove a line, 📷 to upload a photo. Each renders in the
   operating system's own colour and shape, changes between platforms, and is
   announced by a screen reader under its CLDR name rather than by what the
   control does.

   These assertions run against the REAL shipped source of both the storefront
   and the admin panel, and they are written so that ADDING an emoji control
   later fails — the point is not that a list of known cases was fixed once. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = path.resolve(HERE, '..', '..', 'storefront');
const ADMIN = path.resolve(HERE, '..', '..', '..', '..');

/* Comments are stripped everywhere below: several of them NAME the emoji they
   explain, and a check that trips on its own explanation is the recurring way
   this suite has produced false failures. */
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const read = (base, p) => strip(fs.readFileSync(path.join(base, p), 'utf8'));

/* Pictographic characters. Deliberately does NOT include the typographic
   arrows (→ ← ↔) or the bullet/middot: those are punctuation inside sentences
   and audit lines ("pending → shipped"), not controls, and replacing them with
   images would be worse for a screen reader, not better. */
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{FE0F}\u{2660}-\u{2668}]/u;
const PICTOGRAPH_G = new RegExp(PICTOGRAPH.source, 'gu');

/* An arrow is punctuation in "pending → shipped" and a CONTROL in "↺ Repeat
   this order". The range above lets prose arrows through, so this catches the
   other case on its own terms: an arrow may not be the label of a control. */
const ARROW_CONTROL = /<(?:button|a)\b[^>]*>\s*[\u{2190}-\u{21FF}]/gu;

const STOREFRONT_JS = [
  'js/app.js', 'js/icons.js', 'js/ui.js', 'js/pages_home.js', 'js/pages_auth.js',
  'js/pages_catalog.js', 'js/pages_lists.js', 'js/pages_dashboard.js', 'js/pages_cart.js',
  'js/pages_orders.js', 'js/pages_account.js', 'js/pages_agent.js',
];
const ADMIN_JS = fs.readdirSync(path.join(ADMIN, 'js')).filter(f => f.endsWith('.js'));

/* ============ no emoji anywhere a customer or operator can see ============ */

test('no storefront page renders a pictographic character', () => {
  for (const file of STOREFRONT_JS) {
    const code = read(STOREFRONT, file);
    const found = code.match(PICTOGRAPH_G);
    assert.equal(found, null,
      `${file} still renders ${found ? [...new Set(found)].join(' ') : ''} — `
      + 'use icon() from icons.js');
  }
});

test('no admin panel page renders a pictographic character', () => {
  for (const file of ADMIN_JS) {
    const code = read(ADMIN, path.join('js', file));
    const found = code.match(PICTOGRAPH_G);
    assert.equal(found, null,
      `js/${file} still renders ${found ? [...new Set(found)].join(' ') : ''} — use the I registry`);
  }
});

test('no arrow character is used as the label of a control', () => {
  for (const [base, files] of [[STOREFRONT, STOREFRONT_JS], [ADMIN, ADMIN_JS.map(f => `js/${f}`)]]) {
    for (const file of files) {
      const found = read(base, file).match(ARROW_CONTROL);
      assert.equal(found, null,
        `${file}: ${found ? found[0].slice(-40) : ''} — a control gets an icon, not an arrow glyph`);
    }
  }
});

test('neither index.html renders one either', () => {
  for (const [base, file] of [[STOREFRONT, 'index.html'], [ADMIN, 'index.html']]) {
    const html = fs.readFileSync(path.join(base, file), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
    assert.equal(html.match(PICTOGRAPH_G), null, `${file} still renders a pictograph`);
  }
});

/* ============ the icon system itself ============ */

function loadIcons() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(STOREFRONT, 'js/icons.js'), 'utf8'), ctx,
    { filename: 'icons.js' });
  return ctx;
}

test('every icon inherits its colour and is hidden from assistive technology', () => {
  const { icon, iconNames } = loadIcons();
  const names = iconNames();
  assert.ok(names.length >= 20, 'the registry is populated');
  for (const name of names) {
    const svg = icon(name);
    assert.match(svg, /stroke="currentColor"/,
      `${name} must take the colour of the control it sits in`);
    assert.match(svg, /aria-hidden="true"/,
      `${name} is decoration — the control carries the accessible name`);
    assert.match(svg, /focusable="false"/, `${name} must not be a tab stop in IE/Edge legacy`);
    assert.match(svg, /viewBox="0 0 24 24"/, `${name} is drawn on the shared grid`);
    assert.ok(!/fill="(?!none|currentColor)/.test(svg), `${name} hard-codes no colour`);
  }
});

test('an unknown icon name renders nothing rather than a wrong glyph', () => {
  const { icon } = loadIcons();
  assert.equal(icon('no-such-icon'), '');
  assert.equal(icon(''), '');
  assert.equal(icon(undefined), '');
});

test('a filled icon is still monochrome and still inherits colour', () => {
  const { icon } = loadIcons();
  const on = icon('heart', { filled: true });
  assert.match(on, /fill="currentColor"/, 'the ON state is painted, not a second colour');
  assert.match(on, /stroke="currentColor"/);
});

test('nav icons omit their dimensions so the nav CSS sizes them', () => {
  const { navIcon, icon } = loadIcons();
  const nav = navIcon('home');
  assert.ok(!/ width="/.test(nav) && !/ height="/.test(nav),   // stroke-width stays
    'the bottom nav and the topbar size these differently');
  assert.match(nav, /viewBox="0 0 24 24"/, 'but it is still the same shape');
  assert.match(icon('home'), /width="18"/, 'while the general form is sized');
});

test('there is ONE storefront icon registry, not two', () => {
  /* NAVICON used to be a second hand-written copy of the same shapes. A second
     registry is how an icon gets changed in one place and not the other. */
  const app = read(STOREFRONT, 'js/app.js');
  assert.match(app, /NAVICON[\s\S]{0,200}navIcon\(/,
    'NAVICON must derive from the shared registry');
  assert.ok(!/NAVICON\s*=\s*\{[\s\S]*?<svg/.test(app),
    'NAVICON must not hand-write SVG of its own');
});

/* ============ replacing a label with a picture must not remove the label ============ */

test('every icon-only control still has an accessible name', () => {
  /* An emoji at least had a spoken name. An SVG marked aria-hidden has none,
     so the control around it MUST carry a title or aria-label — otherwise this
     change would have made the portal less accessible, not more. */
  for (const file of STOREFRONT_JS) {
    const code = read(STOREFRONT, file);
    for (const tag of code.match(/<button[^>]*>\s*\$\{(icon|emptyIcon|I)\([^}]*\}\s*<\/button>/g) ?? []) {
      assert.ok(/aria-label="|title="/.test(tag),
        `${file}: an icon-only button needs a name — ${tag.slice(0, 90)}`);
    }
  }
});

test('the controls named in the feedback are icons now, and still named', () => {
  const app = read(STOREFRONT, 'js/app.js');
  for (const [label, name] of [['Cart', 'cart'], ['My Account', 'user'], ['Favorites', 'heart']]) {
    const re = new RegExp(`title="${label}"[^>]*aria-label="${label}"[^>]*>\\$\\{icon\\('${name}'`);
    assert.match(app, re, `the ${label} control is an icon with a name`);
  }
});
