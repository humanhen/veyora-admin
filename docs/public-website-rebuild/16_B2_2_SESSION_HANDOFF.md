# 16 — B2.2 Session Handoff

> ## ✅ HANDOFF COMPLETED — 2026-08-05
>
> **This handoff has been picked up and closed out. No action remains from this document.**
>
> A resuming session verified the working tree against §2/§3 below and found it matched exactly
> (branch `mathew/public-website-rebuild`, HEAD `343421e`, the same eleven files, `git diff --check`
> clean, every file syntactically complete with no merge markers, TODO or FIXME), then completed the
> outstanding work:
>
> - **Task 11 formally closed** — full API suite re-run: **634/634 passing**, matching this
>   document's baseline exactly with zero regressions. Grep sweep re-performed and recorded.
>   Runtime verification added beyond the original scan: the `sort` allowlist provably rejects
>   `__proto__`/`constructor`/`toString`/`hasOwnProperty` and injection payloads with a 400 before
>   any query runs; the router registers zero non-GET methods and zero middleware layers; the public
>   boundary contains no mutating SQL.
> - **Task 12 completed** — dated B2.2 sections appended to `04_TARGET_ARCHITECTURE.md` (§13),
>   `07_IMPLEMENTATION_PLAN.md` (§11) and `09_FIRST_BUILD_PACKAGE.md` (§13); a dated implementation
>   update added to R-06 in `08_RISKS_AND_OPEN_DECISIONS.md` (original entry preserved, score
>   deliberately left unchanged — see that entry for why the risk is reduced but not closed).
> - **Nothing was reimplemented.** No source file was rewritten; the only correction needed during
>   review was none — the implementation was found sound as handed off.
>
> The `§8. Next exact implementation step` list below is therefore **historical** — every item in it
> is now done. Everything below this box is the original mid-batch handoff, retained unchanged as
> history.

---

Written mid-batch in response to a usage-limit safety checkpoint. **No file is left syntactically
incomplete or mid-edit** — every file listed below was finished, syntax-checked, and its tests were
passing at the moment this document was written. What remains is documentation only (Task 12),
plus the final formal validation printout (the tail of Task 11).

---

## 1. Starting state

Branch `mathew/public-website-rebuild`, HEAD `343421e` ("Add public content schema and governance" —
completed B2.1), working tree clean at the start of this session (confirmed via `git branch
--show-current`, `git rev-parse --short HEAD`, `git status --short`, `git diff --check`).

## 2. Files created

```
platform/server/api/src/public-forbidden-keys.js   central forbidden-key list + recursive scanner
platform/server/api/src/public-serialize.js         pure allowlist serializer layer (8 serializers)
platform/server/api/src/public-cache.js             ~60s in-process read cache
platform/server/api/src/routes/public.js            the /public router — 7 GET endpoints
platform/server/api/test/public-serialize.test.js    15 tests
platform/server/api/test/public-forbidden-keys.test.js  9 tests
platform/server/api/test/public-cache.test.js        9 tests
platform/server/api/test/public-router.test.js       35 tests
docs/public-website-rebuild/15_B2_PUBLIC_API_CONTRACT.md   full endpoint/contract documentation
```

## 3. Files modified

```
platform/server/api/src/index.js   added the publicRoutes import + app.use('/public', publicRoutes),
                                    mounted before the terminal 404 handler, after /admin
```

No other file touched. Confirmed via `git status --short` (above) and `git diff --check` (clean, no
whitespace errors).

---

## 4. Completed work (B2.2 Tasks 1–10, fully done and tested)

- **Task 1–2**: starting state verified; existing API conventions inspected (`index.js`, `db.js`,
  `catalog.js`'s guest-suppression and TTL-cache pattern, `authmw.js`, and — critically —
  `test/stock-guard.test.js`'s `fakeClient()` / `src/inventory.js`'s `reserveTakes(client, ...)`
  dependency-injection convention, which every new handler function follows).
- **Task 3 — serializer**: `public-serialize.js` exports `serializeMedia`, `serializeVariation`,
  `serializeModelCard`, `serializeModelDetail`, `serializeBrandSummary`, `serializeBrandDetail`,
  `serializeLocation`, `serializeSitemapRecord`. Every one builds a fresh object literal; jsonb
  columns (`best_for`, `component_origins`) are picked apart into validated string arrays, never
  passed through; `attributes` (existing catch-all jsonb) is never attached wholesale — only a
  validated `lensType` is extracted.
- **Task 4 — forbidden-key authority**: `public-forbidden-keys.js` — `FORBIDDEN_KEYS` (normalised,
  exact-match, never substring), `scanForForbiddenKeys()` (recursive, reports exact paths),
  `isForbiddenLabelValue()` for `label:*` tag values. Deliberately exact-match to avoid the
  "discontinued"/"sortOrder" false-positive trap named in the brief.
- **Task 5 — router**: all 7 endpoints implemented (`GET /public/brands`, `/brands/:slug`,
  `/models`, `/models/:brand/:slug`, `/facets`, `/locations`, `/sitemap-data`). No auth middleware,
  no write methods.
- **Task 6 — SQL boundary**: every query lists explicit columns (no `select *`, no `p.*`),
  parameterised, explicit `publication_state = 'published'` / `is_published = true` filters;
  `is_active` is referenced nowhere in the new router.
- **Task 7 — cache**: `public-cache.js`, ~60s TTL, key = endpoint + sorted query params (no
  identity), bounded to 500 entries with oldest-eviction, `invalidatePublicCache()` exported but
  **not wired to anything** (correctly deferred — see §7).
- **Task 8 — errors**: `PublicApiError` (400 for malformed page/sort/filter, 404 for
  unknown/unpublished entity), consistent JSON shape, no SQL detail leaked.
- **Task 9 — tests**: 68 new tests across 4 files (15 + 9 + 9 + 35), all passing. Full suite run
  immediately before the checkpoint arrived: **634/634 passing** (566 pre-existing + 68 new — zero
  regressions).
- **Task 10 — contract doc**: `15_B2_PUBLIC_API_CONTRACT.md` — endpoints, query params, response
  shapes, publication rules, caching, errors, forbidden data, example fixtures, explicitly-omitted
  fields (§6), known limitations (§7), the deferred invalidation hook (§8).

## 5. Partially completed work (Task 11)

Done: full test suite run (634/634 green); diff scanned by hand for `SELECT *`, unrestricted row
spreading, forbidden-table access, accidental write routes, production hostnames, and secrets — all
clean (see the grep output captured just before this checkpoint arrived, reproduced in §6 below).
`git status --short` and `git diff --check` re-confirmed clean/complete when this document was
written.

Not yet done: the formal `git diff --stat` capture for the final response (trivial — printed at the
end of this document), and the final free-space delta report (starting figure was not captured at
the very start of this session — see §9's note).

## 6. Diff-inspection results (already performed, recorded here so it isn't repeated)

```
SELECT * / table-star:        none found
unrestricted row spreading:   none found
forbidden table access:       none found
accidental write routes:      none found
production hostnames:         none found
secrets:                      none found
```

## 7. Decisions made worth preserving

- **DI pattern**: every handler's core logic is an exported `async function(db, ...)` where `db` has
  a `.query(sql, params)` method — the real `pool` in production, a fake recording object in tests.
  Matches `reserveTakes(client, ...)` exactly; do not switch to module-mocking in later work.
- **`audience`/`material` query params**: accepted and validated (so a malformed value still 400s)
  but currently a documented no-op — no backing column exists in the B2.1 schema. Do not silently
  drop them or error on them; a later batch adds the column and the filtering.
- **`locations.address`/`.contact`/`.coordinates`**: omitted entirely, not partially masked — no
  per-field publication marker exists yet to justify exposing any part of them.
- **Single-record endpoints are not cached** (`/brands/:slug`, `/models/:brand/:slug`) — a
  deliberate B2.2 simplification, not an oversight; documented as a known limitation, trivial to add
  later with the same `buildCacheKey`/`getCached`/`setCached` mechanism.
- **A real bug was caught and fixed during test-writing**: `serializeModelCard`'s `categories`
  filter originally only checked `typeof === 'string'`, not `label:*` prefix — fixed before this
  document was written; the fix is already in `public-serialize.js` and covered by
  `public-serialize.test.js`'s "internal label:* tags never appear" test.
- **Three self-referential test false positives were found and fixed**: source-scanning tests in
  `public-router.test.js` were matching their own explanatory comments (e.g. a comment saying "never
  SELECT *" contains the literal string "select *"). Fixed by stripping comments before scanning
  (`stripComments()`), mirroring the existing `codeOf()` helper convention already used in
  `test/admin-orders.test.js`. If writing further source-scanning tests, strip comments first.
- **`invalidatePublicCache()` is intentionally unwired** — exported and unit-tested in isolation,
  not called from any admin or Zoho module. This is correct per the brief ("no current modification
  of admin or Zoho modules in this run"), not a gap to close accidentally in a rush.

## 8. Next exact implementation step

1. Append a dated **B2.2 implementation-result** section to `04_TARGET_ARCHITECTURE.md` (mirror the
   B2.1 §12 pattern already in that file: scope executed, what was implemented, confirmed
   untouched).
2. Append the matching section to `07_IMPLEMENTATION_PLAN.md` (mirror B2.1's §10 pattern — which
   WP-06/WP-07 items this closes, what's still open).
3. Append the matching section to `09_FIRST_BUILD_PACKAGE.md` (mirror B2.1's §12 pattern — files
   created/modified, endpoints, serializer rules, forbidden-key mechanism, cache behaviour, test
   results, known limitations, B2.3/B2.4 deferrals, final free space).
4. Evaluate `08_RISKS_AND_OPEN_DECISIONS.md`: as with B2.1, likely **no update needed** — check
   whether R-06 ("public data leak through a future code change") should note that its mitigation
   (allowlist serializer + forbidden-key test) is now implemented, not just planned. If so, update
   R-06's status; do not touch anything else in that file.
5. Re-run `git diff --check`, `git diff --stat`, `git status --short` for the final formal record;
   report final C: free space.
6. Produce the FINAL RESPONSE printout (the 15-item list the B2.2 brief specifies) and stop — do not
   begin B2.3.

## 9. Free space

Checked at this handoff point: **7.831 GB** free on C:. Note: the starting free-space figure was not
explicitly captured at the very start of this B2.2 session (an oversight — Task 1's git checks were
run, but the free-space record was not); B2.1 ended at 7.859 GB, which is the best available
"starting" reference point for this session. Never approached the 4 GB floor at any point. No new
dependency was installed.

## 10. Confirmation: no production system was accessed

No database connection was made at any point — every test uses either an injected fake `db` object
or a monkey-patched `pool.query` (restored after each test via `t.after()`); the real `pool` from
`src/db.js` never actually queries a live PostgreSQL instance in any test. No VPS, production host,
or DNS was contacted. No migration was applied. No commit was made, and nothing was pushed.
