# Changelog — Storefront catalog UX & homepage

Branch: `feat/storefront-catalog-ux-and-homepage`  
Base: `mathew/public-website-rebuild`

Storefront browsing and navigation updates for guests and signed-in customers, plus product-modal ordering polish and admin brand typography.

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

## Follow-up — product modal, sizing & admin fonts

Shipped after `f1735e4` on the same branch. Focus: make the product order modal usable on phone and desktop, show frame size the way retailers read it, and apply Chromatic Pro type only in the admin panel.

### Product modal — Colors list
- Color rows use a full-width CSS grid: thumb · name · status · qty, with qty pinned to the trailing edge (no left-clustered controls or dead space on the right).
- On phone, name and status stack under the thumb; qty stays on the right and the info column stretches to the modal width (fixes a shrink-wrap bug from `align-items: flex-start` on a column flex).
- Stock pills use short labels in the modal (`Backorder` / `in stock` / `production`).
- “Notify me” only appears when the colour is out of stock **and** backorders are disabled. When backorders are on, the qty box alone is enough.

### Quantity stepper
- The visible digit is a centred `.qtynum` span; the real input is overlaid for typing. That removes the off-centre `0` caused by number-input spinner gutters and font metrics.
- Digits-only filtering and max clamping still work through `bindQtyBox`.

### Frame size line (retailer format)
- Spec attribute **card grid** (Lens width / height / Bridge / Temple / Lens type / Case / Size / EAN) is removed from the modal.
- Replaced with one optical size line: **`eye-bridge-temple`** (e.g. `53-18-140`). Optional lens height shows quietly as `· H 37`.
- Same `eye-bridge-temple` format on catalog / list card attr lines.

### Modal close control
- Floating white circle with soft shadow (brand-style exit).
- **Phone:** close sits on the product gallery image (top-right of the photo).
- **Desktop / tablet:** close stays on the modal’s top-right corner.
- Placement follows `matchMedia('(max-width:760px)')` and updates if the viewport crosses that breakpoint.

### Admin panel typography only
- Admin (`/admin/`) uses Chromatic Pro faces: **Geometric Semibold** for UI/body, **Ghotic Bold** for logo, page titles, and headings.
- Storefront stays on **Montserrat** (homepage display serif stack unchanged). Brand fonts are intentionally **not** applied to the public site.

### Font assets
- `assets/fonts/Ghotic-Bold.ttf`
- `assets/fonts/Geometric-SemiBold.ttf`

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
- **Follow-up:** `attrLine` / `frameDimsBlock` for `W-B-T` sizing; color-row markup (`vcol` / `stockpill` / `vctrl`); phone vs desktop close placement; notify/qty split helpers.

### `platform/server/storefront/css/store.css`

- Drops density / `cols3` styles.
- Styles the new pager (active page, ellipsis gap, meta count).
- Adds `.thumb-swapping` so the hover second-angle image stays hidden only until mouseleave; photo wrap uses `zoom-in` cursor.
- Sizes top-bar SVG icons for the Home control; adds ghost Home pill styles for the guest header.
- Reworks `.hm-port*` into a square feature + three square supporting figures with contain + stone fill.
- Adds footer social icon button styles (`.hm-foot-social`, `.hm-soc`).
- **Follow-up:** product-modal layout (`.pdetail*`, color-row grid), qtyfield / qtynum, dims line, floating close, mobile stretch fixes.

### `platform/server/storefront/js/pages_home.js`

- Adds the guest Home pill.
- Defines social URLs and Instagram / Facebook / LinkedIn SVG icons; renders them in the footer.
- Updates portfolio markup (square feature hints; each supporting shot wrapped in `<figure>`).

### `platform/server/storefront/js/app.js`

- Inserts Home at the start of the logged-in `NAV` list.
- Adds `navLinkActive()` so `#/` / `#/home` highlight correctly without treating every route as Home.
- Logo and a Home icon button navigate to `#/`; drawer links use the same active helper.

### `platform/server/storefront/js/ui.js`

- **Follow-up:** centred qty box (`.qtynum` + text input); short stock-pill labels; digits-only qty binding.

### `platform/server/storefront/js/pages_lists.js`

- **Follow-up:** list cards use the same `eye-bridge-temple` size string.

### `css/styles.css` · `index.html` (admin)

- **Follow-up:** `@font-face` for Ghotic + Geometric; Poppins/Marcellus Google Fonts removed from admin; logo and headings use display face.

### `assets/fonts/`

- Ghotic Bold and Geometric Semibold TTF files for the admin panel.

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
8. **Follow-up:** Open a product modal — size shows as `53-18-140` (no Case / Lens type / Size cards); color rows fill the column with qty on the right; qty `0` is centred.
9. **Follow-up:** On a phone width, close sits on the gallery image; on desktop, close is on the modal corner.
10. **Follow-up:** `/admin/` uses Geometric / Ghotic; public storefront still uses Montserrat.
