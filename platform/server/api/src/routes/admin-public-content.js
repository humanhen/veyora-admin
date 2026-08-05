/* Authenticated administrative API for public-content editing and
   publication (B2.4A).

   Mounted under /admin (see index.js), NOT under /public — the public
   router is unauthenticated and read-only, and putting a mutation there
   would destroy that property. Every route here sits behind the same
   `requireAuth('admin')` gate the rest of the admin surface uses.

   The core logic of every handler is exported as a plain function taking
   an injectable `db` (anything with `.query()`, plus `.tx()` for the
   transactional operations), mirroring this repository's established
   convention for testing database-touching logic without a live database
   (src/inventory.js's reserveTakes(client, ...), test/stock-guard.test.js's
   fakeClient(), routes/public.js's exported handlers). The Router wiring at
   the bottom is a thin wrapper. */
import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { invalidatePublicCache } from '../public-cache.js';
import {
  evaluateBrandPublication,
  evaluateProductPublication,
  evaluateVariationPublication,
  productAdvisories,
} from '../publication-gate.js';
import {
  serializeAdminBrand,
  serializeAdminProduct,
  serializeAdminVariation,
  validateAdminPatch,
  buildUpdateSql,
  tokenMatches,
} from '../admin-public-serialize.js';

/* ---------------------------------------------------------------------------
   Authorisation seam
   --------------------------------------------------------------------------- */

/* THE single permission check for this entire router.
 *
 * Today it is a role check — `requireAuth('admin')` — because that is the
 * only permission mechanism this repository has: `users.role` is a single
 * text enum, and there is no permissions table, per-account permission
 * column, scope list or ACL anywhere in the codebase (verified by search
 * before writing this). Public content is editorial and commercially
 * sensitive, so 'admin' alone is used rather than ADMIN_ROLES — the
 * 'warehouse' role reaches other admin routes for fulfilment work and has
 * no reason to edit public brand copy or publish a model.
 *
 * It is expressed as ONE named middleware, applied once, specifically so
 * that granular per-account permissions (the outstanding management
 * requirement — see 18_B2_ADMIN_PUBLICATION_API.md §"Account-specific
 * permissions") have exactly one place to attach. Adding them needs a
 * schema change (a permissions table or column), which B2.4A is explicitly
 * forbidden from making, so this batch does not pretend to implement them.
 */
export function requirePublicContentAdmin() {
  return requireAuth('admin');
}

/* ---------------------------------------------------------------------------
   Errors
   --------------------------------------------------------------------------- */

export class AdminApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

const notFound = (what) => new AdminApiError(404, { error: `${what} not found` });
const conflict = () =>
  new AdminApiError(409, {
    error: 'This record changed since you loaded it. Reload and reapply your edit.',
    code: 'STALE_TOKEN',
  });

/* ---------------------------------------------------------------------------
   Column lists — explicit everywhere, never SELECT *
   --------------------------------------------------------------------------- */

const BRAND_COLUMNS = `id, slug, name, short_name, segment, headline, summary, story, ideal_retailer,
  price_tier_label, design_origin, manufacturing_origin, style_traits, approved_materials,
  logo_media_id, hero_media_id, publication_state, verification_status, source_reference,
  fact_owner, last_reviewed_at, scheduled_review_at, content_updated_at, created_at, updated_at`;

const PRODUCT_COLUMNS = `id, sku, name, brand, public_slug, brand_id, line, shape, segment,
  public_description, categories, is_published, is_featured, is_discontinued, is_active,
  replacement_product_id, publication_state, verification_status, source_reference, fact_owner,
  last_reviewed_at, scheduled_review_at, content_updated_at, created_at, updated_at`;

const VARIATION_COLUMNS = `id, product_id, sku, color, color_code, swatch_media_id, is_published,
  is_active, created_at`;

/* ---------------------------------------------------------------------------
   Gate context loaders — the cross-row facts the pure gate cannot fetch
   --------------------------------------------------------------------------- */

async function brandGateContext(db, brand) {
  const { rows } = await db.query(`select id from brands where slug = $1 and id <> $2 limit 1`, [
    brand.slug ?? '',
    brand.id,
  ]);
  return { slugIsUnique: rows.length === 0 };
}

async function productGateContext(db, product) {
  const [{ rows: brandRows }, { rows: slugRows }, { rows: variationRows }, { rows: mediaRows }] =
    await Promise.all([
      product.brand_id
        ? db.query(`select id, publication_state from brands where id = $1 limit 1`, [product.brand_id])
        : Promise.resolve({ rows: [] }),
      db.query(`select id from products where public_slug = $1 and id <> $2 limit 1`, [
        product.public_slug ?? '',
        product.id,
      ]),
      db.query(`select ${VARIATION_COLUMNS} from variations where product_id = $1 order by sku`, [product.id]),
      db.query(`select id from media where owner_type = 'product' and owner_id = $1`, [product.id]),
    ]);

  let replacement = null;
  if (product.replacement_product_id) {
    const { rows } = await db.query(`select id, is_published from products where id = $1 limit 1`, [
      product.replacement_product_id,
    ]);
    replacement = rows[0] ?? null;
  }

  /* A variation counts as publishable when it passes its own gate given a
     hypothetically-eligible parent. Passing parentEligible: true here is
     deliberate and non-circular: this asks "is this colourway itself
     complete?", and the parent's own eligibility is decided separately by
     the product gate that consumes this count. */
  const publishableVariationCount = variationRows.filter(
    (v) => evaluateVariationPublication(v, { parentEligible: true, mediaExists: true }).allowed
  ).length;

  return {
    brand: brandRows[0] ?? null,
    slugIsUnique: slugRows.length === 0,
    publishableVariationCount,
    mediaCount: mediaRows.length,
    replacement,
    variations: variationRows,
  };
}

async function variationGateContext(db, variation) {
  const { rows: productRows } = await db.query(
    `select ${PRODUCT_COLUMNS} from products where id = $1 limit 1`,
    [variation.product_id]
  );
  const product = productRows[0] ?? null;
  let parentEligible;
  if (product) {
    const context = await productGateContext(db, product);
    parentEligible = evaluateProductPublication(product, context).allowed;
  }

  let mediaExists = true;
  if (variation.swatch_media_id) {
    const { rows } = await db.query(`select id from media where id = $1 limit 1`, [variation.swatch_media_id]);
    mediaExists = rows.length > 0;
  }
  return { parentEligible, mediaExists };
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

export async function listAdminBrands(db, { limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(
    `select ${BRAND_COLUMNS} from brands order by name asc limit $1 offset $2`,
    [Math.min(Math.max(Number(limit) || 100, 1), 200), Math.max(Number(offset) || 0, 0)]
  );
  return rows.map((row) => serializeAdminBrand(row));
}

export async function getAdminBrand(db, id) {
  const { rows } = await db.query(`select ${BRAND_COLUMNS} from brands where id = $1 limit 1`, [id]);
  const brand = rows[0];
  if (!brand) throw notFound('Brand');
  const gate = evaluateBrandPublication(brand, await brandGateContext(db, brand));
  return serializeAdminBrand(brand, { gate });
}

export async function listAdminProducts(db, { limit = 50, offset = 0, brandId = null } = {}) {
  const { rows } = await db.query(
    `select ${PRODUCT_COLUMNS} from products
      where ($3::text is null or brand_id = $3)
      order by name asc, id asc limit $1 offset $2`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0), brandId]
  );
  return rows.map((row) => serializeAdminProduct(row));
}

export async function getAdminProduct(db, id) {
  const { rows } = await db.query(`select ${PRODUCT_COLUMNS} from products where id = $1 limit 1`, [id]);
  const product = rows[0];
  if (!product) throw notFound('Product');
  const context = await productGateContext(db, product);
  const gate = evaluateProductPublication(product, context);
  return {
    ...serializeAdminProduct(product, {
      gate,
      advisories: productAdvisories(product, context),
    }),
    variations: context.variations.map((v) => serializeAdminVariation(v)),
  };
}

export async function getAdminVariation(db, id) {
  const { rows } = await db.query(`select ${VARIATION_COLUMNS} from variations where id = $1 limit 1`, [id]);
  const variation = rows[0];
  if (!variation) throw notFound('Variation');
  const gate = evaluateVariationPublication(variation, await variationGateContext(db, variation));
  return serializeAdminVariation(variation, { gate });
}

/* ---------------------------------------------------------------------------
   PATCH — draft editing
   --------------------------------------------------------------------------- */

const ENTITY_TABLES = {
  brand: { table: 'brands', columns: BRAND_COLUMNS, label: 'Brand' },
  product: { table: 'products', columns: PRODUCT_COLUMNS, label: 'Product' },
  variation: { table: 'variations', columns: VARIATION_COLUMNS, label: 'Variation' },
};

function tokenSourceFor(entityType, row) {
  if (entityType === 'variation') {
    const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? '');
    return `${created}|${row.color ?? ''}|${row.color_code ?? ''}|${row.swatch_media_id ?? ''}|${row.is_published === true}`;
  }
  return row.updated_at;
}

export async function patchAdminEntity(db, entityType, id, body) {
  const meta = ENTITY_TABLES[entityType];
  if (!meta) throw new AdminApiError(400, { error: 'Unknown entity type' });

  const validated = validateAdminPatch(entityType, body);
  if (!validated.ok) {
    throw new AdminApiError(400, { error: 'Invalid patch', fieldErrors: validated.errors });
  }

  const token = body?.concurrencyToken;

  const outcome = await db.tx(async (c) => {
    /* Locked read inside the transaction — the repository's existing
       pattern (routes/admin.js order PATCH). The lock stops two concurrent
       writers interleaving; the token check below stops a writer
       overwriting a value they never saw. Both are needed. */
    const { rows } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 for update`,
      [id]
    );
    const current = rows[0];
    if (!current) throw notFound(meta.label);

    if (!tokenMatches(token, entityType, id, tokenSourceFor(entityType, current))) {
      // Throwing rolls the transaction back, so a stale attempt writes
      // nothing — asserted by test.
      throw conflict();
    }

    const { sets, values } = buildUpdateSql(validated.fields);
    /* `content_updated_at` is bumped here because this is an editorial
       content change — which is exactly what that column is for
       (14_B2_SCHEMA_REFERENCE.md §4.1: it stays separate from `updated_at`
       so a Zoho stock sync never moves it). */
    const extraSets = [...sets, 'content_updated_at = now()'];
    if (entityType !== 'variation') extraSets.push('updated_at = now()');

    await c.query(`update ${meta.table} set ${extraSets.join(', ')} where id = $1`, [id, ...values]);

    const { rows: after } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 limit 1`,
      [id]
    );
    return after[0];
  });

  // Only after the transaction has committed.
  invalidatePublicCache();
  return outcome;
}

/* ---------------------------------------------------------------------------
   Publication evaluation (read-only, no mutation)
   --------------------------------------------------------------------------- */

export async function evaluateEntity(db, entityType, id) {
  if (entityType === 'brand') {
    const { rows } = await db.query(`select ${BRAND_COLUMNS} from brands where id = $1 limit 1`, [id]);
    if (!rows[0]) throw notFound('Brand');
    return evaluateBrandPublication(rows[0], await brandGateContext(db, rows[0]));
  }
  if (entityType === 'product') {
    const { rows } = await db.query(`select ${PRODUCT_COLUMNS} from products where id = $1 limit 1`, [id]);
    if (!rows[0]) throw notFound('Product');
    return evaluateProductPublication(rows[0], await productGateContext(db, rows[0]));
  }
  if (entityType === 'variation') {
    const { rows } = await db.query(`select ${VARIATION_COLUMNS} from variations where id = $1 limit 1`, [id]);
    if (!rows[0]) throw notFound('Variation');
    return evaluateVariationPublication(rows[0], await variationGateContext(db, rows[0]));
  }
  throw new AdminApiError(400, { error: 'Unknown entity type' });
}

/* ---------------------------------------------------------------------------
   Publish / unpublish — transactional, gated, approval-recorded
   --------------------------------------------------------------------------- */

/**
 * @param actor the AUTHENTICATED user (req.user). Actor identity is taken
 *   only from here — never from the request body — so an approval row
 *   cannot be attributed to someone else by a crafted request.
 */
export async function publishEntity(db, entityType, id, { token, actor, note = '' }) {
  const meta = ENTITY_TABLES[entityType];
  if (!meta) throw new AdminApiError(400, { error: 'Unknown entity type' });

  const result = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 for update`,
      [id]
    );
    const current = rows[0];
    if (!current) throw notFound(meta.label);

    if (!tokenMatches(token, entityType, id, tokenSourceFor(entityType, current))) throw conflict();

    /* Re-evaluate INSIDE the transaction against the freshly locked row —
       not against whatever the caller last saw. This is what makes
       "changing publication_state alone cannot bypass the gate" true: the
       state column is one input to the verdict, not the verdict itself. */
    let verdict;
    if (entityType === 'brand') {
      verdict = evaluateBrandPublication(current, await brandGateContext(c, current));
    } else if (entityType === 'product') {
      verdict = evaluateProductPublication(current, await productGateContext(c, current));
    } else {
      verdict = evaluateVariationPublication(current, await variationGateContext(c, current));
    }

    if (!verdict.allowed) {
      /* Throwing rolls back before any content or approval row is written —
         the "failed gate writes neither" requirement. */
      throw new AdminApiError(422, {
        error: 'This record does not meet the publication requirements.',
        code: 'PUBLICATION_GATE_FAILED',
        reasons: verdict.reasons,
      });
    }

    if (entityType === 'brand') {
      // brands have no is_published column; publication_state is the flag.
      await c.query(
        `update brands set publication_state = 'published', content_updated_at = now(), updated_at = now() where id = $1`,
        [id]
      );
    } else if (entityType === 'product') {
      await c.query(
        `update products set is_published = true, publication_state = 'published',
           content_updated_at = now(), updated_at = now() where id = $1`,
        [id]
      );
    } else {
      await c.query(`update variations set is_published = true where id = $1`, [id]);
    }

    await c.query(
      `insert into content_approvals (entity_type, entity_id, field, approver_id, source_reference, note)
       values ($1, $2, $3, $4, $5, $6)`,
      [entityType, id, 'publication', actor?.id ?? null, current.source_reference ?? '', String(note).slice(0, 2000)]
    );

    const { rows: after } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 limit 1`,
      [id]
    );
    return after[0];
  });

  invalidatePublicCache();
  await audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    'public_content.publish',
    `${entityType}:${id}`,
    'published'
  ).catch(() => {});
  return result;
}

export async function unpublishEntity(db, entityType, id, { token, actor, note = '' }) {
  const meta = ENTITY_TABLES[entityType];
  if (!meta) throw new AdminApiError(400, { error: 'Unknown entity type' });

  const result = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 for update`,
      [id]
    );
    const current = rows[0];
    if (!current) throw notFound(meta.label);
    if (!tokenMatches(token, entityType, id, tokenSourceFor(entityType, current))) throw conflict();

    /* Unpublishing is NOT gated — removing something from public view must
       always be possible, immediately. Content is preserved (nothing is
       deleted), and redirects/slug history are untouched, so a later
       republish keeps its URLs. */
    if (entityType === 'brand') {
      await c.query(
        `update brands set publication_state = 'approved', updated_at = now() where id = $1`,
        [id]
      );
    } else if (entityType === 'product') {
      /* is_published is cleared FIRST in the same statement as the state
         change: the B2.1 CHECK requires is_published = false whenever
         publication_state <> 'published', so both must move together or
         the constraint rejects the update. */
      await c.query(
        `update products set is_published = false, publication_state = 'approved', updated_at = now() where id = $1`,
        [id]
      );
    } else {
      await c.query(`update variations set is_published = false where id = $1`, [id]);
    }

    await c.query(
      `insert into content_approvals (entity_type, entity_id, field, approver_id, source_reference, note)
       values ($1, $2, $3, $4, $5, $6)`,
      [entityType, id, 'unpublication', actor?.id ?? null, current.source_reference ?? '', String(note).slice(0, 2000)]
    );

    const { rows: after } = await c.query(
      `select ${meta.columns} from ${meta.table} where id = $1 limit 1`,
      [id]
    );
    return after[0];
  });

  invalidatePublicCache();
  await audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    'public_content.unpublish',
    `${entityType}:${id}`,
    'unpublished'
  ).catch(() => {});
  return result;
}

/* ---------------------------------------------------------------------------
   Router wiring
   --------------------------------------------------------------------------- */

/** The real database, presented with the `.tx()` shape the handlers expect. */
const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();

// ONE permission check, applied to the whole router. See the seam comment above.
r.use(requirePublicContentAdmin());

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof AdminApiError) return res.status(err.status).json(err.body);
      next(err);
    });
}

const SERIALIZERS = {
  brand: serializeAdminBrand,
  product: serializeAdminProduct,
  variation: serializeAdminVariation,
};

// ---- reads ----
r.get('/brands', (req, res, next) =>
  send(res, next, listAdminBrands(liveDb, { limit: req.query.limit, offset: req.query.offset }), (brands) => ({ brands }))
);
r.get('/brands/:id', (req, res, next) =>
  send(res, next, getAdminBrand(liveDb, req.params.id), (brand) => ({ brand }))
);
r.get('/products', (req, res, next) =>
  send(
    res,
    next,
    listAdminProducts(liveDb, {
      limit: req.query.limit,
      offset: req.query.offset,
      brandId: typeof req.query.brandId === 'string' ? req.query.brandId : null,
    }),
    (products) => ({ products })
  )
);
r.get('/products/:id', (req, res, next) =>
  send(res, next, getAdminProduct(liveDb, req.params.id), (product) => ({ product }))
);
r.get('/variations/:id', (req, res, next) =>
  send(res, next, getAdminVariation(liveDb, req.params.id), (variation) => ({ variation }))
);

// ---- patch ----
for (const [entityType, segment] of [
  ['brand', 'brands'],
  ['product', 'products'],
  ['variation', 'variations'],
]) {
  r.patch(`/${segment}/:id`, (req, res, next) =>
    send(res, next, patchAdminEntity(liveDb, entityType, req.params.id, req.body), (row) => ({
      [entityType]: SERIALIZERS[entityType](row),
    }))
  );

  r.post(`/${segment}/:id/evaluate`, (req, res, next) =>
    send(res, next, evaluateEntity(liveDb, entityType, req.params.id), (gate) => ({ gate }))
  );

  r.post(`/${segment}/:id/publish`, (req, res, next) =>
    send(
      res,
      next,
      publishEntity(liveDb, entityType, req.params.id, {
        token: req.body?.concurrencyToken,
        actor: req.user, // authenticated context only — never req.body
        note: req.body?.note,
      }),
      (row) => ({ [entityType]: SERIALIZERS[entityType](row) })
    )
  );

  r.post(`/${segment}/:id/unpublish`, (req, res, next) =>
    send(
      res,
      next,
      unpublishEntity(liveDb, entityType, req.params.id, {
        token: req.body?.concurrencyToken,
        actor: req.user,
        note: req.body?.note,
      }),
      (row) => ({ [entityType]: SERIALIZERS[entityType](row) })
    )
  );
}

export default r;
