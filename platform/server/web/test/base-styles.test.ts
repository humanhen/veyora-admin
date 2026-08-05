import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = fs.readFileSync(path.join(root, 'src/styles/base.css'), 'utf8');

test('base styles include a :focus-visible rule using the focus-ring tokens', () => {
  assert.match(base, /:focus-visible\s*\{/);
  assert.match(base, /box-shadow:\s*var\(--focus-ring\)/);
});

test('base styles include a dark-surface :focus-visible variant', () => {
  assert.match(base, /\[data-surface=['"]dark['"]\]\s*:focus-visible/);
  assert.match(base, /box-shadow:\s*var\(--focus-ring-dark\)/);
});

test('base styles include a prefers-reduced-motion block', () => {
  assert.match(base, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('reduced-motion block disables transitions and animations, and pauses autoplay video', () => {
  const block = base.match(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/);
  assert.ok(block, 'reduced-motion block not found');
  assert.match(block![0], /animation-duration/);
  assert.match(block![0], /transition-duration/);
  assert.match(block![0], /video\[autoplay\]/);
});

test('form controls (input, select, textarea) retain a 16px minimum font size', () => {
  // Two separate input/select/textarea rules exist (square corners, then
  // font size) — anchor on the textarea that is immediately followed by
  // the font-size declaration, not the first (border-radius) rule.
  assert.match(base, /textarea\s*\{\s*\n\s*font-size:\s*16px/);
});

test('base styles declare a visible skip-link', () => {
  assert.match(base, /\.skip-link\s*\{/);
  assert.match(base, /\.skip-link:focus\s*\{/);
});

test('base styles apply overflow-x clip with a fallback', () => {
  assert.match(base, /overflow-x:\s*hidden/);
  assert.match(base, /@supports \(overflow-x:\s*clip\)/);
});

test('base styles give responsive images/video with intrinsic-size protection', () => {
  const rule = base.match(/img,\s*video\s*\{[\s\S]*?\}/);
  assert.ok(rule, 'img/video rule not found');
  assert.match(rule![0], /max-width:\s*100%/);
  assert.match(rule![0], /height:\s*auto/);
});

test('base styles are safe-area aware', () => {
  assert.match(base, /env\(safe-area-inset-bottom/);
});

test('square controls: no rounded-card or elevated-card utility exists', () => {
  assert.doesNotMatch(base, /\.rounded-card/i);
  assert.doesNotMatch(base, /\.elevated-card/i);
  assert.doesNotMatch(base, /box-shadow:\s*0 \d+px \d+px[^;]*rgba\(0,\s*0,\s*0/i, 'no invented drop shadow');
});

test('button/input/select/textarea are explicitly square (border-radius: 0)', () => {
  const rule = base.match(/button,\s*input,\s*select,\s*textarea\s*\{[\s\S]*?\}/);
  assert.ok(rule, 'control border-radius rule not found');
  assert.match(rule![0], /border-radius:\s*0/);
});
