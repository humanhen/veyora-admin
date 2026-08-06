/* Accessibility and responsive QA at 375 / 768 / 1280 (Fast-Track WS2 Phase 4).
 *
 * Drives a REAL browser over the real production server, at the three widths
 * the brief names, and asserts against computed layout.
 *
 * NOTHING WAS INSTALLED. The brief forbids installing Playwright or a browser
 * binary; it asks whether one is already present and usable without adding a
 * dependency. Chrome is, via the DevTools Protocol over Node 22's global
 * WebSocket — see test/helpers/headless-chrome.ts. There is no new package,
 * no download, and no node_modules entry.
 *
 * On a machine with no Chrome or Edge the whole suite SKIPS with a clear
 * message rather than failing. A QA control that goes red because of the
 * machine it runs on is a control people learn to ignore.
 *
 * Nothing contacts a real API, database or external network: the mock listens
 * on 127.0.0.1, the Astro server is told to use it, and the browser is started
 * with DNS resolution disabled for everything except loopback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi, type MockApi } from './helpers/mock-public-api.ts';
import { HeadlessBrowser, VIEWPORTS, isAvailable, findBrowser, type Viewport } from './helpers/headless-chrome.ts';
import { AUDIT_SOURCE } from './helpers/a11y-audit.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB_PORT = 4331;                       // distinct from every other suite's port
const SITE_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const PORTAL_ORIGIN = 'http://127.0.0.1:4332';
const CDP_PORT = 9412;

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no Chrome or Edge installation was found on this machine';

interface Finding { rule: string; detail: string; element: string | null }
interface AuditResult { findings: Finding[]; stats: Record<string, unknown> }

/* The routes audited. Chosen for coverage of the distinct layouts rather than
   for completeness: the home page, a listing, a filtered listing, a detail
   page, all three enquiry forms (the highest-risk surface for labels, contrast
   and tap targets), a long-copy page, and the 404. Every route the mock can
   serve is exercised at all three widths. */
const ROUTES: readonly string[] = Object.freeze([
  '/',
  '/brands/',
  '/collections/',
  '/collections/optical/',
  '/contact/',
  '/request-b2b-account/',
  '/private-label-enquiry/',
  '/why-veyora/',
  '/accessibility/',
  '/no-such-page-here/',
]);

let mock: MockApi | undefined;
let server: ReturnType<typeof spawn> | undefined;
let browser: HeadlessBrowser | undefined;

/** rule → route → viewport → findings. Filled by the sweep, asserted after. */
const results = new Map<string, AuditResult>();
const key = (route: string, viewport: Viewport) => `${route} @ ${viewport.name}`;

function findingsFor(rule: string): { where: string; finding: Finding }[] {
  const out: { where: string; finding: Finding }[] = [];
  for (const [where, result] of results) {
    for (const finding of result.findings) {
      if (finding.rule === rule) out.push({ where, finding });
    }
  }
  return out;
}

/** A failure message that names the pages and the elements, not a count. */
function report(rule: string): string {
  return findingsFor(rule)
    .map(({ where, finding }) => `  ${where}\n      ${finding.detail}${finding.element ? `\n      ${finding.element}` : ''}`)
    .join('\n');
}

const expectNone = (rule: string, why: string) => {
  const hits = findingsFor(rule);
  assert.equal(hits.length, 0, `${why}\n${report(rule)}`);
};

/* ---------------------------------------------------------------------------
   Known findings — pinned, not muted
   ---------------------------------------------------------------------------

   Two rules have real, systemic findings today. They are NOT design bugs to be
   quietly fixed in an unattended run: both are properties of the approved
   visual system's micro-label typography, applied on every page, and changing
   them is visual drift (08_RISKS_AND_OPEN_DECISIONS.md R-07, score 12) plus a
   design decision that belongs to a person.

   So they are pinned the same way the release-verification host scan pins its
   exceptions:

     - every known element is named here, so the list is the finding register;
     - anything NOT on the list fails the test, so the set can only grow
       deliberately;
     - a pin that no longer matches anything ALSO fails, so a fixed finding
       cannot linger and hold the door open for the next one.

   They are written up as open items in
   docs/public-website-rebuild/29_ACCESSIBILITY_AND_RESPONSIVE_QA.md §5 and
   carried into the release blocker register. A pinned finding is an open
   finding, not a pass. */
const KNOWN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /* WCAG 2.2 AA 2.5.8. Every one is in the site footer: the wordmark link and
     the footer navigation links, all around 19–21px tall. */
  'tap-target': Object.freeze([
    'a.site-footer__logo',
    'a "Home"',
    'a "Collections"',
    'a "Private Label"',
  ]),
  /* 10–12px uppercase letter-spaced labels: the header utility links, the
     footer group headings and navigation, breadcrumbs, pagination, and the
     card and summary meta lines. */
  'font-size-small': Object.freeze([
    'a.site-header__utility-link',
    'p.site-footer__group-heading',
    'p.skeleton-notice__eyebrow',
    'p.brand-summary__segment',
    'p.brand-summary__tier',
    'p.pagination__page',
    'a.pagination__link',
    'span.model-card__brand',
    'a "Home"', 'a "Brands"', 'a "Collections"', 'a "Contact"', 'a "Why Veyora"',
    'a "Private Label"', 'a "Service Model"', 'a "Global Presence"',
    'span "Menu"', 'span "Brands"', 'span "Collections"',
    'span "Contact"', 'span "Why Veyora"', 'span "Optical"', 'span "Accessibility"',
    'span "Private Label Enquiry"', 'span "Request B2B Account"',
  ]),
  /* WCAG 1.4.3. One root cause: a text colour set at 42% alpha. Composited
     over its real background that lands at 4.06:1 on the dark footer (needs
     4.5:1) and 2.65:1 on the light placeholder notice. Changing the alpha is a
     design-token decision. */
  contrast: Object.freeze([
    'p.site-footer__group-heading',
    'div.site-footer__legal',
    'span.model-card__brand',
    'p.skeleton-notice__eyebrow',
    'p.pagination__page',
    'p.brand-summary__tier',
    'p.brand-summary__segment',
  ]),
});

/** Fails on anything not pinned, and on any pin that has stopped matching. */
function expectOnlyKnown(rule: string, why: string) {
  const pins = KNOWN[rule] ?? [];
  const hits = findingsFor(rule);
  const unknown = hits.filter(({ finding }) =>
    !pins.some((pin) => (finding.element ?? '').startsWith(pin)));
  assert.equal(unknown.length, 0,
    `${why}\nNEW findings, not on the known list:\n${unknown
      .map(({ where, finding }) => `  ${where}\n      ${finding.detail}\n      ${finding.element}`)
      .join('\n')}`);

  const stale = pins.filter((pin) =>
    !hits.some(({ finding }) => (finding.element ?? '').startsWith(pin)));
  assert.equal(stale.length, 0,
    `these known findings no longer occur — remove them from KNOWN so the list stays a register:\n${stale.map((s) => `  ${s}`).join('\n')}`);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

test('setup: a browser is already installed, and none was downloaded', { skip }, () => {
  assert.ok(BROWSER, 'expected a browser');
  assert.match(BROWSER!, /chrome|msedge|chromium/i);
  /* Proof of the constraint, not just a comment: no browser automation package
     is a dependency of this project. */
  const manifest = JSON.parse(
    spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync("package.json","utf8"))'],
      { cwd: root, encoding: 'utf8' }).stdout
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const forbidden of ['playwright', '@playwright/test', 'puppeteer', 'puppeteer-core', 'selenium-webdriver', 'cypress', 'chrome-launcher', 'chrome-remote-interface']) {
    assert.ok(!(forbidden in all), `${forbidden} must not be a dependency`);
  }
});

test('setup: production build succeeds', { skip }, () => {
  const result = spawnSync(process.execPath, ['./node_modules/astro/astro.js', 'build'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PUBLIC_SITE_ORIGIN: SITE_ORIGIN,
      PORTAL_ORIGIN,
      PUBLIC_API_ORIGIN: 'http://127.0.0.1:1',
    },
    shell: false,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
});

test('setup: start the server and the browser', { skip }, async () => {
  mock = await startMockApi({});
  server = spawn(process.execPath, ['./dist/server/entry.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(WEB_PORT),
      PUBLIC_SITE_ORIGIN: SITE_ORIGIN,
      PORTAL_ORIGIN,
      PUBLIC_API_ORIGIN: mock.origin,
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const response = await fetch(`${SITE_ORIGIN}/healthz`);
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, 'the Astro server never became reachable');
    await new Promise((r) => setTimeout(r, 150));
  }

  browser = await HeadlessBrowser.launch(CDP_PORT);
});

// ---------------------------------------------------------------------------
// the sweep — one pass, every route at every width
// ---------------------------------------------------------------------------

test('sweep: audit every route at 375, 768 and 1280', { skip }, async (t) => {
  assert.ok(browser, 'the browser did not start');
  for (const route of ROUTES) {
    for (const viewport of VIEWPORTS) {
      await browser!.setViewport(viewport);
      await browser!.goto(`${SITE_ORIGIN}${route}`);
      /* The viewport is applied again after navigation: a fresh document
         resets the layout viewport, and measuring before it settles is how a
         responsive audit quietly measures the wrong width. */
      await browser!.setViewport(viewport);
      const result = await browser!.evaluate<AuditResult>(AUDIT_SOURCE);
      results.set(key(route, viewport), result);
    }
  }
  t.diagnostic(`${results.size} page/viewport combinations audited`);
  assert.equal(results.size, ROUTES.length * VIEWPORTS.length);
});

test('the emulated viewport actually took effect at every width', { skip }, () => {
  /* Checked against `innerWidth`, which includes the scrollbar. `clientWidth`
     is 15px narrower on any page long enough to scroll, and asserting on that
     would report a classic scrollbar as a 15px layout defect. Overflow is
     measured against clientWidth, which is the correct box for that question —
     the two are deliberately not the same number. */
  for (const [where, result] of results) {
    const width = Number(result.stats.innerWidth);
    const expected = VIEWPORTS.find((v) => where.endsWith(v.name))!.width;
    assert.equal(width, expected, `${where}: laid out at ${width}px, not ${expected}px`);
  }
});

// ---------------------------------------------------------------------------
// responsive
// ---------------------------------------------------------------------------

test('375: no page scrolls horizontally on a phone', { skip }, () => {
  const hits = findingsFor('horizontal-overflow').filter(({ where }) => where.includes('mobile 375'));
  assert.equal(hits.length, 0,
    `a horizontal scrollbar on a phone is the most common responsive defect there is\n${report('horizontal-overflow')}`);
});

test('768 and 1280: no page scrolls horizontally either', { skip }, () => {
  const hits = findingsFor('horizontal-overflow').filter(({ where }) => !where.includes('mobile 375'));
  assert.equal(hits.length, 0, report('horizontal-overflow'));
});

test('no individual element breaks out of the viewport at any width', { skip }, () => {
  expectNone('horizontal-overflow-element',
    'an element wider than the viewport, outside any deliberate scroll region');
});

test('the viewport meta tag exists and does not disable zoom', { skip }, () => {
  expectNone('viewport-meta', 'without it a phone lays the page out at 980px and shrinks it');
  expectNone('viewport-zoom', 'pinch-zoom must not be disabled — WCAG 1.4.4');
});

test('no text is rendered below 10px at any width', { skip }, () => {
  expectNone('font-size-illegible', 'text under 10px is effectively unreadable');
});

test('OPEN FINDING — 10-12px micro labels, pinned pending a design decision', { skip }, (t) => {
  expectOnlyKnown('font-size-small',
    'uppercase letter-spaced labels between 10px and 12px. Real, systemic, and a change to the '
    + 'approved type scale rather than a bug fix — see 29_ACCESSIBILITY_AND_RESPONSIVE_QA.md §5.');
  t.diagnostic(`${findingsFor('font-size-small').length} occurrences of known small-label text (open finding)`);
});

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

test('every page declares a language and a title', { skip }, () => {
  expectNone('html-lang', 'a screen reader cannot choose a voice without it');
  expectNone('document-title', 'the title is the first thing announced and the tab label');
});

test('every page has exactly one main landmark, a banner and a contentinfo', { skip }, () => {
  expectNone('landmark-main', 'landmark navigation depends on exactly one main');
  expectNone('landmark-banner', 'no header landmark');
  expectNone('landmark-contentinfo', 'no footer landmark');
});

test('where there is more than one navigation, each is named', { skip }, () => {
  expectNone('landmark-nav-name', 'two unnamed navigations are indistinguishable in a landmark list');
});

test('every page has exactly one H1 and no skipped heading levels', { skip }, () => {
  expectNone('heading-h1', 'the H1 is the page\'s name in every heading-based navigation');
  expectNone('heading-order', 'a skipped level reads as missing content');
  expectNone('heading-empty', 'an empty heading is announced as a heading with nothing in it');
});

test('the first focusable element is a working skip link', { skip }, () => {
  expectNone('skip-link', 'a keyboard user otherwise tabs the whole navigation on every page');
  expectNone('skip-link-target', 'a skip link pointing nowhere is worse than none');
});

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

test('every image has an alt attribute', { skip }, () => {
  /* Deliberately "has the attribute", not "has text": alt="" is the correct
     and required marking for a decorative image, and demanding text would push
     someone to describe a spacer. */
  expectNone('img-alt', 'an img with no alt attribute is announced as its file name');
});

test('every link and button has an accessible name', { skip }, () => {
  expectNone('control-name', 'an unnamed control is announced as "link" or "button" and nothing else');
});

test('every form field has a label', { skip }, () => {
  expectNone('field-label', 'the enquiry forms are the primary conversion path on this site');
  expectNone('field-required', 'a required field must say so in the accessibility tree');
  expectNone('fieldset-legend', 'a group of controls needs a name');
});

test('no id is duplicated and no ARIA reference dangles', { skip }, () => {
  expectNone('duplicate-id', 'a duplicate id silently breaks the label or ARIA reference that uses it');
  expectNone('dangling-aria-reference', 'an ARIA reference to a missing id is silently dropped');
  expectNone('dangling-label', 'a label pointing at a missing id labels nothing');
});

test('nothing overrides the document tab order', { skip }, () => {
  expectNone('positive-tabindex', 'a positive tabindex reorders the whole page for keyboard users');
});

// ---------------------------------------------------------------------------
// measured
// ---------------------------------------------------------------------------

test('OPEN FINDING — footer tap targets under 24x24, pinned pending a design decision', { skip }, (t) => {
  /* WCAG 2.2 AA 2.5.8 Target Size (Minimum). Links inside a sentence are
     exempt by the SC itself and are not counted. Every remaining finding is
     in the footer, at every width — so this is one layout decision repeated,
     not ten separate bugs. Fixing it means adding vertical padding to the
     footer navigation on every page, which moves the footer's rhythm: a
     visual-system change (R-07), not an unattended edit. */
  expectOnlyKnown('tap-target',
    'footer links about 19-21px tall — see 29_ACCESSIBILITY_AND_RESPONSIVE_QA.md §5');
  const mobile = findingsFor('tap-target').filter(({ where }) => where.includes('mobile 375'));
  t.diagnostic(`${mobile.length} known under-size tap targets at 375px (open finding)`);
});

test('every tap target outside the footer meets 24x24 at every width', { skip }, () => {
  const outside = findingsFor('tap-target')
    .filter(({ finding }) => !(finding.element ?? '').includes('footer')
      && !['a "Home"', 'a "Collections"', 'a "Private Label"'].some((k) => (finding.element ?? '').startsWith(k)));
  assert.equal(outside.length, 0,
    `the finding is meant to be confined to the footer navigation\n${outside
      .map(({ where, finding }) => `  ${where}\n      ${finding.detail}\n      ${finding.element}`).join('\n')}`);
});

test('OPEN FINDING — 42%-alpha micro labels miss 4.5:1, pinned pending a token decision', { skip }, (t) => {
  /* WCAG 1.4.3. The foreground is alpha-composited over its resolved
     background before measuring, which is what the browser paints and what a
     reader sees — so these are real ratios, not approximations. */
  expectOnlyKnown('contrast',
    'one root cause: a text colour at 42% alpha — see 29_ACCESSIBILITY_AND_RESPONSIVE_QA.md §5');
  t.diagnostic(`${findingsFor('contrast').length} occurrences of known low-contrast text (open finding)`);
});

test('all other text meets 4.5:1, or 3:1 for large text, at every width', { skip }, () => {
  const others = findingsFor('contrast')
    .filter(({ finding }) => !(KNOWN.contrast ?? []).some((pin) => (finding.element ?? '').startsWith(pin)));
  assert.equal(others.length, 0, report('contrast'));
});

test('the contrast check reports how much it could not measure', { skip }, (t) => {
  /* Honesty about coverage. Text over a background image or a gradient is
     skipped rather than guessed at, and the number is surfaced so the gap is
     visible instead of being implied by a green test. */
  let skipped = 0;
  let measured = 0;
  const reasons = { translucentText: 0, backgroundImage: 0, noOpaqueBackground: 0 };
  for (const result of results.values()) {
    skipped += Number(result.stats.contrastSkipped) || 0;
    measured += Number(result.stats.contrastMeasured) || 0;
    const r = result.stats.contrastSkipReasons as typeof reasons | undefined;
    if (r) {
      reasons.translucentText += r.translucentText ?? 0;
      reasons.backgroundImage += r.backgroundImage ?? 0;
      reasons.noOpaqueBackground += r.noOpaqueBackground ?? 0;
    }
  }
  const total = measured + skipped;
  t.diagnostic(`contrast measured on ${measured}/${total} text elements (${Math.round((measured / total) * 100)}%)`);
  t.diagnostic(`not measured: ${reasons.backgroundImage} over a background image or gradient, `
    + `${reasons.translucentText} with translucent text colour, ${reasons.noOpaqueBackground} with no opaque background found`);
  assert.ok(measured > 0, 'the contrast check measured nothing at all, which would make it meaningless');
  assert.ok(measured / total > 0.25,
    `only ${Math.round((measured / total) * 100)}% of text could be measured — the check would be more gap than coverage`);
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

test('teardown', { skip }, async () => {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      server!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (mock) await mock.close();
});

test('when no browser is installed this suite skips rather than fails', () => {
  /* Runs unconditionally — it is the one assertion that must hold on a machine
     WITHOUT a browser, and it documents the behaviour for whoever runs the
     suite in CI. */
  assert.equal(typeof isAvailable(), 'boolean');
  if (!isAvailable()) {
    assert.ok(skip, 'the suite must carry a skip reason when no browser is present');
  }
});
