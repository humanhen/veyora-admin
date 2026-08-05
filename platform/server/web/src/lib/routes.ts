/* Central route/breadcrumb data. One tree, two consumers today
   (Breadcrumbs.astro's visible trail) and one consumer later (B1.3/B7's
   BreadcrumbList JSON-LD) — both read the same {label, href} pairs, so a
   visible trail and its structured-data twin cannot silently disagree. */

export interface BreadcrumbItem {
  label: string;
  href: string;
}

interface StaticRouteNode {
  path: string;
  label: string;
  parent: string | null;
}

export const HOME: BreadcrumbItem = { label: 'Home', href: '/' };

/** Every fully static route in the B1.2 route set, with its breadcrumb parent. */
const STATIC_ROUTES: StaticRouteNode[] = [
  { path: '/why-veyora/', label: 'Why Veyora', parent: '/' },
  { path: '/brands/', label: 'Brands', parent: '/' },
  { path: '/collections/', label: 'Collections', parent: '/' },
  { path: '/collections/optical/', label: 'Optical', parent: '/collections/' },
  { path: '/collections/sun/', label: 'Sun', parent: '/collections/' },
  { path: '/collections/kids/', label: 'Kids', parent: '/collections/' },
  { path: '/service-model/', label: 'Service Model', parent: '/' },
  { path: '/private-label/', label: 'Private Label', parent: '/' },
  { path: '/private-label-enquiry/', label: 'Private Label Enquiry', parent: '/private-label/' },
  { path: '/global-presence/', label: 'Global Presence', parent: '/' },
  { path: '/resources/', label: 'Resources', parent: '/' },
  { path: '/contact/', label: 'Contact', parent: '/' },
  { path: '/request-b2b-account/', label: 'Request B2B Account', parent: '/' },
  { path: '/shipping/', label: 'Shipping', parent: '/' },
  { path: '/warranty-and-exchanges/', label: 'Warranty & Exchanges', parent: '/' },
  { path: '/ordering-guide/', label: 'Ordering Guide', parent: '/' },
  { path: '/privacy-policy/', label: 'Privacy Policy', parent: '/' },
  { path: '/terms/', label: 'Terms', parent: '/' },
  { path: '/accessibility/', label: 'Accessibility', parent: '/' },
  { path: '/sitemap/', label: 'Site Map', parent: '/' },
];

const BY_PATH = new Map(STATIC_ROUTES.map((r) => [r.path, r]));

/** Full trail (including Home) for a fully static route, walking parents. */
export function staticBreadcrumbs(path: string): BreadcrumbItem[] {
  const trail: BreadcrumbItem[] = [];
  let current = BY_PATH.get(path);
  while (current) {
    trail.unshift({ label: current.label, href: current.path });
    current = current.parent ? BY_PATH.get(current.parent) : undefined;
  }
  return [HOME, ...trail];
}

/** For dynamic routes (brand/model/resource slugs): the caller supplies the
 * trail segments after Home — e.g. Brands > {Brand} — since a real label
 * for a slug depends on data this batch does not have (see B1.2 known
 * limitations). Home is always prepended here, once, so every page's
 * breadcrumbs share the same first item. */
export function breadcrumbsWithHome(segments: BreadcrumbItem[]): BreadcrumbItem[] {
  return [HOME, ...segments];
}

/** Turns a URL slug into a display label by mechanical transform only
 * (split on hyphens, capitalise each word) — never a lookup, never a
 * fact. Used so a B1.2 dynamic-route skeleton has *something* readable to
 * show for an arbitrary slug without inventing a name for it. Real
 * publication data replaces this in B2/B4. */
export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
