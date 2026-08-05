import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

const base = src('layouts/Base.astro');
const page = src('layouts/Page.astro');
const header = src('components/nav/Header.astro');
const mobileMenu = src('components/nav/MobileMenu.astro');
const footer = src('components/nav/Footer.astro');
const breadcrumbs = src('components/nav/Breadcrumbs.astro');
const skeletonNotice = src('components/dev/SkeletonNotice.astro');

test('Base layout includes a skip link', () => {
  assert.match(base, /class="skip-link"/);
  assert.match(base, /href="#main-content"/);
});

test('Page layout provides the main landmark the skip link targets', () => {
  assert.match(page, /<main id="main-content">/);
});

test('Page layout composes Header, optional Breadcrumbs, main and Footer', () => {
  assert.match(page, /<Header /);
  assert.match(page, /<Breadcrumbs /);
  assert.match(page, /<Footer/);
  // Breadcrumbs must be conditional — the home route omits them.
  assert.match(page, /breadcrumbs\s*&&\s*breadcrumbs\.length/);
});

test('Header contains semantic, labelled navigation', () => {
  assert.match(header, /<nav class="site-header__nav" aria-label="Primary">/);
  assert.match(header, /aria-current=/);
});

test('Header exposes an accessible mobile menu trigger', () => {
  assert.match(header, /id="mobile-menu-trigger"/);
  assert.match(header, /aria-expanded="false"/);
  assert.match(header, /aria-controls="mobile-menu"/);
  assert.match(header, /aria-label="Open menu"/);
});

test('Header does not import or copy the storefront header source', () => {
  // Component-derivation comments legitimately reference the storefront as
  // a read-only source of truth (e.g. "extends .hm-nav ... read, not
  // touched") — what must never appear is an actual import reaching into
  // it.
  assert.doesNotMatch(header, /from\s+['"][^'"]*storefront[^'"]*['"]/);
});

test('mobile menu script defines Escape handling', () => {
  assert.match(mobileMenu, /key === 'Escape'/);
});

test('mobile menu script restores focus on close', () => {
  assert.match(mobileMenu, /lastFocused/);
  assert.match(mobileMenu, /\(lastFocused ?\?\? trigger\)\.focus\(\)/);
});

test('mobile menu script updates aria-expanded on open and close', () => {
  assert.match(mobileMenu, /setAttribute\('aria-expanded', 'true'\)/);
  assert.match(mobileMenu, /setAttribute\('aria-expanded', 'false'\)/);
});

test('mobile menu applies and removes inert on the site root, not a manual tabindex scheme', () => {
  assert.match(mobileMenu, /siteRoot\?\.setAttribute\('inert', ''\)/);
  assert.match(mobileMenu, /siteRoot\?\.removeAttribute\('inert'\)/);
});

test('mobile menu constrains Tab focus while open', () => {
  assert.match(mobileMenu, /key === 'Tab'/);
});

test('mobile menu locks body scroll while open via a class, not inline styles', () => {
  assert.match(mobileMenu, /classList\.add\('mobile-menu-open'\)/);
  assert.match(mobileMenu, /classList\.remove\('mobile-menu-open'\)/);
});

test('mobile menu toggles state directly rather than waiting on a transition', () => {
  // The explanatory comment here legitimately mentions "transitionend" by
  // name to say it is NOT used — what must never appear is an actual
  // listener for it.
  assert.doesNotMatch(mobileMenu, /addEventListener\(\s*['"]transitionend['"]/);
});

test('Footer derives its link groups from central nav config, not a repeated literal list', () => {
  assert.match(footer, /import \{ footerGroups \} from '\.\.\/\.\.\/lib\/nav\.ts'/);
  assert.doesNotMatch(footer, /from\s+['"][^'"]*storefront[^'"]*['"]/);
});

test('Footer computes the copyright year dynamically', () => {
  assert.match(footer, /new Date\(\)\.getFullYear\(\)/);
});

test('Footer contains no fake social URL in its own source', () => {
  assert.doesNotMatch(
    footer,
    /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|youtube\.com/i
  );
});

test('Breadcrumbs use ordered-list markup with the required aria-label', () => {
  assert.match(breadcrumbs, /aria-label="Breadcrumb"/);
  assert.match(breadcrumbs, /<ol>/);
});

test('Breadcrumbs mark the current page distinctly from linked ancestors', () => {
  assert.match(breadcrumbs, /aria-current="page"/);
});

test('SkeletonNotice never renders as a rounded card', () => {
  assert.doesNotMatch(skeletonNotice, /border-radius:\s*(?!0)/);
});

test('SkeletonNotice states that approved content is deferred, not a commercial claim', () => {
  assert.match(skeletonNotice, /supplied in a later build batch/i);
});
