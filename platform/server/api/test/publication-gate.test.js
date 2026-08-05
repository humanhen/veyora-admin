/* The publication gate (B2.4A) — pure-function rules, exercised directly.

   Every test builds a complete, publishable record and then breaks exactly
   one thing, so a failure names the rule that broke rather than "something
   in a big fixture". */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBrandPublication,
  evaluateProductPublication,
  evaluateVariationPublication,
  productAdvisories,
  isValidSlug,
  DEFERRED_GATES,
} from '../src/publication-gate.js';

const NOW = '2026-08-06T00:00:00.000Z';

const completeBrand = () => ({
  id: 'br_1',
  slug: 'example-brand',
  name: 'Example Brand',
  summary: 'An approved public summary.',
  headline: 'An approved headline',
  publication_state: 'published',
  verification_status: 'verified',
  source_reference: 'Brand book p12, approved by commercial',
  last_reviewed_at: NOW,
  content_updated_at: NOW,
});

const completeProduct = () => ({
  id: 'p_1',
  sku: '20894',
  name: 'Aviator Classic',
  public_slug: 'aviator-classic',
  brand_id: 'br_1',
  public_description: 'An approved public description.',
  is_discontinued: false,
  replacement_product_id: null,
  publication_state: 'published',
  verification_status: 'verified',
  source_reference: 'Product sheet 2026',
  last_reviewed_at: NOW,
  content_updated_at: NOW,
});

const completeProductContext = () => ({
  brand: { id: 'br_1', publication_state: 'published' },
  slugIsUnique: true,
  publishableVariationCount: 2,
  mediaCount: 1,
  replacement: null,
});

const completeVariation = () => ({
  id: 'v_1',
  product_id: 'p_1',
  sku: '20894.1',
  color: 'Matte Black',
  color_code: 'BLK-01',
  swatch_media_id: null,
});

const codes = (verdict) => verdict.reasons.map((r) => r.code);

// ---------------------------------------------------------------------------
// slug helper
// ---------------------------------------------------------------------------

test('isValidSlug accepts safe slugs and rejects unsafe ones', () => {
  for (const good of ['a', 'example', 'example-brand', 'model-2057', 'a1-b2-c3']) {
    assert.ok(isValidSlug(good), `should accept "${good}"`);
  }
  for (const bad of [
    '',
    'Example',          // uppercase
    'example brand',    // space
    'example_brand',    // underscore
    '-example',         // leading hyphen
    'example-',         // trailing hyphen
    'example--brand',   // double hyphen
    '../etc/passwd',
    'example/brand',
    'example.brand',
    'ex%20ample',
    null,
    42,
  ]) {
    assert.ok(!isValidSlug(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 12/13 — brand
// ---------------------------------------------------------------------------

test('a complete brand passes the gate', () => {
  const verdict = evaluateBrandPublication(completeBrand(), { slugIsUnique: true });
  assert.equal(verdict.allowed, true, `unexpected reasons: ${codes(verdict).join(', ')}`);
  assert.deepEqual(verdict.reasons, []);
});

test('a missing brand record fails rather than throwing', () => {
  const verdict = evaluateBrandPublication(null, { slugIsUnique: true });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(codes(verdict), ['BRAND_NOT_FOUND']);
});

test('each missing brand requirement produces its own stable reason code', () => {
  const cases = [
    [{ name: '' }, 'BRAND_NO_NAME'],
    [{ slug: 'Not A Slug' }, 'BRAND_INVALID_SLUG'],
    [{ publication_state: 'draft' }, 'BRAND_STATE_NOT_PUBLISHED'],
    [{ publication_state: 'retired' }, 'BRAND_RETIRED'],
    [{ verification_status: 'sourced' }, 'BRAND_NOT_VERIFIED'],
    [{ source_reference: '' }, 'BRAND_NO_SOURCE_REFERENCE'],
    [{ last_reviewed_at: null }, 'BRAND_NOT_REVIEWED'],
    [{ content_updated_at: null }, 'BRAND_NO_CONTENT_DATE'],
    [{ summary: '', headline: '' }, 'BRAND_NO_PUBLIC_DESCRIPTION'],
  ];
  for (const [override, expected] of cases) {
    const verdict = evaluateBrandPublication({ ...completeBrand(), ...override }, { slugIsUnique: true });
    assert.equal(verdict.allowed, false, `${expected} should block publication`);
    assert.ok(codes(verdict).includes(expected), `expected ${expected}, got ${codes(verdict).join(', ')}`);
  }
});

test('a brand with only a headline (no summary) still passes — either approved field satisfies the rule', () => {
  const verdict = evaluateBrandPublication({ ...completeBrand(), summary: '' }, { slugIsUnique: true });
  assert.equal(verdict.allowed, true, codes(verdict).join(', '));
});

test('a duplicate brand slug blocks publication; an unchecked slug fails closed', () => {
  assert.ok(codes(evaluateBrandPublication(completeBrand(), { slugIsUnique: false })).includes('BRAND_SLUG_NOT_UNIQUE'));
  assert.ok(codes(evaluateBrandPublication(completeBrand(), {})).includes('BRAND_SLUG_UNIQUENESS_UNKNOWN'));
});

test('brand reasons are returned in deterministic (sorted) order', () => {
  const broken = { ...completeBrand(), name: '', slug: 'BAD', source_reference: '', verification_status: 'unverified' };
  const first = codes(evaluateBrandPublication(broken, { slugIsUnique: true }));
  const second = codes(evaluateBrandPublication(broken, { slugIsUnique: true }));
  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort(), 'codes must be sorted');
});

// ---------------------------------------------------------------------------
// 14/15/16/17/18 — product
// ---------------------------------------------------------------------------

test('a complete product passes the gate', () => {
  const verdict = evaluateProductPublication(completeProduct(), completeProductContext());
  assert.equal(verdict.allowed, true, `unexpected reasons: ${codes(verdict).join(', ')}`);
});

test('each missing product requirement produces its own stable reason code', () => {
  const cases = [
    [{ name: '' }, {}, 'PRODUCT_NO_NAME'],
    [{ public_slug: null }, {}, 'PRODUCT_INVALID_SLUG'],
    [{ sku: '' }, {}, 'PRODUCT_NO_DISPLAY_SKU'],
    [{ public_description: '' }, {}, 'PRODUCT_NO_PUBLIC_DESCRIPTION'],
    [{ publication_state: 'approved' }, {}, 'PRODUCT_STATE_NOT_PUBLISHED'],
    [{ publication_state: 'retired' }, {}, 'PRODUCT_RETIRED'],
    [{ verification_status: 'unverified' }, {}, 'PRODUCT_NOT_VERIFIED'],
    [{ source_reference: '' }, {}, 'PRODUCT_NO_SOURCE_REFERENCE'],
    [{ last_reviewed_at: null }, {}, 'PRODUCT_NOT_REVIEWED'],
    [{ content_updated_at: null }, {}, 'PRODUCT_NO_CONTENT_DATE'],
    [{ brand_id: null }, { brand: null }, 'PRODUCT_NO_BRAND'],
  ];
  for (const [productOverride, contextOverride, expected] of cases) {
    const verdict = evaluateProductPublication(
      { ...completeProduct(), ...productOverride },
      { ...completeProductContext(), ...contextOverride }
    );
    assert.equal(verdict.allowed, false, `${expected} should block publication`);
    assert.ok(codes(verdict).includes(expected), `expected ${expected}, got ${codes(verdict).join(', ')}`);
  }
});

test('an unpublished parent brand blocks product publication', () => {
  const verdict = evaluateProductPublication(completeProduct(), {
    ...completeProductContext(),
    brand: { id: 'br_1', publication_state: 'approved' },
  });
  assert.equal(verdict.allowed, false);
  assert.ok(codes(verdict).includes('PRODUCT_BRAND_NOT_PUBLISHED'));
});

test('a brand id pointing at a missing record blocks publication', () => {
  const verdict = evaluateProductPublication(completeProduct(), { ...completeProductContext(), brand: null });
  assert.ok(codes(verdict).includes('PRODUCT_BRAND_MISSING'));
});

test('self-replacement blocks publication', () => {
  const verdict = evaluateProductPublication(
    { ...completeProduct(), replacement_product_id: 'p_1' },
    completeProductContext()
  );
  assert.equal(verdict.allowed, false);
  assert.ok(codes(verdict).includes('PRODUCT_REPLACEMENT_SELF'));
});

test('a replacement that is missing or unpublished blocks publication', () => {
  const missing = evaluateProductPublication(
    { ...completeProduct(), replacement_product_id: 'p_other' },
    { ...completeProductContext(), replacement: null }
  );
  assert.ok(codes(missing).includes('PRODUCT_REPLACEMENT_MISSING'));

  const unpublished = evaluateProductPublication(
    { ...completeProduct(), replacement_product_id: 'p_other' },
    { ...completeProductContext(), replacement: { id: 'p_other', is_published: false } }
  );
  assert.ok(codes(unpublished).includes('PRODUCT_REPLACEMENT_NOT_PUBLISHED'));
});

test('a valid published replacement is accepted', () => {
  const verdict = evaluateProductPublication(
    { ...completeProduct(), replacement_product_id: 'p_other', is_discontinued: true },
    { ...completeProductContext(), replacement: { id: 'p_other', is_published: true } }
  );
  assert.equal(verdict.allowed, true, codes(verdict).join(', '));
});

test('a product with no publishable variation is blocked, unless declared non-variant', () => {
  const blocked = evaluateProductPublication(completeProduct(), {
    ...completeProductContext(),
    publishableVariationCount: 0,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked).includes('PRODUCT_NO_PUBLISHABLE_VARIATION'));

  const nonVariant = evaluateProductPublication(completeProduct(), {
    ...completeProductContext(),
    publishableVariationCount: 0,
    isNonVariant: true,
  });
  assert.equal(nonVariant.allowed, true, codes(nonVariant).join(', '));
});

test('an uncounted variation or media count fails closed rather than assuming zero problems', () => {
  const noVarCount = evaluateProductPublication(completeProduct(), {
    ...completeProductContext(),
    publishableVariationCount: undefined,
  });
  assert.ok(codes(noVarCount).includes('PRODUCT_VARIATION_COUNT_UNKNOWN'));

  const noMediaCount = evaluateProductPublication(completeProduct(), {
    ...completeProductContext(),
    mediaCount: undefined,
  });
  assert.ok(codes(noMediaCount).includes('PRODUCT_MEDIA_COUNT_UNKNOWN'));
});

test('a product with no approved media is blocked', () => {
  const verdict = evaluateProductPublication(completeProduct(), { ...completeProductContext(), mediaCount: 0 });
  assert.equal(verdict.allowed, false);
  assert.ok(codes(verdict).includes('PRODUCT_NO_APPROVED_MEDIA'));
});

test('a duplicate public slug blocks publication', () => {
  const verdict = evaluateProductPublication(completeProduct(), { ...completeProductContext(), slugIsUnique: false });
  assert.ok(codes(verdict).includes('PRODUCT_SLUG_NOT_UNIQUE'));
});

// ---------------------------------------------------------------------------
// 19/20 — variation
// ---------------------------------------------------------------------------

test('a complete variation passes the gate', () => {
  const verdict = evaluateVariationPublication(completeVariation(), { parentEligible: true, mediaExists: true });
  assert.equal(verdict.allowed, true, codes(verdict).join(', '));
});

test('an incomplete variation fails with its own reason codes', () => {
  const noColour = evaluateVariationPublication({ ...completeVariation(), color: '' }, { parentEligible: true });
  assert.ok(codes(noColour).includes('VARIATION_NO_COLOUR_NAME'));

  const badCode = evaluateVariationPublication(
    { ...completeVariation(), color_code: 'has spaces/and slashes' },
    { parentEligible: true }
  );
  assert.ok(codes(badCode).includes('VARIATION_INVALID_COLOUR_CODE'));

  const missingMedia = evaluateVariationPublication(
    { ...completeVariation(), swatch_media_id: 'med_x' },
    { parentEligible: true, mediaExists: false }
  );
  assert.ok(codes(missingMedia).includes('VARIATION_MEDIA_MISSING'));
});

test('a variation cannot publish when its parent product is not eligible', () => {
  const verdict = evaluateVariationPublication(completeVariation(), { parentEligible: false });
  assert.equal(verdict.allowed, false);
  assert.ok(codes(verdict).includes('VARIATION_PARENT_NOT_ELIGIBLE'));
});

test('an unevaluated parent fails closed', () => {
  const verdict = evaluateVariationPublication(completeVariation(), {});
  assert.ok(codes(verdict).includes('VARIATION_PARENT_UNKNOWN'));
});

test('an absent colour code is fine — it is optional', () => {
  for (const value of [null, undefined, '']) {
    const verdict = evaluateVariationPublication(
      { ...completeVariation(), color_code: value },
      { parentEligible: true }
    );
    assert.equal(verdict.allowed, true, `colour code ${JSON.stringify(value)}: ${codes(verdict).join(', ')}`);
  }
});

test('the variation gate imposes no price, stock or availability requirement', () => {
  // A variation carrying none of those fields at all still passes.
  const verdict = evaluateVariationPublication(
    { id: 'v_2', product_id: 'p_1', sku: 'x.1', color: 'Blue' },
    { parentEligible: true }
  );
  assert.equal(verdict.allowed, true, codes(verdict).join(', '));
});

// ---------------------------------------------------------------------------
// 21 — state change alone cannot bypass the gate
// ---------------------------------------------------------------------------

test('setting publication_state to published does NOT by itself make a record eligible', () => {
  // A brand with the right state but nothing else.
  const bare = {
    id: 'br_x',
    slug: 'bare',
    name: '',
    summary: '',
    headline: '',
    publication_state: 'published',
    verification_status: 'unverified',
    source_reference: '',
    last_reviewed_at: null,
    content_updated_at: null,
  };
  const verdict = evaluateBrandPublication(bare, { slugIsUnique: true });
  assert.equal(verdict.allowed, false);
  // The state check passes, but every other requirement still reports.
  assert.ok(!codes(verdict).includes('BRAND_STATE_NOT_PUBLISHED'));
  assert.ok(codes(verdict).length >= 4, `expected several blocking reasons, got ${codes(verdict).join(', ')}`);
});

// ---------------------------------------------------------------------------
// advisories and deferred gates
// ---------------------------------------------------------------------------

test('advisories are informational and never affect the verdict', () => {
  const product = { ...completeProduct(), is_discontinued: true, replacement_product_id: null };
  const verdict = evaluateProductPublication(product, completeProductContext());
  assert.equal(verdict.allowed, true, 'a discontinued model with no successor may still publish');

  const advice = productAdvisories(product, { publishableVariationCount: 2 });
  assert.ok(advice.some((a) => a.code === 'PRODUCT_DISCONTINUED_NO_REPLACEMENT'));
});

test('deferred gates are declared explicitly rather than silently missing', () => {
  const codesOut = DEFERRED_GATES.map((g) => g.code);
  assert.ok(codesOut.includes('DEFERRED_NON_VARIANT_FLAG'));
  assert.ok(codesOut.includes('DEFERRED_MEDIA_APPROVAL_STATE'));
  assert.ok(codesOut.includes('DEFERRED_FIELD_LEVEL_APPROVAL'));
  for (const gate of DEFERRED_GATES) assert.ok(gate.detail.length > 40, `${gate.code} needs a real explanation`);
});

test('no reason exposes SQL, a column expression or infrastructure detail', () => {
  const verdicts = [
    evaluateBrandPublication({ ...completeBrand(), name: '', slug: 'X' }, {}),
    evaluateProductPublication({ ...completeProduct(), name: '' }, {}),
    evaluateVariationPublication({ ...completeVariation(), color: '' }, {}),
  ];
  for (const verdict of verdicts) {
    for (const reason of verdict.reasons) {
      assert.doesNotMatch(reason.message, /select |from |where |insert |update |pg_|postgres/i);
      assert.doesNotMatch(String(reason.field ?? ''), /select|\$\d|;/i);
    }
  }
});
