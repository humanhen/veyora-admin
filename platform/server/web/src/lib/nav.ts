/* The single navigation configuration. Header, MobileMenu and Footer all
   read from here rather than repeating link lists — one change updates
   every surface, and there is exactly one place that could accidentally
   grow a `#/` link or a hard-coded portal hostname.

   B2B Login is deliberately NOT a literal string here: it is env.portalOrigin
   (src/env.ts), which is validated, fails closed in production, and falls
   back to a documented localhost value in development — never a real
   Veyora domain. */
import { env } from '../env.ts';

export interface NavItem {
  label: string;
  href: string;
  external?: boolean;
  /** Visual weight, applied by the component rendering it — not a CSS class name. */
  style?: 'primary' | 'bordered' | 'text';
}

export const primaryNav: NavItem[] = [
  { label: 'Why Veyora', href: '/why-veyora/' },
  { label: 'Brands', href: '/brands/' },
  { label: 'Collections', href: '/collections/' },
  { label: 'Service Model', href: '/service-model/' },
  { label: 'Private Label', href: '/private-label/' },
  { label: 'Global Presence', href: '/global-presence/' },
  { label: 'Contact', href: '/contact/' },
];

export const utilityNav: NavItem[] = [
  { label: 'Request B2B Account', href: '/request-b2b-account/', style: 'primary' },
  { label: 'Contact Sales', href: '/contact/', style: 'text' },
  { label: 'B2B Login', href: env.portalOrigin, style: 'bordered', external: true },
];

export interface FooterGroup {
  heading: string;
  links: NavItem[];
}

export const footerGroups: FooterGroup[] = [
  {
    heading: 'Company',
    links: [
      { label: 'Why Veyora', href: '/why-veyora/' },
      { label: 'Global Presence', href: '/global-presence/' },
      { label: 'Private Label', href: '/private-label/' },
    ],
  },
  {
    heading: 'Catalogue',
    links: [
      { label: 'Brands', href: '/brands/' },
      { label: 'Collections', href: '/collections/' },
      { label: 'Service Model', href: '/service-model/' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'Resource Hub', href: '/resources/' },
      { label: 'Ordering Guide', href: '/ordering-guide/' },
      { label: 'Shipping', href: '/shipping/' },
      { label: 'Site Map', href: '/sitemap/' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '/privacy-policy/' },
      { label: 'Terms', href: '/terms/' },
      { label: 'Warranty & Exchanges', href: '/warranty-and-exchanges/' },
      { label: 'Accessibility', href: '/accessibility/' },
    ],
  },
];
