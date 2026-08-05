/* The unauthenticated, read-only public API boundary (B2.2) for the future
   Astro public website. No authentication middleware anywhere on this
   router — everything here must already be safe for an anonymous, hostile
   caller by construction of the query (explicit publication filters) and
   the serializer (pure allowlist, api/src/public-serialize.js).

   Deliberately does NOT import pricing.js, ordering.js, cart.js, the
   customer/agent/admin routers, or any authenticated /user handler — this
   file only ever imports `pool` from ../db.js for its own explicit,
   parameterised, published-only SELECTs.

   Every handler's core logic is exported as a plain async function taking
   an injectable `db` (anything with a `.query(sql, params)` method — the
   real `pool` in production, a fake recording object in tests), mirroring
   this repository's existing convention for testing database-touching
   logic without a live database (see src/inventory.js's reserveTakes(client, ...)
   and test/stock-guard.test.js's fakeClient()). The Router wiring below is
   a thin wrapper around these functions. */
import { Router } from 'express';
import { pool } from '../db.js';
import {
  serializeBrandSummary,
  serializeBrandDetail,
  serializeModelCard,
  serializeModelDetail,
  serializeLocation,
  serializeSitemapRecord,
} from '../public-serialize.js';
import { buildCacheKey, getCached, setCached } from '../public-cache.js';

export class PublicApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MODELS_PAGE_SIZE = 24;
const FEATURED_MODELS_LIMIT = 8;
const RELATED_MODELS_LIMIT = 4;
const MAX_FILTER_VALUE_LENGTH = 80;

const MODEL_SORTS = {
  // content_updated_at, not the operationally-churned updated_at (see
  // 14_B2_SCHEMA_REFERENCE.md §4.1) — "newest" means newest *published
  // content*, not "most recently touched by a Zoho sync".
  newest: 'p.content_updated_at desc, p.id asc',
  name: 'p.name asc, p.id asc',
};

// ---------------------------------------------------------------------------
// validation helpers — pure, no I/O
// ---------------------------------------------------------------------------

/** A single scalar query value: not an array, not absurdly long. Returns
 * `null` for "not supplied", a trimmed string otherwise, or throws a 400
 * for anything malformed. Deliberately rejects arrays (Express parses
 * `?x=a&x=b` as an array) — every filter here is single-valued. */
function parseFilterValue(raw, name) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) throw new PublicApiError(400, `${name} must be a single value`);
  const s = String(raw).trim();
  if (s.length === 0) return null;
  if (s.length > MAX_FILTER_VALUE_LENGTH) throw new PublicApiError(400, `${name} is too long`);
  return s;
}

function parsePage(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (Array.isArray(raw)) throw new PublicApiError(400, 'page must be a single value');
  // Reject anything that isn't a bare positive integer literal — "2abc",
  // "2.5", "-1", "" all fail here rather than being coerced by parseInt.
  if (!/^[0-9]+$/.test(String(raw).trim())) throw new PublicApiError(400, 'page must be a positive integer');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new PublicApiError(400, 'page must be a positive integer');
  return n;
}

function parseSort(raw) {
  if (raw === undefined || raw === null || raw === '') return 'newest';
  if (Array.isArray(raw)) throw new PublicApiError(400, 'sort must be a single value');
  const s = String(raw).trim();
  if (!Object.prototype.hasOwnProperty.call(MODEL_SORTS, s)) {
    throw new PublicApiError(400, `unsupported sort: ${s}`);
  }
  return s;
}

function parseSlugParam(raw, name) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_FILTER_VALUE_LENGTH) throw new PublicApiError(404, `${name} not found`);
  return s;
}

// ---------------------------------------------------------------------------
// shared media resolution — explicit columns, batched, never SELECT *
// ---------------------------------------------------------------------------

/** Resolves media rows for a set of (ownerType, ownerId) pairs in one
 * query, grouped by owner id, ordered so the first entry per owner is a
 * stable "primary" image. Returns a Map(ownerId -> media row[]). */
async function fetchMediaByOwners(db, ownerType, ownerIds) {
  const ids = [...new Set(ownerIds)].filter(Boolean);
  const byOwner = new Map();
  if (!ids.length) return byOwner;
  const { rows } = await db.query(
    `select id, path, alt, width, height, kind, owner_id
       from media
      where owner_type = $1 and owner_id = any($2)
      order by owner_id, id`,
    [ownerType, ids]
  );
  for (const row of rows) {
    if (!byOwner.has(row.owner_id)) byOwner.set(row.owner_id, []);
    byOwner.get(row.owner_id).push(row);
  }
  return byOwner;
}

/** Resolves a set of media ids (e.g. brands.logo_media_id/hero_media_id,
 * variations.swatch_media_id) in one query. Returns a Map(id -> row). */
async function fetchMediaByIds(db, ids) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const byId = new Map();
  if (!uniqueIds.length) return byId;
  const { rows } = await db.query(
    `select id, path, alt, width, height, kind from media where id = any($1)`,
    [uniqueIds]
  );
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

// ---------------------------------------------------------------------------
// GET /public/brands
// ---------------------------------------------------------------------------

export async function listPublishedBrands(db, { segment } = {}) {
  const params = [segment ?? null];
  const { rows } = await db.query(
    `select slug, name, short_name, segment, headline, price_tier_label, logo_media_id
       from brands
      where publication_state = 'published'
        and ($1::text is null or segment = $1)
      order by name asc`,
    params
  );
  const mediaById = await fetchMediaByIds(db, rows.map((r) => r.logo_media_id));
  return rows.map((row) => serializeBrandSummary(row, { logoMedia: mediaById.get(row.logo_media_id) ?? null }));
}

// ---------------------------------------------------------------------------
// GET /public/brands/:slug
// ---------------------------------------------------------------------------

export async function getPublishedBrandBySlug(db, slug) {
  const { rows } = await db.query(
    `select id, slug, name, short_name, segment, headline, summary, story, ideal_retailer,
            best_for, style_traits, price_tier_label, design_origin, manufacturing_origin,
            component_origins, approved_materials, logo_media_id, hero_media_id, content_updated_at
       from brands
      where slug = $1 and publication_state = 'published'
      limit 1`,
    [slug]
  );
  const brand = rows[0];
  if (!brand) throw new PublicApiError(404, 'brand not found');

  const { rows: featuredRows } = await db.query(
    `select p.id, p.public_slug, p.sku, p.name, p.line, p.shape, p.segment, p.size,
            p.categories, p.is_featured, b.slug as brand_slug, b.name as brand_name
       from products p
       join brands b on b.id = p.brand_id
      where p.brand_id = $1 and p.is_published = true and p.is_featured = true
      order by p.content_updated_at desc, p.id
      limit $2`,
    [brand.id, FEATURED_MODELS_LIMIT]
  );

  const mediaByOwner = await fetchMediaByOwners(db, 'product', featuredRows.map((r) => r.id));
  const brandMediaById = await fetchMediaByIds(db, [brand.logo_media_id, brand.hero_media_id]);

  return serializeBrandDetail(brand, {
    logoMedia: brandMediaById.get(brand.logo_media_id) ?? null,
    heroMedia: brandMediaById.get(brand.hero_media_id) ?? null,
    featuredModels: featuredRows.map((row) => ({
      row,
      primaryMedia: (mediaByOwner.get(row.id) ?? [])[0] ?? null,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /public/models
// ---------------------------------------------------------------------------

export async function listPublishedModels(db, query = {}) {
  const brand = parseFilterValue(query.brand, 'brand');
  const category = parseFilterValue(query.category, 'category');
  const shape = parseFilterValue(query.shape, 'shape');
  const size = parseFilterValue(query.size, 'size');
  // Accepted for forward API compatibility with the route matrix's facet
  // set, but currently a documented no-op: no `audience`/`material` column
  // exists yet (see 15_B2_PUBLIC_API_CONTRACT.md "known limitations").
  // Still validated so a malformed value 400s rather than being ignored
  // silently.
  parseFilterValue(query.audience, 'audience');
  parseFilterValue(query.material, 'material');
  const sort = parseSort(query.sort);
  const page = parsePage(query.page);

  const params = [brand, shape, size, category, MODELS_PAGE_SIZE + 1, (page - 1) * MODELS_PAGE_SIZE];
  const { rows } = await db.query(
    `select p.id, p.public_slug, p.sku, p.name, p.line, p.shape, p.segment, p.size,
            p.categories, p.is_featured, p.content_updated_at,
            b.slug as brand_slug, b.name as brand_name
       from products p
       join brands b on b.id = p.brand_id
      where p.is_published = true
        and b.publication_state = 'published'
        and ($1::text is null or b.slug = $1)
        and ($2::text is null or p.shape = $2)
        and ($3::text is null or p.size = $3)
        and ($4::text is null or p.categories @> array[$4]::text[])
      order by ${MODEL_SORTS[sort]}
      limit $5 offset $6`,
    params
  );

  const hasMore = rows.length > MODELS_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, MODELS_PAGE_SIZE) : rows;
  const mediaByOwner = await fetchMediaByOwners(db, 'product', pageRows.map((r) => r.id));

  return {
    items: pageRows.map((row) => serializeModelCard(row, { primaryMedia: (mediaByOwner.get(row.id) ?? [])[0] ?? null })),
    page,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// GET /public/models/:brand/:slug
// ---------------------------------------------------------------------------

export async function getPublishedModelBySlugs(db, brandSlug, modelSlug) {
  const { rows } = await db.query(
    `select p.id, p.public_slug, p.sku, p.name, p.line, p.shape, p.segment, p.size,
            p.categories, p.is_featured, p.public_description, p.attributes,
            p.content_updated_at, b.id as brand_id, b.slug as brand_slug, b.name as brand_name
       from products p
       join brands b on b.id = p.brand_id
      where b.slug = $1 and p.public_slug = $2
        and p.is_published = true and b.publication_state = 'published'
      limit 1`,
    [brandSlug, modelSlug]
  );
  const product = rows[0];
  if (!product) throw new PublicApiError(404, 'model not found');

  const { rows: variationRows } = await db.query(
    `select id, sku, color, color_code, swatch_media_id
       from variations
      where product_id = $1 and is_published = true
      order by sku`,
    [product.id]
  );
  const swatchMediaById = await fetchMediaByIds(db, variationRows.map((v) => v.swatch_media_id));

  const mediaByOwner = await fetchMediaByOwners(db, 'product', [product.id]);
  const media = mediaByOwner.get(product.id) ?? [];

  const { rows: relatedRows } = await db.query(
    `select p.id, p.public_slug, p.sku, p.name, p.line, p.shape, p.segment, p.size,
            p.categories, p.is_featured, b.slug as brand_slug, b.name as brand_name
       from products p
       join brands b on b.id = p.brand_id
      where p.brand_id = $1 and p.is_published = true and p.id <> $2
      order by p.content_updated_at desc, p.id
      limit $3`,
    [product.brand_id, product.id, RELATED_MODELS_LIMIT]
  );
  const relatedMediaByOwner = await fetchMediaByOwners(db, 'product', relatedRows.map((r) => r.id));

  return serializeModelDetail(product, {
    variations: variationRows.map((v) => ({
      variation: v,
      swatchMedia: swatchMediaById.get(v.swatch_media_id) ?? null,
    })),
    media,
    relatedModels: relatedRows.map((row) => ({
      row,
      primaryMedia: (relatedMediaByOwner.get(row.id) ?? [])[0] ?? null,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /public/facets
// ---------------------------------------------------------------------------

export async function getPublicFacets(db) {
  const [{ rows: shapeRows }, { rows: sizeRows }, { rows: categoryRows }, { rows: brandRows }] = await Promise.all([
    db.query(`select distinct shape from products where is_published = true and shape <> '' order by shape`),
    db.query(`select distinct size from products where is_published = true and size <> '' order by size`),
    db.query(
      `select distinct unnest(categories) as category
         from products where is_published = true order by category`
    ),
    db.query(`select slug, name from brands where publication_state = 'published' order by name`),
  ]);
  return {
    shapes: shapeRows.map((r) => r.shape),
    sizes: sizeRows.map((r) => r.size),
    categories: categoryRows.map((r) => r.category),
    brands: brandRows.map((r) => ({ slug: r.slug, name: r.name })),
  };
}

// ---------------------------------------------------------------------------
// GET /public/locations
// ---------------------------------------------------------------------------

export async function listPublishedLocations(db) {
  const { rows } = await db.query(
    `select slug, name, function, regions_served, hours
       from locations
      where publication_state = 'published' and is_public = true
      order by name asc`
  );
  return rows.map((row) => serializeLocation(row));
}

// ---------------------------------------------------------------------------
// GET /public/sitemap-data
// ---------------------------------------------------------------------------

export async function getSitemapData(db) {
  const [{ rows: brandRows }, { rows: modelRows }, { rows: pageRows }] = await Promise.all([
    db.query(`select slug, content_updated_at from brands where publication_state = 'published' order by slug`),
    db.query(
      `select p.public_slug, b.slug as brand_slug, p.content_updated_at
         from products p
         join brands b on b.id = p.brand_id
        where p.is_published = true and b.publication_state = 'published' and p.public_slug is not null
        order by b.slug, p.public_slug`
    ),
    db.query(
      `select route, content_updated_at from content_pages
        where publication_state = 'published' and index_state = 'index'
        order by route`
    ),
  ]);

  return {
    brands: brandRows.map((r) => serializeSitemapRecord({ path: `/brands/${r.slug}/`, contentUpdatedAt: r.content_updated_at })),
    models: modelRows.map((r) =>
      serializeSitemapRecord({ path: `/collections/${r.brand_slug}/${r.public_slug}/`, contentUpdatedAt: r.content_updated_at })
    ),
    pages: pageRows.map((r) => serializeSitemapRecord({ path: r.route, contentUpdatedAt: r.content_updated_at })),
  };
}

// ---------------------------------------------------------------------------
// Router wiring — thin; all real logic is in the exported functions above
// ---------------------------------------------------------------------------

const r = Router();

r.get('/brands', async (req, res, next) => {
  try {
    const segment = parseFilterValue(req.query.segment, 'segment');
    const key = buildCacheKey('brands', { segment });
    const cached = getCached(key);
    if (cached) return res.json(cached);
    const body = { brands: await listPublishedBrands(pool, { segment }) };
    setCached(key, body);
    res.json(body);
  } catch (e) {
    if (e instanceof PublicApiError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

r.get('/brands/:slug', async (req, res, next) => {
  try {
    const slug = parseSlugParam(req.params.slug, 'brand');
    const body = { brand: await getPublishedBrandBySlug(pool, slug) };
    res.json(body);
  } catch (e) {
    if (e instanceof PublicApiError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

r.get('/models', async (req, res, next) => {
  try {
    const key = buildCacheKey('models', req.query);
    const cached = getCached(key);
    if (cached) return res.json(cached);
    const body = await listPublishedModels(pool, req.query);
    setCached(key, body);
    res.json(body);
  } catch (e) {
    if (e instanceof PublicApiError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

r.get('/models/:brand/:slug', async (req, res, next) => {
  try {
    const brandSlug = parseSlugParam(req.params.brand, 'model');
    const modelSlug = parseSlugParam(req.params.slug, 'model');
    const body = { model: await getPublishedModelBySlugs(pool, brandSlug, modelSlug) };
    res.json(body);
  } catch (e) {
    if (e instanceof PublicApiError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

r.get('/facets', async (req, res, next) => {
  try {
    const key = buildCacheKey('facets', {});
    const cached = getCached(key);
    if (cached) return res.json(cached);
    const body = await getPublicFacets(pool);
    setCached(key, body);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

r.get('/locations', async (req, res, next) => {
  try {
    const key = buildCacheKey('locations', {});
    const cached = getCached(key);
    if (cached) return res.json(cached);
    const body = { locations: await listPublishedLocations(pool) };
    setCached(key, body);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

r.get('/sitemap-data', async (req, res, next) => {
  try {
    const key = buildCacheKey('sitemap-data', {});
    const cached = getCached(key);
    if (cached) return res.json(cached);
    const body = await getSitemapData(pool);
    setCached(key, body);
    res.json(body);
  } catch (e) {
    next(e);
  }
});

export default r;
