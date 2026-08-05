# Changelog — Storefront catalog UX & homepage

Branch: `feat/storefront-catalog-ux-and-homepage`  
Base: `mathew/public-website-rebuild`

Storefront browsing and navigation updates for guests and signed-in customers.

---

## What changed (product)

### Product cards
Colour thumbnails now drive the main photo. Opening the lightbox or order modal keeps that colour selected. The second-angle hover effect still works after you move the pointer off the card.

### Catalog layout
The 3-column / 4-column density toggle is gone. The grid stays at four columns on desktop and still breaks down to three, then two, on smaller screens.

### Pagination
Page numbers with ellipsis replace Prev/Next-only paging. Logged-in users get a compact `1 … 5 6 7 … 40` style list plus a product count. Guests get a short sliding window of pages so the control does not keep growing as they browse.

### Brand filters
Brand chips prefer the product’s brand **category** over the Zoho `brand` field. That field is often wrong (for example a Charlett frame labeled Laura Ferre). Chips like Charlett now return the right set. If a product has no brand category, the Zoho brand column is still used as a fallback.

### Home navigation
- Guest header: Home pill next to Products  
- Logged-in: Home in the text nav, Home icon in the top bar, logo goes to the homepage (not the dashboard)

### Homepage portfolio
Left feature image and three supporting shots are square, vertically balanced, and use `object-fit: contain` on the stone background. Black letterbox bars are gone and brand marks (e.g. CHARLETT) stay visible.

### Footer social
Instagram, Facebook, and LinkedIn icons link to the real Veyora Vision profiles:
- https://www.instagram.com/veyora.vision/
- https://www.facebook.com/veyoravision
- https://www.linkedin.com/company/veyoravision/

---

## Files

### `platform/server/api/src/routes/catalog.js`

Adds `productMatchesBrand()`. Brand filtering checks public brand names in `categories` first, and only falls back to the Zoho `brand` column when no public brand category is present.

### `platform/server/storefront/js/pages_catalog.js`

- Removes density state and the density UI; grid always uses the default `.pgrid2` layout.
- Adds `pagerNumbers()` and wires numbered page buttons (with Prev/Next and optional total count).
- Tracks `selectedSrc` on each card; thumb clicks call `setMainPhoto` and set a short-lived `thumb-swapping` class so hover does not cover the chosen colour.
- Photo / guest click opens the lightbox on the selected colour; Order / customer click opens `productModal(p, selectedSrc)`.
- Modal accepts an optional start image so the main photo and thumbstrip open on that colour.

### `platform/server/storefront/css/store.css`

- Drops density / `cols3` styles.
- Styles the new pager (active page, ellipsis gap, meta count).
- Adds `.thumb-swapping` so the hover second-angle image stays hidden only until mouseleave; photo wrap uses `zoom-in` cursor.
- Sizes top-bar SVG icons for the Home control; adds ghost Home pill styles for the guest header.
- Reworks `.hm-port*` into a square feature + three square supporting figures with contain + stone fill.
- Adds footer social icon button styles (`.hm-foot-social`, `.hm-soc`).

### `platform/server/storefront/js/pages_home.js`

- Adds the guest Home pill.
- Defines social URLs and Instagram / Facebook / LinkedIn SVG icons; renders them in the footer.
- Updates portfolio markup (square feature hints; each supporting shot wrapped in `<figure>`).

### `platform/server/storefront/js/app.js`

- Inserts Home at the start of the logged-in `NAV` list.
- Adds `navLinkActive()` so `#/` / `#/home` highlight correctly without treating every route as Home.
- Logo and a Home icon button navigate to `#/`; drawer links use the same active helper.

### `docs/storefront-ux-changelog.md`

This changelog.

---

## How to verify

1. On Products, click a colour thumb — main image updates; lightbox and order modal open on that colour; hover second-angle still works after leaving the card.
2. Filter by Charlett — results match Charlett, not mislabeled Zoho brands.
3. Move through pagination with page numbers; guest pager stays short; customer sees a total count.
4. Confirm the density toggle is gone and the grid still responds at the usual breakpoints.
5. Use Home from guest header, logged-in nav, top-bar icon, and logo.
6. Check the homepage portfolio on desktop and mobile — no black bars, branding visible.
7. Open each footer social link and confirm the correct profile.
