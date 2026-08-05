/* Deterministic normalisation for the catalogue audit (B2.4C1).

   Every function here is PURE and DETERMINISTIC: same input, same output,
   every run, on every machine. No clock, no randomness, no locale-dependent
   behaviour, no I/O. That is what lets a reviewer diff two runs and trust
   that any difference came from the data rather than from the tool.

   Two specific hazards are handled explicitly:

     - `toLowerCase()` is locale-sensitive in some engines for a handful of
       characters (the Turkish dotted/dotless I being the classic case).
       Every case fold here goes through `toLowerCase('en-US')`... except that
       `String.prototype.toLowerCase` takes no locale, so the safe form is to
       normalise to NFKD, strip combining marks, and fold only ASCII.

     - Unicode has several ways to spell the same string. Everything is
       normalised to NFC on the way in, so "Café" typed two ways compares
       equal, and to NFKD when generating a slug, so accents can be stripped
       to their ASCII base letters. */

/* Reserved public path segments. A product or brand slug that collides with
   one of these would shadow a real page on the public site. Sourced from the
   Astro route tree plus the infrastructure paths Caddy owns. */
export const RESERVED_SLUGS = Object.freeze([
  '404', '500', 'accessibility', 'admin', 'api', 'assets', 'brands', 'collections',
  'contact', 'favicon', 'global-presence', 'healthz', 'index', 'models',
  'ordering-guide', 'privacy-policy', 'private-label', 'private-label-enquiry',
  'request-b2b-account', 'resources', 'robots', 's3', 'service-model', 'shipping',
  'sitemap', 'static', 'terms', 'warranty-and-exchanges', 'why-veyora',
]);

const RESERVED = new Set(RESERVED_SLUGS);

/** The API's own slug rule, restated here so the planner cannot propose a
    slug the publication gate would then reject. Kept in sync deliberately —
    a test asserts the two agree. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 120;

/* ---------------------------------------------------------------------------
   Text
   --------------------------------------------------------------------------- */

/** Trim, collapse internal whitespace, normalise to NFC. Null-safe. */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** A case- and whitespace-insensitive comparison key. ASCII-folded so that
    "Café" and "Cafe" compare equal — deliberate, because the import has both
    spellings of some names, and treating them as different brands would
    silently split a brand in two. */
export function comparisonKey(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining marks
    .replace(/[^0-9a-zA-Z]+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))   // ASCII-only fold
    .replace(/\s+/g, ' ');
}

/** True when the value carries no usable content. */
export function isBlank(value) {
  return cleanText(value) === '';
}

/* ---------------------------------------------------------------------------
   Slugs
   --------------------------------------------------------------------------- */

/**
 * Deterministic slug proposal.
 *
 * @returns {{ok:true, slug:string} | {ok:false, code:string}}
 *
 * Never falls back to an internal id: a slug like `p-a1b2c3` is a public URL
 * that tells a visitor nothing and pins an internal identifier into the site's
 * address space forever. A record that cannot produce a meaningful slug is a
 * review item, not a machine decision.
 */
export function proposeSlug(source) {
  const base = cleanText(source)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')                 // elisions join: "men's" → "mens"
    .replace(/&/g, ' and ')
    .replace(/[^0-9a-zA-Z]+/g, '-')        // every other run becomes one hyphen
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    .replace(/-+/g, '-')                   // collapse repeats
    .replace(/^-|-$/g, '');                // trim separators

  if (base === '') return { ok: false, code: 'SLUG_EMPTY' };
  if (base.length > MAX_SLUG) {
    /* Truncate on a hyphen boundary so a cut never leaves a dangling
       fragment, and never mid-word where possible. */
    const cut = base.slice(0, MAX_SLUG);
    const trimmed = cut.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
    if (!SLUG_PATTERN.test(trimmed)) return { ok: false, code: 'SLUG_TOO_LONG' };
    return finish(trimmed);
  }
  return finish(base);

  function finish(slug) {
    if (!SLUG_PATTERN.test(slug)) return { ok: false, code: 'SLUG_INVALID' };
    if (RESERVED.has(slug)) return { ok: false, code: 'SLUG_RESERVED' };
    return { ok: true, slug };
  }
}

/** Whether an already-stored slug is usable as-is. */
export function isUsableSlug(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= MAX_SLUG
    && SLUG_PATTERN.test(value)
    && !RESERVED.has(value);
}

/**
 * Deterministic de-duplication suffix. Given a base slug already claimed by
 * someone else, produces `base-2`, `base-3`, … — never a random or
 * id-derived suffix, so two runs over the same data agree.
 *
 * `taken` is a Set of slugs already claimed. It is NOT mutated: the caller
 * decides whether a proposal becomes a claim, because a proposal that needs a
 * suffix is a review item and may be rejected.
 */
export function proposeDeduplicatedSlug(base, taken, limit = 50) {
  if (!isUsableSlug(base)) return { ok: false, code: 'SLUG_INVALID' };
  if (!taken.has(base)) return { ok: true, slug: base, suffixed: false };
  for (let n = 2; n <= limit; n++) {
    const candidate = `${base}-${n}`;
    if (candidate.length <= MAX_SLUG && !taken.has(candidate) && !RESERVED.has(candidate)) {
      return { ok: true, slug: candidate, suffixed: true };
    }
  }
  return { ok: false, code: 'SLUG_DEDUPE_EXHAUSTED' };
}

/* ---------------------------------------------------------------------------
   Brand and category
   --------------------------------------------------------------------------- */

/** Canonical display form of a free-text brand: cleaned, but NEVER reworded,
    re-cased into title case, expanded or abbreviated. Changing "ESSEDUE" to
    "Essedue" would be inventing a marketing decision. */
export function canonicalBrandName(value) {
  return cleanText(value);
}

/** Category normalisation: cleaned, de-duplicated by comparison key, and
    ordered deterministically. The first spelling encountered wins, so the
    output is stable for a given input order. */
export function normaliseCategories(list) {
  const seen = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = cleanText(raw);
    if (text === '') continue;
    const key = comparisonKey(text);
    if (key === '' || seen.has(key)) continue;
    seen.set(key, text);
  }
  return [...seen.values()].sort(compareText);
}

/** Colour codes are structured: uppercase ASCII alphanumerics and hyphens. */
export function normaliseColorCode(value) {
  const cleaned = cleanText(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9a-zA-Z-]+/g, '')
    .replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned;
}

export function isWellFormedColorCode(value) {
  return typeof value === 'string' && /^[0-9A-Z]+(?:-[0-9A-Z]+)*$/.test(value) && value.length <= 40;
}

/* ---------------------------------------------------------------------------
   Ordering
   --------------------------------------------------------------------------- */

/** Byte-wise string comparison. Deliberately NOT localeCompare: that is
    locale- and ICU-version-dependent, so it could order two runs differently
    on two machines. */
export function compareText(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Stable record ordering: by the given keys in turn, then by id, so the
    output is fully determined even when the primary keys tie. */
export function stableSort(records, ...keys) {
  return [...records].sort((a, b) => {
    for (const key of keys) {
      const c = compareText(a?.[key], b?.[key]);
      if (c !== 0) return c;
    }
    return compareText(a?.id, b?.id);
  });
}
