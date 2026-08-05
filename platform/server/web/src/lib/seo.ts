/* Builds the complete <head> metadata bundle for a route from one
   RouteMetadata record (src/lib/metadata.ts) plus the current request's
   path and query. indexing.ts is the only source of the robots directive
   and canonical query-state — this file never recomputes that logic
   itself, so there is exactly one place a canonical/robots decision is
   made. Base.astro renders whatever this returns; it contains no
   metadata logic of its own. */
import { env } from '../env.ts';
import { resolveIndexing } from './indexing.ts';
import type { RouteMetadata } from './metadata.ts';

const SITE_NAME = 'Veyora';

export interface SeoHead {
  title: string;
  description: string;
  /** null only for the system error pages, which have no canonical version of themselves. */
  canonical: string | null;
  robots: string;
  ogType: string;
  ogSiteName: string;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string | null;
  ogImage?: string;
  twitterCard: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage?: string;
}

export interface BuildSeoHeadParams {
  meta: RouteMetadata;
  pathname: string;
  searchParams: URLSearchParams;
  ogImage?: string;
  /** Set only by the 404/500 pages, whose robots directive is fixed
   * (indexing.ts's NOT_FOUND_ROBOTS / SERVER_ERROR_ROBOTS) rather than
   * computed from query state. */
  fixedRobots?: string;
}

/** Throws — deliberately, per the B1.3 brief — rather than rendering a
 * page with a blank title or description. A missing value here is a
 * programming error in a route file, not a state a real visitor should
 * ever see silently. */
export function buildSeoHead({ meta, pathname, searchParams, ogImage, fixedRobots }: BuildSeoHeadParams): SeoHead {
  if (!meta.title?.trim()) {
    throw new Error(`SEO: route "${meta.path}" has no title`);
  }
  if (!meta.description?.trim()) {
    throw new Error(`SEO: route "${meta.path}" has no description`);
  }

  let robots: string;
  let canonicalPath: string | null;

  if (fixedRobots) {
    robots = fixedRobots;
    canonicalPath = null;
  } else {
    const indexing = resolveIndexing(pathname, searchParams);
    robots = indexing.robots;
    canonicalPath = indexing.canonicalPath;
  }

  // Canonical origin comes only from the environment contract — never a
  // literal — and canonicalPath already carries the programme's
  // trailing-slash convention (every route path ends in "/").
  const canonical = canonicalPath ? `${env.siteOrigin}${canonicalPath}` : null;

  return {
    title: meta.title,
    description: meta.description,
    canonical,
    robots,
    ogType: 'website',
    ogSiteName: SITE_NAME,
    ogTitle: meta.title,
    ogDescription: meta.description,
    ogUrl: canonical,
    ogImage,
    twitterCard: 'summary_large_image',
    twitterTitle: meta.title,
    twitterDescription: meta.description,
    twitterImage: ogImage,
  };
}
