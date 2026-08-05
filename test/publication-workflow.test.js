/* The publication workflow interface (B2.4B2B).

   Drives the REAL shipped js/*.js in the vm harness: evaluation, publish and
   unpublish, their confirmations, capability separation, concurrency and the
   dirty-edit policy. Assertions are on rendered output and on the requests
   actually sent. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_permissions.js', 'js/pages_public_content.js'];

const BRAND = {
  id: 'br_1', slug: 'example-brand', name: 'Example Brand', shortName: '', segment: 'premium',
  headline: 'A headline', summary: 'A summary', story: '', idealRetailer: '', priceTierLabel: '',
  designOrigin: '', manufacturingOrigin: '', styleTraits: [], approvedMaterials: [],
  logoMediaId: null, heroMediaId: null,
  governance: { publicationState: 'approved', verificationStatus: 'verified', sourceReference: 'Brand book',
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
  legacyBrandText: 'Legacy', line: '', shape: 'Pilot', segment: 'premium', size: '54-18-145',
  publicDescription: 'A description', categories: [],
  isPublished: false, isFeatured: false, isDiscontinued: true, replacementProductId: null,
  isActiveInPortal: true,
  governance: { publicationState: 'approved', verificationStatus: 'verified', sourceReference: 'ref',
    lastReviewedAt: '2026-07-01T00:00:00.000Z', scheduledReviewAt: null,
    contentUpdatedAt: '2026-08-01T00:00:00.000Z', factOwnerId: null },
  advisories: [
    { code: 'PRODUCT_DISCONTINUED_NO_REPLACEMENT', message: 'This model is marked discontinued and names no replacement.', field: 'replacement_product_id' },
  ],
  variations: [VARIATION],
  concurrencyToken: 'product:p_1:v1',
  updatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
};

/* Deliberately out of alphabetical order so "server order preserved" is a
   real assertion rather than an accident of sorting. */
const BLOCKED_GATE = {
  allowed: false,
  reasons: [
    { code: 'BRAND_NO_SOURCE_REFERENCE', message: 'A source reference is required before publishing.', field: 'source_reference' },
    { code: 'BRAND_INVALID_SLUG', message: 'A valid public slug is required.', field: 'slug' },
    { code: 'BRAND_NO_PUBLISHABLE_VARIATION', message: 'At least one publishable colour is required.', field: 'variations[0].color' },
  ],
};
const ALLOWED_GATE = { allowed: true, reasons: [] };

const CAPS = (view, edit, publish) => async () => ({ status: 200, body: { capabilities: { view, edit, publish } } });
const ok = (body) => async () => ({ status: 200, body });
const fail = (status, body = {}) => async () => ({ status, body });

async function render(path = '/brands/br_1', { caps = [true, true, true], routes = {} } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/account-permissions/registry': fail(403, {}),
    'GET /admin/public-content/capabilities': CAPS(caps[0], caps[1], caps[2]),
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

  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_1', name: 'Ed', role: 'admin' }));
  sandbox.location.hash = '#/public-content' + path;
  await sandbox.App.loadCaps();

  const el = sandbox.document.getElementById('content');
  sandbox.App.routes['public-content'](el, path.split('/').filter(Boolean));
  await settle();
  return { sandbox, el, calls };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

const evalBtn = (el) => el.querySelector('[data-pc-evaluate]');
const pubBtn = (el) => el.querySelector('[data-pc-publish]');
const unpubBtn = (el) => el.querySelector('[data-pc-unpublish]');
const field = (el, col) => el.querySelector(`[data-pc-field="${col}"]`);
const modal = (sandbox) => sandbox.document.getElementById('modal-root');
const posts = (calls) => calls.filter(c => c.method === 'POST');

/** Clicks a decision button and confirms in the modal. */
function confirmDecision(sandbox, el, which) {
  (which === 'publish' ? pubBtn(el) : unpubBtn(el)).click();
  const go = modal(sandbox).querySelector('[data-pc-go]');
  assert.ok(go, 'a confirmation must be shown');
  go.click();
}

// ---------------------------------------------------------------------------
// 1/2/3/4 — capability separation
// ---------------------------------------------------------------------------

test('1 — a view-only account may check readiness but sees no publish or unpublish control', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, false, false] });
  /* Evaluation is gated on `view` by the API (the evaluate route uses
     canRead), so a viewer legitimately gets the readiness check. What they
     must not get is a decision. */
  assert.ok(evalBtn(el), 'readiness check is a read, available with view');
  assert.equal(pubBtn(el), null);
  assert.equal(unpubBtn(el), null);
  assert.match(el.textContent, /require the/i);
});

test('2 — an edit-only account sees no publish or unpublish control', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, true, false] });
  assert.equal(pubBtn(el), null, 'edit must not imply publish');
  assert.equal(unpubBtn(el), null);
  assert.equal(field(el, 'headline').disabled, false, 'but editing still works');
});

test('3 — a publish-only account gets publication controls without gaining edit controls', async () => {
  const { el } = await render('/brands/br_1', { caps: [true, false, true] });
  assert.ok(pubBtn(el), 'publish capability must expose the decision');
  for (const ctl of el.querySelectorAll('[data-pc-field]')) {
    assert.equal(ctl.disabled, true, `${ctl.dataset.pcField} editable without the edit capability`);
  }
  assert.equal(el.querySelector('[data-pc-save]').disabled, true);
});

test('4 — a role-only administrator gains nothing', async () => {
  const { el, sandbox } = await render('/brands/br_1', { caps: [false, false, false] });
  assert.equal(sandbox.App.can('public_content.publish'), false);
  assert.match(el.textContent, /Access denied/);
  assert.equal(evalBtn(el), null);
  assert.equal(pubBtn(el), null);
});

test('logout clears publish capability along with the rest', async () => {
  const { sandbox } = await render('/brands/br_1', { caps: [true, true, true] });
  sandbox.App.ready = true;
  sandbox.App.renderNav();
  sandbox.document.getElementById('logout-btn').click();
  assert.equal(sandbox.App.can('public_content.publish'), false);
  assert.equal(sandbox.App.caps, null);
});

// ---------------------------------------------------------------------------
// 5/6/7/8/9 — evaluation
// ---------------------------------------------------------------------------

test('5 — opening a record does not evaluate, and evaluation sends no mutation', async () => {
  const { el, calls } = await render('/brands/br_1');
  assert.equal(posts(calls).length, 0, 'opening a record must not call evaluate');
  assert.doesNotMatch(el.textContent, /Meets the publication requirements|Not ready to publish/);

  const after = await (async () => {
    const ctx = await render('/brands/br_1', {
      routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: ALLOWED_GATE }) },
    });
    evalBtn(ctx.el).click();
    await settle();
    return ctx;
  })();

  const evaluate = posts(after.calls).find(c => c.path.endsWith('/evaluate'));
  assert.ok(evaluate, 'the explicit action must call evaluate');
  assert.equal(evaluate.body, null, 'evaluate carries no body — it is a read');
  assert.ok(!after.calls.some(c => c.method === 'PATCH'), 'evaluation must not mutate');
});

test('evaluation does not disturb the concurrency token', async () => {
  const ctx = await render('/brands/br_1', {
    routes: {
      'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: ALLOWED_GATE }),
      'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true, concurrencyToken: 'brand:br_1:v2' } }),
    },
  });
  evalBtn(ctx.el).click();
  await settle();
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  const publish = posts(ctx.calls).find(c => c.path.endsWith('/publish'));
  assert.equal(publish.body.concurrencyToken, 'brand:br_1:v1', 'the token must survive an evaluation unchanged');
});

test('6/7 — gate reasons render in server order, with their field paths, and no raw JSON', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: BLOCKED_GATE }) },
  });
  evalBtn(el).click();
  await settle();

  const rendered = el.querySelectorAll('.pc-reason-code').map(n => n.textContent.trim());
  assert.deepEqual(rendered, BLOCKED_GATE.reasons.map(r => r.code), 'server order must be preserved exactly');

  for (const r of BLOCKED_GATE.reasons) assert.ok(el.textContent.includes(r.message), `missing "${r.message}"`);
  // A nested field path renders as text, safely.
  assert.match(el.textContent, /variations\[0\]\.color/);
  assert.doesNotMatch(el.innerHTML, /\{"code"|\[object Object\]/, 'no raw JSON dump');
});

test('8 — a blocked evaluation does not enable Publish', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: BLOCKED_GATE }) },
  });
  assert.equal(pubBtn(el).disabled, true, 'disabled before any check');
  evalBtn(el).click();
  await settle();
  assert.equal(pubBtn(el).disabled, true, 'still disabled when blocked');
  assert.match(el.textContent, /Not ready to publish/);
});

test('8 — a blocked record offers no bypass control', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: BLOCKED_GATE }) },
  });
  evalBtn(el).click();
  await settle();
  assert.doesNotMatch(el.textContent, /publish anyway|override|force|skip check/i);
  const options = field(el, 'publication_state').querySelectorAll('option').map(o => o.getAttribute('value'));
  assert.ok(!options.includes('published'), 'the state select must not be a bypass');
});

test('9 — an allowed evaluation enables Publish', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: ALLOWED_GATE }) },
  });
  evalBtn(el).click();
  await settle();
  assert.equal(pubBtn(el).disabled, false);
  assert.match(el.textContent, /Meets the publication requirements/);
});

test('advisories are shown separately from blockers and never block publication', async () => {
  const { el } = await render('/products/p_1', {
    routes: { 'POST /admin/public-content/products/p_1/evaluate': ok({ gate: ALLOWED_GATE }) },
  });
  assert.match(el.textContent, /Advisories/);
  assert.match(el.textContent, /do not block publication/i);
  assert.match(el.textContent, /marked discontinued and names no replacement/);

  evalBtn(el).click();
  await settle();
  assert.equal(pubBtn(el).disabled, false, 'an advisory must not block Publish');
});

test('a failed evaluation is reported without enabling Publish', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': fail(500, { error: 'boom' }) },
  });
  evalBtn(el).click();
  await settle();
  assert.match(el.textContent, /could not be completed/i);
  assert.equal(pubBtn(el).disabled, true);
});

// ---------------------------------------------------------------------------
// 10/11/12/13/14/15/16 — publish
// ---------------------------------------------------------------------------

async function readyToPublish(extraRoutes = {}) {
  const ctx = await render('/brands/br_1', {
    routes: Object.assign({
      'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: ALLOWED_GATE }),
    }, extraRoutes),
  });
  evalBtn(ctx.el).click();
  await settle();
  return ctx;
}

test('10 — publishing requires an explicit confirmation naming the record', async () => {
  const ctx = await readyToPublish();
  pubBtn(ctx.el).click();

  const m = modal(ctx.sandbox);
  assert.match(m.textContent, /Publish to the public website\?/);
  assert.match(m.textContent, /Example Brand/, 'the record must be named');
  assert.match(m.textContent, /visible on the public website/i);
  assert.ok(m.querySelector('[data-pc-go]'), 'an explicit action button');
  assert.ok(m.querySelector('[data-x]'), 'an explicit cancel');
  assert.equal(m.querySelector('[data-pc-go]').textContent.trim(), 'Publish', 'not a generic OK');
  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 0, 'nothing sent yet');
});

test('11 — cancelling makes no request', async () => {
  const ctx = await readyToPublish();
  pubBtn(ctx.el).click();
  modal(ctx.sandbox).querySelector('[data-x]').click();
  await settle();
  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 0);
  assert.equal(modal(ctx.sandbox).textContent, '', 'the dialog closed');
});

test('11 — dismissing the dialog by its close control does not publish', async () => {
  const ctx = await readyToPublish();
  pubBtn(ctx.el).click();
  modal(ctx.sandbox).querySelector('.modal-x').click();
  await settle();
  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 0);
});

test('12 — a double click on the confirmation sends exactly one decision', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true, concurrencyToken: 'brand:br_1:v2' } }),
  });
  pubBtn(ctx.el).click();
  const go = modal(ctx.sandbox).querySelector('[data-pc-go]');
  go.click();
  go.click();          // the button disables itself on the first click
  await settle();
  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 1);
});

test('13/14/15 — publish sends the current token, and success replaces token and state', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({
      brand: { ...BRAND, isPublished: true, concurrencyToken: 'brand:br_1:v2',
               governance: { ...BRAND.governance, publicationState: 'published' } },
    }),
    'POST /admin/public-content/brands/br_1/unpublish': ok({ brand: { ...BRAND, concurrencyToken: 'brand:br_1:v3' } }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  const publish = posts(ctx.calls).find(c => c.path.endsWith('/publish'));
  assert.equal(publish.body.concurrencyToken, 'brand:br_1:v1');
  assert.match(ctx.el.textContent, /Published\./);
  assert.match(ctx.el.textContent, /currently on the public website/);
  assert.ok(unpubBtn(ctx.el), 'the record now offers Unpublish');
  assert.equal(pubBtn(ctx.el), null, 'and no longer offers Publish');

  // The next decision must carry the refreshed token.
  confirmDecision(ctx.sandbox, ctx.el, 'unpublish');
  await settle();
  const unpublish = posts(ctx.calls).find(c => c.path.endsWith('/unpublish'));
  assert.equal(unpublish.body.concurrencyToken, 'brand:br_1:v2', 'the spent token must not be reused');
});

test('a successful publish invalidates the readiness result', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true, concurrencyToken: 'brand:br_1:v2' } }),
  });
  assert.match(ctx.el.textContent, /Meets the publication requirements/);
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();
  assert.doesNotMatch(ctx.el.textContent, /Meets the publication requirements/,
    'a verdict about the pre-decision record must not linger');
});

test('16 — a failed publish never reports success', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': fail(500, { error: 'boom' }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();
  assert.doesNotMatch(ctx.el.textContent, /Published\./);
  assert.match(ctx.el.textContent, /could not be completed/i);
  assert.match(ctx.el.textContent, /not on the public website/, 'the record state is unchanged');
});

test('the note is optional and travels in the body when given', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true } }),
  });
  pubBtn(ctx.el).click();
  const m = modal(ctx.sandbox);
  m.querySelector('#pc-note').value = 'Signed off by marketing';
  m.querySelector('[data-pc-go]').click();
  await settle();

  const publish = posts(ctx.calls).find(c => c.path.endsWith('/publish'));
  assert.equal(publish.body.note, 'Signed off by marketing');
  assert.deepEqual(Object.keys(publish.body).sort(), ['concurrencyToken', 'note']);
});

// ---------------------------------------------------------------------------
// 17/18/19 — unpublish
// ---------------------------------------------------------------------------

const PUBLISHED_BRAND = { ...BRAND, isPublished: true,
  governance: { ...BRAND.governance, publicationState: 'published' } };

async function renderPublished(extraRoutes = {}) {
  return render('/brands/br_1', {
    routes: Object.assign({ 'GET /admin/public-content/brands/br_1': ok({ brand: PUBLISHED_BRAND }) }, extraRoutes),
  });
}

test('17/18 — unpublish confirms explicitly and is never presented as deletion', async () => {
  const ctx = await renderPublished();
  assert.ok(unpubBtn(ctx.el));
  assert.equal(pubBtn(ctx.el), null, 'an already-published record offers no Publish');

  unpubBtn(ctx.el).click();
  const m = modal(ctx.sandbox);
  assert.match(m.textContent, /Remove from the public website\?/);
  assert.match(m.textContent, /Example Brand/);
  assert.match(m.textContent, /Nothing is deleted/i);
  assert.match(m.textContent, /published again later/i);
  assert.equal(m.querySelector('[data-pc-go]').textContent.trim(), 'Unpublish');
  assert.doesNotMatch(m.textContent, /\bdelete this\b|permanently|cannot be undone/i);
});

test('18 — no delete language appears on the publication panel', async () => {
  const ctx = await renderPublished();
  const panel = ctx.el.querySelector('.pc-publication');
  assert.doesNotMatch(panel.textContent, /\bdelete\b|\bremove permanently\b|\bdestroy\b/i);
});

test('19 — a successful unpublish replaces the token and the visible state', async () => {
  const ctx = await renderPublished({
    'POST /admin/public-content/brands/br_1/unpublish': ok({
      brand: { ...BRAND, isPublished: false, concurrencyToken: 'brand:br_1:v9',
               governance: { ...BRAND.governance, publicationState: 'approved' } },
    }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'unpublish');
  await settle();

  const unpublish = posts(ctx.calls).find(c => c.path.endsWith('/unpublish'));
  assert.equal(unpublish.body.concurrencyToken, 'brand:br_1:v1');
  assert.match(ctx.el.textContent, /Unpublished\./);
  assert.match(ctx.el.textContent, /Nothing was deleted/i);
  assert.match(ctx.el.textContent, /not on the public website/);
  assert.equal(unpubBtn(ctx.el), null);
  assert.ok(pubBtn(ctx.el), 'it can be published again');
});

test('unpublish does not require a readiness check', async () => {
  const ctx = await renderPublished({
    'POST /admin/public-content/brands/br_1/unpublish': ok({ brand: { ...BRAND, isPublished: false } }),
  });
  assert.equal(unpubBtn(ctx.el).disabled, false, 'withdrawing must always be possible');
});

// ---------------------------------------------------------------------------
// 20/21/22/23/24 — failures
// ---------------------------------------------------------------------------

test('20/21 — a 409 does not retry, does not claim success, and offers a reload', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': fail(409, { error: 'stale', code: 'STALE_TOKEN' }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 1, 'exactly one attempt');
  assert.match(ctx.el.textContent, /Another administrator changed/);
  assert.doesNotMatch(ctx.el.textContent, /Published\./);
  assert.ok(ctx.el.querySelector('[data-pc-reload]'), 'a reload action must be offered');
});

test('21 — reloading after a conflict fetches the record again and drops the stale verdict', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': fail(409, { code: 'STALE_TOKEN' }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  const before = ctx.calls.filter(c => c.path === '/admin/public-content/brands/br_1').length;
  ctx.el.querySelector('[data-pc-reload]').click();
  await settle();

  assert.ok(ctx.calls.filter(c => c.path === '/admin/public-content/brands/br_1').length > before, 'the record was re-read');
  assert.doesNotMatch(ctx.el.textContent, /Meets the publication requirements/, 'the old verdict is discarded');
  assert.equal(pubBtn(ctx.el).disabled, true, 'and Publish is disabled again until re-checked');
});

test('22 — a 422 renders the gate reasons that came back with it', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': fail(422, {
      error: 'This record does not meet the publication requirements.',
      code: 'PUBLICATION_GATE_FAILED',
      reasons: BLOCKED_GATE.reasons,
    }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  assert.doesNotMatch(ctx.el.textContent, /Published\./);
  assert.match(ctx.el.textContent, /does not meet the publication requirements/i);
  for (const r of BLOCKED_GATE.reasons) assert.ok(ctx.el.textContent.includes(r.message), `missing ${r.code}`);
  const rendered = ctx.el.querySelectorAll('.pc-reason-code').map(n => n.textContent.trim());
  assert.deepEqual(rendered, BLOCKED_GATE.reasons.map(r => r.code), 'server order preserved');
  assert.equal(pubBtn(ctx.el).disabled, true, 'the record is no longer presented as ready');
  assert.match(ctx.el.textContent, /not on the public website/, 'state unchanged');
});

test('23 — 401, 403 and 404 render safe states', async () => {
  for (const [status, pattern] of [[401, /session has expired/i], [403, /does not have permission/i], [404, /no longer exists/i]]) {
    const ctx = await readyToPublish({ 'POST /admin/public-content/brands/br_1/publish': fail(status, {}) });
    confirmDecision(ctx.sandbox, ctx.el, 'publish');
    await settle();
    assert.match(ctx.el.textContent, pattern, `status ${status}`);
    assert.doesNotMatch(ctx.el.textContent, /Published\./);
  }
});

test('24 — a generic failure leaks no internal detail', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': fail(500, {
      error: 'update brands set publication_state failed: connection to 10.0.0.4:5432 refused',
      stack: 'at Object.query (/srv/api/src/db.js:14:9)',
    }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();
  const shown = ctx.el.textContent;
  for (const leak of ['update brands', '10.0.0.4', '5432', 'db.js', 'at Object', 'connection to']) {
    assert.ok(!shown.includes(leak), `leaked "${leak}"`);
  }
});

// ---------------------------------------------------------------------------
// 25/26 — dirty-edit policy
// ---------------------------------------------------------------------------

test('25 — unsaved edits block evaluation, with an explanation', async () => {
  const { el, calls } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: ALLOWED_GATE }) },
  });
  field(el, 'headline').typeInto('Changed but not saved');
  assert.equal(evalBtn(el).disabled, true, 'the check must be unavailable while dirty');
  assert.match(el.textContent, /unsaved changes/i);
  assert.match(el.textContent, /act on the saved record/i);

  evalBtn(el).click();          // a disabled control does nothing
  await settle();
  assert.equal(posts(calls).length, 0, 'no evaluation may run against stale server state');
});

test('26 — unsaved edits block publish, and never discard the edit', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true } }),
  });
  assert.equal(pubBtn(ctx.el).disabled, false);

  field(ctx.el, 'headline').typeInto('Unsaved work');
  assert.equal(pubBtn(ctx.el).disabled, true, 'a decision must not act while the screen shows unsaved copy');

  pubBtn(ctx.el).click();
  await settle();
  assert.equal(modal(ctx.sandbox).textContent, '', 'no confirmation opens');
  assert.equal(posts(ctx.calls).filter(c => c.path.endsWith('/publish')).length, 0);
  assert.equal(field(ctx.el, 'headline').value, 'Unsaved work', 'the edit is preserved, never silently dropped');
});

test('an edit marks an existing readiness verdict as out of date', async () => {
  const ctx = await readyToPublish();
  assert.match(ctx.el.textContent, /Meets the publication requirements/);
  field(ctx.el, 'headline').typeInto('Changed');
  await settle();
  assert.match(ctx.el.textContent, /out of date/i);
  assert.equal(pubBtn(ctx.el).disabled, true);
});

test('unsaved edits block unpublish too', async () => {
  const ctx = await renderPublished();
  field(ctx.el, 'headline').typeInto('Unsaved');
  assert.equal(unpubBtn(ctx.el).disabled, true);
});

test('saving clears the dirty block and discards the pre-save verdict', async () => {
  const ctx = await readyToPublish({
    'PATCH /admin/public-content/brands/br_1': ok({ brand: { ...BRAND, headline: 'Saved', concurrencyToken: 'brand:br_1:v2' } }),
  });
  field(ctx.el, 'headline').typeInto('Saved');
  ctx.el.querySelector('#pc-form').submit();
  await settle();

  assert.equal(evalBtn(ctx.el).disabled, false, 'the check is available again');
  assert.doesNotMatch(ctx.el.textContent, /Meets the publication requirements/, 'the pre-save verdict is gone');
  assert.equal(pubBtn(ctx.el).disabled, true, 'Publish waits for a fresh check');
});

// ---------------------------------------------------------------------------
// 27/28/29/30 — boundary safety
// ---------------------------------------------------------------------------

test('27 — a variation decision uses its own token, never its product’s', async () => {
  const ctx = await render('/products/p_1/variations/v_1', {
    routes: {
      'POST /admin/public-content/variations/v_1/evaluate': ok({ gate: ALLOWED_GATE }),
      'POST /admin/public-content/variations/v_1/publish': ok({ variation: { ...VARIATION, isPublished: true } }),
    },
  });
  evalBtn(ctx.el).click();
  await settle();
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  const publish = posts(ctx.calls).find(c => c.path.endsWith('/publish'));
  assert.equal(publish.path, '/admin/public-content/variations/v_1/publish');
  assert.equal(publish.body.concurrencyToken, 'variation:v_1:v1');
  assert.notEqual(publish.body.concurrencyToken, PRODUCT.concurrencyToken);
});

test('28/29 — actor, approver and is_published can never be sent', async () => {
  const ctx = await readyToPublish({
    'POST /admin/public-content/brands/br_1/publish': ok({ brand: { ...BRAND, isPublished: true } }),
  });
  confirmDecision(ctx.sandbox, ctx.el, 'publish');
  await settle();

  const publish = posts(ctx.calls).find(c => c.path.endsWith('/publish'));
  assert.deepEqual(Object.keys(publish.body).sort(), ['concurrencyToken'],
    'the decision body carries the token and nothing else');
  const json = JSON.stringify(publish.body);
  for (const forbidden of ['actor', 'approver', 'approved_at', 'is_published', 'publication_state', 'userId', 'role']) {
    assert.ok(!json.includes(forbidden), `client sent ${forbidden}`);
  }
});

test('29 — the client filters these fields out even when asked directly', async () => {
  const { sandbox, calls } = await render('/brands/br_1', {
    routes: { 'PATCH /admin/public-content/brands/br_1': ok({ brand: BRAND }) },
  });
  await sandbox.DB.patchAdminBrand('br_1', {
    headline: 'ok', is_published: true, publication_state: 'published',
    approver_id: 'u_x', approved_at: 'now', fact_owner: 'u_x',
  }, 'brand:br_1:v1');

  const patch = calls.find(c => c.method === 'PATCH');
  assert.deepEqual(Object.keys(patch.body).sort(), ['concurrencyToken', 'headline', 'publication_state']);
  assert.ok(!('is_published' in patch.body), 'is_published can never be sent');
  assert.ok(!('approver_id' in patch.body));
  /* `publication_state` IS on the API allowlist, so the client may send it —
     the server's boundary guard is what refuses a published transition. The
     UI never offers that value; asserted in the editor tests. */
});

test('30 — no bootstrap or permission-grant control appears anywhere', async () => {
  for (const path of ['/brands/br_1', '/products/p_1', '/products/p_1/variations/v_1']) {
    const { el } = await render(path);
    assert.doesNotMatch(el.textContent, /bootstrap|grant permission|insert into|sql/i, path);
  }
});

// ---------------------------------------------------------------------------
// accessibility
// ---------------------------------------------------------------------------

test('the readiness result is announced, and decision buttons are real buttons', async () => {
  const ctx = await readyToPublish();
  const gate = ctx.el.querySelector('.pc-gate');
  assert.equal(gate.getAttribute('role'), 'status');
  assert.equal(gate.getAttribute('aria-live'), 'polite');
  for (const b of [evalBtn(ctx.el), pubBtn(ctx.el)]) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.getAttribute('type'), 'button', 'must not submit the edit form');
  }
});

test('a blocking reason can jump to the field that owns it', async () => {
  const { el } = await render('/brands/br_1', {
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: BLOCKED_GATE }) },
  });
  evalBtn(el).click();
  await settle();

  const jump = el.querySelectorAll('[data-pc-jump]').find(b => b.dataset.pcJump === 'slug');
  assert.ok(jump, 'a reason naming an editable field should link to it');
  jump.click();      // focuses the control; must not throw
  // A path naming a related record has no control to jump to, and offers none.
  assert.ok(!el.querySelectorAll('[data-pc-jump]').some(b => b.dataset.pcJump === 'variations[0]'));
});

test('a viewer without edit gets no jump links, since there is nothing to edit', async () => {
  const { el } = await render('/brands/br_1', {
    caps: [true, false, false],
    routes: { 'POST /admin/public-content/brands/br_1/evaluate': ok({ gate: BLOCKED_GATE }) },
  });
  evalBtn(el).click();
  await settle();
  assert.equal(el.querySelectorAll('[data-pc-jump]').length, 0);
  assert.match(el.textContent, /A source reference is required/, 'but the reasons still show');
});
