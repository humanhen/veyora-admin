/* Read-only catalogue exporter (Fast-Track Phase 1, for B2.4C2).

   Produces exactly the closed audit-input fixture that
   `catalogue-audit/input-schema.js` accepts. It is a library function taking
   an INJECTED database client, so the whole thing is testable without a
   database — and so the connection is supplied by the caller rather than
   assembled here from an environment variable.

   Three properties are load-bearing and asserted by test:

     1. EXPLICIT COLUMNS ONLY. Never `select *`. The public boundary's
        forbidden data lives in the same tables as the data we want — one
        wildcard would put prices, purchase costs, stock status and Zoho
        identifiers into a file destined for a review spreadsheet.

     2. NO WRITES. Every statement is a SELECT. There is no transaction,
        because there is nothing to make atomic; a read-only tool that opens
        a write transaction is one refactor away from being a write tool.

     3. PRESENCE, NOT CONTENT, for description and source reference. The
        planner never proposes copy, so it never needs to carry copy. This
        keeps editorial text out of review CSVs entirely.

   Deterministic ordering throughout, so two exports of unchanged data are
   byte-identical and can be diffed. */

/* Explicit column lists. `public_description` and `source_reference` are
   selected only to be collapsed into booleans below — never emitted. */
const PRODUCT_COLUMNS = [
  'id', 'sku', 'name', 'brand', 'brand_id', 'categories', 'line', 'shape', 'segment',
  'public_slug', 'public_description', 'is_active', 'is_published', 'is_featured',
  'is_discontinued', 'replacement_product_id', 'publication_state', 'verification_status',
  'source_reference', 'last_reviewed_at', 'scheduled_review_at', 'content_updated_at',
].join(', ');

const VARIATION_COLUMNS = [
  'id', 'product_id', 'sku', 'color', 'color_code', 'is_active', 'is_published', 'swatch_media_id',
].join(', ');

const BRAND_COLUMNS = [
  'id', 'slug', 'name', 'publication_state', 'verification_status', 'source_reference',
].join(', ');

/* Media is read as a reference only: no path, no alt text, and deliberately
   no rights_holder/rights_expiry — those are media-rights administration
   fields the public boundary already treats as forbidden. */
const MEDIA_COLUMNS = ['id', 'owner_type', 'owner_id', 'kind'].join(', ');

const text = (value) => (value === null || value === undefined ? null : String(value));
const bool = (value) => value === true;
const present = (value) => typeof value === 'string' && value.trim() !== '';
const iso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const stringList = (value) => (Array.isArray(value) ? value.map((v) => String(v)) : []);

/**
 * Reads the catalogue into an audit-input fixture.
 *
 * @param db     anything with `.query(sql, params)` — the real pool, or a
 *               double in tests. No pool is created here.
 * @param source a label recorded in the fixture, e.g. 'staging-2026-08-06'.
 */
export async function exportCatalogue(db, { source = null, exportedAt = null } = {}) {
  /* Sequential rather than parallel: an export is not latency-sensitive, and
     serialising keeps the statement order deterministic in test doubles. */
  const brands = await db.query(`select ${BRAND_COLUMNS} from brands order by id asc`);
  const products = await db.query(`select ${PRODUCT_COLUMNS} from products order by id asc`);
  const variations = await db.query(`select ${VARIATION_COLUMNS} from variations order by id asc`);
  const media = await db.query(
    `select ${MEDIA_COLUMNS} from media where owner_type = 'product' order by id asc`
  );

  return {
    exportedAt: iso(exportedAt) ?? null,
    source: source === null ? null : String(source),
    brands: brands.rows.map((row) => ({
      id: text(row.id),
      slug: text(row.slug),
      name: text(row.name),
      publicationState: text(row.publication_state),
      verificationStatus: text(row.verification_status),
      hasSourceReference: present(row.source_reference),
    })),
    products: products.rows.map((row) => ({
      id: text(row.id),
      sku: text(row.sku),
      name: text(row.name),
      brand: text(row.brand),
      brandId: text(row.brand_id),
      categories: stringList(row.categories),
      line: text(row.line),
      shape: text(row.shape),
      segment: text(row.segment),
      publicSlug: text(row.public_slug),
      // Presence only — the copy itself never leaves the database.
      hasPublicDescription: present(row.public_description),
      isActive: bool(row.is_active),
      isPublished: bool(row.is_published),
      isFeatured: bool(row.is_featured),
      isDiscontinued: bool(row.is_discontinued),
      replacementProductId: text(row.replacement_product_id),
      publicationState: text(row.publication_state),
      verificationStatus: text(row.verification_status),
      hasSourceReference: present(row.source_reference),
      lastReviewedAt: iso(row.last_reviewed_at),
      scheduledReviewAt: iso(row.scheduled_review_at),
      contentUpdatedAt: iso(row.content_updated_at),
    })),
    variations: variations.rows.map((row) => ({
      id: text(row.id),
      productId: text(row.product_id),
      sku: text(row.sku),
      colorName: text(row.color),
      colorCode: text(row.color_code),
      isActive: bool(row.is_active),
      isPublished: bool(row.is_published),
      hasSwatchMedia: row.swatch_media_id !== null && row.swatch_media_id !== undefined,
    })),
    media: media.rows.map((row) => ({
      id: text(row.id),
      ownerType: text(row.owner_type),
      ownerId: text(row.owner_id),
      kind: text(row.kind),
    })),
  };
}

/** The column lists, exposed so tests and documentation cannot drift from
    what is actually selected. */
export const EXPORT_COLUMNS = Object.freeze({
  brands: BRAND_COLUMNS,
  products: PRODUCT_COLUMNS,
  variations: VARIATION_COLUMNS,
  media: MEDIA_COLUMNS,
});
