/* A controlled local mock of the /public/* API, shared by the client
   tests and the live end-to-end HTTP test (B2.3).

   Nothing here contacts a real API, database or network beyond
   127.0.0.1. The fixtures deliberately carry ADVERSARIAL EXTRA FIELDS —
   price, stock, zohoItemId, factOwner, label:* tags and so on — that the
   real API would never send, precisely so the tests can prove those
   fields cannot survive validation or reach rendered HTML even if the
   upstream were compromised or version-skewed. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Every forbidden value planted in the fixtures below. Tests assert none
 * of these strings appears in validated output or rendered HTML. Each is
 * a distinctive literal (not a common word) so a match is unambiguous. */
export const PLANTED_SECRETS = {
  price: '199.99',
  salePrice: '149.99',
  purchasePrice: '80.00',
  cost: '77.77',
  margin: '0.6123',
  wholesale: '70.70',
  qty: '4242',
  stockStatus: 'in-stock-SECRET',
  warehouse: 'wh_main_SECRET',
  shelf: 'A12-SECRET',
  zohoItemId: 'zoho_SECRET_999',
  factOwner: 'u_owner_SECRET',
  approverId: 'u_approver_SECRET',
  customerEmail: 'buyer-SECRET@example.com',
  labelTag: 'label:internal-SECRET',
  rightsHolder: 'PhotographerSECRET',
} as const;

/** A model card carrying every forbidden extra field alongside the real
 * public ones. */
function poisonedModelCard(overrides: Record<string, unknown> = {}) {
  return {
    brandSlug: 'example-brand',
    brandName: 'Example Brand',
    slug: 'example-model',
    sku: '20894',
    name: 'Example Model',
    line: 'Heritage',
    shape: 'aviator',
    segment: 'premium',
    size: 'Medium',
    categories: ['Optical', PLANTED_SECRETS.labelTag],
    isFeatured: true,
    primaryMedia: {
      path: '/s3/models/example.jpg',
      alt: 'Example Model frame',
      width: 800,
      height: 800,
      kind: 'image',
      rightsHolder: PLANTED_SECRETS.rightsHolder,
    },
    // ---- adversarial extras the real API never sends ----
    price: PLANTED_SECRETS.price,
    salePrice: PLANTED_SECRETS.salePrice,
    purchasePrice: PLANTED_SECRETS.purchasePrice,
    cost: PLANTED_SECRETS.cost,
    margin: PLANTED_SECRETS.margin,
    wholesale: PLANTED_SECRETS.wholesale,
    qty: PLANTED_SECRETS.qty,
    stockStatus: PLANTED_SECRETS.stockStatus,
    availability: 'available-SECRET',
    warehouse: PLANTED_SECRETS.warehouse,
    shelf: PLANTED_SECRETS.shelf,
    zohoItemId: PLANTED_SECRETS.zohoItemId,
    factOwner: PLANTED_SECRETS.factOwner,
    approverId: PLANTED_SECRETS.approverId,
    customerEmail: PLANTED_SECRETS.customerEmail,
    internal: { nested: { cost: PLANTED_SECRETS.cost, email: PLANTED_SECRETS.customerEmail } },
    ...overrides,
  };
}

export const FIXTURES = {
  brands: {
    brands: [
      {
        slug: 'example-brand',
        name: 'Example Brand',
        shortName: 'Example',
        segment: 'premium',
        headline: 'Distinctive eyewear for modern retail',
        priceTierLabel: 'Premium',
        logoMedia: { path: '/s3/brands/example-logo.svg', alt: 'Example Brand logo', width: 400, height: 120, kind: 'image' },
        // adversarial extras
        factOwner: PLANTED_SECRETS.factOwner,
        margin: PLANTED_SECRETS.margin,
        internalNotes: PLANTED_SECRETS.customerEmail,
      },
    ],
  },
  brandDetail: {
    brand: {
      slug: 'example-brand',
      name: 'Example Brand',
      shortName: 'Example',
      segment: 'premium',
      headline: 'Distinctive eyewear for modern retail',
      priceTierLabel: 'Premium',
      logoMedia: null,
      summary: 'A premium eyewear brand built for independent retailers.',
      story: 'Founded in a small workshop.',
      idealRetailer: 'Independent optical retailers',
      bestFor: ['Statement pieces', 'Boutique assortments'],
      styleTraits: ['Bold', 'Colourful'],
      designOrigin: 'Italy',
      manufacturingOrigin: 'Italy',
      componentOrigins: ['Italy', 'Japan'],
      approvedMaterials: ['Acetate', 'Titanium'],
      heroMedia: null,
      featuredModels: [poisonedModelCard()],
      contentUpdatedAt: '2026-08-01T00:00:00.000Z',
      // adversarial extras
      factOwner: PLANTED_SECRETS.factOwner,
      wholesale: PLANTED_SECRETS.wholesale,
    },
  },
  models: {
    items: [poisonedModelCard(), poisonedModelCard({ slug: 'second-model', name: 'Second Model', sku: '20895' })],
    page: 1,
    hasMore: true,
  },
  modelsEmpty: { items: [], page: 1, hasMore: false },
  modelDetail: {
    model: {
      ...poisonedModelCard(),
      publicDescription: 'A classic aviator silhouette.',
      lensType: 'polarized',
      variations: [
        {
          sku: '20894.1',
          colorName: 'Matte Black',
          colorCode: 'BLK-01',
          swatchMedia: null,
          // adversarial extras on a variation
          price: PLANTED_SECRETS.price,
          purchasePrice: PLANTED_SECRETS.purchasePrice,
          qty: PLANTED_SECRETS.qty,
          zohoItemId: PLANTED_SECRETS.zohoItemId,
        },
      ],
      media: [
        { path: '/s3/models/example.jpg', alt: 'Example Model frame', width: 800, height: 800, kind: 'image' },
        // An unsafe scheme that must be dropped by validation, never rendered.
        { path: 'javascript:alert(1)', alt: 'unsafe', width: null, height: null, kind: 'image' },
      ],
      relatedModels: [poisonedModelCard({ slug: 'related-model', name: 'Related Model' })],
      contentUpdatedAt: '2026-08-01T00:00:00.000Z',
    },
  },
  locations: {
    locations: [
      {
        slug: 'italy-supply-base',
        name: 'Italy Supply Base',
        function: 'supply_base',
        regionsServed: ['Europe'],
        hours: 'Mon-Fri 9-5',
        // adversarial extras the API never returns
        address: { street: '123 Via Roma SECRET', city: 'Milan' },
        contact: { email: PLANTED_SECRETS.customerEmail, phone: '+39-555-SECRET' },
        coordinates: { lat: 45.46, lng: 9.19 },
        factOwner: PLANTED_SECRETS.factOwner,
      },
    ],
  },
  locationsEmpty: { locations: [] },
  sitemapData: {
    brands: [{ path: '/brands/example-brand/', contentUpdatedAt: '2026-08-01T00:00:00.000Z' }],
    models: [{ path: '/collections/example-brand/example-model/', contentUpdatedAt: '2026-08-01T00:00:00.000Z' }],
    pages: [{ path: '/resources/fitting-guide/', contentUpdatedAt: null }],
  },
  sitemapDataEmpty: { brands: [], models: [], pages: [] },
  facets: {
    shapes: ['aviator', 'round'],
    sizes: ['Medium'],
    categories: ['Optical', 'Sun'],
    brands: [{ slug: 'example-brand', name: 'Example Brand' }],
  },
} as const;

export interface MockApiOptions {
  /** Force a specific status for any request path matching this prefix. */
  failWith?: { status: number; body?: string; contentType?: string };
  /** Return a non-JSON content type on success. */
  contentType?: string;
  /** Return a body that is not valid JSON. */
  invalidJson?: boolean;
  /** Delay every response by this many ms (to exercise client timeouts). */
  delayMs?: number;
  /** Return a payload that is valid JSON but the wrong shape. */
  malformedShape?: boolean;
  /** Force a status from the /forms/* endpoints (429, 502, …). */
  formStatus?: number;
  /** Serve empty collections instead of populated fixtures. */
  empty?: boolean;
}

export interface MockApi {
  origin: string;
  /** Every request the server received — path plus the raw headers, so a
   * test can prove no cookie/auth header was forwarded. */
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  /** Every enquiry submission received, with the parsed body — so a test can
   * assert exactly what the site forwarded. Nothing is stored beyond this. */
  submissions: Array<{ formType: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** Starts a mock /public/* API on an ephemeral 127.0.0.1 port. */
export async function startMockApi(options: MockApiOptions = {}): Promise<MockApi> {
  const requests: MockApi['requests'] = [];
  const submissions: MockApi['submissions'] = [];

  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });

    const respond = () => {
      if (options.failWith) {
        res.writeHead(options.failWith.status, {
          'content-type': options.failWith.contentType ?? 'application/json',
        });
        res.end(options.failWith.body ?? JSON.stringify({ error: 'mock failure' }));
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      /* Enquiry submission (Fast-Track Phase 3). A deliberately small stand-in
         for the real /forms router: it accepts a POST, records the parsed body
         so a test can assert what the site forwarded, and mirrors just enough
         of the validation contract (a missing required field, an unknown
         field) to exercise the 400 path. It stores nothing. */
      if (path.startsWith('/forms/')) {
        const formType = path.slice('/forms/'.length);
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
          submissions.push({ formType, body: parsed });

          if (options.formStatus && options.formStatus !== 200) {
            res.writeHead(options.formStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mock form failure' }));
            return;
          }
          const missing = ['name', 'email'].filter((f) => !parsed[f]);
          if (missing.length || parsed.unexpectedField !== undefined) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Some details need attention.',
              fieldErrors: [
                ...missing.map((field) => ({ field, code: 'REQUIRED', message: `${field} is required.` })),
                ...(parsed.unexpectedField !== undefined
                  ? [{ field: 'unexpectedField', code: 'UNKNOWN_FIELD', message: 'This form does not accept that field.' }]
                  : []),
              ],
            }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      let body: unknown;
      if (path === '/public/brands') body = options.empty ? { brands: [] } : FIXTURES.brands;
      else if (path.startsWith('/public/brands/')) {
        const slug = decodeURIComponent(path.slice('/public/brands/'.length));
        if (slug !== 'example-brand') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'brand not found' }));
          return;
        }
        body = FIXTURES.brandDetail;
      } else if (path === '/public/models') {
        // Mirror the real API's own validation so client-side tests can
        // exercise the 400 path.
        const sort = url.searchParams.get('sort');
        if (sort && !['newest', 'name'].includes(sort)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unsupported sort: ${sort}` }));
          return;
        }
        // Echo the requested page, exactly as the real API does — the site
        // trusts the API's echoed page when building pagination links, so
        // a mock that always claimed page 1 would not exercise that path.
        const requestedPage = Number(url.searchParams.get('page') ?? '1');
        const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
        body = options.empty
          ? { ...FIXTURES.modelsEmpty, page }
          : { ...FIXTURES.models, page };
      } else if (path.startsWith('/public/models/')) {
        const rest = path.slice('/public/models/'.length).split('/').filter(Boolean);
        if (rest[0] !== 'example-brand' || rest[1] !== 'example-model') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'model not found' }));
          return;
        }
        body = FIXTURES.modelDetail;
      } else if (path === '/public/facets') body = FIXTURES.facets;
      else if (path === '/public/sitemap-data') {
        body = options.empty ? FIXTURES.sitemapDataEmpty : FIXTURES.sitemapData;
      } else if (path === '/public/locations') {
        body = options.empty ? FIXTURES.locationsEmpty : FIXTURES.locations;
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (options.malformedShape) body = { unexpected: 'shape', brands: 'not-an-array' };

      res.writeHead(200, { 'content-type': options.contentType ?? 'application/json' });
      res.end(options.invalidJson ? '{not valid json' : JSON.stringify(body));
    };

    if (options.delayMs) setTimeout(respond, options.delayMs);
    else respond();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    submissions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
