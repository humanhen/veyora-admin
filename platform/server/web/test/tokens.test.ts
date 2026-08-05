import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tokens = fs.readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');

// Every value asserted here is a literal from
// docs/public-website-rebuild/02_VISUAL_SYSTEM_INVENTORY.md §6, itself
// ported from body.hm-dark in platform/server/storefront/css/store.css.
const APPROVED_SOURCE_VALUES: Record<string, string> = {
  '--canvas': '#f5f2ec',
  '--paper': '#fffdf9',
  '--stone': '#ebe5db',
  '--ink': '#191612',
  '--ink-soft': 'rgba(25, 22, 18, 0.64)',
  '--ink-faint': 'rgba(25, 22, 18, 0.42)',
  '--rule': 'rgba(25, 22, 18, 0.14)',
  '--night': '#141210',
  '--void': '#0d0b0a',
};

test('tokens.css contains the approved source colour values', () => {
  for (const [name, value] of Object.entries(APPROVED_SOURCE_VALUES)) {
    assert.ok(
      tokens.includes(`${name}: ${value}`),
      `expected ${name}: ${value} in tokens.css`
    );
  }
});

test('tokens.css declares the approved serif stack', () => {
  assert.match(tokens, /--serif:\s*'Iowan Old Style'/);
});

test('tokens.css declares a Montserrat-oriented sans stack', () => {
  assert.match(tokens, /--sans:\s*'Montserrat',\s*sans-serif/);
});

test('tokens.css declares the editorial type scale (display/lead/body/eyebrow/label)', () => {
  for (const name of ['--display', '--display-sm', '--display-xs', '--lead', '--body', '--label', '--eyebrow']) {
    assert.match(tokens, new RegExp(`${name.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')}:`));
  }
});

test('tokens.css declares layout container, gutter, section rhythm and gap', () => {
  assert.match(tokens, /--container:\s*1320px/);
  assert.match(tokens, /--gutter:/);
  assert.match(tokens, /--section:/);
  assert.match(tokens, /--gap:/);
});

test('tokens.css declares approved motion durations', () => {
  assert.match(tokens, /--motion:\s*0\.18s/);
  assert.match(tokens, /--motion-slow:\s*0\.22s/);
});

test('tokens.css declares control and link heights', () => {
  assert.match(tokens, /--control-h:\s*50px/);
  assert.match(tokens, /--link-h:\s*44px/);
});

test('tokens.css declares the one source-supported soft lift shadow, not a card shadow', () => {
  assert.match(tokens, /--shadow-lift:\s*0 24px 60px rgba\(25, 22, 18, 0\.16\)/);
  assert.doesNotMatch(tokens, /--shadow-card/i);
  assert.doesNotMatch(tokens, /card-shadow/i);
});

test('tokens.css declares accessible focus-ring tokens (light and dark surface)', () => {
  assert.match(tokens, /--focus-ring:/);
  assert.match(tokens, /--focus-ring-dark:/);
});

test('square-corner policy: --radius exists and is 0', () => {
  assert.match(tokens, /--radius:\s*0\s*;/);
});

test('no rounded-card token exists anywhere in tokens.css', () => {
  assert.doesNotMatch(tokens, /--radius-card/i);
  assert.doesNotMatch(tokens, /--card-radius/i);
  assert.doesNotMatch(tokens, /radius:\s*(?!0\s*;)[1-9]/, 'no non-zero radius value of any kind');
});

test('tokens.css invents no accent colour, gradient or icon-palette token', () => {
  assert.doesNotMatch(tokens, /--accent/i);
  assert.doesNotMatch(tokens, /--gradient/i);
  assert.doesNotMatch(tokens, /--icon/i);
});
