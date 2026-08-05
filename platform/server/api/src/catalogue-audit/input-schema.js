/* Safe input contract for the catalogue readiness audit (B2.4C1).

   The planner reads an EXPORTED FIXTURE, never a database. This module is the
   only door into it, and it is a closed allowlist in both directions:

     - every top-level key must be known;
     - every field on every record must be known;
     - anything on the public API's forbidden list is rejected by name, not
       merely ignored.

   Rejecting rather than ignoring is the point. An export that happens to
   carry prices, stock, customer data or the unrestricted `attributes` blob is
   a mistake at the point it was produced — silently dropping those fields
   would let that mistake travel, and a later run with a slightly different
   pipeline could start emitting them. Refusing the file makes the mistake
   visible where it can still be fixed.

   `attributes` (jsonb: lens_w, bridge, lens_h, temple, lensType, caseCode) is
   excluded wholesale rather than filtered. It is unrestricted by construction
   — nothing stops a future import putting anything in it — so no allowlist
   over its contents could be trusted.

   The public description arrives as a PRESENCE BOOLEAN, not as text. The
   planner never proposes description copy, so it only ever needs to know
   whether approved copy exists. */

import { isForbiddenKey, scanForForbiddenKeys } from '../public-forbidden-keys.js';

/* ---------------------------------------------------------------------------
   The contract
   --------------------------------------------------------------------------- */

const TOP_LEVEL = new Set(['exportedAt', 'source', 'brands', 'products', 'variations', 'media']);

/** kind: 'string' | 'string?' (nullable) | 'bool' | 'stringList' | 'iso?' */
const BRAND_FIELDS = {
  id: 'string',
  slug: 'string?',
  name: 'string',
  publicationState: 'string?',
  verificationStatus: 'string?',
  hasSourceReference: 'bool',
};

const PRODUCT_FIELDS = {
  id: 'string',
  sku: 'string',
  name: 'string',
  brand: 'string?',            // the legacy free-text brand from the import
  brandId: 'string?',
  categories: 'stringList',
  line: 'string?',
  shape: 'string?',
  segment: 'string?',
  publicSlug: 'string?',
  hasPublicDescription: 'bool',
  isActive: 'bool',
  isPublished: 'bool',
  isFeatured: 'bool',
  isDiscontinued: 'bool',
  replacementProductId: 'string?',
  publicationState: 'string?',
  verificationStatus: 'string?',
  hasSourceReference: 'bool',
  lastReviewedAt: 'iso?',
  scheduledReviewAt: 'iso?',
  contentUpdatedAt: 'iso?',
};

const VARIATION_FIELDS = {
  id: 'string',
  productId: 'string',
  sku: 'string',
  colorName: 'string?',
  colorCode: 'string?',
  isActive: 'bool',
  isPublished: 'bool',
  hasSwatchMedia: 'bool',
};

/* Media is admitted only as a safe reference so approved images can be
   COUNTED. No path, no alt text, and deliberately no `rightsHolder` or
   `rightsExpiry` — those are media-rights administration fields that the
   public boundary already treats as forbidden. */
const MEDIA_FIELDS = {
  id: 'string',
  ownerType: 'string',
  ownerId: 'string',
  kind: 'string?',
};

const COLLECTIONS = {
  brands: BRAND_FIELDS,
  products: PRODUCT_FIELDS,
  variations: VARIATION_FIELDS,
  media: MEDIA_FIELDS,
};

/** Named so a rejection can say WHY, beyond "unknown field". */
const EXCLUDED_BY_NAME = new Map([
  ['attributes', 'unrestricted attribute blob — its contents are not constrained by anything'],
  ['price', 'commercial data'],
  ['salePrice', 'commercial data'],
  ['purchasePrice', 'supplier cost'],
  ['cost', 'commercial data'],
  ['margin', 'commercial data'],
  ['stock', 'stock data'],
  ['stockStatus', 'availability data'],
  ['qty', 'stock data'],
  ['quantity', 'stock data'],
  ['warehouse', 'warehouse data'],
  ['zohoItemId', 'supplier sync identifier'],
  ['factOwner', 'internal user identifier'],
  ['factOwnerId', 'internal user identifier'],
  ['rightsHolder', 'media-rights administration field'],
  ['rightsExpiry', 'media-rights administration field'],
  ['description', 'internal portal description — the audit uses hasPublicDescription instead'],
  ['publicDescription', 'description text is never needed for planning — use hasPublicDescription'],
  ['sourceReference', 'source text is never needed for planning — use hasSourceReference'],
  ['tags', 'internal tag list may carry label:* internals'],
  ['images', 'raw image paths — media is admitted as counted references instead'],
  ['ean', 'barcode identifier, not needed for planning'],
]);

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

export class AuditInputError extends Error {
  constructor(errors) {
    super(`Invalid catalogue export: ${errors.length} problem(s)`);
    this.name = 'AuditInputError';
    this.errors = errors;
  }
}

const err = (path, code, message) => ({ path, code, message });

function checkField(kind, value, path, errors) {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(err(path, 'REQUIRED_STRING', 'A non-empty string is required.'));
        return;
      }
      break;
    case 'string?':
      if (value !== null && value !== undefined && typeof value !== 'string') {
        errors.push(err(path, 'INVALID_STRING', 'Must be a string or null.'));
        return;
      }
      break;
    case 'bool':
      if (typeof value !== 'boolean') {
        errors.push(err(path, 'INVALID_BOOLEAN', 'Must be true or false.'));
        return;
      }
      break;
    case 'stringList':
      if (!Array.isArray(value)) {
        errors.push(err(path, 'INVALID_ARRAY', 'Must be an array of strings.'));
        return;
      }
      if (value.some((v) => typeof v !== 'string')) {
        errors.push(err(path, 'INVALID_ARRAY_ITEM', 'Every entry must be a string.'));
        return;
      }
      break;
    case 'iso?':
      if (value === null || value === undefined) break;
      if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
        errors.push(err(path, 'INVALID_DATE', 'Must be an ISO date string or null.'));
        return;
      }
      break;
    default:
      errors.push(err(path, 'INTERNAL', `Unknown field kind ${kind}.`));
  }
}

function checkRecord(record, fields, path, errors) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    errors.push(err(path, 'INVALID_RECORD', 'Each entry must be an object.'));
    return;
  }

  for (const key of Object.keys(record)) {
    if (EXCLUDED_BY_NAME.has(key)) {
      errors.push(err(`${path}.${key}`, 'EXCLUDED_FIELD',
        `This field must not appear in an audit export: ${EXCLUDED_BY_NAME.get(key)}.`));
      continue;
    }
    if (isForbiddenKey(key)) {
      errors.push(err(`${path}.${key}`, 'FORBIDDEN_FIELD',
        'This field is on the public boundary’s forbidden list and must not appear in an audit export.'));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      errors.push(err(`${path}.${key}`, 'UNKNOWN_FIELD',
        'Unknown field. The audit input is a closed allowlist; extend it deliberately rather than exporting extra data.'));
    }
  }
  if (errors.length > 200) return;   // an unusable file need not be fully enumerated

  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      errors.push(err(`${path}.${key}`, 'MISSING_FIELD', 'Required by the audit input contract.'));
      continue;
    }
    checkField(kind, record[key], `${path}.${key}`, errors);
  }
}

/**
 * Validates a parsed catalogue export against the closed allowlist.
 *
 * @returns {{ok:true, input:object}|{ok:false, errors:Array}}
 */
export function validateAuditInput(raw) {
  const errors = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [err('$', 'INVALID_ROOT', 'The export must be a JSON object.')] };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) {
      errors.push(err(`$.${key}`, 'UNKNOWN_TOP_LEVEL',
        `Unknown top-level key. Allowed: ${[...TOP_LEVEL].join(', ')}.`));
    }
  }

  if (raw.exportedAt !== undefined) checkField('iso?', raw.exportedAt, '$.exportedAt', errors);
  if (raw.source !== undefined) checkField('string?', raw.source, '$.source', errors);

  for (const [name, fields] of Object.entries(COLLECTIONS)) {
    const list = raw[name];
    if (list === undefined) {
      errors.push(err(`$.${name}`, 'MISSING_COLLECTION', 'Required. Use an empty array if there are none.'));
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(err(`$.${name}`, 'INVALID_COLLECTION', 'Must be an array.'));
      continue;
    }
    list.forEach((record, i) => checkRecord(record, fields, `$.${name}[${i}]`, errors));
  }

  /* Belt and braces: a deep scan for anything forbidden that slipped through
     as a nested key. The per-field checks above already reject unknown keys,
     so this should never fire — it exists so that a future widening of the
     allowlist cannot quietly admit forbidden data. */
  if (errors.length === 0) {
    const found = scanForForbiddenKeys(raw);
    for (const hit of found) {
      errors.push(err(hit.path, 'FORBIDDEN_FIELD', `Forbidden key "${hit.key}" found in the export.`));
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, input: shapeInput(raw) };
}

/** Builds the internal shape: explicit fields only, never the raw object. */
function shapeInput(raw) {
  const pick = (record, fields) => {
    const out = {};
    for (const key of Object.keys(fields)) out[key] = record[key] ?? null;
    return out;
  };
  return {
    exportedAt: raw.exportedAt ?? null,
    source: raw.source ?? null,
    brands: raw.brands.map((b) => pick(b, BRAND_FIELDS)),
    products: raw.products.map((p) => pick(p, PRODUCT_FIELDS)),
    variations: raw.variations.map((v) => pick(v, VARIATION_FIELDS)),
    media: raw.media.map((m) => pick(m, MEDIA_FIELDS)),
  };
}

export const AUDIT_INPUT_CONTRACT = Object.freeze({
  topLevel: [...TOP_LEVEL],
  brands: Object.keys(BRAND_FIELDS),
  products: Object.keys(PRODUCT_FIELDS),
  variations: Object.keys(VARIATION_FIELDS),
  media: Object.keys(MEDIA_FIELDS),
  excluded: [...EXCLUDED_BY_NAME.keys()],
});
