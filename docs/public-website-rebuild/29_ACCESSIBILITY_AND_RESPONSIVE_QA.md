# 29 — Accessibility and Responsive QA

Every public route audited in a **real browser**, at **375 / 768 / 1280 px**, against computed layout.

**Nothing was installed.** No Playwright, no Puppeteer, no browser binary, no new dependency of any
kind. **Nothing was deployed and no production system was contacted.**

---

## 1. How this was done without installing anything

The brief for this phase forbids installing Playwright or downloading a browser, and asks first
whether a browser is *already* on the machine and can be driven headlessly without adding a
dependency.

It can. Chrome and Edge both ship the **Chrome DevTools Protocol** over a plain WebSocket, and Node 22
has a **global `WebSocket`**. So the entire driver is `spawn()` + `fetch()` + `WebSocket`:
`platform/server/web/test/helpers/headless-chrome.ts`, about 200 lines, no package, no download,
nothing in `node_modules`, nothing to keep up to date.

A test asserts this rather than merely claiming it: `playwright`, `@playwright/test`, `puppeteer`,
`puppeteer-core`, `selenium-webdriver`, `cypress`, `chrome-launcher` and `chrome-remote-interface`
are each asserted absent from the project's dependencies.

### Why a real browser, rather than a DOM shim or a stylesheet scan

The questions this phase exists to answer are not answerable from source:

- *Does anything overflow horizontally at 375px?*
- *Is this tap target 24 CSS pixels tall?*
- *Is this text 4.5:1 against what is actually painted behind it?*

Each is about **computed layout after the cascade and the media queries have resolved**. A shim or a
scan can only approximate it, and the approximation is wrong in exactly the cases that matter — the
42%-alpha text in §5 is a good example, because its contrast is not a property of any single
declaration.

### Safety

- A throwaway `--user-data-dir` under the OS temp directory. The operator's real Chrome profile,
  history, cookies and logins are never opened, read or written.
- `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` — **DNS is dead inside this browser.**
  It can reach loopback and nothing else, so a mistyped URL cannot contact a real host, let alone a
  Veyora one.
- Background networking, sync, component updates, extensions and the first-run flow all disabled.
- The site under test is the **real production build**, served by the real standalone server, pointed
  at the local mock API on 127.0.0.1.
- **On a machine with no Chrome or Edge, the whole suite skips** with a clear message rather than
  failing. A QA control that goes red because of the machine it runs on is a control people learn to
  ignore.
- **The browser is fully shut down and its profile removed.** This took two attempts to get right —
  see §8.1, because the failure mode is worth knowing about.

---

## 2. Coverage

Ten routes × three viewports = **30 page/viewport audits**, in one browser session.

| Route | Why it is in the set |
|---|---|
| `/` | Home — the densest layout |
| `/brands/` | Listing |
| `/collections/` | Listing with filters |
| `/collections/optical/` | Filtered listing |
| `/contact/` | Enquiry form |
| `/request-b2b-account/` | Enquiry form — the longest, with a select and a required group |
| `/private-label-enquiry/` | Enquiry form |
| `/why-veyora/` | Long editorial copy |
| `/accessibility/` | The accessibility statement itself |
| `/no-such-page-here/` | The 404 — an error page is still a page |

| Viewport | Emulation |
|---|---|
| 375 × 812 | mobile emulation on, so a missing viewport meta would lay out at the legacy 980px exactly as a phone would |
| 768 × 1024 | tablet |
| 1280 × 900 | desktop |

A test asserts the emulation actually took effect at every one of the 30 combinations — measured
against `innerWidth`, not `clientWidth`, because a classic scrollbar makes the latter 15px narrower
and asserting on it reports a scrollbar as a layout defect. Overflow is measured against
`clientWidth`, which *is* the right box for that question. The two are deliberately different numbers.

---

## 3. What is checked

17 rules, run in-page against computed style and geometry.

**Responsive** — document-level horizontal overflow; per-element overflow (skipping anything inside a
deliberate `overflow-x: auto` region); viewport meta present; pinch-zoom not disabled
(`user-scalable=no`, `maximum-scale` under 2); text not rendered below 10px.

**Structure** — `html[lang]`; a non-empty `<title>`; exactly one `main` landmark; `header` and
`footer` landmarks; every navigation named when there is more than one; exactly one visible `h1`; no
skipped heading level; no empty heading; the first focusable element is a skip link pointing at a
target that exists.

**Names** — every `img` has an `alt` attribute (deliberately "has the attribute", not "has text":
`alt=""` is the correct marking for a decorative image, and demanding text would push someone to
describe a spacer); every link and button has an accessible name; every form field has a label or an
accessible name; every `fieldset` has a `legend`; no `aria-required="false"` on a required field.

**References** — no duplicate `id`; no `aria-labelledby`/`describedby`/`controls`/`owns` pointing at a
missing id; no `label[for]` pointing at a missing id; no positive `tabindex`.

**Measured** — tap targets at least 24 × 24 CSS px (WCAG 2.2 AA 2.5.8, with the SC's own exception for
links inside a sentence); text contrast 4.5:1, or 3:1 for large text (WCAG 1.4.3).

Accessible-name resolution follows the real precedence: `aria-label`, then `aria-labelledby`, then
`label[for]`, then a wrapping `label`, then text content, then a nested `img[alt]`, then `title`.

### Contrast is composited, not approximated

The foreground colour is **alpha-blended over its resolved background** before the ratio is computed —
which is what the browser paints and what a reader sees.

This mattered a great deal. On the first run the check treated a translucent text colour as
unmeasurable and skipped it. That skipped **687 of 1,113 text elements — 62% of the text on the
site** — and reported the remaining 38% as a contrast audit. Compositing brought coverage to
**1,113 / 1,113 (100%)** and immediately surfaced the §5 findings, which the 38% version had missed
entirely.

The lesson is worth keeping: a check that silently skips what it finds hard reports a pass on the
part it understood, and that is indistinguishable from a pass on everything.

---

## 4. Results

**28 tests, all passing. Three open findings, pinned.**

Every structural, naming, reference and responsive rule came back **clean at all three widths**:

- no horizontal overflow on any page at any width, and no individual element breaking out;
- viewport meta present everywhere, zoom never disabled;
- exactly one `main`, one `h1`, and no skipped heading levels on any page;
- a working skip link as the first focusable element on every page;
- every image with an `alt`, every link and button named, **every form field labelled** on all three
  enquiry forms;
- no duplicate id, no dangling ARIA reference, no positive `tabindex`;
- no text below 10px;
- outside the footer, every tap target meets 24 × 24 at every width.

---

## 5. Open findings

Three, and they share a shape: each is one **design-system decision** applied everywhere, not a bug
in a page. Fixing any of them changes the approved visual system on every route — which is
`08_RISKS_AND_OPEN_DECISIONS.md` **R-07, visual drift, score 12** — and is a decision that belongs to
a person, not to an unattended run.

So they are **pinned, not muted**, exactly as the release-verification host scan pins its exceptions:

- every affected element is named in `KNOWN` in the test, so the list is the finding register;
- **anything not on the list fails**, so the set can only grow deliberately;
- **a pin that stops matching also fails**, so a fixed finding cannot linger and hold the door open
  for the next one.

**A pinned finding is an open finding, not a pass.**

### 5.1 Footer tap targets under 24 × 24 — WCAG 2.2 AA 2.5.8

| Element | Size | Where |
|---|---|---|
| `a.site-footer__logo` | 142 × 19 | every page, every width |
| `a "Home"` | 32 × 21 | footer navigation |
| `a "Collections"` | 59 × 21 | footer navigation |
| `a "Private Label"` | 70 × 21 | footer navigation |

20 occurrences at 375px. **Every one is in the footer** — one layout decision repeated, not twenty
bugs, and a test asserts the finding stays confined there.

*Fix:* vertical padding on the footer navigation links, which moves the footer's vertical rhythm on
every page. Small, but visual.

### 5.2 Text contrast at 4.06:1 and 2.65:1 — WCAG 1.4.3

One root cause: **a text colour set at 42% alpha.**

| Element | Composited ratio | Needs |
|---|---|---|
| `p.site-footer__group-heading` | 4.06:1 (11px/600 on the dark footer) | 4.5:1 |
| `div.site-footer__legal` | 4.06:1 (12px/400) | 4.5:1 |
| `span.model-card__brand` | 4.06:1 | 4.5:1 |
| `p.pagination__page` | 4.06:1 | 4.5:1 |
| `p.brand-summary__tier`, `p.brand-summary__segment` | 4.06:1 | 4.5:1 |
| `p.skeleton-notice__eyebrow` | **2.65:1** (11px/600 on light) | 4.5:1 |

183 occurrences. The footer group is a **near miss** — raising the alpha from 0.42 to about 0.52
clears 4.5:1 with no other change. The skeleton notice at 2.65:1 is a clear failure, and it is a
**development placeholder that should not ship at all**, which is a separate and easier decision.

### 5.3 Micro labels between 10px and 12px

363 occurrences: the header utility links (11px), footer group headings (10.5px), footer navigation,
breadcrumbs, pagination, and the card and summary meta lines.

WCAG sets **no minimum font size**, so this is not a conformance failure — it is a readability
finding, and it is reported separately from the sub-10px rule for exactly that reason. Uppercase
letter-spaced micro labels are a normal editorial pattern; at 10.5px they sit at the edge of it, and
they overlap with 5.2 (the same elements are also the low-contrast ones), so the two are best decided
together.

The check is split at 10px: below that is treated as a defect and hard-fails (there are none).

### Recommended order

1. **Remove the skeleton-notice placeholder** — it should not ship, and it takes 2.65:1 with it.
2. **Raise the 42% alpha token to ~52%** — one token, clears 5.2 everywhere, no layout change.
3. **Then** decide 5.1 and 5.3 together, since both touch the footer's type and spacing.

---

## 6. Where this runs

`node scripts/verify-release.mjs` includes it as the `accessibility-responsive` gate
([28_RELEASE_QUALITY_GATES.md](28_RELEASE_QUALITY_GATES.md)), and it is part of the Astro suite, so
`npm test` in `platform/server/web` runs it too. About 23 seconds for all 30 audits.

Because the suite skips cleanly without a browser, the gate reports "passing" on a machine that has
none. **A green gate is therefore not proof that browser QA ran** — the run's diagnostics say
explicitly how many combinations were audited, and a run reporting zero is a run where no browser was
present.

---

## 7. What automated checking does not cover

Roughly a third of WCAG issues are machine-decidable at best. Everything below needs a person, and
none of it was done here:

1. **Screen-reader testing.** NVDA, JAWS and VoiceOver each behave differently; a page with a correct
   accessibility tree can still read badly.
2. **Keyboard walkthrough.** Tab order is asserted to be document order, but nobody tabbed through a
   form, opened the mobile menu with a keyboard, or checked that focus goes somewhere sensible after
   submitting. **Focus visibility is not checked at all** — whether a focus ring is actually
   *visible against its background* is a rendering judgement.
3. **Alt text quality.** Every image has an `alt`; whether it is a useful description is not
   decidable. `alt="image"` passes this audit.
4. **Reading order and meaning.** Heading levels are structurally correct; whether the outline
   describes the page is a human judgement.
5. **Colour as the only carrier of meaning.** Not machine-detectable.
6. **Motion and animation.** `prefers-reduced-motion` is not checked, and no animation was measured.
7. **Real devices.** Emulated viewports are not a phone. Touch behaviour, on-screen keyboards, safe
   areas, notches and iOS Safari's dynamic viewport are all unrepresented.
8. **Zoom and reflow.** WCAG 1.4.10 (400% zoom) and 1.4.12 (text spacing) are not tested.
9. **Real content.** Every page was rendered from mock fixtures. Long brand names, missing images and
   unusual characters will all change the layout, and none of them is present.
10. **The admin panel and the storefront are out of scope.** This audit covers the public Astro site
    only.

**A supervised manual accessibility pass, and a real-device pass, remain release requirements.**
Recorded as blockers in [31_RELEASE_CANDIDATE_READINESS.md](31_RELEASE_CANDIDATE_READINESS.md).

---

## 8. Limitations of the tooling itself

### 8.1 A resource leak, found and fixed

The first version of the driver called `child.kill()` and retried removing the profile for 2.5
seconds. Both were wrong, and the combination leaked badly.

`child.kill()` signals the **launcher** process. Chrome's crashpad handler, network service, GPU
process and renderers are **separate processes** that survive it. So every run of this suite left a
live process group and a locked profile directory behind. Across repeated runs while the suite was
being written, that reached **199 orphaned Chrome processes and about 3.6 GB** of unavailable disk —
on a laptop the whole run was constrained to keep above 4 GB free.

It is worth stating plainly because it is easy to repeat: a headless browser is not one process, and
killing the handle you were given does not stop it.

The fix has three parts, and all three are needed:

1. **`Browser.close` over CDP** — the graceful path, which brings the whole process group down the
   way quitting the browser would.
2. **Kill the process tree** as a fallback (`taskkill /T /F` on Windows; a process-group signal
   elsewhere), for when CDP is already gone.
3. **Sweep stale `veyora-a11y-*` profiles at launch**, so a leak from an interrupted run *self-heals*
   on the next one instead of accumulating. A directory still locked by a concurrent run is skipped.

Verified after the fix: zero orphaned processes, zero leftover profile directories, free space stable
across runs.

### 8.2 Everything else

- **This is not axe-core**, and does not claim to be. It implements the rules that matter for this
  site and are decidable without heuristics. It will not find what it does not check for.
- **Chrome only.** Firefox and Safari are not exercised. Safari in particular differs on flexbox
  gaps, dynamic viewport units and form control sizing.
- **Headless is not headful.** Scrollbar behaviour, font rasterisation and some GPU-dependent effects
  differ.
- **A background image or gradient behind text would be skipped** by the contrast check rather than
  guessed at. There are none today (the reported count is 0), but the gap is real if one is added.
- **The mock serves the fixtures it has.** Routes whose data does not exist — content pages, resource
  detail — are not in the set, so coverage grows as the catalogue does.
