import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryNav, utilityNav, footerGroups } from '../src/lib/nav.ts';
import { env } from '../src/env.ts';

const REQUIRED_PUBLIC_PATHS = [
  '/why-veyora/',
  '/brands/',
  '/collections/',
  '/service-model/',
  '/private-label/',
  '/global-presence/',
  '/contact/',
  '/request-b2b-account/',
];

function allConfiguredHrefs(): string[] {
  return [
    ...primaryNav.map((item) => item.href),
    ...utilityNav.map((item) => item.href),
    ...footerGroups.flatMap((group) => group.links.map((link) => link.href)),
  ];
}

test('central navigation contains every required public path', () => {
  const hrefs = allConfiguredHrefs();
  for (const path of REQUIRED_PUBLIC_PATHS) {
    assert.ok(hrefs.includes(path), `missing ${path} from the navigation config`);
  }
});

test('no navigation item anywhere uses a legacy #/ route', () => {
  for (const href of allConfiguredHrefs()) {
    assert.doesNotMatch(href, /#\//, `found a #/ route: ${href}`);
  }
});

test('B2B Login is sourced from the environment configuration, not a literal', () => {
  const b2bLogin = utilityNav.find((item) => item.label === 'B2B Login');
  assert.ok(b2bLogin, 'B2B Login utility item not found');
  assert.equal(b2bLogin!.href, env.portalOrigin);
  assert.equal(b2bLogin!.external, true);
});

test('B2B Login is never a hard-coded production portal hostname', () => {
  const b2bLogin = utilityNav.find((item) => item.label === 'B2B Login');
  assert.doesNotMatch(b2bLogin!.href, /veyora\.(design|com)/i);
});

test('Request B2B Account is styled as the primary utility action', () => {
  const item = utilityNav.find((i) => i.label === 'Request B2B Account');
  assert.ok(item);
  assert.equal(item!.style, 'primary');
});

test('B2B Login is present but not styled as the primary action', () => {
  const item = utilityNav.find((i) => i.label === 'B2B Login');
  assert.ok(item);
  assert.notEqual(item!.style, 'primary');
});

test('footer navigation derives from at least four central groups, including legal routes', () => {
  assert.ok(footerGroups.length >= 4, 'expected at least four footer groups');
  const hrefs = footerGroups.flatMap((g) => g.links.map((l) => l.href));
  for (const legal of ['/privacy-policy/', '/terms/', '/accessibility/']) {
    assert.ok(hrefs.includes(legal), `missing ${legal} in footer groups`);
  }
});

test('no footer link is a fake or placeholder social URL', () => {
  const hrefs = footerGroups.flatMap((g) => g.links.map((l) => l.href));
  for (const href of hrefs) {
    assert.doesNotMatch(
      href,
      /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|tiktok\.com|youtube\.com/i
    );
  }
});

test('every configured href is either a site-relative path or the environment-sourced portal origin', () => {
  for (const href of allConfiguredHrefs()) {
    const isRelative = href.startsWith('/');
    const isPortal = href === env.portalOrigin;
    assert.ok(isRelative || isPortal, `unexpected href shape: ${href}`);
  }
});
