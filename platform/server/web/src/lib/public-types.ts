/* Explicit types and hand-written runtime validation for every /public/*
   response this site consumes (B2.3).

   Why runtime validation at all, when the API is ours and B2.2 already
   guarantees a safe shape: the API is a separate process across a network
   boundary, and "the server we called returned what we expected" is an
   assumption, not a fact — a version skew, a proxy error page, or a
   half-deployed API can all produce a 200 with the wrong body. Validating
   here means a malformed payload becomes a clean, documented 502 rather
   than a page that renders `undefined` or, worse, silently renders an
   unexpected field.

   Every validator follows the same discipline as the API's own serializer
   layer (platform/server/api/src/public-serialize.js), for the same
   reason: it builds a FRESH object from named fields and never spreads the
   parsed API object. Spreading would re-admit exactly the class of bug the
   forbidden-key boundary exists to prevent — an unexpected extra field
   riding along into a template. Unknown fields on the wire are therefore
   dropped silently and by construction, not filtered by a denylist.

   No schema library — hand-written, per the B2.3 brief's dependency rules. */

// ---------------------------------------------------------------------------
// types — the public shape, and nothing else. Never add price, stock,
// availability, customer, or any internal identifier to these.
// ---------------------------------------------------------------------------

export interface PublicMedia {
  path: string;
  alt: string;
  width: number | null;
  height: number | null;
  kind: 'image' | 'video';
}

export interface PublicBrandSummary {
  slug: string;
  name: string;
  shortName: string | null;
  segment: string | null;
  headline: string | null;
  priceTierLabel: string | null;
  logoMedia: PublicMedia | null;
}

export interface PublicModelCard {
  brandSlug: string;
  brandName: string | null;
  slug: string;
  sku: string | null;
  name: string;
  line: string | null;
  shape: string | null;
  segment: string | null;
  size: string | null;
  categories: string[];
  isFeatured: boolean;
  primaryMedia: PublicMedia | null;
}

export interface PublicBrandDetail extends PublicBrandSummary {
  summary: string | null;
  story: string | null;
  idealRetailer: string | null;
  bestFor: string[];
  styleTraits: string[];
  designOrigin: string | null;
  manufacturingOrigin: string | null;
  componentOrigins: string[];
  approvedMaterials: string[];
  heroMedia: PublicMedia | null;
  featuredModels: PublicModelCard[];
  contentUpdatedAt: string | null;
}

export interface PublicVariation {
  sku: string | null;
  colorName: string | null;
  colorCode: string | null;
  swatchMedia: PublicMedia | null;
}

export interface PublicModelDetail extends PublicModelCard {
  publicDescription: string | null;
  lensType: string | null;
  variations: PublicVariation[];
  media: PublicMedia[];
  relatedModels: PublicModelCard[];
  contentUpdatedAt: string | null;
}

export interface PublicModelList {
  items: PublicModelCard[];
  page: number;
  hasMore: boolean;
}

export interface PublicFacets {
  shapes: string[];
  sizes: string[];
  categories: string[];
  brands: Array<{ slug: string; name: string }>;
}

export interface PublicLocation {
  slug: string;
  name: string;
  function: string | null;
  regionsServed: string[];
  hours: string | null;
}

export interface PublicSitemapRecord {
  path: string;
  contentUpdatedAt: string | null;
}

export interface PublicSitemapData {
  brands: PublicSitemapRecord[];
  models: PublicSitemapRecord[];
  pages: PublicSitemapRecord[];
}

// ---------------------------------------------------------------------------
// validation primitives
// ---------------------------------------------------------------------------

/** Thrown when a 200 response does not match the documented public shape.
 * The caller (public-api.ts) turns this into a distinct "malformed upstream
 * payload" outcome, which routes render as 502 — deliberately different
 * from both 404 and a transport failure. */
export class PublicShapeError extends Error {
  constructor(message: string) {
    super(`malformed public API response: ${message}`);
  }
}

const MAX_STRING_LENGTH = 5000;
const MAX_ARRAY_ITEMS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new PublicShapeError(`${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PublicShapeError(`${path} must be an array`);
  if (value.length > MAX_ARRAY_ITEMS) throw new PublicShapeError(`${path} has too many items`);
  return value;
}

/** A required, non-empty string. Rejects numbers/booleans/null outright
 * rather than coercing — a required field arriving as the wrong primitive
 * type is a real signal that the payload is not what we think it is. */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new PublicShapeError(`${path} must be a string`);
  const s = value.trim();
  if (!s) throw new PublicShapeError(`${path} must not be empty`);
  if (s.length > MAX_STRING_LENGTH) throw new PublicShapeError(`${path} is too long`);
  return s;
}

/** An optional string: null/undefined/'' all normalise to null, so a
 * template can test one thing (`x === null`) rather than three. */
function optionalString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new PublicShapeError(`${path} must be a string or null`);
  const s = value.trim();
  if (!s) return null;
  if (s.length > MAX_STRING_LENGTH) throw new PublicShapeError(`${path} is too long`);
  return s;
}

function optionalNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PublicShapeError(`${path} must be a finite number or null`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new PublicShapeError(`${path} must be a boolean`);
  return value;
}

/* Internal label tags (`label:best-seller`) are portal-only merchandising
   signals and must never reach public output. The API's own serializer
   already strips them (B2.2), so this is defence in depth — but it is not
   redundant: this layer's whole purpose is that we do not assume the
   upstream is the version we think it is, and a caught regression here
   costs nothing while a missed one is permanently cached and scraped
   (08_RISKS_AND_OPEN_DECISIONS.md R-06). Matched as a literal prefix, not
   a substring, so a legitimate value merely containing "label" survives. */
function isInternalLabelTag(value: string): boolean {
  return /^label:/i.test(value.trim());
}

function requireStringArray(value: unknown, path: string): string[] {
  const arr = requireArray(value, path);
  return arr
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_STRING_LENGTH && !isInternalLabelTag(item));
}

/** An ISO-8601-ish timestamp, kept as a string (templates format it; this
 * layer does not decide presentation). Rejects a value that is present but
 * not parseable as a date, because that indicates a shape mismatch. */
function optionalDateString(value: unknown, path: string): string | null {
  const s = optionalString(value, path);
  if (s === null) return null;
  if (Number.isNaN(new Date(s).getTime())) throw new PublicShapeError(`${path} is not a valid date`);
  return s;
}

/* Media paths are the one field that becomes an HTML attribute a browser
   will dereference, so the scheme is checked explicitly. Only a rooted
   relative path (`/s3/...`, what the API actually returns) or an absolute
   http(s) URL is accepted; `javascript:`, `data:`, `vbscript:`,
   protocol-relative `//evil.example`, and bare relative paths are all
   rejected. Astro escapes attribute values, so this is defence in depth
   against a dangerous-but-well-formed URL rather than against injection. */
function validateMediaPath(value: unknown, path: string): string | null {
  const s = optionalString(value, path);
  if (s === null) return null;
  if (s.startsWith('//')) return null; // protocol-relative — resolves off-origin
  if (s.startsWith('/')) return s; // rooted relative path — the normal case
  if (/^https?:\/\//i.test(s)) return s;
  return null; // any other scheme (javascript:, data:, …) or bare relative path
}

// ---------------------------------------------------------------------------
// validators — each returns a FRESH object; none spreads the input
// ---------------------------------------------------------------------------

export function validateMedia(value: unknown, path = 'media'): PublicMedia | null {
  if (value === null || value === undefined) return null;
  const obj = requireObject(value, path);
  const mediaPath = validateMediaPath(obj.path, `${path}.path`);
  // A media object whose path is absent or unsafe is dropped entirely
  // rather than rendered as a broken image.
  if (mediaPath === null) return null;
  return {
    path: mediaPath,
    alt: optionalString(obj.alt, `${path}.alt`) ?? '',
    width: optionalNumber(obj.width, `${path}.width`),
    height: optionalNumber(obj.height, `${path}.height`),
    kind: obj.kind === 'video' ? 'video' : 'image',
  };
}

export function validateBrandSummary(value: unknown, path = 'brand'): PublicBrandSummary {
  const obj = requireObject(value, path);
  return {
    slug: requireString(obj.slug, `${path}.slug`),
    name: requireString(obj.name, `${path}.name`),
    shortName: optionalString(obj.shortName, `${path}.shortName`),
    segment: optionalString(obj.segment, `${path}.segment`),
    headline: optionalString(obj.headline, `${path}.headline`),
    priceTierLabel: optionalString(obj.priceTierLabel, `${path}.priceTierLabel`),
    logoMedia: validateMedia(obj.logoMedia, `${path}.logoMedia`),
  };
}

export function validateModelCard(value: unknown, path = 'model'): PublicModelCard {
  const obj = requireObject(value, path);
  return {
    brandSlug: requireString(obj.brandSlug, `${path}.brandSlug`),
    brandName: optionalString(obj.brandName, `${path}.brandName`),
    slug: requireString(obj.slug, `${path}.slug`),
    sku: optionalString(obj.sku, `${path}.sku`),
    name: requireString(obj.name, `${path}.name`),
    line: optionalString(obj.line, `${path}.line`),
    shape: optionalString(obj.shape, `${path}.shape`),
    segment: optionalString(obj.segment, `${path}.segment`),
    size: optionalString(obj.size, `${path}.size`),
    categories: requireStringArray(obj.categories ?? [], `${path}.categories`),
    isFeatured: obj.isFeatured === true,
    primaryMedia: validateMedia(obj.primaryMedia, `${path}.primaryMedia`),
  };
}

export function validateBrandDetail(value: unknown, path = 'brand'): PublicBrandDetail {
  const obj = requireObject(value, path);
  const summary = validateBrandSummary(obj, path);
  const featured = requireArray(obj.featuredModels ?? [], `${path}.featuredModels`);
  return {
    slug: summary.slug,
    name: summary.name,
    shortName: summary.shortName,
    segment: summary.segment,
    headline: summary.headline,
    priceTierLabel: summary.priceTierLabel,
    logoMedia: summary.logoMedia,
    summary: optionalString(obj.summary, `${path}.summary`),
    story: optionalString(obj.story, `${path}.story`),
    idealRetailer: optionalString(obj.idealRetailer, `${path}.idealRetailer`),
    bestFor: requireStringArray(obj.bestFor ?? [], `${path}.bestFor`),
    styleTraits: requireStringArray(obj.styleTraits ?? [], `${path}.styleTraits`),
    designOrigin: optionalString(obj.designOrigin, `${path}.designOrigin`),
    manufacturingOrigin: optionalString(obj.manufacturingOrigin, `${path}.manufacturingOrigin`),
    componentOrigins: requireStringArray(obj.componentOrigins ?? [], `${path}.componentOrigins`),
    approvedMaterials: requireStringArray(obj.approvedMaterials ?? [], `${path}.approvedMaterials`),
    heroMedia: validateMedia(obj.heroMedia, `${path}.heroMedia`),
    featuredModels: featured.map((m, i) => validateModelCard(m, `${path}.featuredModels[${i}]`)),
    contentUpdatedAt: optionalDateString(obj.contentUpdatedAt, `${path}.contentUpdatedAt`),
  };
}

export function validateVariation(value: unknown, path = 'variation'): PublicVariation {
  const obj = requireObject(value, path);
  return {
    sku: optionalString(obj.sku, `${path}.sku`),
    colorName: optionalString(obj.colorName, `${path}.colorName`),
    colorCode: optionalString(obj.colorCode, `${path}.colorCode`),
    swatchMedia: validateMedia(obj.swatchMedia, `${path}.swatchMedia`),
  };
}

export function validateModelDetail(value: unknown, path = 'model'): PublicModelDetail {
  const obj = requireObject(value, path);
  const card = validateModelCard(obj, path);
  const variations = requireArray(obj.variations ?? [], `${path}.variations`);
  const media = requireArray(obj.media ?? [], `${path}.media`);
  const related = requireArray(obj.relatedModels ?? [], `${path}.relatedModels`);
  return {
    brandSlug: card.brandSlug,
    brandName: card.brandName,
    slug: card.slug,
    sku: card.sku,
    name: card.name,
    line: card.line,
    shape: card.shape,
    segment: card.segment,
    size: card.size,
    categories: card.categories,
    isFeatured: card.isFeatured,
    primaryMedia: card.primaryMedia,
    publicDescription: optionalString(obj.publicDescription, `${path}.publicDescription`),
    lensType: optionalString(obj.lensType, `${path}.lensType`),
    variations: variations.map((v, i) => validateVariation(v, `${path}.variations[${i}]`)),
    // A media entry with an unsafe/absent path validates to null and is
    // dropped here rather than rendered as a broken <img>.
    media: media
      .map((m, i) => validateMedia(m, `${path}.media[${i}]`))
      .filter((m): m is PublicMedia => m !== null),
    relatedModels: related.map((m, i) => validateModelCard(m, `${path}.relatedModels[${i}]`)),
    contentUpdatedAt: optionalDateString(obj.contentUpdatedAt, `${path}.contentUpdatedAt`),
  };
}

export function validateBrandListResponse(value: unknown): PublicBrandSummary[] {
  const obj = requireObject(value, 'response');
  const brands = requireArray(obj.brands, 'response.brands');
  return brands.map((b, i) => validateBrandSummary(b, `response.brands[${i}]`));
}

export function validateBrandDetailResponse(value: unknown): PublicBrandDetail {
  const obj = requireObject(value, 'response');
  return validateBrandDetail(obj.brand, 'response.brand');
}

export function validateModelListResponse(value: unknown): PublicModelList {
  const obj = requireObject(value, 'response');
  const items = requireArray(obj.items, 'response.items');
  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    throw new PublicShapeError('response.page must be a positive integer');
  }
  return {
    items: items.map((m, i) => validateModelCard(m, `response.items[${i}]`)),
    page,
    hasMore: requireBoolean(obj.hasMore, 'response.hasMore'),
  };
}

export function validateModelDetailResponse(value: unknown): PublicModelDetail {
  const obj = requireObject(value, 'response');
  return validateModelDetail(obj.model, 'response.model');
}

export function validateFacetsResponse(value: unknown): PublicFacets {
  const obj = requireObject(value, 'response');
  const brands = requireArray(obj.brands ?? [], 'response.brands');
  return {
    shapes: requireStringArray(obj.shapes ?? [], 'response.shapes'),
    sizes: requireStringArray(obj.sizes ?? [], 'response.sizes'),
    categories: requireStringArray(obj.categories ?? [], 'response.categories'),
    brands: brands.map((b, i) => {
      const item = requireObject(b, `response.brands[${i}]`);
      return {
        slug: requireString(item.slug, `response.brands[${i}].slug`),
        name: requireString(item.name, `response.brands[${i}].name`),
      };
    }),
  };
}

export function validateLocationsResponse(value: unknown): PublicLocation[] {
  const obj = requireObject(value, 'response');
  const locations = requireArray(obj.locations, 'response.locations');
  return locations.map((l, i) => {
    const item = requireObject(l, `response.locations[${i}]`);
    return {
      slug: requireString(item.slug, `response.locations[${i}].slug`),
      name: requireString(item.name, `response.locations[${i}].name`),
      function: optionalString(item.function, `response.locations[${i}].function`),
      regionsServed: requireStringArray(item.regionsServed ?? [], `response.locations[${i}].regionsServed`),
      hours: optionalString(item.hours, `response.locations[${i}].hours`),
    };
  });
}

export function validateSitemapDataResponse(value: unknown): PublicSitemapData {
  const obj = requireObject(value, 'response');
  const section = (key: 'brands' | 'models' | 'pages'): PublicSitemapRecord[] =>
    requireArray(obj[key] ?? [], `response.${key}`).map((r, i) => {
      const item = requireObject(r, `response.${key}[${i}]`);
      return {
        path: requireString(item.path, `response.${key}[${i}].path`),
        contentUpdatedAt: optionalDateString(item.contentUpdatedAt, `response.${key}[${i}].contentUpdatedAt`),
      };
    });
  return { brands: section('brands'), models: section('models'), pages: section('pages') };
}
