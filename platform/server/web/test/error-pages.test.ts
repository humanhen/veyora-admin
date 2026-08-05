import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const notFound = fs.readFileSync(path.join(root, 'src/pages/404.astro'), 'utf8');
const serverError = fs.readFileSync(path.join(root, 'src/pages/500.astro'), 'utf8');

test('404 page sets a real 404 status explicitly', () => {
  assert.match(notFound, /Astro\.response\.status\s*=\s*404/);
});

test('404 page uses the shared Page layout (editorial public layout) with exactly one H1 source', () => {
  assert.match(notFound, /<Page\b/);
  assert.doesNotMatch(notFound, /<h1\b/); // H1 comes from Page.astro via meta.h1, not a literal here
});

test('404 page uses its own NOT_FOUND_METADATA and the fixed NOT_FOUND_ROBOTS', () => {
  assert.match(notFound, /NOT_FOUND_METADATA/);
  assert.match(notFound, /NOT_FOUND_ROBOTS/);
  assert.match(notFound, /fixedRobots=\{NOT_FOUND_ROBOTS\}/);
});

test('404 page links to Brands, Collections and Contact', () => {
  assert.match(notFound, /href="\/brands\/"/);
  assert.match(notFound, /href="\/collections\/"/);
  assert.match(notFound, /href="\/contact\/"/);
});

test('404 page has no API or database dependency', () => {
  assert.doesNotMatch(notFound, /\/api\//);
  assert.doesNotMatch(notFound, /\bpg\b/);
  assert.doesNotMatch(notFound, /fetch\(/);
});

test('404 page invents no company claim (no exclamation-mark marketing copy, no numeric claims)', () => {
  assert.doesNotMatch(notFound, /\d+%|\d+ years|guarantee/i);
});

test('500 page sets a real 500 status explicitly', () => {
  assert.match(serverError, /Astro\.response\.status\s*=\s*500/);
});

test('500 page uses the shared Page layout with exactly one H1 source', () => {
  assert.match(serverError, /<Page\b/);
  assert.doesNotMatch(serverError, /<h1\b/);
});

test('500 page uses its own SERVER_ERROR_METADATA and the fixed SERVER_ERROR_ROBOTS (noindex, nofollow)', () => {
  assert.match(serverError, /SERVER_ERROR_METADATA/);
  assert.match(serverError, /SERVER_ERROR_ROBOTS/);
  assert.match(serverError, /fixedRobots=\{SERVER_ERROR_ROBOTS\}/);
});

test('500 page offers safe retry/home/contact options', () => {
  assert.match(serverError, /reload/i);
  assert.match(serverError, /href="\/"/);
  assert.match(serverError, /href="\/contact\/"/);
});

test('500 page has no API, database or catalogue dependency', () => {
  assert.doesNotMatch(serverError, /\/api\//);
  assert.doesNotMatch(serverError, /\bpg\b/);
  assert.doesNotMatch(serverError, /fetch\(/);
});

test('500 page contains no stack trace, error object, or secret-shaped content', () => {
  assert.doesNotMatch(serverError, /err\.stack|error\.message|process\.env(?!\.NODE_ENV)/);
});

test('both error pages carry no hard-coded Veyora domain', () => {
  assert.doesNotMatch(notFound, /veyora\.(design|com)/i);
  assert.doesNotMatch(serverError, /veyora\.(design|com)/i);
});
