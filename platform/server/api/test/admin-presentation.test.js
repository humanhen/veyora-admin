/* Batch 1I — admin presentation micro-fix.

   Two RC findings: the Backorders action buttons were clipped at desktop width,
   and two dashboard pulse tiles did not say which currency they aggregated.

   Assertions run against the SHIPPED sources — js/pages_sales.js,
   js/pages_core.js and css/styles.css — with comments stripped from the JS, so
   a comment can never satisfy one. Nothing here is re-implemented. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOf = p => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* CSS: strip comments, then collapse whitespace so a rule can be matched
   without depending on how it happens to be wrapped. */
const CSS = read('css/styles.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const cssRule = selector => {
  const at = CSS.indexOf(selector + '{');
  if (at < 0) return null;
  return CSS.slice(at, CSS.indexOf('}', at) + 1).replace(/\s+/g, '');
};

/* ============ 1 — Backorders actions must not be clipped ============ */

const SALES = codeOf('js/pages_sales.js');
const BACKORDERS = SALES.slice(SALES.indexOf("App.register('backorders'"),
                               SALES.indexOf("App.register('returns'"));

test('the actions container is allowed to wrap', () => {
  const rule = cssRule('.row-actions');
  assert.ok(rule, '.row-actions rule found');
  assert.match(rule, /flex-wrap:wrap/,
    'a nowrap flex row is what forced the three controls past the card edge');
  assert.match(rule, /display:flex/, 'it is still a flex row');
  /* Column spacing is unchanged so no other table shifts; the row gap only
     shows once something has actually wrapped. */
  assert.match(rule, /gap:6px2px/, 'row-gap 6px, column-gap unchanged at 2px');
});

test('the actions column is given room and cannot cut a button off', () => {
  const flat = CSS.replace(/\s+/g, '');
  assert.match(flat, /\.tblth\.col-actions,\.tbltd\.col-actions\{width:1%\}/,
    'the column shrinks to fit rather than taking an equal share');
  assert.match(flat, /\.tbltd\.col-actions\.row-actions\{min-width:132px\}/,
    'but never below the widest control');
  /* Scoped above the card-table breakpoint: below it every row becomes a card
     and a 1% cell would collapse to nothing. */
  const at = CSS.indexOf('.col-actions');
  const guard = CSS.lastIndexOf('@media(min-width:821px)', at);
  assert.ok(guard > -1 && guard < at,
    'the width rule sits inside @media(min-width:821px)');
});

test('the widest headings may use two lines instead of widening the table', () => {
  assert.ok(CSS.replace(/\s+/g, '').includes('.tbltheadth.wrap{white-space:normal;min-width:74px}'),
    'a .wrap heading overrides the table-wide nowrap');
  /* The default stays nowrap — only opted-in headings wrap. */
  assert.match(cssRule('.tbl thead th'), /white-space:nowrap/,
    'other headings are unchanged');
});

test('the Backorders table opts the long headings and the actions cell in', () => {
  for (const heading of ['Backorder #', 'Original Order',
                         'Customer authorised', 'Stock cleared']) {
    assert.ok(BACKORDERS.includes(`<th class="wrap">${heading}</th>`),
      `"${heading}" must be a wrapping heading`);
  }
  assert.match(BACKORDERS, /<th class="col-actions">Actions<\/th>/);
  assert.match(BACKORDERS, /<td class="col-actions"><div class="row-actions">/);
});

test('the ten columns and the empty-row colspan still agree', () => {
  const head = BACKORDERS.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  assert.ok(head, 'the header row is present');
  // `<th(?=[\s>])` so a `<thead>` can never be miscounted as a column.
  const ths = head[1].match(/<th(?=[\s>])[^>]*>/g) || [];
  assert.equal(ths.length, 10, 'still ten columns');
  assert.match(BACKORDERS, /colspan="10"/, 'the empty state still spans them all');
  /* Batch 1G: two columns that mean different things, named differently. */
  const labels = [...head[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.equal(labels.filter(x => x === 'Customer').length, 1,
    'exactly one column is plainly "Customer"');
  assert.ok(labels.includes('Customer authorised'));
});

test('all three actions are still rendered for an applicable open backorder', () => {
  /* OPEN_BO covers 'open' and the legacy 'approved'. An open, not-yet-cleared
     record shows all three controls. */
  assert.match(BACKORDERS,
    /OPEN_BO\(b\)&&!b\.eligible\?`<button class="btn btn-sm" data-el="\$\{b\.id\}">Mark stock cleared<\/button>`/,
    'Mark stock cleared');
  assert.match(BACKORDERS,
    /OPEN_BO\(b\)\?`<button class="btn btn-sm btn-dark" data-cv="\$\{b\.id\}">Convert<\/button>`/,
    'Convert');
  assert.match(BACKORDERS,
    /<button class="icon-btn" data-view="\$\{b\.id\}" title="Details">/,
    'Details');
  /* Details is unconditional — it must never depend on state. */
  const detailsAt = BACKORDERS.indexOf('data-view="${b.id}"');
  const line = BACKORDERS.slice(BACKORDERS.lastIndexOf('\n', detailsAt), detailsAt);
  assert.ok(!/\?`/.test(line), 'the details control is not behind a condition');
});

test('layout only — no action behaviour or eligibility rule changed', () => {
  assert.match(BACKORDERS, /await DB\.setBackorderEligibility\(bo\.id,true\)/);
  assert.match(BACKORDERS, /await DB\.convertBackorder\(bo\.id\)/);
  assert.match(BACKORDERS, /await DB\.refreshLive\(\)/,
    'both still re-read the server afterwards');
  assert.match(BACKORDERS, /Modal\.confirm\('Convert Backorder'/,
    'Convert still confirms first');
  assert.match(BACKORDERS, /err\.status===409&&err\.data&&err\.data\.shortages/,
    'the server shortage list is still rendered');
  /* Nothing decides convertibility in the browser. */
  assert.ok(!/bo\.eligible\s*=[^=]/.test(BACKORDERS));
  assert.ok(!/bo\.status\s*=[^=]/.test(BACKORDERS));
  assert.match(BACKORDERS, /function OPEN_BO/.test(SALES) ? /OPEN_BO\(b\)/ : /OPEN_BO/);
});

test('the mobile card layout keeps the actions inside the card', () => {
  const flat = CSS.replace(/\s+/g, '');
  /* Below 820px rows become cards and the wrapper stops scrolling, so the
     buttons must wrap rather than run past the card edge — which is what
     flex-wrap now guarantees. The existing right alignment is unchanged. */
  assert.match(flat, /\.table-wrap\{border:none;overflow:visible\}/);
  assert.match(flat, /\.tbl\.row-actions\{justify-content:flex-end\}/);
  assert.match(cssRule('.row-actions'), /flex-wrap:wrap/,
    'the same wrap rule applies at every width');
});

/* ============ 2 — dashboard currency labels ============ */

const CORE = codeOf('js/pages_core.js');

test('the two aggregate pulse tiles name their currency', () => {
  assert.match(CORE, /<div class="stat-label">REVENUE \(USD\) &middot; LAST 24H/);
  assert.match(CORE, /<div class="stat-label">AVG ORDER VALUE \(USD\) &middot; LAST 24H/);
  assert.ok(!/>REVENUE &middot; LAST 24H/.test(CORE), 'the unlabelled version is gone');
  assert.ok(!/AVG ORDER VALUE &middot; L…/.test(CORE),
    'the truncated, unlabelled version is gone');
});

test('the tiles that are NOT money are left alone', () => {
  for (const label of ['ORDERS &middot; LAST 24H', 'ACTIVE CARTS', 'AGENTS ACTIVE',
                       'CUSTOMERS ORDERIN']) {
    assert.ok(CORE.includes(label), `"${label}" is unchanged`);
  }
  assert.ok(!/ORDERS \(USD\)/.test(CORE), 'a count is not money');
});

test('the calculations behind both tiles are untouched', () => {
  assert.match(CORE, /const rev24=p24\.reduce\(\(s,o\)=>s\+o\.total,0\);/);
  assert.match(CORE, /const aov24=p24\.length\?rev24\/p24\.length:null;/);
  assert.match(CORE, /const cut24=new Date\(Date\.now\(\)-864e5\);/);
  assert.match(CORE, /\$\{p24\.length\?money\(rev24\):'—'\}/,
    'the revenue tile still renders the same value');
  assert.match(CORE, /\$\{aov24!=null\?money\(aov24\):'—'\}/,
    'and so does the average');
  /* Base USD: these sum orders in mixed currencies, so orderMoney would be
     wrong here — it converts per order. Batch 1G established this. */
  assert.ok(!/orderMoney/.test(CORE),
    'dashboard aggregates are never converted per order');
});

test('the rest of the dashboard USD labelling from Batch 1G still stands', () => {
  assert.match(CORE, /REVENUE \(USD\) \$\{I\.money\}/, 'the performance tile');
  assert.match(CORE, /\['Revenue \(USD\)','revenue'/, 'the by-country column');
  assert.match(codeOf('js/pages_ops.js'), /<div class="page-title">Revenue \(USD\)<\/div>/);
  assert.match(codeOf('js/pages_sales.js'), /'Customer','Orders','Amount \(USD\)','Frames'/);
});

test('the six pulse tiles stay on one baseline once a label wraps', () => {
  const flat = CSS.replace(/\s+/g, '');
  assert.match(flat, /\.dash\.stat-label\{font-size:9px;align-items:flex-start;min-height:2\.4em\}/,
    'a shared minimum height keeps the row from going ragged');
});
