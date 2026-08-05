# Visual Baseline Manifest

**Status:** manifest only. No screenshots have been captured under this file.

| | |
|---|---|
| Created | 2026-08-05 |
| Branch | `mathew/public-website-rebuild` |
| Starting commit | `2c749ec` |
| Created during | B1.1 (Astro foundation, environment and design tokens) |

---

## 1. Visual source-of-truth files

These are the files the public design system is ported from. They are read-only references for
this work — nothing in them is modified by B1.1.

- `platform/server/storefront/css/store.css` — the editorial `hm-*` block, lines 405–647
- `platform/server/storefront/js/pages_home.js` — homepage markup and recorded art-direction
  rationale
- `platform/server/storefront/js/pages_catalog.js` — guest catalogue (application layer,
  reference only)
- `platform/server/storefront/index.html` — font loading and document head (reference only)
- `platform/server/storefront/assets/**` — logos, photography, video (not copied; referenced
  only)
- `docs/public-website-rebuild/02_VISUAL_SYSTEM_INVENTORY.md` — the derived token set and
  extension rules this build follows

## 2. Routes that will require screenshot capture (not yet captured)

Per `09_FIRST_BUILD_PACKAGE.md` §B0.1, the pre-code design freeze covers the current public
surface:

- `/` (editorial homepage)
- `/#/products` (guest catalogue)
- `/#/login`
- `/#/list/<slug>`

## 3. Required capture parameters (for when capture is performed)

**Viewport widths:** 1440, 1280, 1024, 900, 768, 560, 414, 375

**Orientation / agent:** each width captured under both a desktop and a mobile user agent, per
`09_FIRST_BUILD_PACKAGE.md` §B0.1 ("desktop and mobile").

**Naming convention:**

```
<route-slug>__<width>__<desktop|mobile>.png
```

Examples: `home__1440__desktop.png`, `home__375__mobile.png`,
`list-slug__768__mobile.png` (route parameters flattened to a fixed placeholder slug).

Each capture file is accompanied by the capture date and the commit hash it was taken against,
recorded in a manifest alongside the images (not embedded in the filename), so provenance
survives a rename. This satisfies the `REQ-EXEC-008` / `CTL-052` provenance requirement.

## 4. Capture status

**No live or production capture has been performed.** No request has been made to any Veyora
domain, staging host, or the VPS as part of this or any prior step in this rebuild. This manifest
records the requirement and convention only.

## 5. Approval gate

Visual baselines require explicit approval before any visual-regression test built against them
becomes a blocking (merge-gating) check. Until approved, visual comparisons are advisory only.
This mirrors the design-freeze and baseline-acceptance sequencing in `07_IMPLEMENTATION_PLAN.md`
(B1 exit: "visual regression baseline accepted for the shell") and `08_RISKS_AND_OPEN_DECISIONS.md`
R-07.
