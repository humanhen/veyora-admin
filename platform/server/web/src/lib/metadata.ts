/* Central route metadata registry — the single source of truth for every
   public route's title, description, H1 and breadcrumb label. Page files
   import a record (or call a builder, for the three dynamic routes) rather
   than declaring their own literals, so a title and its H1 cannot drift
   apart, and a test can walk this file to check all 25 routes at once.

   Titles and H1s are the exact text from
   docs/public-website-rebuild/05_ROUTE_TEMPLATE_MATRIX.md §3 wherever the
   specification supplies one. Nothing here invents a commercial claim: for
   the three category landings, the private-label-enquiry route, all six
   policy routes, the HTML sitemap, and all three dynamic routes — none of
   which the specification gives approved copy for — the title/H1 is a
   neutral structural label and `pendingContent` is true. */

import { humanizeSlug } from './routes.ts';

export type IndexingCategory =
  | 'home'
  | 'company'
  | 'brand-index'
  | 'brand-detail'
  | 'catalogue-index'
  | 'catalogue-category'
  | 'catalogue-detail'
  | 'form'
  | 'policy'
  | 'resource-hub'
  | 'resource'
  | 'utility';

export interface RouteMetadata {
  /** Documentation only — not matched against by any router. Dynamic
   * segments are written `:param`. */
  path: string;
  title: string;
  description: string;
  h1: string;
  breadcrumbLabel: string;
  indexingCategory: IndexingCategory;
  /** Structural intent — should this route's clean canonical form be listed
   * in a future XML sitemap (B7). Independent of the per-request
   * page/filter/sort eligibility indexing.ts computes. */
  sitemapEligible: boolean;
  /** True when title/description/H1 are neutral placeholders authored for
   * this batch, not approved specification or business copy. */
  pendingContent: boolean;
}

/** The 22 fully static routes. Keyed by path for lookup by page files. */
export const STATIC_ROUTE_METADATA: Record<string, RouteMetadata> = {
  '/': {
    path: '/',
    title: 'Wholesale Eyewear Distributor for Optical Retailers | Veyora',
    description:
      "Veyora is a wholesale eyewear distributor working with optical retailers to build a stronger, better-supported assortment.",
    h1: 'More than eyewear distribution. A growth partner for optical retailers.',
    breadcrumbLabel: 'Home',
    indexingCategory: 'home',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/why-veyora/': {
    path: '/why-veyora/',
    title: 'About Veyora | Global Eyewear Distribution Partner',
    description:
      'Learn about Veyora, an international eyewear distribution partner built to support modern optical retailers.',
    h1: 'An international eyewear distribution partner built for modern retail.',
    breadcrumbLabel: 'Why Veyora',
    indexingCategory: 'company',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/brands/': {
    path: '/brands/',
    title: 'Wholesale Eyewear Brands for Every Retail Segment | Veyora',
    description:
      "Browse Veyora's wholesale eyewear brand portfolio, structured to serve every optical retail segment.",
    h1: 'A wholesale eyewear portfolio structured for every retail role.',
    breadcrumbLabel: 'Brands',
    indexingCategory: 'brand-index',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/collections/': {
    path: '/collections/',
    title: 'Wholesale Eyewear Collections and Frames | Veyora',
    description: "Explore Veyora's wholesale eyewear collections, organised for modern optical retailers.",
    h1: 'Explore wholesale eyewear collections for modern optical retail.',
    breadcrumbLabel: 'Collections',
    indexingCategory: 'catalogue-index',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/collections/optical/': {
    path: '/collections/optical/',
    title: 'Optical collection page | Veyora',
    description: 'Temporary development page for the optical collection route. Approved category content is not yet published.',
    h1: 'Optical collection page',
    breadcrumbLabel: 'Optical',
    indexingCategory: 'catalogue-category',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/collections/sun/': {
    path: '/collections/sun/',
    title: 'Sun collection page | Veyora',
    description: 'Temporary development page for the sun collection route. Approved category content is not yet published.',
    h1: 'Sun collection page',
    breadcrumbLabel: 'Sun',
    indexingCategory: 'catalogue-category',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/collections/kids/': {
    path: '/collections/kids/',
    title: 'Kids collection page | Veyora',
    description: 'Temporary development page for the kids collection route. Approved category content is not yet published.',
    h1: 'Kids collection page',
    breadcrumbLabel: 'Kids',
    indexingCategory: 'catalogue-category',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/service-model/': {
    path: '/service-model/',
    title: 'B2B Eyewear Distribution Services | Veyora',
    description: "See how Veyora's B2B eyewear distribution services are built to reduce friction for optical retailers.",
    h1: 'Retailer-friendly eyewear distribution built to reduce friction.',
    breadcrumbLabel: 'Service Model',
    indexingCategory: 'company',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/private-label/': {
    path: '/private-label/',
    title: 'Private Label Eyewear Programs for Retailers | Veyora',
    description:
      "Explore Veyora's private label eyewear programs, built for retailers who want their own line without building a supply chain alone.",
    h1: 'Launch your own eyewear program without building the supply chain alone.',
    breadcrumbLabel: 'Private Label',
    indexingCategory: 'company',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/private-label-enquiry/': {
    path: '/private-label-enquiry/',
    title: 'Private label enquiry page | Veyora',
    description:
      'Temporary development page for the private label enquiry route. Approved enquiry-form content is not yet published.',
    h1: 'Private label enquiry page',
    breadcrumbLabel: 'Private Label Enquiry',
    indexingCategory: 'form',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/global-presence/': {
    path: '/global-presence/',
    // The title's country list is 05_ROUTE_TEMPLATE_MATRIX.md's own
    // documented text, carried verbatim — the specification itself flags
    // it "re-checked after ... the domain decision" (DECISION-12,
    // 08_RISKS_AND_OPEN_DECISIONS.md), which is why pendingContent is true
    // below even though the text is sourced, not invented.
    title: 'Eyewear Distribution in Canada, USA and Europe | Veyora',
    description: "Learn about Veyora's global eyewear distribution network and local support model.",
    h1: 'Global eyewear distribution with local support.',
    breadcrumbLabel: 'Global Presence',
    indexingCategory: 'company',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/resources/': {
    path: '/resources/',
    title: 'Eyewear Retail Resources and Guides | Veyora',
    description: "Browse practical eyewear retail guidance and resources from Veyora.",
    h1: 'Practical eyewear retail guidance from Veyora.',
    breadcrumbLabel: 'Resources',
    indexingCategory: 'resource-hub',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/contact/': {
    path: '/contact/',
    title: "Contact Veyora Sales | Wholesale Eyewear Distribution",
    description: "Contact Veyora's sales team to build the right wholesale eyewear assortment for your business.",
    h1: "Let's build the right eyewear assortment for your business.",
    breadcrumbLabel: 'Contact',
    indexingCategory: 'form',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/request-b2b-account/': {
    path: '/request-b2b-account/',
    title: 'Request a Veyora B2B Account | Wholesale Eyewear',
    description: 'Request a Veyora B2B account to start ordering wholesale eyewear.',
    h1: 'Request a Veyora B2B account.',
    breadcrumbLabel: 'Request B2B Account',
    indexingCategory: 'form',
    sitemapEligible: true,
    pendingContent: false,
  },
  '/shipping/': {
    path: '/shipping/',
    title: 'Shipping policy page | Veyora',
    description: 'Temporary development page for the shipping policy route. Approved policy content is not yet published.',
    h1: 'Shipping policy page',
    breadcrumbLabel: 'Shipping',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/warranty-and-exchanges/': {
    path: '/warranty-and-exchanges/',
    title: 'Warranty and exchanges page | Veyora',
    description:
      'Temporary development page for the warranty and exchanges route. Approved policy content is not yet published.',
    h1: 'Warranty and exchanges page',
    breadcrumbLabel: 'Warranty & Exchanges',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/ordering-guide/': {
    path: '/ordering-guide/',
    title: 'Ordering guide page | Veyora',
    description: 'Temporary development page for the ordering guide route. Approved guide content is not yet published.',
    h1: 'Ordering guide page',
    breadcrumbLabel: 'Ordering Guide',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/privacy-policy/': {
    path: '/privacy-policy/',
    title: 'Privacy policy page | Veyora',
    description: 'Temporary development page for the privacy policy route. Approved policy content is not yet published.',
    h1: 'Privacy policy page',
    breadcrumbLabel: 'Privacy Policy',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/terms/': {
    path: '/terms/',
    title: 'Terms page | Veyora',
    description: 'Temporary development page for the terms route. Approved legal content is not yet published.',
    h1: 'Terms page',
    breadcrumbLabel: 'Terms',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/accessibility/': {
    path: '/accessibility/',
    title: 'Accessibility page | Veyora',
    description:
      'Temporary development page for the accessibility statement route. Approved accessibility content is not yet published.',
    h1: 'Accessibility page',
    breadcrumbLabel: 'Accessibility',
    indexingCategory: 'policy',
    sitemapEligible: true,
    pendingContent: true,
  },
  '/sitemap/': {
    path: '/sitemap/',
    title: 'Site map page | Veyora',
    description: 'Temporary development page for the HTML site map route. Approved site map content is not yet published.',
    h1: 'Site map page',
    breadcrumbLabel: 'Site Map',
    indexingCategory: 'utility',
    sitemapEligible: true,
    pendingContent: true,
  },
};

/** `/brands/{brand}/` — the humanised-slug fallback, used ONLY when there
 * is no validated API record (which in practice means the page is about to
 * render an error state, not a brand). When a record exists, callers use
 * brandDetailMetadataFromRecord() below instead.
 *
 * B2.3 note: this is deliberately retained rather than deleted. A 503/502
 * page still needs a title, and inventing a brand name for one would be
 * worse than a neutral slug-derived label. */
export function brandDetailMetadata(brand: string): RouteMetadata {
  const label = humanizeSlug(brand);
  return {
    path: '/brands/:brand/',
    title: `${label} Wholesale Eyewear for Optical Retailers | Veyora`,
    description: `Temporary development page for the ${label} brand detail route. Approved brand content is not yet published.`,
    h1: `${label} brand detail page`,
    breadcrumbLabel: label,
    indexingCategory: 'brand-detail',
    sitemapEligible: true,
    pendingContent: true,
  };
}

/** Metadata built from a VALIDATED public API brand record (B2.3).
 *
 * Every value here comes from an approved, published database field — the
 * name, and the headline/summary the brand record itself carries. Nothing
 * is invented: when a brand has no approved headline or summary, the
 * description falls back to a factual, non-promotional sentence naming only
 * the brand and what the page is, rather than asserting a positioning
 * claim nobody approved (06_CONTENT_AND_PLACEHOLDER_REGISTER.md's rule).
 *
 * `pendingContent` is false because this IS the approved content — the
 * flag exists to mark placeholder copy, and these values are real. */
export function brandDetailMetadataFromRecord(brand: {
  slug: string;
  name: string;
  headline: string | null;
  summary: string | null;
}): RouteMetadata {
  const approvedDescription = brand.summary ?? brand.headline;
  return {
    path: '/brands/:brand/',
    title: `${brand.name} Wholesale Eyewear for Optical Retailers | Veyora`,
    description:
      approvedDescription ?? `${brand.name} wholesale eyewear, distributed by Veyora for optical retailers.`,
    h1: brand.name,
    breadcrumbLabel: brand.name,
    indexingCategory: 'brand-detail',
    sitemapEligible: true,
    pendingContent: false,
  };
}

/** `/collections/{brand}/{model}/` — no catalogue data source exists until
 * B2/B4; same humanised-slug caveat as brandDetailMetadata(). */
export function modelDetailMetadata(brand: string, model: string): RouteMetadata {
  const brandLabel = humanizeSlug(brand);
  const modelLabel = humanizeSlug(model);
  return {
    path: '/collections/:brand/:model/',
    // Interpolated, not a fixed generic string — two different real
    // brand/model pairs must not collide on the same title/H1.
    title: `${brandLabel} ${modelLabel} | Veyora`,
    description: `Temporary development page for the ${brandLabel} ${modelLabel} model detail route. Approved model content is not yet published.`,
    h1: `${brandLabel} ${modelLabel} model detail page`,
    breadcrumbLabel: `${brandLabel} ${modelLabel}`,
    indexingCategory: 'catalogue-detail',
    sitemapEligible: true,
    pendingContent: true,
  };
}

/** Metadata built from a VALIDATED public API model record (B2.3).
 *
 * Same discipline as brandDetailMetadataFromRecord(): the title, H1 and
 * description are built only from approved published fields (brand name,
 * model name, display SKU, and the model's own approved public
 * description). When no approved description exists, the fallback states
 * only verifiable facts — brand, model, and that Veyora distributes it —
 * and claims nothing about the product itself. */
export function modelDetailMetadataFromRecord(model: {
  brandName: string | null;
  name: string;
  sku: string | null;
  publicDescription: string | null;
}): RouteMetadata {
  const brandLabel = model.brandName?.trim();
  const displayName = brandLabel ? `${brandLabel} ${model.name}` : model.name;
  return {
    path: '/collections/:brand/:model/',
    title: `${displayName} | Wholesale Eyewear | Veyora`,
    description:
      model.publicDescription ??
      `${displayName}${model.sku ? ` (${model.sku})` : ''} — wholesale eyewear distributed by Veyora for optical retailers.`,
    h1: displayName,
    breadcrumbLabel: displayName,
    indexingCategory: 'catalogue-detail',
    sitemapEligible: true,
    pendingContent: false,
  };
}

/** `/resources/{category}/` and `/resources/{slug}/` share this one
 * dynamic route file (see src/pages/resources/[slug]/index.astro for why)
 * until Content Collections (B5) can disambiguate category from article. */
export function resourceMetadata(slug: string): RouteMetadata {
  const label = humanizeSlug(slug);
  return {
    path: '/resources/:slug/',
    // Interpolated, not a fixed generic string — two different real
    // resource slugs (a category and an article, in particular — see the
    // file comment above) must not collide on the same title/H1.
    title: `${label} | Veyora`,
    description: `Temporary development page for the ${label} resource route. Approved resource content is not yet published.`,
    h1: `${label} resource page`,
    breadcrumbLabel: label,
    indexingCategory: 'resource',
    sitemapEligible: true,
    pendingContent: true,
  };
}

/** Fixed metadata for the two system error pages — not part of the 25
 * public routes and never listed in a sitemap. indexing.ts, not this file,
 * is the authority on their robots directive; this only carries head text. */
export const NOT_FOUND_METADATA: RouteMetadata = {
  path: '/404/',
  title: 'Page Not Found | Veyora',
  description: 'The page you requested could not be found. Explore Brands, Collections or Contact instead.',
  h1: 'Page not found',
  breadcrumbLabel: 'Not Found',
  indexingCategory: 'utility',
  sitemapEligible: false,
  pendingContent: false,
};

export const SERVER_ERROR_METADATA: RouteMetadata = {
  path: '/500/',
  title: 'Something Went Wrong | Veyora',
  description: 'Something went wrong on our end. Please try again, or return to the homepage.',
  h1: 'Something went wrong',
  breadcrumbLabel: 'Server Error',
  indexingCategory: 'utility',
  sitemapEligible: false,
  pendingContent: false,
};

/** All 25 routes resolved to a concrete RouteMetadata — the 21 static
 * entries plus one representative example of each dynamic route — for
 * tests and documentation that want to walk "every route" as a flat list.
 * Never used by an actual page (pages call the specific static entry or
 * builder they need).
 *
 * Resolves 4 dynamic examples, not 3, because resourceMetadata() is
 * called twice: routes 14 (`/resources/{category}/`) and 15
 * (`/resources/{slug}/`) are two distinct route DEFINITIONS in
 * 05_ROUTE_TEMPLATE_MATRIX.md even though they share one FILE (see
 * src/pages/resources/[slug]/index.astro). 21 static + brand + model +
 * 2×resource = 25, matching the specification's route count exactly. */
export function allRouteMetadataForTesting(): RouteMetadata[] {
  return [
    ...Object.values(STATIC_ROUTE_METADATA),
    brandDetailMetadata('example-brand'),
    modelDetailMetadata('example-brand', 'example-model'),
    resourceMetadata('example-category'),
    resourceMetadata('example-slug'),
  ];
}
