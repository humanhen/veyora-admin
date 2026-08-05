/* Administrative serializers, PATCH validation and concurrency tokens
   (B2.4A). Pure functions, exercised directly with adversarial input. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeAdminBrand,
  serializeAdminProduct,
  serializeAdminVariation,
  validateAdminPatch,
  buildUpdateSql,
  makeConcurrencyToken,
  tokenMatches,
  EDITABLE_FIELDS,
} from '../src/admin-public-serialize.js';

const UPDATED = new Date('2026-08-06T10:00:00.000Z');

/* A row carrying every private/internal field a real table could hold
   alongside the legitimate administrative ones. */
const poisonedBrandRow = {
  id: 'br_1',
  slug: 'example-brand',
  name: 'Example Brand',
  short_name: 'Example',
  segment: 'premium',
  headline: 'A headline',
  summary: 'A summary',
  story: 'A story',
  ideal_retailer: 'Independents',
  price_tier_label: 'Premium',
  design_origin: 'Italy',
  manufacturing_origin: 'Italy',
  style_traits: ['Bold'],
  approved_materials: ['Acetate'],
  logo_media_id: 'med_1',
  hero_media_id: null,
  publication_state: 'draft',
  verification_status: 'unverified',
  source_reference: 'ref',
  fact_owner: 'u_owner',
  last_reviewed_at: UPDATED,
  scheduled_review_at: null,
  content_updated_at: UPDATED,
  created_at: UPDATED,
  updated_at: UPDATED,
  // ---- must never appear ----
  password_hash: 'HASH_SECRET',
  email: 'someone-SECRET@example.com',
  balance: 999,
  payment_terms: 30,
  pricing: { mode: 'tiered' },
  zoho_item_id: 'zoho_SECRET',
};

const poisonedProductRow = {
  id: 'p_1',
  sku: '20894',
  name: 'Aviator',
  brand: 'Legacy Brand Text',
  public_slug: 'aviator',
  brand_id: 'br_1',
  line: 'Heritage',
  shape: 'aviator',
  segment: 'premium',
  size: 'Medium',
  public_description: 'desc',
  categories: ['Optical'],
  is_published: false,
  is_featured: true,
  is_discontinued: false,
  is_active: true,
  replacement_product_id: null,
  publication_state: 'draft',
  verification_status: 'unverified',
  source_reference: '',
  fact_owner: 'u_owner',
  last_reviewed_at: null,
  scheduled_review_at: null,
  content_updated_at: UPDATED,
  created_at: UPDATED,
  updated_at: UPDATED,
  // ---- must never appear ----
  price: 199.99,
  sale_price: 149.99,
  purchase_price: 80,
  zoho_item_id: 'zoho_SECRET',
  customer_id: 'u_SECRET',
};

const SECRETS = [
  'HASH_SECRET',
  'someone-SECRET@example.com',
  'zoho_SECRET',
  'u_SECRET',
  '199.99',
  '149.99',
];

function assertNoSecrets(value, label) {
  const json = JSON.stringify(value);
  for (const secret of SECRETS) {
    assert.ok(!json.includes(secret), `${label} leaked "${secret}"`);
  }
}

// ---------------------------------------------------------------------------
// 5 — explicit serializers
// ---------------------------------------------------------------------------

test('the admin brand serializer returns only its documented fields', () => {
  const out = serializeAdminBrand(poisonedBrandRow);
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      'approvedMaterials', 'concurrencyToken', 'createdAt', 'designOrigin', 'governance',
      'headline', 'heroMediaId', 'id', 'idealRetailer', 'isPublished', 'logoMediaId',
      'manufacturingOrigin', 'name', 'priceTierLabel', 'publicationGate', 'segment',
      'shortName', 'slug', 'story', 'summary', 'styleTraits', 'updatedAt',
    ].sort()
  );
  assertNoSecrets(out, 'admin brand');
});

test('the admin product serializer returns only its documented fields, and no pricing or Zoho id', () => {
  const out = serializeAdminProduct(poisonedProductRow);
  assertNoSecrets(out, 'admin product');
  assert.ok(!('price' in out) && !('salePrice' in out) && !('purchasePrice' in out));
  assert.ok(!('zohoItemId' in out));
  // The portal's ordering flag is shown read-only so an editor is not confused.
  assert.equal(out.isActiveInPortal, true);
  assert.equal(out.legacyBrandText, 'Legacy Brand Text');
});

test('the admin variation serializer returns only its documented fields', () => {
  const out = serializeAdminVariation({
    id: 'v_1', product_id: 'p_1', sku: '20894.1', color: 'Black', color_code: 'BLK',
    swatch_media_id: null, is_published: false, is_active: true, created_at: UPDATED,
    price: 199.99, purchase_price: 80, zoho_item_id: 'zoho_SECRET',
  });
  assertNoSecrets(out, 'admin variation');
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      'colorCode', 'colorName', 'concurrencyToken', 'createdAt', 'id', 'isActiveInPortal',
      'isPublished', 'productId', 'publicationGate', 'sku', 'swatchMediaId',
    ].sort()
  );
});

test('governance fields ARE exposed to admins — they are needed for editorial work', () => {
  const out = serializeAdminBrand(poisonedBrandRow);
  assert.equal(out.governance.publicationState, 'draft');
  assert.equal(out.governance.verificationStatus, 'unverified');
  assert.equal(out.governance.factOwnerId, 'u_owner');
  // ...but only as an identifier: no account detail is joined in.
  assert.ok(!JSON.stringify(out).includes('@'), 'no email should reach an admin response through this path');
});

test('serializers return a fresh object, never the input row', () => {
  assert.notEqual(serializeAdminBrand(poisonedBrandRow), poisonedBrandRow);
  assert.notEqual(serializeAdminProduct(poisonedProductRow), poisonedProductRow);
});

// ---------------------------------------------------------------------------
// 6/7/8/9/10/11 — PATCH validation
// ---------------------------------------------------------------------------

test('a valid partial patch is accepted — draft editing does not require every field', () => {
  const result = validateAdminPatch('brand', { headline: 'New headline' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields, { headline: 'New headline' });
});

test('an unknown field is rejected with 400-shaped errors, never silently dropped', () => {
  const result = validateAdminPatch('brand', { headline: 'ok', nonsense_field: 'x' });
  assert.equal(result.ok, false);
  const err = result.errors.find((e) => e.field === 'nonsense_field');
  assert.equal(err.code, 'UNKNOWN_FIELD');
});

test('immutable fields are rejected with a distinct code', () => {
  for (const field of ['id', 'created_at', 'updated_at', 'fact_owner', 'approver_id', 'is_active', 'sku', 'price']) {
    const result = validateAdminPatch('product', { [field]: 'x' });
    assert.equal(result.ok, false, `${field} should be rejected`);
    assert.equal(result.errors[0].code, 'IMMUTABLE_FIELD', `${field}: ${JSON.stringify(result.errors)}`);
  }
});

test('is_published cannot be set through PATCH — publication is a separate gated operation', () => {
  const result = validateAdminPatch('product', { is_published: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'IMMUTABLE_FIELD');
  assert.match(result.errors[0].message, /publish endpoint/i);
});

test('an arbitrary publication or verification state is rejected', () => {
  for (const bad of ['live', 'PUBLISHED', 'deleted', '', null, 42]) {
    const result = validateAdminPatch('brand', { publication_state: bad });
    assert.equal(result.ok, false, `publication_state ${JSON.stringify(bad)} should be rejected`);
    assert.equal(result.errors[0].code, 'INVALID_VALUE');
  }
  assert.equal(validateAdminPatch('brand', { publication_state: 'approved' }).ok, true);
  assert.equal(validateAdminPatch('brand', { verification_status: 'verified' }).ok, true);
});

test('unsafe slugs are rejected; an empty slug is allowed while drafting', () => {
  for (const bad of ['Example Brand', '../etc', 'a/b', 'UPPER', 'a--b', '-lead']) {
    const result = validateAdminPatch('brand', { slug: bad });
    assert.equal(result.ok, false, `slug "${bad}" should be rejected`);
    assert.equal(result.errors[0].code, 'INVALID_SLUG');
  }
  assert.equal(validateAdminPatch('brand', { slug: '' }).ok, true, 'an empty slug is a legitimate draft state');
  assert.equal(validateAdminPatch('brand', { slug: 'good-slug' }).ok, true);
});

test('oversized values are rejected', () => {
  const long = 'x'.repeat(25_000);
  const result = validateAdminPatch('brand', { summary: long });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOO_LONG');

  const manyItems = Array.from({ length: 100 }, () => 'trait');
  assert.equal(validateAdminPatch('brand', { style_traits: manyItems }).errors[0].code, 'TOO_MANY_ITEMS');
});

test('wrong primitive types are rejected rather than coerced', () => {
  assert.equal(validateAdminPatch('brand', { name: 42 }).errors[0].code, 'INVALID_TYPE');
  assert.equal(validateAdminPatch('product', { is_featured: 'true' }).errors[0].code, 'INVALID_TYPE');
  assert.equal(validateAdminPatch('brand', { style_traits: 'Bold' }).errors[0].code, 'INVALID_TYPE');
});

test('nested objects not in the contract are rejected', () => {
  const result = validateAdminPatch('brand', { seo: { title: 'x' } });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_FIELD');
});

test('id references must look like record ids or be null', () => {
  assert.equal(validateAdminPatch('product', { brand_id: 'br_abc123' }).ok, true);
  assert.equal(validateAdminPatch('product', { brand_id: null }).ok, true);
  assert.equal(validateAdminPatch('product', { brand_id: 'not an id' }).errors[0].code, 'INVALID_ID');
  assert.equal(validateAdminPatch('product', { brand_id: '../../etc' }).errors[0].code, 'INVALID_ID');
});

test('dates must be ISO-parseable or null', () => {
  assert.equal(validateAdminPatch('brand', { last_reviewed_at: '2026-08-06T00:00:00Z' }).ok, true);
  assert.equal(validateAdminPatch('brand', { last_reviewed_at: null }).ok, true);
  assert.equal(validateAdminPatch('brand', { last_reviewed_at: 'yesterday' }).errors[0].code, 'INVALID_DATE');
});

test('an empty patch, a non-object body and an unknown entity are all rejected', () => {
  assert.equal(validateAdminPatch('brand', {}).errors[0].code, 'EMPTY_PATCH');
  assert.equal(validateAdminPatch('brand', null).errors[0].code, 'INVALID_BODY');
  assert.equal(validateAdminPatch('brand', ['a']).errors[0].code, 'INVALID_BODY');
  assert.equal(validateAdminPatch('nonsense', { a: 1 }).errors[0].code, 'UNKNOWN_ENTITY');
});

test('the concurrency token in the body is not treated as a data field', () => {
  const result = validateAdminPatch('brand', { concurrencyToken: 'brand:br_1:x', headline: 'ok' });
  assert.equal(result.ok, true);
  assert.ok(!('concurrencyToken' in result.fields));
});

test('editable-field allowlists are explicit and exclude every dangerous field', () => {
  for (const entity of ['brand', 'product', 'variation']) {
    for (const forbidden of ['id', 'is_published', 'is_active', 'price', 'fact_owner', 'created_at']) {
      assert.ok(!EDITABLE_FIELDS[entity].includes(forbidden), `${entity} must not allow ${forbidden}`);
    }
  }
});

test('errors are returned in deterministic order', () => {
  const body = { zzz_unknown: 1, aaa_unknown: 2, slug: 'BAD' };
  const first = validateAdminPatch('brand', body).errors.map((e) => `${e.field}:${e.code}`);
  const second = validateAdminPatch('brand', body).errors.map((e) => `${e.field}:${e.code}`);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// buildUpdateSql — column names come from validated fields only
// ---------------------------------------------------------------------------

test('buildUpdateSql produces parameterised set clauses with no value interpolation', () => {
  const { sets, values } = buildUpdateSql({ headline: "Robert'); drop table brands;--", segment: 'premium' });
  assert.deepEqual(sets, ['headline = $2', 'segment = $3']);
  assert.deepEqual(values, ["Robert'); drop table brands;--", 'premium']);
  // The payload appears only as a bound value, never in SQL text.
  assert.ok(!sets.join(' ').includes('drop table'));
});

// ---------------------------------------------------------------------------
// 22-26 — concurrency tokens
// ---------------------------------------------------------------------------

test('a token binds entity type, id and version together', () => {
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  assert.ok(tokenMatches(token, 'brand', 'br_1', UPDATED));
});

test('a stale version does not match', () => {
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  const later = new Date(UPDATED.getTime() + 1000);
  assert.equal(tokenMatches(token, 'brand', 'br_1', later), false);
});

test('a token for another record or another entity type cannot be reused', () => {
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  assert.equal(tokenMatches(token, 'brand', 'br_2', UPDATED), false, 'reused across records');
  assert.equal(tokenMatches(token, 'product', 'br_1', UPDATED), false, 'reused across entity types');
});

test('an absent or malformed token never matches', () => {
  for (const bad of [undefined, null, '', 'garbage', 42, {}]) {
    assert.equal(tokenMatches(bad, 'brand', 'br_1', UPDATED), false, `token ${JSON.stringify(bad)} should not match`);
  }
});

test('the variation token changes when any editable field changes (no updated_at column exists)', () => {
  const base = { id: 'v_1', product_id: 'p_1', sku: 'x', color: 'Black', color_code: 'BLK', swatch_media_id: null, is_published: false, created_at: UPDATED };
  const before = serializeAdminVariation(base).concurrencyToken;
  const afterColour = serializeAdminVariation({ ...base, color: 'Blue' }).concurrencyToken;
  const afterPublish = serializeAdminVariation({ ...base, is_published: true }).concurrencyToken;
  assert.notEqual(before, afterColour);
  assert.notEqual(before, afterPublish);
});
