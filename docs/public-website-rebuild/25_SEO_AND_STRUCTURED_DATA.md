# 25 — SEO Controls and Structured Data

`robots.txt`, the XML sitemap, JSON-LD, and the rendered forbidden-data gate.

No production system was contacted, no DNS was touched, and no hostname is hard-coded anywhere in
this work.

---

## 1. robots.txt

Served dynamically from `src/pages/robots.txt.ts`, not as a static file, for two reasons: the sitemap
URL must be absolute and derived from `PUBLIC_SITE_ORIGIN` (a static file would have to hard-code a
hostname), and non-production origins must answer differently without a second deployment artefact.

**Production**

```
User-agent: *
Disallow: /admin
Disallow: /api/
Disallow: /s3/

Sitemap: <PUBLIC_SITE_ORIGIN>/sitemap.xml
```

**Non-production** — `Disallow: /` for everything, and **no sitemap line**. A staging copy inviting
indexing is how it ends up outranking the real site. "Non-production" is detected by origin shape
(`localhost`, `127.0.0.1`, `.local`, a bare IP) plus `NODE_ENV`, never by a hard-coded hostname.

**Disallow is not a security control**, and the file says so. Everything listed is already protected
server-side; `robots.txt` only asks well-behaved crawlers not to waste requests. It deliberately does
not enumerate anything sensitive — a `robots.txt` is public, and a list of interesting paths in it is
a map. The three entries are namespaces already visible in the site's own markup.

Content type `text/plain; charset=utf-8`, cached 5 minutes.

---

## 2. XML sitemap

`src/pages/sitemap.xml.ts` + the pure builders in `src/lib/sitemap-xml.ts`. Data comes from
`getSitemapData()` through the existing server-side public API client.

### Included

The hand-listed indexable static routes, plus published brands, models and content pages the endpoint
returns. Static routes are hand-listed rather than derived from the filesystem: a route existing is
not the same as it being worth indexing.

### Excluded, and enforced by `isIndexablePath()`

Any path carrying a query string or fragment (so no filtered, sorted, searched or paginated state),
protocol-relative or traversal paths, `/admin`, `/api`, `/s3`, Astro internals, `/404/`, `/500/`,
`/healthz`, and anything not ending in `/`.

This matters because those states are `noindex` in `src/lib/indexing.ts`. Listing a `noindex` URL in
a sitemap is a **contradiction** — it asks a crawler to both ignore the page and treat it as
canonical — and search engines read that as a quality signal against the site. The filter runs over
upstream records too, so a malformed path from the API is dropped rather than emitted.

### Correctness details

- **Absolute URLs**, built from `PUBLIC_SITE_ORIGIN`.
- **XML escaping** with `&` replaced first, so nothing double-escapes.
- **`lastmod` only when valid and not in the future.** A future or unparseable date invites a crawler
  to distrust every date in the file.
- **Deterministic**: static routes in declared order, then upstream records in the order the API
  sorted them, duplicates removed by path. Two requests over unchanged data produce identical XML.

### An upstream failure answers non-200, never a short sitemap

If `getSitemapData()` fails, the route returns the mapped failure status (`503`/`502`) with
`cache-control: no-store` and an XML comment — **not** a 200 containing only the static routes.

A sitemap missing most of its URLs is worse than no sitemap: it looks authoritative and invites
de-indexing of everything absent. A 503 tells a crawler to come back; a short 200 tells it to forget.

---

## 3. JSON-LD

`src/lib/structured-data.ts`, emitted by `Page.astro` into the existing `structured-data` slot.

| Type | Where |
|---|---|
| `WebSite` | every indexable page |
| `BreadcrumbList` | every page with a trail of two or more crumbs |
| `Brand` | `/brands/{brand}/` |
| `Product` | `/collections/{brand}/{model}/` |
| `CollectionPage` + `ItemList` | available for listings |

### What is deliberately absent

`offers`, `price`, `priceCurrency`, `availability`, `aggregateRating`, `review` — the fields that
make a Product rich result attractive, and every one of which would be **fabricated** here. This is a
wholesale catalogue: there is no public price, no consumer stock position, no review corpus. Emitting
them would be false structured data — a manual-action risk, and more simply a lie to someone reading
a search result.

`Organization` claims (address, telephone, `sameAs`, founder, employee count) are omitted for the
same reason: the content register has no approved values, and structured data is not the place to
guess at corporate facts. A brand is described as a `Brand`, not an `Organization`.

`FORBIDDEN_JSONLD_KEYS` lists all of these and a test asserts none appears in any emitted node.

### Safety properties

- **Built only from validated records.** A poisoned upstream payload has nowhere to land; a test
  hands a builder a record carrying every planted secret and asserts none survives.
- **Breadcrumb data mirrors the visible trail**, built from the same items the page renders, so the
  two cannot disagree.
- **`numberOfItems` counts this page's items**, never a claimed catalogue total the API does not
  expose.
- **A missing or unsafe image is omitted**, never guessed. `javascript:` never becomes an image URL.
- **`<` is escaped as `<`** on serialisation, so a value containing `</script>` cannot close the
  block early — the one XSS vector a JSON-LD island actually has.
- **A `noindex` page emits no structured data at all.** Describing a page in JSON-LD while telling
  crawlers to ignore it is a contradiction; the layout suppresses it.

---

## 4. Rendered forbidden-data gate

`test/http-routes.test.ts` requests every integrated public route — plus `/robots.txt` and
`/sitemap.xml` — against the real standalone server, pointed at a mock API whose fixtures carry
**planted literals** for price, sale price, purchase cost, margin, wholesale, qty, stock status,
warehouse, shelf, Zoho id, fact-owner id, approver id, a customer email, a `label:*` tag, media
rights holder, a street address and coordinates, including a **nested** private object.

Each literal is distinctive (`199.99`, `zoho_SECRET_999`, `u_owner_SECRET`) rather than a common
word, so a match is unambiguous and the scan cannot pass by accident or fail on a false positive.
JSON-LD blocks inside those pages are scanned by the same assertions.

### R-06 status: unchanged, and deliberately so

This phase closed the **fourth and last** surface the original R-06 mitigation named (JSON-LD and
inline JSON). The score stays at **L3 × I4 = 12**, because two conditions from the original entry
remain unmet:

1. **Nothing is wired as a merge gate.** The scan runs inside `npm test` — a test, not a control. A
   contributor can merge without running it.
2. **No real row has ever been checked.** Every scan runs against fixtures. A field that exists in
   production but in no fixture is invisible to all four surfaces.

Marking R-06 closed on the strength of four green surfaces would be exactly the kind of
false-confidence the entry was written to prevent. Full reasoning in
[08_RISKS_AND_OPEN_DECISIONS.md](08_RISKS_AND_OPEN_DECISIONS.md).

---

## 5. Canonical host

Canonical URLs remain environment-derived through `src/lib/seo.ts` and `PUBLIC_SITE_ORIGIN`; nothing
in this phase hard-codes a host. `robots.txt` and the sitemap read the same value, so all three
surfaces move together when the origin changes.

Astro's `security.allowedDomains` (added in Phase 3 — see
[24_PUBLIC_ENQUIRY_FORMS.md](24_PUBLIC_ENQUIRY_FORMS.md) §7) is now also part of this picture: it is
what makes Astro trust the real `Host` and `X-Forwarded-Proto` behind Caddy, and therefore what makes
the computed request origin match the deployed hostname.

---

## 6. Tests

| Suite | Tests | Covers |
|---|---|---|
| `test/seo-controls.test.ts` | 25 | robots content and both branches, sitemap inclusion/exclusion rules, escaping, `lastmod` validity, determinism, every JSON-LD builder, forbidden keys, script-closing escape, layout wiring |
| `test/http-routes.test.ts` | +6 | live robots.txt, live sitemap XML parsed and checked URL by URL, JSON-LD parsed as JSON, breadcrumb/visible-trail agreement, no offers on Product, no structured data on a `noindex` page, planted-secret scan across eight routes |

Web suite **412 passing**. Production Astro build succeeds.

---

## 7. Limitations

- **The sitemap is a single file.** At ~1,300 models it is far inside the 50,000-URL / 50 MB limits,
  so no index file is needed — but that will need revisiting if the catalogue grows an order of
  magnitude.
- **No `changefreq` or `priority`.** Both are advisory, widely ignored, and would be invented values.
- **No image or video sitemap.**
- **`lastmod` is absent for static routes**, because nothing tracks when their copy last changed.
- **The rendered scan covers routes the mock can serve.** Routes whose data does not exist yet are
  not exercised, so coverage grows with the catalogue rather than being complete today.
- **Structured data is not validated against Google's Rich Results Test** — that needs a public URL,
  which does not exist yet.
