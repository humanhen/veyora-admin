/* The Public Content administration screens (B2.4B2A).

   Drives the REAL shipped js/*.js in the vm harness with a stubbed fetch:
   capability loading, navigation, lists, and the three editors. Assertions
   are on rendered output and on the requests actually sent. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_permissions.js', 'js/pages_public_content.js'];

const BRAND = {
  id: 'br_1', slug: 'example-brand', name: 'Example Brand', shortName: 'EX', segment: 'premium',
  headline: 'A headline', summary: 'A summary', story: 'A story', idealRetailer: 'Boutiques',
  priceTierLabel: 'Accessible luxury', designOrigin: 'Italy', manufacturingOrigin: 'Italy',
  styleTraits: ['minimal', 'architectural'], approvedMaterials: ['acetate'],
  logoMediaId: null, heroMediaId: null,
  governance: { publicationState: 'draft', verificationStatus: 'sourced', sourceReference: 'Brand book p12',
    lastReviewedAt: '2026-07-01T00:00:00.000Z', scheduledReviewAt: null,
    contentUpdatedAt: '2026-08-01T00:00:00.000Z', factOwnerId: null },
  isPublished: false, concurrencyToken: 'brand:br_1:v1',
  updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
};

const VARIATION = {
  id: 'v_1', productId: 'p_1', sku: '20894-BLK', colorName: 'Black', colorCode: 'BLK',
  swatchMediaId: null, isPublished: false, isActiveInPortal: true,
  concurrencyToken: 'variation:v_1:v1', createdAt: '2026-01-01T00:00:00.000Z',
};

const PRODUCT = {
  id: 'p_1', sku: '20894', name: 'Aviator', publicSlug: 'aviator', brandId: 'br_1',
  legacyBrandText: 'Legacy Brand', line: 'Heritage', shape: 'Pilot', segment: 'premium',
  size: '54-18-145', publicDescription: 'A description', categories: ['sun'],
  isPublished: false, isFeatured: false, isDiscontinued: false, replacementProductId: null,
  isActiveInPortal: true,
  governance: { publicationState: 'draft', verificationStatus: 'unverified', sourceReference: '',
    lastReviewedAt: null, scheduledReviewAt: null, contentUpdatedAt: null, factOwnerId: null },
  variations: [VARIATION],
  concurrencyToken: 'product:p_1:v1',
  updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
};

const CAPS = (view, edit, publish) => async () => ({ status: 200, body: { capabilities: { view, edit, publish } } });
const ok = (body) => async () => ({ status: 200, body });
const fail = (status, body = {}) => async () => ({ status, body });

/**
 * Boots the panel with a stubbed fetch and renders #/public-content<path>.
 * @param caps [view, edit, publish]
 */
async function render(path = '', { caps = [true, true, false], routes = {}, manage = false } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/account-permissions/registry': async () =>
      manage ? { status: 200, body: { permissions: [] } } : { status: 403, body: {} },
    'GET /admin/public-content/capabilities': CAPS(caps[0], caps[1], caps[2]),
    'GET /admin/public-content/brands': ok({ brands: [BRAND] }),
    'GET /admin/public-content/products': ok({ products: [PRODUCT] }),
    'GET /admin/public-content/brands/br_1': ok({ brand: BRAND }),
    'GET /admin/public-content/products/p_1': ok({ product: PRODUCT }),
    'GET /admin/public-content/variations/v_1': ok({ variation: VARIATION }),
  }, routes);

  sandbox.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const p = String(url).replace(/^\/api/, '');
    calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
    const responder = table[`${method} ${p}`] || table[`${method} *`];
    const r = responder ? await responder() : { status: 404, body: { error: 'not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };

  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_1', name: 'Editor', role: 'admin' }));
  sandbox.location.hash = '#/public-content' + path;
  await sandbox.App.loadCaps();

  const el = sandbox.document.getElementById('content');
  const args = path.split('/').filter(Boolean);
  sandbox.App.routes['public-content'](el, args);
  await settle();
  return { sandbox, el, calls };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };

const saveBtn = (el) => el.querySelector('[data-pc-save]');
const field = (el, col) => el.querySelector(`[data-pc-field="${col}"]`);
const patchOf = (calls) => calls.find(c => c.method === 'PATCH');

// ---------------------------------------------------------------------------
// 1/2/3/4/5/6 — capabilities, navigation, access
// ---------------------------------------------------------------------------

test('1/3 — the nav entry is hidden without view, including for a role-only administrator', async () => {
  const { sandbox } = await render('', { caps: [false, false, false] });
  assert.equal(sandbox.App.can('public_content.view'), false);
  sandbox.App.ready = true;
  sandbox.App.renderNav();
  const nav = sandbox.document.getElementById('side-nav');
  assert.equal(nav.querySelector('[href="#/public-content"]'), null);
  assert.ok(nav.querySelector('[href="#/audit"]'), 'unrelated entries still render');
});

test('2 — the nav entry appears with view capability', async () => {
  const { sandbox } = await render('', { caps: [true, false, false] });
  sandbox.App.ready = true;
  sandbox.App.renderNav();
  const link = sandbox.document.getElementById('side-nav').querySelector('[href="#/public-content"]');
  assert.ok(link);
  assert.match(link.textContent, /Public Content/);
});

test('4 — a direct visit without view renders access denied, not the screen', async () => {
  const { el } = await render('/brands', { caps: [false, false, false] });
  assert.match(el.textContent, /Access denied/);
  assert.equal(el.querySelector('[data-pc-save]'), null);
  assert.equal(el.querySelector('.tbl'), null);
});

test('4 — a direct visit to a record without view is denied too', async () => {
  const { el, calls } = await render('/brands/br_1', { caps: [false, false, false] });
  assert.match(el.textContent, /Access denied/);
  assert.ok(!calls.some(c => c.path.includes('/brands/br_1')), 'no record may be fetched');
});

test('5 — logout clears all public-content capability state', async () => {
  const { sandbox } = await render('', { caps: [true, true, true] });
  assert.equal(sandbox.App.can('public_content.edit'), true);
  sandbox.App.ready = true;
  sandbox.App.renderNav();
  sandbox.document.getElementById('logout-btn').click();

  assert.equal(sandbox.App.caps, null);
  assert.equal(sandbox.App.capsChecked, false);
  for (const k of ['public_content.view', 'public_content.edit', 'public_content.publish']) {
    assert.equal(sandbox.App.can(k), false, `${k} survived logout`);
  }
});

test('6 — a malformed capability response fails closed', async () => {
  for (const body of [{}, { capabilities: null }, { capabilities: { view: 'yes', edit: 1 } }, null]) {
    const { sandbox } = await render('', { routes: { 'GET /admin/public-content/capabilities': ok(body) } });
    for (const k of ['public_content.view', 'public_content.edit', 'public_content.publish']) {
      assert.equal(sandbox.App.can(k), false, `${JSON.stringify(body)} granted ${k}`);
    }
  }
});

test('6 — a 401, 403 or network failure on the capability call fails closed', async () => {
  for (const responder of [fail(401), fail(403), fail(500), async () => { throw new Error('down'); }]) {
    const { sandbox } = await render('', { routes: { 'GET /admin/public-content/capabilities': responder } });
    assert.equal(sandbox.App.can('public_content.view'), false);
    assert.equal(sandbox.App.capsChecked, true);
  }
});

test('a stale capability set cannot survive into a failed re-probe', async () => {
  const { sandbox } = await render('', { caps: [true, true, true] });
  assert.equal(sandbox.App.can('public_content.edit'), true);
  sandbox.fetch = async () => { throw new Error('network down'); };
  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('public_content.edit'), false, 'the previous session leaked through');
});

test('the B2.4B1 permissions.manage probe still works alongside', async () => {
  const { sandbox } = await render('', { caps: [true, false, false], manage: true });
  assert.equal(sandbox.App.can('permissions.manage'), true);
  assert.equal(sandbox.App.can('public_content.view'), true);
});

// ---------------------------------------------------------------------------
// 7/8/9 — lists
// ---------------------------------------------------------------------------

test('7 — the brand list renders safe administrative fields with state badges', async () => {
  const { el } = await render('/brands');
  assert.match(el.textContent, /Example Brand/);
  assert.match(el.textContent, /example-brand/);
  assert.match(el.textContent, /draft/);
  assert.match(el.textContent, /sourced/);
  assert.match(el.textContent, /Not published/);
});

test('7 — the product list renders and links to records', async () => {
  const { el } = await render('/products');
  assert.match(el.textContent, /Aviator/);
  const link = el.querySelector('[href="#/public-content/products/p_1"]');
  assert.ok(link, 'a stable link to the record must exist');
});

test('8 — a failed list load is an error with a retry, never an empty list', async () => {
  const { el } = await render('/brands', { routes: { 'GET /admin/public-content/brands': fail(500, {}) } });
  assert.match(el.textContent, /Could not load public content/);
  assert.match(el.textContent, /not an empty catalogue/i);
  assert.doesNotMatch(el.textContent, /No brands exist yet/);
  assert.ok(el.querySelector('[data-pc-retry]'));
});

test('8 — a malformed list body is an error, not an empty list', async () => {
  const { el } = await render('/brands', { routes: { 'GET /admin/public-content/brands': ok({ nope: true }) } });
  assert.match(el.textContent, /Could not load public content/);
});

test('a genuinely empty list says so distinctly', async () => {
  const { el } = await render('/brands', { routes: { 'GET /admin/public-content/brands': ok({ brands: [] }) } });
  assert.match(el.textContent, /No brands exist yet/);
});

test('9 — record selection is carried by the URL, not hidden state', async () => {
  const { el } = await render('/brands');
  assert.ok(el.querySelector('[href="#/public-content/brands/br_1"]'));
  const detail = await render('/brands/br_1');
  assert.match(detail.el.textContent, /Example Brand/);
  assert.ok(detail.el.querySelector('#pc-form'), 'the editor rendered from the URL alone');
});

test('18 — no price, cost, stock or availability data appears anywhere', async () => {
  /* Targets DATA, not prose: a control bound to such a field, or a rendered
     amount. The words themselves legitimately occur in explanatory copy
     ("Publishing is not available here", "Price tier label"), so matching
     bare substrings would fail on sentences that say the opposite. */
  for (const path of ['/brands', '/products', '/brands/br_1', '/products/p_1', '/products/p_1/variations/v_1']) {
    const { el } = await render(path);

    for (const ctl of el.querySelectorAll('[data-pc-field]')) {
      /* `price_tier_label` is on the API's own brand allowlist and is a
         DESCRIPTIVE string ("Accessible luxury") — never an amount. It is
         exempt by name, and the digit check below is what actually holds it
         to that. */
      if (ctl.dataset.pcField === 'price_tier_label') continue;
      assert.doesNotMatch(ctl.dataset.pcField, /price|cost|stock|qty|inventory|availab|balance/i,
        `${path} binds a control to ${ctl.dataset.pcField}`);
    }
    for (const forbidden of ['salePrice', 'purchase_price', 'purchasePrice', 'stockQty', 'quantity', 'inventory', 'balance']) {
      assert.ok(!el.innerHTML.includes(forbidden), `${path} rendered ${forbidden}`);
    }
    assert.ok(!/\$\s?\d/.test(el.textContent), `${path} rendered a currency amount`);
    // "Price tier label" is a descriptive string field, never an amount.
    const tier = field(el, 'price_tier_label');
    if (tier) assert.ok(!/\d/.test(tier.value), 'the price tier label must not carry a number');
  }
});

// ---------------------------------------------------------------------------
// 10/11/12 — view vs edit separation
// ---------------------------------------------------------------------------

test('10 — a view-only account sees the record with every control disabled', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, false, false] });
  const controls = el.querySelectorAll('[data-pc-field]');
  assert.ok(controls.length > 5, 'the record must still be visible');
  for (const c of controls) assert.equal(c.disabled, true, `${c.dataset.pcField} is editable without the capability`);
  assert.equal(saveBtn(el).disabled, true);
  assert.match(el.textContent, /read-only access/i);
});

test('11 — an edit account can edit, and no publish control exists anywhere', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, true, false] });
  assert.equal(field(el, 'headline').disabled, false);

  for (const path of ['/brands/br_1', '/products/p_1', '/products/p_1/variations/v_1']) {
    const r = await render(path, { caps: [true, true, true] });
    assert.deepEqual(publishControls(r.el), [], `${path} has a publish control`);
    assert.equal(r.el.querySelector('[data-pc-field="is_published"]'), null);
  }
});

/** Any element that would actually trigger a publish: a button, or an option
 *  that could set the published state. Prose explaining that publishing is
 *  unavailable is not a control, so this looks at elements, not words. */
function publishControls(el) {
  const buttons = el.querySelectorAll('button').concat(el.querySelectorAll('a'))
    .filter(b => /^\s*(un)?publish\b/i.test(b.textContent.trim()));
  const options = el.querySelectorAll('option').filter(o => o.getAttribute('value') === 'published');
  return buttons.concat(options);
}

test('12 — edit does not imply publish: holding edit alone still shows no publish action', async () => {
  const { el, sandbox } = await render('/brands/br_1', { caps: [true, true, false] });
  assert.equal(sandbox.App.can('public_content.publish'), false);
  assert.deepEqual(publishControls(el), [], 'no control may trigger publication');

  // The state select never offers the published state.
  const options = field(el, 'publication_state').querySelectorAll('option').map(o => o.getAttribute('value'));
  assert.deepEqual(options, ['draft', 'verified', 'approved', 'retired']);
});

test('even with publish capability this screen offers no publish action', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, true, true] });
  assert.deepEqual(publishControls(el), [], 'publish is B2.4B2B, not this screen');
  assert.match(el.textContent, /Publication is a separate, gated action/i);
});

// ---------------------------------------------------------------------------
// 13/14/15/16/17/19/20 — saving
// ---------------------------------------------------------------------------

test('19/20 — editing locally makes no request and save is disabled until something changes', async () => {
  const { el, calls } = await render('/brands/br_1');
  assert.equal(saveBtn(el).disabled, true);
  const before = calls.length;

  field(el, 'headline').typeInto('A new headline');
  await settle();
  assert.equal(calls.length, before, 'typing must never call the API');
  assert.equal(saveBtn(el).disabled, false);

  field(el, 'headline').typeInto('A headline');   // back to the loaded value
  assert.equal(saveBtn(el).disabled, true, 'reverting by hand clears the dirty state');
});

test('13 — a brand save sends only the changed allowed fields plus the token', async () => {
  const { el, calls } = await render('/brands/br_1', {
    routes: { 'PATCH /admin/public-content/brands/br_1': ok({ brand: { ...BRAND, headline: 'New', concurrencyToken: 'brand:br_1:v2' } }) },
  });
  field(el, 'headline').typeInto('New');
  el.querySelector('#pc-form').submit();
  await settle();

  const put = patchOf(calls);
  assert.ok(put, 'a PATCH must have been sent');
  assert.deepEqual(Object.keys(put.body).sort(), ['concurrencyToken', 'headline']);
  assert.equal(put.body.headline, 'New');
  assert.equal(put.body.concurrencyToken, 'brand:br_1:v1');
});

test('14 — a product save sends only the changed allowed fields', async () => {
  const { el, calls } = await render('/products/p_1', {
    routes: { 'PATCH /admin/public-content/products/p_1': ok({ product: { ...PRODUCT, line: 'Modern' } }) },
  });
  field(el, 'line').typeInto('Modern');
  field(el, 'is_featured').check(true);
  el.querySelector('#pc-form').submit();
  await settle();

  const put = patchOf(calls);
  assert.deepEqual(Object.keys(put.body).sort(), ['concurrencyToken', 'is_featured', 'line']);
  assert.equal(put.body.is_featured, true);
});

test('15 — a variation save sends only its own allowed fields', async () => {
  const { el, calls } = await render('/products/p_1/variations/v_1', {
    routes: { 'PATCH /admin/public-content/variations/v_1': ok({ variation: { ...VARIATION, colorName: 'Jet' } }) },
  });
  field(el, 'color').typeInto('Jet');
  el.querySelector('#pc-form').submit();
  await settle();

  const put = patchOf(calls);
  assert.equal(put.path, '/admin/public-content/variations/v_1');
  assert.deepEqual(Object.keys(put.body).sort(), ['color', 'concurrencyToken']);
});

test('16/17 — actor, approval and is_published fields can never be sent', async () => {
  const { sandbox, calls } = await render('/brands/br_1', {
    routes: { 'PATCH /admin/public-content/brands/br_1': ok({ brand: BRAND }) },
  });
  // Even asked directly, the client filters to the API's allowlist.
  await sandbox.DB.patchAdminBrand('br_1', {
    headline: 'ok',
    is_published: true, fact_owner: 'u_x', approver_id: 'u_x', approved_at: 'now',
    id: 'br_evil', created_at: 'x', updated_at: 'x', price: 1, sku: 'X', brand: 'Y',
  }, 'brand:br_1:v1');

  const put = patchOf(calls);
  assert.deepEqual(Object.keys(put.body).sort(), ['concurrencyToken', 'headline']);
  for (const forbidden of ['is_published', 'fact_owner', 'approver_id', 'approved_at', 'price', 'sku']) {
    assert.ok(!(forbidden in put.body), `${forbidden} reached the request`);
  }
});

test('17 — no rendered control is bound to is_published', async () => {
  for (const path of ['/brands/br_1', '/products/p_1', '/products/p_1/variations/v_1']) {
    const { el } = await render(path, { caps: [true, true, true] });
    assert.equal(el.querySelector('[data-pc-field="is_published"]'), null, path);
  }
});

test('a response is never spread back into a request', async () => {
  const { sandbox, calls } = await render('/brands/br_1', {
    routes: {
      'GET /admin/public-content/brands/br_1': ok({ brand: { ...BRAND, injected: 'x', is_published: true } }),
      'PATCH /admin/public-content/brands/br_1': ok({ brand: BRAND }),
    },
  });
  const loaded = await sandbox.DB.adminBrand('br_1');
  assert.equal(loaded.injected, undefined, 'an unexpected response field must not survive shaping');
  await sandbox.DB.patchAdminBrand('br_1', loaded, 'brand:br_1:v1');
  const put = patchOf(calls);
  assert.ok(!('injected' in put.body));
  assert.ok(!('is_published' in put.body));
});

// ---------------------------------------------------------------------------
// 21/22 — concurrency
// ---------------------------------------------------------------------------

test('21 — a successful save replaces the concurrency token', async () => {
  const { el, calls } = await render('/brands/br_1', {
    routes: { 'PATCH /admin/public-content/brands/br_1': ok({ brand: { ...BRAND, concurrencyToken: 'brand:br_1:v2' } }) },
  });
  field(el, 'headline').typeInto('One');
  el.querySelector('#pc-form').submit();
  await settle();
  assert.equal(patchOf(calls).body.concurrencyToken, 'brand:br_1:v1');

  field(el, 'headline').typeInto('Two');
  el.querySelector('#pc-form').submit();
  await settle();

  const patches = calls.filter(c => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[1].body.concurrencyToken, 'brand:br_1:v2', 'the refreshed token must be used');
});

test('22 — a variation is saved with its own token, never the parent product’s', async () => {
  const { el, calls } = await render('/products/p_1/variations/v_1', {
    routes: { 'PATCH /admin/public-content/variations/v_1': ok({ variation: VARIATION }) },
  });
  field(el, 'color').typeInto('Jet');
  el.querySelector('#pc-form').submit();
  await settle();

  const put = patchOf(calls);
  assert.equal(put.body.concurrencyToken, 'variation:v_1:v1');
  assert.notEqual(put.body.concurrencyToken, PRODUCT.concurrencyToken);
});

// ---------------------------------------------------------------------------
// 23/24/25/26/27 — errors
// ---------------------------------------------------------------------------

async function saveWith(status, body, path = '/brands/br_1', col = 'headline') {
  const key = path.startsWith('/brands') ? 'brands/br_1' : 'products/p_1';
  const ctx = await render(path, {
    routes: { [`PATCH /admin/public-content/${key}`]: async () => ({ status, body }) },
  });
  field(ctx.el, col).typeInto('Changed');
  ctx.el.querySelector('#pc-form').submit();
  await settle();
  return ctx;
}

test('23 — a 400 renders field-level errors against the relevant controls', async () => {
  const { el } = await saveWith(400, {
    error: 'Invalid patch',
    fieldErrors: [
      { field: 'slug', code: 'INVALID_SLUG', message: 'Must be lower-case letters, numbers and hyphens.' },
      { field: 'headline', code: 'TOO_LONG', message: 'Too long.' },
    ],
  });
  assert.match(el.textContent, /Must be lower-case letters/);
  assert.match(el.textContent, /Too long\./);

  const slugField = field(el, 'slug').closest('.pc-field');
  assert.ok(slugField.classList.contains('has-error'), 'the failing field must be marked');
  assert.equal(slugField.querySelector('.pc-error').getAttribute('role'), 'alert');
});

test('24 — a 409 never reports success and never silently retries', async () => {
  const { el, calls } = await saveWith(409, { error: 'stale', code: 'STALE_TOKEN' });
  assert.match(el.textContent, /Another editor changed this brand/);
  assert.doesNotMatch(el.textContent, /Saved\./);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 1, 'exactly one attempt');
  assert.ok(el.querySelector('[data-pc-reload]'), 'a reload action must be offered');
  assert.match(el.querySelector('#pc-dirty').textContent, /Unsaved changes/,
    'the local edit is preserved until the operator chooses');
});

test('25 — reloading after a conflict retrieves the current stored version', async () => {
  let n = 0;
  const ctx = await render('/brands/br_1', {
    routes: {
      'PATCH /admin/public-content/brands/br_1': fail(409, { code: 'STALE_TOKEN' }),
      'GET /admin/public-content/brands/br_1': async () => ({
        status: 200,
        body: { brand: n++ === 0 ? BRAND : { ...BRAND, headline: 'Changed by someone else', concurrencyToken: 'brand:br_1:v9' } },
      }),
    },
  });
  field(ctx.el, 'headline').typeInto('Mine');
  ctx.el.querySelector('#pc-form').submit();
  await settle();

  ctx.el.querySelector('[data-pc-reload]').click();
  await settle();

  assert.equal(field(ctx.el, 'headline').value, 'Changed by someone else');
  assert.equal(saveBtn(ctx.el).disabled, true, 'the discarded local edit is gone after an explicit reload');
});

test('26 — 401, 403 and 404 render safe states', async () => {
  assert.match((await saveWith(401, {})).el.textContent, /session has expired/i);
  assert.match((await saveWith(403, {})).el.textContent, /does not have permission to edit/i);
  assert.match((await saveWith(404, {})).el.textContent, /no longer exists/i);
});

test('26 — a 404 on load renders a safe missing-record state, not a blank form', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'GET /admin/public-content/brands/br_1': fail(404, { error: 'Brand not found' }) },
  });
  assert.match(el.textContent, /no longer exists/i);
  assert.equal(el.querySelector('#pc-form'), null);
});

test('27 — a generic failure leaks no API detail, stack or infrastructure hint', async () => {
  const { el } = await saveWith(500, {
    error: 'update brands set ... failed: connection to 10.0.0.4:5432 refused',
    stack: 'at Object.query (/srv/api/src/db.js:14:9)',
  });
  const shown = el.textContent;
  assert.match(shown, /could not be saved/i);
  for (const leak of ['update brands', '10.0.0.4', '5432', 'db.js', 'at Object', 'connection to']) {
    assert.ok(!shown.includes(leak), `leaked "${leak}"`);
  }
});

test('a refused save leaves the record untouched and the edit still pending', async () => {
  const { el } = await saveWith(500, { error: 'boom' });
  assert.equal(field(el, 'headline').value, 'Changed', 'the attempted change is kept');
  assert.equal(saveBtn(el).disabled, false, 'the operator can retry deliberately');
});

// ---------------------------------------------------------------------------
// 28 — unsaved-change guard
// ---------------------------------------------------------------------------

test('28 — leaving a record with unsaved changes asks first', async () => {
  const { el, sandbox } = await render('/brands/br_1');
  field(el, 'headline').typeInto('Unsaved work');

  el.querySelector('[data-pc-back]').click();

  const modal = sandbox.document.getElementById('modal-root');
  assert.match(modal.textContent, /unsaved changes/i);
  assert.equal(sandbox.location.hash, '#/public-content/brands/br_1', 'navigation is held');

  modal.querySelector('[data-yes]').click();
  assert.equal(sandbox.location.hash, '#/public-content/brands', 'confirming proceeds');
});

test('leaving with no unsaved changes does not interrupt', async () => {
  const { el, sandbox } = await render('/brands/br_1');
  el.querySelector('[data-pc-back]').click();
  assert.equal(sandbox.document.getElementById('modal-root').textContent, '');
  assert.equal(sandbox.location.hash, '#/public-content/brands');
});

test('reset restores the loaded values and clears the dirty state', async () => {
  const { el } = await render('/brands/br_1');
  field(el, 'headline').typeInto('Changed');
  field(el, 'summary').typeInto('Also changed');
  assert.equal(saveBtn(el).disabled, false);

  el.querySelector('[data-pc-reset]').click();
  assert.equal(field(el, 'headline').value, 'A headline');
  assert.equal(field(el, 'summary').value, 'A summary');
  assert.equal(saveBtn(el).disabled, true);
});

// ---------------------------------------------------------------------------
// product context and variations
// ---------------------------------------------------------------------------

test('the product screen shows its variations and links into each', async () => {
  const { el } = await render('/products/p_1');
  assert.match(el.textContent, /Variations/);
  assert.match(el.textContent, /Black/);
  assert.ok(el.querySelector('[href="#/public-content/products/p_1/variations/v_1"]'));
});

test('read-only product context is shown but is not editable', async () => {
  const { el } = await render('/products/p_1', { caps: [true, true, false] });
  assert.match(el.textContent, /Legacy Brand/);
  assert.match(el.textContent, /Orderable in the portal/);
  assert.equal(field(el, 'sku'), null, 'sku is not editable through this API');
  assert.equal(field(el, 'legacy_brand_text'), null);
});

test('the variation screen carries its parent product context and a way back', async () => {
  const { el } = await render('/products/p_1/variations/v_1');
  assert.ok(el.querySelector('[href="#/public-content/products/p_1"]'), 'a route back to the model');
  assert.match(el.textContent, /Black/);
  assert.equal(field(el, 'color_code').value, 'BLK');
});

// ---------------------------------------------------------------------------
// accessibility
// ---------------------------------------------------------------------------

test('every control has a real label bound to it', async () => {
  for (const path of ['/brands/br_1', '/products/p_1', '/products/p_1/variations/v_1']) {
    const { el } = await render(path);
    for (const ctl of el.querySelectorAll('[data-pc-field]')) {
      assert.ok(ctl.id, `${path}: a control needs an id`);
      const label = el.querySelector(`label[for="${ctl.id}"]`);
      assert.ok(label, `${path}: no <label for="${ctl.id}">`);
      assert.ok(label.textContent.trim().length > 1);
    }
  }
});

test('the dirty indicator is an announced live region', async () => {
  const { el } = await render('/brands/br_1');
  const s = el.querySelector('#pc-dirty');
  assert.equal(s.getAttribute('role'), 'status');
  assert.equal(s.getAttribute('aria-live'), 'polite');
});

test('the list tabs are marked up as tabs with selection state', async () => {
  const { el } = await render('/products');
  const tabs = el.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 2);
  assert.equal(tabs.find(t => t.getAttribute('href').endsWith('products')).getAttribute('aria-selected'), 'true');
});
