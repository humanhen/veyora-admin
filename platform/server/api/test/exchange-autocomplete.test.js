/* Client feedback item C — the exchange frame is chosen, not typed.

   The return form asked the customer to type "Exchange for — SKU of the frame
   you want instead" into a free-text box. Nobody knows a SKU by heart, so the
   realistic outcomes were a typo or a blank.

   The search is bounded ON THE SERVER, which is the part that matters: a
   type-ahead reachable by any signed-in browser is a catalogue export unless
   the row count and the minimum query length are enforced where the query
   runs, not in the page that calls it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchExchangeVariations, EXCHANGE_SEARCH_LIMIT, EXCHANGE_SEARCH_MIN,
} from '../src/returns.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = path.resolve(HERE, '..', '..', 'storefront');
const code = fs.readFileSync(path.join(STOREFRONT, 'js/pages_orders.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Records the SQL and answers with a catalogue of `n` frames. */
function db(rowCount = 50) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const limit = params[params.length - 1];
      return {
        rows: Array.from({ length: Math.min(rowCount, limit) }, (_, i) => ({
          sku: `18${44 + i}.1`, name: 'Charlett Saint Cloud', color: 'Black',
          image: null, price: '120.00',
        })),
      };
    },
  };
}

test('a query shorter than the minimum runs no query at all', async () => {
  for (const term of ['', ' ', 'a', '  b ', null, undefined]) {
    const d = db();
    assert.deepEqual(await searchExchangeVariations(d, term), []);
    assert.equal(d.calls.length, 0, `"${term}" must not reach the database`);
  }
  assert.equal(EXCHANGE_SEARCH_MIN, 2);
});

test('the row count is capped in SQL, not merely sliced afterwards', async () => {
  const d = db(5000);
  const rows = await searchExchangeVariations(d, '1844');
  assert.equal(rows.length, EXCHANGE_SEARCH_LIMIT);
  assert.match(d.calls[0].sql, /limit \$\d+/, 'the limit is part of the query');
  assert.equal(d.calls[0].params[d.calls[0].params.length - 1], EXCHANGE_SEARCH_LIMIT);
});

test('a caller cannot raise the cap', async () => {
  const d = db(5000);
  const rows = await searchExchangeVariations(d, '1844', { limit: 100000 });
  assert.equal(rows.length, EXCHANGE_SEARCH_LIMIT, 'the ceiling is the module\'s, not the caller\'s');
});

test('a nonsensical limit falls back to the cap rather than to zero or NaN', async () => {
  for (const limit of [0, -5, 'lots', null, NaN]) {
    const d = db(5000);
    const rows = await searchExchangeVariations(d, '1844', { limit });
    assert.ok(rows.length > 0 && rows.length <= EXCHANGE_SEARCH_LIMIT,
      `limit ${limit} produced ${rows.length}`);
  }
});

test('the search never returns a price', async () => {
  /* A hide-prices account must not be handed prices through a search box that
     the catalogue itself withholds. Identifying a frame does not need one. */
  const rows = await searchExchangeVariations(db(), '1844');
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['color', 'image', 'name', 'sku']);
  }
});

test('LIKE metacharacters are escaped so they are searched for, not matched with', async () => {
  const d = db();
  await searchExchangeVariations(d, '50%');
  const [like] = d.calls[0].params;
  assert.equal(like, '%50\\%%', 'the percent the customer typed is a literal');
  assert.match(d.calls[0].sql, /escape '\\'/, 'and the escape character is declared');

  const d2 = db();
  await searchExchangeVariations(d2, '_x');
  assert.equal(d2.calls[0].params[0], '%\\_x%');
});

test('the term is passed as a parameter, never interpolated into SQL', async () => {
  const d = db();
  await searchExchangeVariations(d, "'; drop table variations; --");
  assert.ok(!/drop table/i.test(d.calls[0].sql), 'the SQL text is fixed');
  assert.match(d.calls[0].params[0], /drop table/, 'the input travelled as a parameter');
});

test('only active products and variations are offered', async () => {
  const d = db();
  await searchExchangeVariations(d, '1844');
  assert.match(d.calls[0].sql, /p\.is_active/);
  assert.match(d.calls[0].sql, /v\.is_active is distinct from false/);
});

test('a prefix match on the SKU sorts above an incidental one', async () => {
  const d = db();
  await searchExchangeVariations(d, '1844');
  assert.match(d.calls[0].sql, /order by \(v\.sku ilike \$2[^)]*\) desc/,
    'typing a SKU should surface that SKU first');
});

/* ============ the form that consumes it ============ */

test('the picker debounces rather than searching on every keystroke', () => {
  assert.match(code, /debounce\(async \(\) => \{[\s\S]*?exchange-search/,
    'the search is wrapped in debounce()');
});

test('a stale response cannot overwrite a newer one', () => {
  /* Typing "1844" fires one request; a slow earlier one must not land after
     it and repaint the older results. */
  assert.match(code, /const mine = \+\+token;/);
  assert.match(code, /if \(mine !== token\) return;/);
});

test('the picker is a real combobox for keyboard and screen-reader users', () => {
  for (const attr of ['role="combobox"', 'aria-expanded', 'aria-autocomplete="list"',
    'aria-controls', 'role="listbox"', 'role="option"', 'aria-selected',
    'aria-activedescendant']) {
    assert.ok(code.includes(attr), `the picker must set ${attr}`);
  }
});

test('arrow keys, Enter and Escape are all handled', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
    assert.match(code, new RegExp(`'${key}'`), `${key} must be handled`);
  }
  assert.match(code, /active = e\.key === 'ArrowDown'[\s\S]*?results\.length/,
    'the selection wraps rather than sticking at the ends');
});

test('editing the text after a pick clears the chosen SKU', () => {
  /* The hidden SKU is what gets submitted. If it survived an edit, a customer
     could see one frame in the box and send another. */
  assert.match(code, /input\.addEventListener\('input', \(\) => \{[\s\S]{0,300}?hidden\.value = '';/);
});

test('an exchange cannot be submitted without a chosen frame', () => {
  assert.match(code, /if \(!chosen\) \{[\s\S]{0,160}?return;/,
    'submission stops rather than sending an exchange with no replacement');
});

/* ============ the form is driven by orders, and sends no price ============ */

test('the form is built from the customer\'s own returnable orders', () => {
  assert.match(code, /API\.get\('\/user\/returnable-orders'\)/);
  assert.ok(!/placeholder="SKU/.test(code), 'the free-text SKU box is gone');
  assert.ok(!/id="rOrder" placeholder/.test(code), 'so is the free-text order box');
});

test('the quantity control is bounded by what the server said is returnable', () => {
  assert.match(code, /const max = Number\(row\.dataset\.max\)/);
  assert.match(code, /qtyBox\(1, 1, max\)/);
});

test('a fully returned line is shown but cannot be selected', () => {
  assert.match(code, /l\.returnableQty > 0[\s\S]{0,200}?class="r-on"/,
    'the checkbox is only rendered when something remains');
  assert.match(code, /all \$\{l\.qty\} already returned/,
    'and the customer is told why, rather than the line vanishing');
});

test('the submitted payload carries no price', () => {
  const submit = code.slice(code.indexOf("API.post('/user/returns'"));
  const call = submit.slice(0, submit.indexOf('});'));
  assert.ok(!/price/i.test(call), 'the browser may not name a refund amount');
  for (const field of ['orderNumber', 'notes', 'items']) {
    assert.ok(call.includes(field), `${field} is sent`);
  }
});

test('the item payload is only the four fields the server validates', () => {
  const build = code.slice(code.indexOf('const item = {'));
  const literal = build.slice(0, build.indexOf('};'));
  assert.match(literal, /sku,/);
  assert.match(literal, /qty:/);
  assert.match(literal, /resolution,/);
  assert.ok(!/price/i.test(literal));
});
