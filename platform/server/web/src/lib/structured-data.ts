/* JSON-LD structured data (Fast-Track Phase 4).

   Pure builders. Every value comes from an already-validated public API
   record or from the metadata registry — nothing is invented, and nothing is
   read from a raw upstream payload.

   WHAT IS DELIBERATELY ABSENT, AND WHY.

   `offers`, `price`, `priceCurrency`, `availability`, `aggregateRating` and
   `review` are the fields that make a Product rich result attractive — and
   every one of them would be a fabrication here. This is a wholesale
   catalogue: there is no public price, no consumer stock position, and no
   review corpus. Emitting them would be false structured data, which is both
   a manual-action risk and, more simply, a lie to a visitor reading a search
   result.

   `Organization` claims (address, telephone, sameAs, founder, numberOfEmployees)
   are likewise omitted: the content register has no approved values for them,
   and structured data is not the place to guess at corporate facts.

   The result is a smaller set of types than a consumer store would emit, and
   that is the correct trade. */

import type { PublicBrandDetail, PublicModelDetail, PublicModelCard } from './public-types.ts';
import type { BreadcrumbItem } from './routes.ts';

/** A JSON-LD node. Deliberately loose: these objects are serialised, never
    read back, and a stricter type would only be re-asserted at every call. */
export type JsonLd = Record<string, unknown>;

const absolute = (origin: string, path: string): string => `${origin.replace(/\/$/, '')}${path}`;

/** Serialises for embedding in a <script type="application/ld+json">.
 *
 * `<` is escaped as `<` so a value containing `</script>` cannot close
 * the block early — the one XSS vector a JSON-LD island actually has. */
export function serialiseJsonLd(node: JsonLd | JsonLd[]): string {
  return JSON.stringify(node).replace(/</g, '\\u003c');
}

/** Site-level identity. Name and origin only — no logo claim, no sameAs, no
    contact point, because none of those has an approved source. */
export function buildWebSite(origin: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Veyora',
    url: `${origin.replace(/\/$/, '')}/`,
  };
}

/** Breadcrumbs, built from the SAME items the page renders visually, so the
    structured data can never disagree with what a visitor sees. */
export function buildBreadcrumbs(items: BreadcrumbItem[], origin: string): JsonLd | null {
  const usable = items.filter((item) => typeof item.href === 'string' && item.href.startsWith('/'));
  if (usable.length < 2) return null;   // a single crumb is not a trail
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: usable.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: absolute(origin, item.href as string),
    })),
  };
}

/** A catalogue listing. `numberOfItems` describes THIS PAGE's items, not a
    catalogue total — the API exposes no total, and claiming one would be
    inventing a number. */
export function buildCollectionPage(
  { name, description, path, items, origin }:
  { name: string; description: string; path: string; items: PublicModelCard[]; origin: string }
): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url: absolute(origin, path),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: absolute(origin, `/collections/${item.brandSlug}/${item.slug}/`),
        name: item.name,
      })),
    },
  };
}

/** A model. Product without offers — see the file header.
 *
 * `sku` and `brand` are real, published catalogue facts. `image` is included
 * only when the validated record actually carries one. */
export function buildProduct(model: PublicModelDetail, origin: string): JsonLd {
  const node: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: model.name,
    url: absolute(origin, `/collections/${model.brandSlug}/${model.slug}/`),
  };

  if (model.sku) node.sku = model.sku;
  if (model.brandName) node.brand = { '@type': 'Brand', name: model.brandName };
  if (model.publicDescription) node.description = model.publicDescription;

  const image = model.primaryMedia?.path ?? model.media?.[0]?.path ?? null;
  /* Only an absolute http(s) URL is emitted. The validator already drops
     unsafe schemes, but a relative path in JSON-LD is simply invalid. */
  if (image && /^\/[^/]/.test(image)) node.image = absolute(origin, image);

  const colours = (model.variations ?? [])
    .map((variation) => variation.colorName)
    .filter((name): name is string => typeof name === 'string' && name !== '');
  if (colours.length) node.color = colours;

  return node;
}

/** A brand page. Organization would imply corporate claims this project has
    no approved source for, so a brand is described as a `Brand`. */
export function buildBrand(brand: PublicBrandDetail, origin: string): JsonLd {
  const node: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Brand',
    name: brand.name,
    url: absolute(origin, `/brands/${brand.slug}/`),
  };
  if (brand.summary) node.description = brand.summary;
  const logo = brand.logoMedia?.path ?? null;
  if (logo && /^\/[^/]/.test(logo)) node.logo = absolute(origin, logo);
  return node;
}

/* The keys that must never appear in any emitted node. Asserted by test
   against real rendered output, not merely by reading this list. */
export const FORBIDDEN_JSONLD_KEYS: readonly string[] = [
  'offers', 'price', 'priceCurrency', 'lowPrice', 'highPrice', 'priceRange',
  'availability', 'inventoryLevel', 'aggregateRating', 'review', 'ratingValue',
  'address', 'telephone', 'email', 'sameAs', 'founder', 'numberOfEmployees',
];
