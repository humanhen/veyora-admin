# 02 — Visual System Inventory

**Scope of evidence.** Every value in this document is a literal read from the repository —
CSS custom properties, declared rules, media queries, markup and the design rationale recorded
in source comments. The primary sources are:

- `platform/server/storefront/css/store.css` — 806 lines; the editorial homepage system is
  lines 405–647
- `platform/server/storefront/js/pages_home.js` — the homepage markup and its design commentary
- `platform/server/storefront/js/pages_catalog.js` — the guest catalogue
- `platform/server/storefront/index.html` — font loading and document head
- `platform/server/storefront/assets/**` — logos, photography, video

**Recorded limitation — no rendered inspection was possible.** The repository has no
`node_modules`; there is no Playwright, Puppeteer or other headless browser available, and the
brief prohibits installing dependencies. Nothing in this document is an observation of a
rendered page. The following are therefore **unverified and must be measured before the visual
regression baseline is accepted**, and are marked `[UNVERIFIED]` where they appear below:
computed type sizes at real viewport widths, actual rendered metrics of the local serif stack
(which resolves differently per platform), colour-contrast ratios, focus-ring appearance,
scroll and motion behaviour as experienced, real-device mobile behaviour, and the true LCP
element per route.

**Explicitly excluded from evidence:** the specification's Appendix A wireframes. They were not
opened or interpreted. The orange/black utilitarian treatment they carry is not part of this
system and must not enter it.

---

## 1. Two separate design systems exist in this repository

| | Public / storefront | Admin panel |
|---|---|---|
| File | `platform/server/storefront/css/store.css` | `css/styles.css` |
| Body font | Montserrat (Google Fonts, 200–800) | Poppins (Google Fonts, 300–700) |
| Display font | local serif stack (see §2) | Marcellus |
| Canvas | `#fafbfc` app / `#f5f2ec` homepage | `#f8f8f7` |
| Ink | `#221F20` | `#1c1a17` |
| Accent | `#324264` slate blue | `#3273b8` blue |
| Radius | `10px` | `12px` / `16px` |

**Only the storefront system is the public visual source of truth.** The admin panel's tokens,
Poppins/Marcellus pairing and peach table headers are internal-tool language and must not leak
into the public site.

Within the storefront there are in turn **two layers**, and the distinction matters:

- **The application layer** (`--ink`, `--ink-2`, `--accent`, `--radius`, `.btn`, `.card`,
  `.pcard2`, `.topbar`, `.nav`, `.bottomnav`, `.drawer`, `.modal`, `.fchip`, …) — the
  authenticated portal and the guest catalogue. Blue-slate, functional, dense.
- **The editorial layer** (`body.hm-dark` + all `hm-*` rules) — the public marketing homepage.
  Warm ivory, serif display, generous rhythm, photography-led.

**The public website must be built on the editorial layer and extend it.** The application layer
is the portal's language. Where a specification module has no editorial equivalent (filters,
result grids, forms), the extension must be authored in editorial terms — ivory canvas, serif
display headings, uppercase letter-spaced controls, hairline rules — not by importing
`.btn`/`.fchip`/`.pcard2` wholesale.

---

## 2. Typography

### 2.1 Families

| Role | Stack | Source |
|---|---|---|
| Body / UI | `'Montserrat', sans-serif` | Google Fonts, weights 200;300;400;500;600;700;800, `display=swap` |
| Editorial display | `--hm-serif: 'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,'Times New Roman',serif` | **local only — no webfont requested** |

The serif stack is a deliberate zero-request decision, documented in source: *"The display face
is a local serif stack — no extra webfont is requested, and the mixed-case serif is what
separates this page from the letter-spaced uppercase Montserrat used everywhere else in the
app."*

`[UNVERIFIED]` This stack renders as Iowan Old Style on macOS/iOS, Palatino Linotype on Windows
and Georgia or a DejaVu fallback on Linux/Android. The three differ measurably in x-height,
width and colour. **Decision required before the visual regression baseline is set:** either
accept per-platform variation as intentional, or self-host one licensed serif. The
specification's performance guidance (subset and self-host where licensing permits) and the
need for a stable visual-regression baseline both point toward self-hosting.

### 2.2 Editorial type scale (all fluid via `clamp`)

| Token | Size | Line height | Tracking | Weight | Colour |
|---|---|---|---|---|---|
| `.hm-display` | `clamp(32px, 5.4vw, 66px)` | `1.06` | `-.015em` | 400 | `--hm-ink` |
| `.hm-display.sm` | `clamp(26px, 4vw, 46px)` | `1.13` | `-.015em` | 400 | `--hm-ink` |
| `.hm-display.xs` | `clamp(24px, 3vw, 34px)` | `1.18` | `-.015em` | 400 | `--hm-ink` |
| `.hm-state-copy h2` | `clamp(26px, 4.2vw, 50px)` | `1.14` | `-.012em` | 400 | `#fff`, `max-width:19ch` |
| `.hm-lead` | `clamp(15px, 1.1vw, 17px)` | `1.75` | — | 400 | `--hm-ink-soft`, `max-width:44ch` |
| `.hm-body` | `15.5px` | `1.8` | — | 400 | `--hm-ink-soft`, `max-width:46ch` |
| `.hm-eyebrow` | `10.5px` | `1.7` | `.22em` | 600 | `--hm-ink-faint` |
| `.hm-strip h2` | `11px` | — | `.2em` | 600 | `--hm-ink` |
| `.hm-strip p` | `14.5px` | `1.7` | — | 400 | `--hm-ink-soft`, `max-width:34ch` |
| `.hm-strip-no` | `13px` | — | — | 400 | serif, `--hm-ink-faint` |
| `.hm-btn` / `.hm-textlink` | `11.5px` | — | `.16em` | 600 uppercase | contextual |
| `.hm-nav-links a` | `clamp(10px, 1.6vw, 11.5px)` | — | `.14em` | 600 uppercase | `--hm-ink` |
| `.hm-close-side p` | `15.5px` | `1.8` | — | 400 | `rgba(255,255,255,.66)`, `max-width:38ch` |
| `.hm-foot-links a` | `12.5px` | — | — | 400 | `rgba(255,255,255,.72)` |
| `.hm-foot-legal` | `12px` | — | — | 400 | `rgba(255,255,255,.42)` |

**Governing principle, extractable as a rule:** *mixed-case serif for statements, uppercase
letter-spaced Montserrat at 10.5–11.5px for every label, control and navigation item, and
measure-capped sans body copy at 34–46ch.* Every new public template should be composable from
exactly these five roles — display, lead, body, eyebrow, control — with no new sizes invented.

### 2.3 Application-layer type (portal / guest catalogue — for reference, not for extension)

Base `14px` / `1.45`. `h1.pagetitle` 20px/700. `.prod-head h1` 22px/600, 16px below 760px.
`.pcard2 .pname` 11.5px/500 uppercase, `1.5px` tracking. `.pcard2 .orderbtn` 8.8px/500 uppercase,
`1.5px` tracking. `.pcard2 .attrline` 12px, `1px` tracking. Form inputs are forced to `16px` to
prevent iOS zoom-on-focus — a pattern the public forms must keep.

### 2.4 Login page scale (measured replica of the old veyora.com `/my-account`)

`h1` 36px/600, tracking `-.72px`, colour `#1c1917`; eyebrow 11px/500, tracking `2.2px`
uppercase, `rgba(28,25,23,.55)`; field labels 11px/600, tracking `1.32px` uppercase; submit
button 52px tall, 13px/600, tracking `2.34px` uppercase, `#1c1917` on `#fafaf9`, radius `6px`.
This warm-neutral, high-tracking treatment is closer to the editorial layer than to the app
layer and is a useful precedent for **public form styling**.

---

## 3. Colour

### 3.1 Editorial palette — `body.hm-dark` (the public system)

| Token | Value | Role |
|---|---|---|
| `--hm-canvas` | `#f5f2ec` | warm ivory page background |
| `--hm-paper` | `#fffdf9` | lifted panel (value strip) |
| `--hm-stone` | `#ebe5db` | pale stone (portfolio band, image placeholder) |
| `--hm-ink` | `#191612` | primary text, primary button fill |
| `--hm-ink-soft` | `rgba(25,22,18,.64)` | body copy |
| `--hm-ink-faint` | `rgba(25,22,18,.42)` | eyebrows, serif numerals |
| `--hm-rule` | `rgba(25,22,18,.14)` | hairline rules and dividers |
| `--hm-night` | `#141210` | dark sections (statement, closing CTA, video frame) |
| footer | `#0d0b0a` | deepest black, one step below `--hm-night` |

Dark-section text: `#fff` for headings, `rgba(255,255,255,.66)` body, `rgba(255,255,255,.6)`
eyebrow, `rgba(255,255,255,.72)` footer links, `rgba(255,255,255,.42)` legal, borders
`rgba(255,255,255,.08)`.

**Four-value neutral ladder, no chroma.** The editorial system contains no brand colour, no
accent hue and no status colour. Everything is warm-neutral, and the photography carries all the
colour. `[UNVERIFIED]` `--hm-ink-faint` at `rgba(25,22,18,.42)` on `#f5f2ec` is approximately
4.0:1 and is used at 10.5px for eyebrows — this is the most likely WCAG 2.2 AA contrast failure
in the system and must be measured first.

### 3.2 Application palette (portal / guest catalogue — reference only)

`--ink #221F20` · `--ink-2 #131e42` · `--ink-3 #32204e` · `--accent #324264` · `--muted #64748b`
· `--line #e2e8f0` · `--bg #fafbfc` · `--card #ffffff` · `--soft-blue #ebf3f9` ·
`--soft-purple #f1e3f7` · `--ok #15803d` · `--warn #b45309` · `--bad #b91c1c`.
Accent lilac `#bda0d3` (badges, presentation mode). Catalogue neutrals: `#f5efe4` search field,
`#f4f3f1` product photo field, `#f7f6f4` modal stage, `#221F20` active chip.
Seller badges: `#E8730C` best / `#f4d96e` good — **the only saturated colours in the repository,
and they are portal-only merchandising signals. They must not appear on the public site.**

### 3.3 Gradients

The editorial system uses exactly one gradient, and it is functional rather than decorative —
the campaign-statement scrim:

```css
linear-gradient(100deg, rgba(12,10,9,.8) 0%, rgba(12,10,9,.52) 46%,
                        rgba(12,10,9,.2) 78%, rgba(12,10,9,.06) 100%),
linear-gradient(0deg,   rgba(12,10,9,.52) 0%, rgba(12,10,9,0) 44%)
```

A directional wash from the copy side plus a bottom lift. There is also a 56×1px
`linear-gradient` used as a hairline rule above the hero eyebrow. The application layer adds an
auth-screen gradient (`150deg, --ink → --ink-3 → --ink-2`) and a skeleton shimmer; neither
belongs to the public system.

---

## 4. Layout, grid and spacing

### 4.1 Container

`max-width: 1320px` on every editorial section (`1240px` on the motion section only), centred,
with fluid gutters `clamp(20px, 4vw, 40px)` — widening to `clamp(20px, 5.6vw, 32px)` on the hero
below 900px and `clamp(20px, 5.6vw, 40px)` in the nav.

### 4.2 Section rhythm (vertical padding)

| Section | Padding |
|---|---|
| Hero | `clamp(40px,5vw,70px)` top · `clamp(52px,6vw,84px)` bottom |
| Value strip | `clamp(30px,3.2vw,46px)` |
| Focus, Portfolio | `clamp(52px,6vw,92px)` |
| Motion | `clamp(50px,6vw,92px)` |
| Statement copy | `clamp(64px,8vw,120px)` top · `clamp(34px,4vw,60px)` bottom |
| Closing CTA | `clamp(52px,6vw,96px)` |
| Footer | `clamp(34px,3.6vw,48px)` top · `clamp(52px,5vw,76px)` bottom |

**The rhythm is one value: `clamp(52px, 6vw, 92px)` is the standard editorial section padding.**
The hero is tighter at the top, the statement is deeper, the strip is half-height. New sections
should use the standard value unless there is a stated reason.

### 4.3 Asymmetric grids — the signature of the system

No section uses a symmetric two-column split. Every one is deliberately off-balance:

| Section | Columns | Gap |
|---|---|---|
| Hero | `minmax(0,1fr) minmax(0,1.12fr)` — copy left, art right | `clamp(36px,5vw,72px)` |
| Value strip | `repeat(3, minmax(0,1fr))` with left hairline dividers | `clamp(24px,3vw,44px)` |
| Focus | `minmax(0,.78fr) minmax(0,1.22fr)` | `clamp(32px,4.4vw,64px)` |
| Focus image pair | `minmax(0,1.22fr) minmax(0,1fr)`, fixed height `clamp(400px,54vh,580px)` | `clamp(12px,1.6vw,22px)` |
| Portfolio | `minmax(0,.85fr) minmax(0,1.15fr)` | `clamp(32px,4.4vw,64px)` |
| Portfolio detail row | `repeat(3, minmax(0,1fr))` | `clamp(8px,1.2vw,16px)` |
| Motion | `minmax(0,.66fr) minmax(0,1.34fr)`, `align-items:end` | `clamp(30px,4vw,56px)` |
| Closing CTA | `minmax(0,1.15fr) minmax(0,.85fr)`, `align-items:end` | `clamp(30px,4vw,64px)` |
| Footer | `auto minmax(0,1fr)` | `20px 40px` |

`minmax(0, …)` is used universally to prevent grid blowout — a pattern to carry forward.

**Extension guidance for the specification's grids.** Brand grids and model grids do not exist
in the editorial layer. They must be authored as editorial compositions: `repeat(auto-fill,
minmax(…))` on the ivory canvas, hairline-ruled rather than boxed, with the 4→2→1 column
reduction the specification requires. They must not reuse `.pgrid2` / `.pcard2`, which are the
portal's dense merchandising cards with seller badges, colour-swatch strips and Order buttons.

### 4.4 Breakpoints

| Width | Meaning | Origin |
|---|---|---|
| `1100px` | catalogue grid 4→3 | app layer |
| `900px` | **primary layout switch** — homepage grids collapse to one column; app shell switches to burger + bottom-nav; catalogue filters move into a bottom sheet | app + editorial |
| `840px` | catalogue grid 3→2 | app layer |
| `820px` | value strip stacks; footer stacks; guest header shrinks | editorial |
| `760px` | modal stacks; tables tighten; `.desktop-only` / `.mobile-only` swap | app layer |
| `640px` | `.grid2` → one column | app layer |
| `560px` | full-width primary button; hero crop 3:2; WhatsApp float hidden on homepage | editorial |
| `480px` | catalogue grid → 2 columns; touch-target enlargements | app layer |

**The editorial system uses four: 900, 820, 560 and (implicitly) the fluid `clamp` range above
900.** The public site should standardise on `1100 / 900 / 820 / 560` and test at 1440, 1280,
1024, 900, 768, 560, 414 and 375.

### 4.5 Radii

| Context | Value |
|---|---|
| **Editorial layer** | **`0` — no radius anywhere.** Buttons, image frames, video frame, nav account control are all square-cornered. |
| Circular | `999px` — WhatsApp float only |
| App layer | `--radius: 10px` cards; `8px` buttons/inputs; `12–16px` modals, lightbox, filter sheet; `2px` product card; `999px` chips and pills |

**The absence of radius is a defining editorial characteristic and must be preserved.** Rounded
cards would be the single most visible drift toward generic template design.

### 4.6 Shadows

The editorial layer uses two shadows, both large and soft, both on dark objects:

- video frame — `0 24px 60px rgba(25,22,18,.16)`
- WhatsApp float — `0 8px 24px rgba(25,22,18,.3)`

There is **no card shadow, no hover elevation and no border-boxed panel** anywhere in the
editorial system. Separation is done with background changes (`canvas` → `paper` → `stone` →
`night`) and `1px` hairline rules at `rgba(25,22,18,.14)`. This is a hard rule for extension.

App-layer reference: `--shadow: 0 1px 3px rgba(19,30,66,.08), 0 4px 14px rgba(19,30,66,.06)`.

---

## 5. Components

### 5.1 Buttons and links (editorial)

| Component | Specification |
|---|---|
| `.hm-btn` | `min-height:50px`, `padding:0 32px`, fill `--hm-ink`, border `1px solid --hm-ink`, `#fff` text, 11.5px/600 uppercase, tracking `.16em`, radius 0, transition `background/border-color/color .18s`. Hover → `#000`. |
| `.hm-btn.light` | On dark sections: fill/border `--hm-canvas`, ink text. Hover → `#fff`. |
| `.hm-btn.ghost` | Transparent, border `rgba(255,255,255,.4)`, white text. Hover → `rgba(255,255,255,.1)` + `#fff` border. |
| `.hm-textlink` | `min-height:44px`, no fill, `box-shadow: inset 0 -1px 0 var(--hm-rule)` as an underline, `::after { content:'→' }`, same 11.5px uppercase treatment. Hover darkens the rule to `--hm-ink`. |
| `.hm-nav-acct` | Nav-scale text link with a `1px --hm-rule` border box; hover darkens the border. |

`min-height` 50px / 44px satisfies WCAG 2.2 target size. `[UNVERIFIED]` **No `:focus-visible`
style is declared anywhere in the editorial system.** Focus relies entirely on the UA default
ring, which on an ivory background at these low-contrast borders is very likely to fail WCAG 2.2
AA focus-visibility. **This is a confirmed gap that must be designed and added, not merely
tested.**

Action hierarchy as implemented: one filled primary + one text link in the hero; text link only
in mid-page sections; filled light + ghost pair in the closing CTA.

### 5.2 Cards

The editorial layer has **no card component**. The value strip is the closest thing: bare
`<article>` elements separated by `border-left: 1px solid --hm-rule` with
`padding-left: clamp(20px,2vw,30px)`, the first item unruled; below 820px the rule rotates to
`border-top` with `22px` padding and margin.

**This is the pattern to extend for brand cards, model cards and benefit cards** — hairline
separation, serif or numeric marker, uppercase micro-heading, measure-capped body. Not the
portal's `.pcard2`.

For reference, the portal's model card (`.pcard2`) contains: `#f4f3f1` photo field, 1:1
`object-fit:contain` image, hover second-angle cross-fade at `.18s`, seller badge, favourite
toggle, uppercase 11.5px name, attribute line, 44px circular colour-swatch thumbnails with a
`#221F20` selected border, and a full-width `#1a1a1a` Order button. The **public** model card
must keep the image discipline and colourway thumbnails and drop the badge, favourite and Order
button, replacing them with a crawlable "View details" link.

### 5.3 Header

Two headers exist and both are in use:

**`.hm-nav` — editorial (homepage).** `position: sticky; top: 0`, background
`rgba(245,242,236,.93)` with `backdrop-filter: blur(10px)`, `border-bottom: 1px solid --hm-rule`.
Logo `height: clamp(17px,4.8vw,24px)`, `width:auto`. Links `clamp(10px,1.6vw,11.5px)` uppercase,
`gap: clamp(10px,2.4vw,30px)`. **It never wraps and never collapses to a burger** — the logo and
type shrink with the viewport instead. Two items only today (Products, Sign in / My account).

**`.hm-head` — dark guest header (sign-in, catalogue, shared lists).** `position: fixed`, dark,
200px logo (150px below 820px), a pill-shaped Products control with `backdrop-filter: blur(6px)`,
and a person icon.

**Extension decision required.** The specification's primary navigation is seven items plus three
utility actions. Ten items cannot survive `.hm-nav`'s shrink-don't-collapse strategy on a phone.
A mobile menu must be designed **in editorial language** — full-height ivory overlay, serif
section headings, uppercase links — and the desktop bar must remain the sticky blurred ivory rule.
`.hm-head` (dark, fixed) is the portal's guest chrome and should stay with the portal.

### 5.4 Footer

`.hm-foot` — `#0d0b0a`, `border-top: 1px solid rgba(255,255,255,.08)`. Grid `auto minmax(0,1fr)`:
logo left (19px tall, white), links right-aligned and wrapping (`gap: 4px 26px`, each
`min-height:36px`), then a full-width legal row above a `1px` white-8% rule with a dynamically
generated year. Below 820px everything left-aligns into one column and the bottom padding grows
to `calc(72px + env(safe-area-inset-bottom))` to clear the floating action.

The specification requires four content columns plus a legal row. The extension is
straightforward — same black, same rule weight, same link scale, four `minmax(0,1fr)` columns
collapsing to one at 820px — and the current four dead `#/` links must be replaced with the real
information architecture.

### 5.5 Forms

There is no public form in the repository. Two internal precedents:

- App layer `.field` — 12.5px/600 muted label, `10px 12px` input, `1px --line` border, `8px`
  radius, focus `border-color: --accent` + `0 0 0 3px rgba(50,66,100,.12)` ring. Inputs forced to
  `16px` to prevent iOS zoom.
- Login page — underline-only fields (`border-bottom: 1px solid rgba(28,25,23,.18)`, focus
  darkens to `#1c1917`), 11px uppercase tracked labels, 52px submit.

**The login page's underline treatment is the correct editorial ancestor for the public
Contact and Request B2B forms.** It must be extended with what the specification requires and
neither precedent has: persistent visible labels with an accessible required state, inline
validation, an error summary that links to invalid fields, and a designed focus state.

### 5.6 Motion

| Element | Timing |
|---|---|
| Buttons | `background/border-color/color .18s` |
| Text link underline | `box-shadow .18s` |
| WhatsApp float | `transform .15s, background .18s`, hover `scale(1.06)` |
| Card hover (app) | `box-shadow .15s, transform .15s`, `translateY(-2px)` |
| Product second-angle | `opacity .18s ease`, gated on `@media (hover:hover)` |
| Drawer backdrop | `opacity .22s` |
| Filter sheet | `opacity .25s` — **deliberately no transform slide**, documented as a fix for a throttled transition stranding the panel off-screen |
| Toast | `pop .2s` |
| Skeleton | `sk 1.2s infinite` |

**The whole system is 0.15–0.25 s, opacity/colour/small-translate only.** There is no scroll
animation, no parallax, no reveal-on-scroll and no entrance animation anywhere. The one
autonomous motion is the homepage video, which plays and pauses via `IntersectionObserver` with
a scroll fallback and a `touchend` retry for iOS Low-Power mode; it is `muted loop playsinline
preload="metadata"` with a poster.

`[UNVERIFIED]` **`prefers-reduced-motion` is not honoured anywhere in the repository.** The
auto-playing video is the clearest violation of the specification's reduced-motion requirement.
This is a confirmed gap.

### 5.7 Image treatment

The strongest and most characteristic part of the system.

| Rule | Evidence |
|---|---|
| Every image declares intrinsic `width`/`height` | all homepage `<img>` and `<video>` |
| Aspect ratio is reserved in CSS | `aspect-ratio: 4/5` (hero, portfolio), `16/9` (video), `1/1` (product), responsive overrides at 900/560px |
| Editorial photography is `object-fit: cover` with a hand-chosen `object-position` | hero `50% 46%`, focus-a `50% 25%`, focus-b `50% 30%`, statement `57% 43%` |
| Crop percentages are justified against the actual photograph | source comments record subject bands, e.g. *"hero-04 … hair 31%, sunglasses 36%, hips 60%, boots 82%"* |
| Product photography is `object-fit: contain` on a neutral field | `#f4f3f1` card, `#f7f6f4` modal, `mix-blend-mode: multiply` on the large stage |
| Placeholder colour while loading | `background: var(--hm-stone)` on editorial, `#111` on portfolio |
| First image prioritised, everything else lazy | `fetchpriority="high" decoding="async"` on the hero; `loading="lazy" decoding="async"` on all others |
| Alt text is contextual and descriptive | *"Veyora campaign portrait — a model in aviator sunglasses seated in an arched white studio"* |
| Hero height capped against the viewport | `max-height: min(70vh, 680px)`; `48vh` below 900px |
| Mobile re-crops rather than shrinks | hero `4/5` → `5/4` at 900px → `3/2` at 560px, with the reason recorded (*"At 375×667 the 5/4 crop put the CTA exactly on the fold"*) |

**Gaps against the specification:** no `srcset`/`sizes` anywhere, no AVIF, no image CDN,
`login-hero.jpg` is a 519 KB unoptimised JPEG, and product images come from the `/s3/` uploads
volume with no responsive variants.

### 5.8 Icons

Inline SVG only — no icon font, no sprite sheet, no external icon package. Uniform style:
`viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width` 1.6–1.7 (2.0 for
the burger), `stroke-linecap="round"`, `stroke-linejoin="round"`, sized 18–26px. The set covers
home, glasses, gear, bag, user, burger, eye/eye-off, funnel, document, person and a filled
WhatsApp mark (the one exception to the outline rule).

The homepage uses **no icons at all** except the WhatsApp float — the value strip uses serif
numerals `01/02/03` where a lesser design would use pictograms. This is a deliberate editorial
choice and should govern the new benefit/pillar/process modules: **numerals and type, not icon
sets.**

### 5.9 Mobile patterns

| Pattern | Implementation |
|---|---|
| Homepage stacking | Hero art moves above copy (`order: -1`) so the photograph leads the first screen; everything else follows reading order |
| Crop-not-shrink | Hero aspect ratio changes at 900px and 560px rather than the image scaling down |
| Full-width CTA | `.hm-actions .hm-btn { flex: 1 1 100% }` below 560px, with the text link beneath |
| Value strip | Vertical rules become horizontal rules |
| Float placement | Homepage float shrinks at 820px and is **hidden entirely below 560px**, documented: *"there is no corner the float can sit in without landing on a headline… Talk to Sales stays reachable three other ways"* |
| Safe areas | `env(safe-area-inset-bottom)` used in the bottom nav, both float variants and the footer |
| Horizontal pan | `overflow-x: clip` on `html, body` with an `@supports not` fallback to `hidden` |
| Touch | `-webkit-tap-highlight-color: transparent` globally; `user-select: none` + `-webkit-touch-callout: none` on interactive elements; 40px minimum steppers below 760px |
| Portal shell | Below 900px: burger + centred logo + fixed bottom tab bar + slide-in drawer (`280px`, `max-width:84vw`) |
| Filters (portal) | Below 900px the chip bar hides and a bottom sheet holds the same `.fbar` node, moved in and out of the DOM rather than duplicated |

The bottom-sheet-with-node-relocation pattern is directly applicable to the specification's
required mobile filter drawer with a visible active-filter count.

---

## 6. Token set proposed for the public site

Direct lift from `body.hm-dark`, plus the four values the editorial system uses as literals and
the additions the specification forces. Nothing here invents a value that is not already in the
repository except where marked **NEW**.

```css
:root {
  /* colour — lifted verbatim */
  --canvas:#f5f2ec;  --paper:#fffdf9;  --stone:#ebe5db;
  --ink:#191612;     --ink-soft:rgba(25,22,18,.64);  --ink-faint:rgba(25,22,18,.42);
  --rule:rgba(25,22,18,.14);
  --night:#141210;   --void:#0d0b0a;
  --on-dark:#fff;    --on-dark-soft:rgba(255,255,255,.66);
  --on-dark-faint:rgba(255,255,255,.42);  --rule-dark:rgba(255,255,255,.08);

  /* type */
  --serif:'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif; /* self-host decision pending */
  --sans:'Montserrat',sans-serif;
  --display:clamp(32px,5.4vw,66px);  --display-sm:clamp(26px,4vw,46px);
  --display-xs:clamp(24px,3vw,34px);
  --lead:clamp(15px,1.1vw,17px);     --body:15.5px;
  --label:11.5px;                    --eyebrow:10.5px;
  --track-label:.16em;               --track-eyebrow:.22em;  --track-nav:.14em;

  /* layout */
  --container:1320px;
  --gutter:clamp(20px,4vw,40px);
  --section:clamp(52px,6vw,92px);
  --section-tight:clamp(30px,3.2vw,46px);
  --gap:clamp(32px,4.4vw,64px);

  /* form */
  --radius:0;
  --control-h:50px;   --link-h:44px;
  --shadow-lift:0 24px 60px rgba(25,22,18,.16);
  --motion:.18s;      --motion-slow:.22s;

  /* NEW — required by WCAG 2.2 AA, absent from the current system */
  --focus-ring:0 0 0 2px var(--canvas), 0 0 0 4px var(--ink);
  --focus-ring-dark:0 0 0 2px var(--night), 0 0 0 4px #fff;
}
```

---

## 7. Confirmed gaps in the current visual system

Ordered by severity. These are **not** drift from the design; they are things the design does not
yet contain and which the specification requires.

1. **No `:focus-visible` treatment anywhere.** WCAG 2.2 AA blocker.
2. **`prefers-reduced-motion` not honoured**, and the homepage video auto-plays. WCAG 2.2 AA blocker.
3. **`--hm-ink-faint` at 10.5px** is the most likely contrast failure; must be measured.
4. **No mobile navigation pattern** capable of holding seven primary + three utility items.
5. **No card, grid, filter, breadcrumb, accordion, table, form, pagination or error component**
   exists in editorial language — all are required by the specification and all must be authored.
6. **No `srcset`/`sizes`, no AVIF, no responsive image pipeline.**
7. **Serif stack is platform-dependent**, which is incompatible with a stable visual-regression
   baseline unless self-hosted.
8. **Fonts are third-party-hosted**, affecting LCP and privacy posture.
9. **No favicon file** and no suitable OG share image.
10. **No dark/light theming, no `color-scheme`** — acceptable, but should be a recorded decision.

---

## 8. Rules for extension

1. Extend the **editorial** layer. Never import portal components (`.btn`, `.pcard2`, `.fchip`,
   `.card`, `.pill`, `.topbar`, `.bottomnav`) into a public template.
2. **No radius.** Square corners are load-bearing.
3. **No card shadows.** Separate with background steps and `1px` hairlines.
4. **No new colours.** The palette is four warm neutrals plus two blacks. Photography carries
   the colour.
5. **No icon sets in editorial modules.** Serif numerals and type, as the value strip does.
6. **No new type sizes.** Compose from display / lead / body / eyebrow / label.
7. **Asymmetric grids.** `.78/1.22`, `.85/1.15`, `1/1.12`, `.66/1.34` — never `1fr 1fr`.
8. **Section rhythm is `clamp(52px,6vw,92px)`** unless there is a stated reason.
9. **Every image declares intrinsic size, reserves aspect ratio, and states a chosen
   `object-position` justified against the actual photograph.** Record the reason in a comment,
   as the current source does.
10. **Motion stays at 0.15–0.25 s, opacity and colour only**, and must respect
    `prefers-reduced-motion`.
11. **Crop for mobile; do not shrink.**
12. When the specification names a module that has no editorial ancestor, design it from the
    five type roles, the four neutrals, the hairline rule and the asymmetric grid — and record
    the derivation, so the next reviewer can check it against this document rather than against
    taste.
