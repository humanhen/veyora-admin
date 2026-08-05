/* XML sitemap construction (Fast-Track Phase 4).

   Pure functions, so the escaping and inclusion rules are testable without a
   server or a build.

   A sitemap is an ASSERTION to a search engine: "these URLs exist, are
   canonical, and are worth indexing." That makes two things load-bearing:

   1. Only clean, indexable, canonical URLs go in. A filtered, sorted or
      paginated listing is `noindex` in src/lib/indexing.ts, so including it
      here would contradict the page's own robots directive — and search
      engines treat that contradiction as a quality signal against the site.

   2. An upstream failure must NOT produce a short sitemap. A sitemap missing
      most of its URLs is worse than no sitemap, because it looks authoritative
      and invites de-indexing of everything absent. The caller answers non-200
      instead. */

import type { PublicSitemapData, PublicSitemapRecord } from './public-types.ts';

/** Static routes that are indexable and have no query state. Deliberately
    hand-listed rather than derived from the filesystem: a route existing is
    not the same as it being worth indexing, and `/500/`, `/404/` and the
    enquiry-confirmation states must never appear. */
export const STATIC_SITEMAP_PATHS: readonly string[] = [
  '/',
  '/why-veyora/',
  '/brands/',
  '/collections/',
  '/collections/optical/',
  '/collections/sun/',
  '/collections/kids/',
  '/private-label/',
  '/service-model/',
  '/ordering-guide/',
  '/global-presence/',
  '/resources/',
  '/contact/',
  '/request-b2b-account/',
  '/private-label-enquiry/',
  '/shipping/',
  '/warranty-and-exchanges/',
  '/terms/',
  '/privacy-policy/',
  '/accessibility/',
  '/sitemap/',
];

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** XML escaping for text nodes. `&` must be replaced first or the later
    replacements would double-escape their own output. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Only a valid, non-future ISO date is emitted. A `lastmod` in the future,
    or an unparseable one, is worse than none — it invites a crawler to
    distrust every date in the file. */
export function normaliseLastmod(value: string | null, now: Date = new Date()): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime()) return null;
  return date.toISOString().slice(0, 10);
}

/** Rejects anything that is not a clean, canonical, indexable public path. */
export function isIndexablePath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  // No query state, no fragment, no protocol-relative or absolute escape.
  if (/[?#]/.test(path) || path.startsWith('//')) return false;
  // No traversal, no whitespace, no control characters.
  if (path.includes('..') || /\s/.test(path)) return false;
  // Non-public namespaces.
  if (/^\/(admin|api|s3|_|__)/.test(path)) return false;
  // Error routes are never canonical.
  if (path === '/404/' || path === '/500/' || path === '/healthz') return false;
  // Trailing-slash convention: every public HTML route ends in '/'.
  return path.endsWith('/');
}

/**
 * Builds the entry list from the API's sitemap data plus the static routes.
 *
 * Deterministic: static routes first in their declared order, then brands,
 * models and pages in the order the API returned them (it sorts), with
 * duplicates removed by path.
 */
export function buildSitemapEntries(
  data: PublicSitemapData,
  { origin, now = new Date() }: { origin: string; now?: Date }
): SitemapEntry[] {
  const base = origin.replace(/\/$/, '');
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];

  const add = (path: string, lastmod: string | null) => {
    if (!isIndexablePath(path) || seen.has(path)) return;
    seen.add(path);
    entries.push({ loc: `${base}${path}`, lastmod: normaliseLastmod(lastmod, now) });
  };

  for (const path of STATIC_SITEMAP_PATHS) add(path, null);
  for (const record of collect(data)) add(record.path, record.contentUpdatedAt);

  return entries;
}

function collect(data: PublicSitemapData): PublicSitemapRecord[] {
  return [...(data.brands ?? []), ...(data.models ?? []), ...(data.pages ?? [])];
}

/** Serialises to XML. One URL per `<url>`, `<lastmod>` only when known. */
export function renderSitemapXml(entries: SitemapEntry[]): string {
  const body = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
