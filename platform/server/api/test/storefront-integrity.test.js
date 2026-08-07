/* Static integrity of the storefront (Phase 5 QA).

   The portal is a set of plain <script> tags with no module system, no
   bundler and no type checker. Nothing tells you that `icon('carret')` is a
   typo, that a page calls a helper that lives in a file loaded after it, or
   that a link points at a route nobody registered — the screen simply renders
   without the icon, or throws at the moment a customer clicks something.

   This batch added a shared icon registry, a Back table, a new page and a
   handful of cross-file helpers, which is exactly the kind of change that
   introduces those. So the checks are mechanical and repository-wide rather
   than a list of the things this batch happened to touch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const STOREFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'storefront');
const read = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const INDEX = read('index.html');
/** The scripts, in the order the browser runs them. */
const SCRIPTS = [...INDEX.matchAll(/<script src="(js\/[^"?]+)/g)].map(m => m[1]);

test('every js file in the directory is actually loaded', () => {
  /* A page script nobody loads is a route that silently does not exist. */
  const onDisk = fs.readdirSync(path.join(STOREFRONT, 'js'))
    .filter(f => f.endsWith('.js')).map(f => `js/${f}`).sort();
  assert.deepEqual([...SCRIPTS].sort(), onDisk);
});

test('every icon a page asks for exists in the registry', () => {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/icons.js'), ctx, { filename: 'icons.js' });
  const names = new Set(vm.runInContext('Object.keys(ICON_PATHS)', ctx));

  const missing = [];
  for (const file of SCRIPTS) {
    const code = strip(read(file));
    for (const m of code.matchAll(/\b(?:icon|emptyIcon|navIcon)\(\s*'([^']+)'/g)) {
      if (!names.has(m[1])) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'an unknown icon renders nothing at all');
});

test('every CSS custom property used is defined', () => {
  const css = read('css/store.css');
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));
  const missing = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/gi)) {
    /* A var() with a fallback is a deliberate optional, not a mistake. */
    if (!defined.has(m[1]) && !m[2]) missing.add(m[1]);
  }
  assert.deepEqual([...missing], [], 'an undefined custom property silently resolves to nothing');
});

test('every helper a page calls is defined somewhere that loads first', () => {
  /* The one class of error this architecture cannot catch by itself: a page
     calling something declared in a file the browser has not reached yet. */
  const declaredBy = new Map();
  SCRIPTS.forEach((file, i) => {
    const code = read(file);
    for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
      if (!declaredBy.has(m[1])) declaredBy.set(m[1], i);
    }
    for (const m of code.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
      if (!declaredBy.has(m[1])) declaredBy.set(m[1], i);
    }
  });

  /* Called by our own code and expected to be ours. Browser and language
     built-ins are excluded by name — enumerating them is more honest than
     guessing from the shape of the call. */
  const BUILTIN = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'Date', 'JSON',
    'Promise', 'Map', 'Set', 'RegExp', 'Error', 'parseInt', 'parseFloat',
    'isNaN', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'encodeURIComponent', 'decodeURIComponent', 'fetch', 'alert', 'confirm',
    'require', 'super', 'await', 'new', 'do', 'else', 'FormData', 'Intl',
  ]);

  /* Only calls that run AT LOAD TIME are ordering-sensitive. A call inside a
     function body executes when a customer clicks something, by which point
     every script has loaded — `app.js` legitimately calls `waIcon()` from
     `pages_home.js` that way. So the scan is restricted to brace-depth zero,
     which is what actually runs as the tag is reached. */
  const topLevel = (code) => {
    let depth = 0;
    let out = '';
    for (let i = 0; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') { depth = Math.max(0, depth - 1); continue; }
      out += depth === 0 ? ch : ' ';
    }
    return out;
  };

  const problems = [];
  SCRIPTS.forEach((file, i) => {
    const code = topLevel(strip(read(file)));
    for (const m of code.matchAll(/(^|[^.\w$'"`])([a-z][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (BUILTIN.has(name)) continue;
      if (!declaredBy.has(name)) continue;      // not ours; a method or a local
      if (declaredBy.get(name) > i) {
        problems.push(`${file} calls ${name}() at load time, `
          + `declared later in ${SCRIPTS[declaredBy.get(name)]}`);
      }
    }
  });
  assert.deepEqual([...new Set(problems)], [],
    'a helper must be defined before the page that uses it is loaded');
});

test('every route linked to is a route that exists', () => {
  const registered = new Set();
  for (const file of SCRIPTS) {
    for (const m of read(file).matchAll(/Routes\['(#\/[a-z-]*)'\]\s*=/g)) registered.add(m[1]);
  }
  assert.ok(registered.size > 10, `expected the full route table, saw ${registered.size}`);

  const missing = new Set();
  for (const file of SCRIPTS) {
    const code = strip(read(file));
    for (const m of code.matchAll(/(?:location\.hash\s*=\s*|href="|hash: )'?(#\/[a-z-]+)/g)) {
      /* Only the first segment identifies the route. */
      const key = '#/' + m[1].replace(/^#\//, '').split('/')[0];
      if (!registered.has(key)) missing.add(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual([...missing], [], 'a link to an unregistered route is a dead end');
});

test('every navigation entry points at a registered route', () => {
  const registered = new Set();
  for (const file of SCRIPTS) {
    for (const m of read(file).matchAll(/Routes\['(#\/[a-z-]*)'\]\s*=/g)) registered.add(m[1]);
  }
  const app = read('js/app.js');
  const entries = [...app.matchAll(/hash: '(#\/[a-z-]*)'/g)].map(m => m[1]);
  assert.ok(entries.length >= 10, 'the nav tables were found');
  for (const hash of new Set(entries)) {
    assert.ok(registered.has(hash), `the navigation offers ${hash}, which is not registered`);
  }
});

test('no page script throws merely by being loaded', () => {
  /* Everything at the top level of these files runs the moment the browser
     reaches the tag — a registry built from another file, a frozen table, a
     const referencing a helper. If any of that throws, every screen after it
     is dead, and the failure appears as a blank page with no clue why. */
  const ctx = {
    console, Routes: {}, Store: { session: null, fx: {}, features: {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: () => {},
      createElement: () => ({ content: { firstElementChild: null }, style: {} }),
      body: { classList: { add() {}, remove() {}, toggle() {} } },
    },
    location: { hash: '#/' }, history: {}, navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    addEventListener() {}, scrollTo() {}, matchMedia: () => ({ matches: false, addListener() {} }),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of SCRIPTS) {
    assert.doesNotThrow(
      () => vm.runInContext(read(file), ctx, { filename: file }),
      `${file} throws while loading`);
  }
  /* And the whole thing really did assemble. Read by evaluating the names:
     `const Routes = {}` at the top level of a plain script is NOT a property
     of the global object, so `ctx.Routes` would be the empty stub passed in
     and this would pass while testing nothing. */
  const routes = vm.runInContext('Object.keys(Routes)', ctx);
  assert.ok(routes.length > 10, `the route table is populated (saw ${routes.length})`);
  for (const name of ['icon', 'backTarget', 'confirmModal', 'orderLineRow', 'stampedAddress']) {
    assert.equal(vm.runInContext(`typeof ${name}`, ctx), 'function', `${name} is available`);
  }
});

test('the pages added this batch are registered and reachable', () => {
  const app = read('js/app.js');
  assert.match(read('js/pages_balance.js'), /Routes\['#\/balance'\]/);
  assert.match(app, /hash: '#\/balance'/, 'and it is in the navigation');
});
