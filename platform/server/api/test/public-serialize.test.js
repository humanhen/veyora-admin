/* Serializer boundary (B2.2) — proves the pure allowlist in
   public-serialize.js cannot leak forbidden data even when handed an
   adversarial row containing every forbidden field the real database
   schema could realistically carry (pricing, stock, customer/user/agent
   identity, Zoho ids, internal label tags, governance/administration
   internals). Every serializer output is additionally run through the
   independent recursive scanner (public-forbidden-keys.js) as a second,
   structurally different check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeMedia,
  serializeVariation,
  serializeModelCard,
  serializeModelDetail,
  serializeBrandSummary,
  serializeBrandDetail,
  serializeLocation,
  serializeSitemapRecord,
} from '../src/public-serialize.js';
import { scanForForbiddenKeys, assertNoForbiddenKeys } from '../src/public-forbidden-keys.js';

/* A single adversarial product row carrying every forbidden field this
   schema could plausibly have alongside the legitimate public ones —
   plus a nested "attributes" jsonb bag also carrying forbidden keys, to
   prove the model-detail serializer's explicit lensType extraction (not
   a spread of the bag) keeps them out too. */
const poisonedProductRow = {
  id: 'p_secret123',
  public_slug: 'aviator-classic',
  sku: '20894',
  name: 'Aviator Classic',
  line: 'Heritage',
  shape: 'aviator',
  segment: 'premium',
  size: 'Medium',
  categories: ['Optical', 'label:internal-only'],
  is_featured: true,
  public_description: 'A classic aviator silhouette.',
  attributes: {
    lensType: 'polarized',
    cost: 12.5,
    purchasePrice: 9.99,
    zohoItemId: 'zoho_999',
    warehouse: 'wh_main',
  },
  content_updated_at: '2026-08-01T00:00:00Z',
  brand_slug: 'example-brand',
  brand_name: 'Example Brand',
  replacement_product_id: 'p_other',
  // ---- forbidden fields a raw row would also carry ----
  price: 199.99,
  sale_price: 149.99,
  purchase_price: 80,
  basePrice: 199.99,
  cost: 80,
  margin: 0.6,
  wholesale: 70,
  discount: 10,
  promotion: 'SPRING10',
  qty: 42,
  quantity: 42,
  stock: 42,
  stockStatus: 'in stock',
  onHand: 42,
  available: true,
  availability: 'in_stock',
  warehouse: 'wh_main',
  shelf: 'A12',
  customer: 'acme-optics',
  customerNumber: 'C-1001',
  customer_id: 'u_abc',
  user_id: 'u_abc',
  email: 'buyer@example.com',
  phone: '+1-555-0100',
  tax_id: '12-3456789',
  balance: 500,
  payment_terms: 30,
  pricing: { mode: 'tiered' },
  hide_prices: false,
  order: 'o_123',
  order_id: 'o_123',
  invoice: 'in_123',
  credit: 100,
  agent_id: 'u_agent',
  zoho_item_id: 'zoho_999',
  fact_owner: 'u_owner',
  source_reference: 'internal note',
};

const poisonedVariationRow = {
  id: 'v_secret456',
  sku: '20894.1',
  color: 'Matte Black',
  color_code: 'BLK-01',
  swatch_media_id: null,
  price: 199.99,
  sale_price: 149.99,
  purchase_price: 80,
  stock_status: 'in stock',
  qty: 12,
  zoho_item_id: 'zoho_888',
};

const poisonedBrandRow = {
  id: 'br_secret',
  slug: 'example-brand',
  name: 'Example Brand',
  short_name: 'Example',
  segment: 'premium',
  headline: 'Distinctive eyewear',
  summary: 'A premium eyewear brand.',
  story: 'Founded in ...',
  ideal_retailer: 'Independent optical retailers',
  best_for: ['Statement pieces', { nestedObject: true, cost: 5 }, 'x'.repeat(500)],
  style_traits: ['Bold', 'Colourful'],
  price_tier_label: 'Premium',
  design_origin: 'Italy',
  manufacturing_origin: 'Italy',
  component_origins: ['Italy', 'Japan'],
  approved_materials: ['Acetate', 'Titanium'],
  logo_media_id: null,
  hero_media_id: null,
  content_updated_at: '2026-08-01T00:00:00Z',
  // ---- forbidden / internal fields ----
  fact_owner: 'u_owner',
  source_reference: 'internal note',
  verification_status: 'unverified',
  publication_state: 'published',
};

const poisonedMediaRow = {
  id: 'med_secret',
  path: '/s3/brands/example.jpg',
  alt: 'Example brand hero image',
  width: 1200,
  height: 630,
  kind: 'image',
  rights_holder: 'Photographer X',
  rights_expiry: '2027-01-01',
  owner_type: 'brand',
  owner_id: 'br_secret',
};

const poisonedLocationRow = {
  id: 'loc_secret',
  slug: 'italy-supply-base',
  name: 'Italy Supply Base',
  function: 'supply_base',
  is_public: true,
  address: { street: '123 Via Roma', city: 'Milan' },
  regions_served: ['Europe'],
  contact: { email: 'ops@example.com', phone: '+39-555-0100' },
  hours: 'Mon-Fri 9-5',
  coordinates: { lat: 45.46, lng: 9.19 },
  fact_owner: 'u_owner',
};

test('serializeModelCard/detail cannot leak any forbidden field from a fully poisoned row', () => {
  const card = serializeModelCard(poisonedProductRow);
  assertNoForbiddenKeys(card, 'model card');

  const detail = serializeModelDetail(poisonedProductRow, {
    variations: [{ variation: poisonedVariationRow, swatchMedia: null }],
    media: [poisonedMediaRow],
    relatedModels: [{ row: poisonedProductRow, primaryMedia: null }],
  });
  assertNoForbiddenKeys(detail, 'model detail');
});

test('adversarial product row: not one forbidden key appears as an own property anywhere in the output', () => {
  const detail = serializeModelDetail(poisonedProductRow, {
    variations: [{ variation: poisonedVariationRow }],
    media: [poisonedMediaRow],
    relatedModels: [],
  });
  const json = JSON.stringify(detail);
  for (const forbidden of [
    'price', 'sale_price', 'salePrice', 'purchase_price', 'purchasePrice', 'basePrice',
    'cost', 'margin', 'wholesale', 'discount', 'promotion', 'qty', 'quantity', 'stock',
    'stockStatus', 'onHand', 'available', 'availability', 'warehouse', 'shelf',
    'customer', 'customerNumber', 'customer_id', 'user_id', 'email', 'phone', 'tax_id',
    'balance', 'payment_terms', 'pricing', 'hide_prices', 'order_id', 'invoice', 'credit',
    'agent_id', 'zoho_item_id', 'fact_owner',
  ]) {
    assert.ok(!json.includes(`"${forbidden}"`), `output JSON contains the forbidden key "${forbidden}"`);
  }
});

test('adversarial variation row cannot leak price, stock, purchase cost or Zoho id', () => {
  const out = serializeVariation(poisonedVariationRow);
  assertNoForbiddenKeys(out, 'variation');
  assert.deepEqual(Object.keys(out).sort(), ['colorCode', 'colorName', 'sku', 'swatchMedia']);
});

test('nested JSON (attributes bag) cannot smuggle forbidden keys through model detail', () => {
  const detail = serializeModelDetail(poisonedProductRow, { variations: [], media: [], relatedModels: [] });
  assert.equal(detail.lensType, 'polarized');
  // Only lensType is ever pulled from `attributes` — cost/zohoItemId/warehouse
  // inside that bag must not appear anywhere in the output.
  assertNoForbiddenKeys(detail, 'model detail (attributes bag)');
  assert.ok(!('attributes' in detail), 'the raw attributes bag itself must never be attached to the output');
});

test('internal label:* tags never appear in serialized categories', () => {
  const card = serializeModelCard(poisonedProductRow);
  assert.ok(!card.categories.some((c) => /^label:/i.test(c)), 'a label: tag leaked into categories');
  assertNoForbiddenKeys(card, 'model card categories');
});

test('media administrative fields (rights holder, rights expiry, owner) never appear', () => {
  const out = serializeMedia(poisonedMediaRow);
  assertNoForbiddenKeys(out, 'media');
  assert.deepEqual(Object.keys(out).sort(), ['alt', 'height', 'kind', 'path', 'width']);
});

test('fact-owner and approval-adjacent ids never appear on a brand', () => {
  const out = serializeBrandDetail(poisonedBrandRow, { featuredModels: [] });
  assertNoForbiddenKeys(out, 'brand detail');
  assert.ok(!('factOwner' in out) && !('fact_owner' in out));
  assert.ok(!('verificationStatus' in out) && !('publicationState' in out), 'governance fields must not appear on the public brand shape either');
});

test('a malformed jsonb best_for value (object, over-long string) is dropped, not passed through', () => {
  const out = serializeBrandDetail(poisonedBrandRow, { featuredModels: [] });
  assert.deepEqual(out.bestFor, ['Statement pieces']); // the object and the 500-char string are dropped
});

test('serializers create a NEW object and never return the input row reference', () => {
  assert.notEqual(serializeModelCard(poisonedProductRow), poisonedProductRow);
  assert.notEqual(serializeVariation(poisonedVariationRow), poisonedVariationRow);
  assert.notEqual(serializeBrandDetail(poisonedBrandRow, {}), poisonedBrandRow);
  assert.notEqual(serializeMedia(poisonedMediaRow), poisonedMediaRow);
  const loc = serializeLocation(poisonedLocationRow);
  assert.notEqual(loc, poisonedLocationRow);
});

test('serializeLocation never exposes address, contact or coordinates, only neutral fields', () => {
  const out = serializeLocation(poisonedLocationRow);
  assertNoForbiddenKeys(out, 'location');
  assert.deepEqual(Object.keys(out).sort(), ['function', 'hours', 'name', 'regionsServed', 'slug']);
  assert.ok(!('address' in out) && !('contact' in out) && !('coordinates' in out));
});

test('the recursive scanner reports the exact violating path when given a deliberately-broken serializer output', () => {
  // Simulating a hypothetical regression: an object that DID leak a
  // forbidden field nested two levels deep.
  const broken = { model: { variation: { sku: 'X', purchase_price: 80 } } };
  const violations = scanForForbiddenKeys(broken);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, '$.model.variation.purchase_price');
  assert.equal(violations[0].key, 'purchase_price');
});

test('the scanner also reports a label:* value nested in an array', () => {
  const broken = { categories: ['Optical', 'label:internal'] };
  const violations = scanForForbiddenKeys(broken);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, '$.categories[1]');
  assert.equal(violations[0].reason, 'label-tag');
});

test('harmless public fields do not trigger false positives', () => {
  const safe = serializeModelCard({
    brand_slug: 'example', brand_name: 'Example', public_slug: 'model-x', sku: '100',
    name: 'Model X', line: 'Core', shape: 'round', segment: 'core', size: 'Medium',
    categories: ['Optical', 'New'], is_featured: false,
  });
  assertNoForbiddenKeys(safe, 'clean model card');
  // Specifically the words the brief calls out as false-positive risks.
  const alsoSafe = { isDiscontinued: true, sortOrder: 3, orderIndex: 1, discontinued: true };
  assert.deepEqual(scanForForbiddenKeys(alsoSafe), []);
});

test('serializeSitemapRecord shapes a path + contentUpdatedAt pair only', () => {
  const out = serializeSitemapRecord({ path: '/brands/example-brand/', contentUpdatedAt: '2026-08-01T00:00:00Z' });
  assert.deepEqual(Object.keys(out).sort(), ['contentUpdatedAt', 'path']);
  assertNoForbiddenKeys(out, 'sitemap record');
});

test('serializeBrandSummary exposes only the documented safe fields', () => {
  const out = serializeBrandSummary(poisonedBrandRow);
  assert.deepEqual(
    Object.keys(out).sort(),
    ['headline', 'logoMedia', 'name', 'priceTierLabel', 'segment', 'shortName', 'slug']
  );
});
