# 30 — Storefront Fix Integration Preparation

An integration-preparation report for another developer's storefront work.

**Nothing was merged.** No branch was checked out, no working tree was modified, nothing was pushed,
and the other developer was not contacted. Every finding below comes from read-only git inspection of
fetched refs — including the merge result, which was computed with `git merge-tree --write-tree`, a
command that produces a tree object without touching the working tree or any branch.

---

## 1. Finding the branch

The branch was **not** assumed from a name. Nine remote branches exist; each was fetched read-only and
ranked by recency, author and content.

| Last commit | Author | Branch | Relationship to this release branch |
|---|---|---|---|
| 2026-08-06 | mathewmljourney93 | `mathew/public-website-rebuild` | this branch |
| **2026-08-06** | **0x1p0** | **`feat/storefront-catalog-ux-and-homepage`** | **branches from `2c749ec` — this branch's own root** |
| 2026-08-04 | Claude | `claude/veyora-testflight-setup-82zsdj` | unrelated (mobile/TestFlight) |
| 2026-08-04 | 0x1p0 | `fix/storefront-catalog-thumb-selection` | branches from `mathew/monday-release` — **no common ancestor with this branch** |
| 2026-08-04 | mathewmljourney93 | `mathew/mobile-app-design` | same commit as `monday-release` |
| 2026-08-04 | mathewmljourney93 | `mathew/monday-release` | the current release lineage |
| 2026-07-27 | BuildMindX | `main` | ancestor of `monday-release` |
| 2026-07-26 | SetuG | `feat/ai-build` | unrelated ("Show to customer" view) |
| 2026-07-25 | BuildMindX | `fix/stubs-and-spareparts` | unrelated (production board) |

### The repository has two unrelated histories

This is the single most important fact for any integration, and it is not obvious from a branch list.

```
093db1a (2026-07-07, humanhen)          2c749ec (2026-08-04, mathewmljourney93)
  │  "Veyora Admin — full admin panel"    │  "Document public website rebuild architecture"
  ├─ main (b5533f1)                       │   ← a ROOT COMMIT: no parents
  │   └─ mathew/monday-release (8637f49)  ├─ mathew/public-website-rebuild  (this branch)
  │       └─ mathew/mobile-app-design     └─ feat/storefront-catalog-ux-and-homepage
  │       └─ fix/storefront-catalog-thumb-selection
  ├─ feat/ai-build
  └─ fix/stubs-and-spareparts
```

`git merge-base origin/main origin/mathew/public-website-rebuild` returns **nothing**. The public
website rebuild was started as an orphan history containing a snapshot of the whole repository — the
storefront, the admin panel and the API are all present at `2c749ec`, they simply have no shared
ancestry with `main`.

Consequences, both of which matter more than the merge itself:

- **Anything on the `main` lineage cannot be merged into this branch normally.** It needs
  `--allow-unrelated-histories` (which would produce a merge with no meaningful common base and a
  diff against everything) or a cherry-pick.
- **Landing this branch is not an ordinary pull request.** It shares no ancestor with `main`, so how
  the two histories are reconciled is a decision somebody has to make deliberately. Recorded as a
  release blocker.

### The identification, on content rather than name

`feat/storefront-catalog-ux-and-homepage` is the storefront work to integrate:

1. It is the most recent non-mine commit in the repository (2026-08-06).
2. It branches from `2c749ec` — **this branch's exact root** — so its author deliberately based it on
   the public-website-rebuild line, not on `monday-release`.
3. Its own changelog, committed on the branch as `docs/storefront-ux-changelog.md`, states
   `Base: mathew/public-website-rebuild`.
4. Its two commits are entirely storefront, admin-panel and catalog-API changes.

### `fix/storefront-catalog-thumb-selection` is superseded — do not merge it

The older branch's single commit fixes storefront catalog card image selection. **That fix is already
present in `feat/storefront-catalog-ux-and-homepage`**: the distinctive `setMainPhoto` /
`thumb-swapping` construction appears in the newer branch's `pages_catalog.js`, re-applied on the new
base.

It also has no common ancestor with this branch. Merging it separately would mean an
unrelated-histories merge to obtain a fix that is already there. **Treat it as closed by the newer
branch, not as a second thing to integrate.**

*(This is the "ambiguous candidates" case the brief anticipates, and it resolves: two branches by the
same author touching the same feature, where the newer supersedes the older on a different base. The
evidence for that is in this section rather than a coin toss.)*

---

## 2. What the change contains

Two commits by `0x1p0`, 2026-08-05 and 2026-08-06, over `2c749ec`.

```
 assets/fonts/Geometric-SemiBold.ttf            | Bin 0 -> 51256 bytes
 assets/fonts/Ghotic-Bold.ttf                   | Bin 0 -> 47184 bytes
 css/styles.css                                 |  21 ++-
 docs/storefront-ux-changelog.md                | 144 +++++
 index.html                                     |   6 +-
 platform/server/api/src/routes/catalog.js      |  23 ++-
 platform/server/storefront/css/store.css       | 244 +++++++++++++------
 platform/server/storefront/js/app.js           |  13 +-
 platform/server/storefront/js/pages_catalog.js | 230 +++++++++++++------
 platform/server/storefront/js/pages_home.js    |  40 +++-
 platform/server/storefront/js/pages_lists.js   |   7 +-
 platform/server/storefront/js/ui.js            |  48 ++--
 12 files changed, 617 insertions(+), 159 deletions(-)
```

Their changelog is thorough and worth reading in full on the branch. In summary: colour thumbnails
drive the main product photo and carry the selection into the lightbox and order modal; the
density toggle is replaced by a fixed responsive grid; numbered pagination with ellipsis replaces
prev/next; brand chips prefer the product's brand *category* over the frequently-wrong Zoho `brand`
column; home navigation and the homepage portfolio are reworked; the product order modal is rebuilt
for phone and desktop; the spec grid is replaced by a retailer-format `eye-bridge-temple` size line;
and the admin panel adopts two brand typefaces.

**It does not touch `platform/server/web/` at all.** The public Astro site — every route, every
template, the enquiry forms, the SEO controls and the accessibility work from Phase 4 — is completely
untouched by this change. That is the most reassuring fact in this report.

---

## 3. Merge assessment

**The merge is clean.** `git merge-tree --write-tree HEAD origin/feat/storefront-catalog-ux-and-homepage`
exits 0 and reports no conflicts, producing tree `1116351`. This was computed without checking
anything out.

Only **two files** are touched by both sides:

### `index.html`

- **Them:** removed the Google Fonts `<link>` and `preconnect` (Poppins, Marcellus), bumped
  `css/styles.css?v=7` → `?v=8`.
- **Us:** added `<script src="js/pages_enquiries.js?v=7">`.

Different regions; git merges them. **But there is a latent inconsistency the clean merge hides:** the
stylesheet moves to `?v=8` while *every* script tag stays at `?v=7`, including the new
`pages_enquiries.js`. A returning operator gets the new CSS and the cached old JavaScript. Bump all
the script versions in the same change, or the Enquiries screen ships behind a cache.

Removing the Google Fonts link is a genuine improvement worth keeping: it removes a third-party
request from an authenticated admin panel, which is one fewer party seeing who is logged in and when.

### `css/styles.css`

- **Them:** two `@font-face` declarations, `--font` switched from Poppins to Geometric, a new
  `--font-display`, and `.brand-logo` / headings switched to it.
- **Us:** no change in this workstream (earlier batches added the permission and public-content
  screens' styles).

No overlapping region. The new Enquiries screen reuses existing classes (`perm-layout`, `card`,
`field`, `badge`, `section-label`), so it inherits the new typography automatically — but **it has
never been seen in it**. Worth a look after integration; it is not a correctness risk.

---

## 4. Risks and things to check before this lands

Ordered by consequence. None of these blocks the merge mechanically; every one of them is a reason
the merge should be **supervised** rather than automatic.

### 4.1 Font licensing — legal, and not mine to decide

Two TrueType files totalling **98 KB** are added to the repository and served from the admin panel:
`Ghotic-Bold.ttf` and `Geometric-SemiBold.ttf`, described as "Chromatic Pro" faces.

Self-hosting a commercial typeface requires a licence that permits web embedding, and repositories are
frequently the place that gets forgotten. **This needs someone to confirm the licence covers
self-hosted web use before it ships.** I have not assessed it and cannot.

Mitigating: their changelog is explicit that the faces are applied to the **admin panel only**, and
that the storefront stays on Montserrat and the public site is deliberately untouched. So the exposure
is an authenticated internal tool, not a public site.

### 4.2 No tests accompany the change

**Zero test files** in the diff. The storefront has no test suite at all — no `test/` directory under
`platform/server/storefront/` — so this is consistent with the repository rather than an omission by
the author. But it means the pagination rewrite, the modal rebuild and the brand-filter change are
covered by nothing.

The one change with automated exposure is `platform/server/api/src/routes/catalog.js`, and the only
test that references that file is `module-wiring.test.js`, which checks its imports rather than its
behaviour. **`productMatchesBrand` has no direct test coverage.**

### 4.3 The brand-filter change alters what a customer sees

`productMatchesBrand` inverts the precedence: a product's brand **categories** now decide the chip
match, and the Zoho `brand` column is consulted only when the product has no public brand category at
all. Their stated reason is a real data defect ("a Charlett frame labelled Laura Ferre").

This is a behaviour change on an authenticated, revenue-carrying route. It is very likely correct —
but it is decided by catalogue data nobody has inspected in this run, and its blast radius is "which
products appear under which brand for every customer". **It deserves a look at real data before it
ships**, which is exactly the kind of check this run is barred from doing.

Boundary check performed: this route is the **authenticated portal catalogue** (`r.use(requireAuth())`),
not the unauthenticated `/public/*` API. The public boundary is untouched, so
`08_RISKS_AND_OPEN_DECISIONS.md` R-06 is unaffected.

### 4.4 Social links now point at real, live profiles

Instagram, Facebook and LinkedIn links to `veyora.vision` profiles are added to the storefront footer.
Worth one person confirming those three accounts are the right ones and are live; a wrong or dormant
brand profile linked from the storefront is a small, visible embarrassment. They are storefront-only
and do not appear on the public Astro site.

### 4.5 Release-verification gates

Checked against the merged content, statically:

| Gate | Effect |
|---|---|
| `secret-and-host-scan` | **No effect.** Their added lines introduce no production hostname in any scanned path. The three pinned R-01 exceptions in `catalog.js` are untouched by their diff, so the pins stay valid rather than going stale. |
| `merge-markers`, `diff-check` | No effect. |
| `deploy-payload` | No effect — the payload globs already cover `storefront` and the admin `assets/`. The two fonts add ~98 KB. |
| `accessibility-responsive`, `json-ld`, `forbidden-data*`, `web-suite`, `astro-build` | **No effect** — nothing under `platform/server/web/` changes. |
| `api-suite` | `catalog.js` changes; **must be re-run**. |
| `admin-frontend-suite` | `index.html` and `css/styles.css` change; `admin-shell.test.js` asserts the exact script list in `index.html`. **Must be re-run.** |

### 4.6 A pre-existing admin-panel accessibility issue, noticed here

`index.html` carries `maximum-scale=1.0` in its viewport meta, which disables pinch-zoom (WCAG 1.4.4).
It predates both branches and neither changes it. Phase 4's audit covers the **public site only**, so
this was never in its scope — recording it because it surfaced while reading the overlap. It is a
one-attribute fix in the admin panel.

---

## 5. Recommended integration procedure

**Supervised, and not part of this run.** The brief asks for preparation rather than a merge, and this
is the reason beyond that instruction: §4.1 is a legal question, §4.3 needs real catalogue data, and
§4.4 needs someone who knows which social accounts are real. None is decidable from here.

```
# 1. Confirm the starting point
git checkout mathew/public-website-rebuild
git fetch origin
git log --oneline -1                  # expect the Phase 6 checkpoint

# 2. Merge (expected clean — verified with merge-tree)
git merge origin/feat/storefront-catalog-ux-and-homepage

# 3. Fix the cache-buster inconsistency (§3): bump every js/*.js?v=7 to ?v=8
#    in index.html so the stylesheet and the scripts move together.

# 4. Re-run every gate
node scripts/verify-release.mjs

# 5. Eyeball the admin panel in the new typography, including the new
#    Enquiries screen, which has never been rendered in it.

# 6. Do NOT merge fix/storefront-catalog-thumb-selection — see §1.
```

Before step 2, someone should have answered: **is the font licence in order?** If not, the merge can
still proceed with the two `@font-face` declarations and the font files removed — they are isolated in
`css/styles.css` and `assets/fonts/`, and reverting to the previous `--font` value is a two-line
change.

---

## 6. What was deliberately not done

- **No merge, no rebase, no cherry-pick, no push.** The working tree and `HEAD` are exactly where
  Phase 4 left them; `git merge-tree` writes an object into the database but changes no ref.
- **No branch checkout.** Every fact here comes from `git log`, `git diff`, `git show`, `git ls-tree`
  and `git merge-base` against fetched refs.
- **The other developer was not contacted**, and nothing here should be taken as speaking for them.
  Where their intent is quoted it is quoted from `docs/storefront-ux-changelog.md` on their branch.
- **`git fetch` was used** — read-only, no push, no ref on the remote altered. It is the only way to
  identify a branch by content rather than by guessing at a name, which is what the brief asks for.
- **No judgement of their code quality.** This report is about integration risk. The change is
  well-described, tightly scoped to the storefront and admin panel, and deliberately avoids the public
  site.

---

## 7. Summary for the release decision

| Question | Answer |
|---|---|
| Which branch? | `feat/storefront-catalog-ux-and-homepage` (0x1p0, 2026-08-06) |
| Is the older `fix/…-thumb-selection` branch needed? | **No** — superseded, and its content is already in the newer branch |
| Does it merge cleanly? | **Yes**, verified with `merge-tree --write-tree` — no conflicts |
| Does it touch the public website? | **No** — nothing under `platform/server/web/` |
| Does it touch the public API boundary? | **No** — the changed route is authenticated-only |
| Does it break a release gate? | Not statically; `api-suite` and `admin-frontend-suite` must be re-run |
| Can it be merged unattended? | **No** — font licensing, a catalogue-data behaviour change, and live social links each need a person |
| Biggest surprise | The repository has **two unrelated histories**; this branch shares no ancestor with `main` |
