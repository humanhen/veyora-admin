# 03B — Traceability Changelog

**Phase 0.1 — requirements traceability correction · 2026-08-04**

Records what changed between the Phase 0 draft register and the corrected control document,
and every interpretation decision behind it.

---

## 1. Headline numbers

| Measure | Before (Phase 0) | After (Phase 0.1) |
|---|---:|---:|
| Rows in `03_REQUIREMENTS_TRACEABILITY.csv` | 464 | **501** |
| — source requirements | not distinguished | **421** |
| — source acceptance criteria | not distinguished | **80** |
| — derived engineering controls mixed into the register | present but unlabelled | **0** |
| Rows in `03A_ENGINEERING_CONTROLS.csv` | n/a | **57** |
| Production blockers in the requirements register | **376** | **148** |
| Controls blocking merge | n/a | 47 |
| Controls blocking production | n/a | 32 |
| Rows with an exact source locator | 0 | **501 (100%)** |
| Placeholder classifications using a controlled vocabulary | 0 | **501 (100%)** |

Total items across both files: **558** (501 + 57), against 464 before.

---

## 2. Why the row count went up, not down

The Phase 0 register was criticised for being generated rather than extracted, and the intuition
was that a source-faithful register would be smaller. It is larger, for four specific reasons —
each of which is a correction, not padding:

1. **The route table was one row and is now twelve.** Section 6 lists twelve routes each with its
   own purpose and indexing rule. Phase 0 collapsed them into a single "implement the twelve
   baseline routes" row. Each route is an atomic, independently testable requirement.
2. **The structured-data mapping table was partially collapsed and is now eleven rows.** Section
   19.4 gives a per-template schema rule; each is separately verifiable.
3. **The faceted-indexing table is now one row per URL state** (eight), because the indexing
   disposition differs per state and each needs its own test.
4. **Three sections had no representation at all** — Section 1 Document control (5 rows, new
   `REQ-DOC-*`), Section 27 Appendix A framing statement (1 row, `REQ-WF-001`), Section 28
   standards-recheck instruction (1 row, `REQ-REF-001`).

Offsetting these, several Phase 0 groupings were **merged** where the source genuinely repeats
itself — see §5.

---

## 3. Row disposition accounting

| Disposition | Count | Detail |
|---|---:|---|
| **Retained with the same ID and meaning** | 396 | Source basis confirmed; a source locator, controlled-vocabulary values and a corrected blocker classification were added |
| **Split into finer atoms** | 34 → 96 | Route table (1→12); brand/model route table (1→4); structured-data mapping (partially collapsed →11); faceted indexing (1→8); per-page search packages (11→22, metadata package + schema); Section 24 sequence vs backlog vs definition-of-done separated |
| **Merged as genuine source duplication** | 41 → 12 | Seven identical "Required" brand rows →1; two identical Essedue/Kyme rows →1; Contact form field table (8 rows) →1; Request B2B field table (11 rows) →1; audience table (6) →1; launch-topics table (7) →1; success-metrics table (6) →1; implementation-sequence table (7) →1; metadata matrix (12) →1 cross-reference row |
| **Moved to `03A_ENGINEERING_CONTROLS.csv`** | 57 controls | Extracted from the `proposed_implementation` and `acceptance_or_test_method` columns of Phase 0 rows, plus mechanisms that had no source text at all |
| **Removed as duplicates within the register** | 0 | No Phase 0 row was deleted outright |
| **Newly added from source not previously represented** | 7 | `REQ-DOC-001` … `REQ-DOC-005`, `REQ-WF-001`, `REQ-REF-001` |
| **Source items deliberately not registered** | 2 | See §4 |

**No source requirement was lost.** Every Phase 0 requirement ID either survives in
`03` with the same meaning, or its substance is preserved in `03A` with the old ID recorded in
the control's `notes` field.

### 3.1 Per-namespace delta

| Prefix | Before | After | Δ | Reason |
|---|---:|---:|---:|---|
| DOC | 0 | 5 | +5 | Section 1 was unrepresented |
| EXEC | 8 | 12 | +4 | Source-of-truth hierarchy split into its five list items |
| CSF | 21 | 21 | 0 | Locators added; blockers reclassified |
| OUT | 12 | 14 | +2 | Business goals split per list item |
| IA | 16 | 27 | +11 | Route table and brand route table expanded |
| GC | 25 | 25 | 0 | — |
| HOME | 17 | 18 | +1 | Search package split into metadata + schema |
| WHY | 16 | 17 | +1 | as above |
| BRX | 16 | 17 | +1 | as above |
| BRD | 21 | 22 | +1 | as above |
| COL | 27 | 28 | +1 | as above |
| MOD | 18 | 19 | +1 | as above |
| SVC | 17 | 18 | +1 | as above |
| PL | 16 | 17 | +1 | as above |
| GP | 15 | 16 | +1 | as above |
| FRM | 17 | 18 | +1 | Two search packages split; two form tables merged |
| RES | 11 | 12 | +1 | Section 18 priority statement registered |
| SEO | 43 | 44 | +1 | Illustrative robots.txt registered |
| GEO | 28 | 28 | 0 | — |
| CM | 28 | 28 | 0 | — |
| ANL | 16 | 16 | 0 | — |
| RAP | 20 | 20 | 0 | — |
| IMP | 12 | 12 | 0 | — |
| DOD | 11 | 11 | 0 | — |
| QA | 25 | 25 | 0 | — |
| META | 8 | 9 | +1 | Metadata-matrix note registered separately |
| WF | 0 | 1 | +1 | Appendix A framing statement |
| REF | 0 | 1 | +1 | Standards-recheck instruction |
| **Total** | **464** | **501** | **+37** | |

---

## 4. Source items deliberately not registered

Two, both recorded here rather than silently dropped:

1. **Section 3 "Contents"** — a twelve-item table of contents. It states no requirement; every
   entry resolves to a section that is itself fully registered.
2. **Section 28 reference list (22 items)** — a bibliography of Google, OpenAI, Bing, IndexNow
   and W3C documentation. The *instruction* attached to it ("recheck any standard that changes
   before launch") is registered as `REQ-REF-001`; the individual citations are not requirements.

Additionally, **Section 1 rows "Purpose", "Primary business goal" and "Primary audiences"** were
judged contextual rather than requirement-bearing — the business goal and audience content is
registered from Sections 5.2 and 5.3 where the specification states them as requirements.

---

## 5. Interpretation decisions

Every judgement call that a reviewer might reasonably have made differently.

### 5.1 Atomicity

- **Search packages split in two, not six.** Each page's search-package table has six rows
  (canonical route, title, meta description, H1, primary intent, schema). Canonical/title/
  description/H1/intent are one deliverable produced by one metadata record and verified by one
  test, so they are one row. **Schema is separate** because it is produced by a different builder
  and verified by a different test. Result: 22 rows across 11 pages rather than 66.
- **Form field tables merged to one row each.** Nineteen field rows across two tables describe one
  form definition each, verified by one field-set snapshot test.
- **Brand route table merged from eleven rows to four.** Seven rows are identical ("Required") and
  two are identical ("Recommended separate page"). Merging preserves every named brand in the
  `source_summary` while keeping one row per distinct decision.
- **Section 26 metadata matrix registered as a single cross-reference row.** It restates the
  title and H1 values already carried by the eleven per-page search packages. Registering all
  twelve rows again would create twelve duplicate blockers.

### 5.2 Source locators

DOCX page numbers are **not** derivable from OOXML without rendering the document. `docProps/app.xml`
declares `<Pages>59</Pages>`, but that is a last-save artefact from Word and carries no mapping from
content to page. **No page number appears anywhere in the register.** Instead every row carries a
stable structural locator of the form:

- `Section 12.2; table 'Faceted navigation and indexing'; row '?sort='`
- `Section 19.1; list item 3`
- `Section 4.1; table 'Critical findings'; row 'Legacy 404s' (P0)`

Section numbers are the sequential position of `Heading1`/`Heading2`/`Heading3` paragraphs in
`word/document.xml`; the document itself carries no printed numbering. Table and list indices are
positional within their section. This scheme is reproducible from the extraction script and
survives repagination.

### 5.3 Priority

Where the specification states a priority it is used verbatim: the eight Section 4.1 critical
findings carry their stated P0/P1; the Section 24.1 backlog carries its stated P0/P1/P2; Section 6
marks Resources as P1; Section 18 states the resource layer is P1. Everywhere else priority is
derived: **P0** for anything in a required module order, a definition-of-done item or the launch QA
checklist; **P1** for anything in an "Enhancements" subsection or described as recommended;
**P2** for anything the source marks optional, conditional or deferred.

Final distribution: P0 383 · P1 105 · P2 13.

### 5.4 Production-blocker reclassification — 376 → 148

This is the largest correction. The Phase 0 register marked a row blocking essentially whenever the
specification contained it. The corrected register applies the eleven programme criteria and marks
a row blocking only where its absence causes one of them.

**Removed from blocking (228 rows), by reason:**

| Reason | Approx. rows |
|---|---:|
| Content incompleteness — brand copy, stories, module copy, resource articles (rulings 3, 13) | 74 |
| Optional or unapproved claims that may simply be omitted (ruling 13) | 46 |
| Enhancements and P1/P2 items the source does not require at launch | 31 |
| Duplicate blockers — the same failure mode already carried by another row | 34 |
| CRM, analytics, social and Meta Pixel decisions (rulings 10, 11, 12) | 14 |
| Location functions and geographic wording (rulings 5, 6) | 9 |
| Brand-count, Essedue/Kyme and Extreme Next decisions (rulings 7, 8, 9) | 8 |
| Metadata packages per page, superseded by the site-wide uniqueness requirement | 12 |

**Retained as blocking (148 rows), by criterion:**

| Criterion | Rows | Representative IDs |
|---|---:|---|
| Public exposure of private or commercially sensitive data | 9 | `REQ-OUT-007` `REQ-BRD-022` `REQ-COL-027` `REQ-MOD-009` `REQ-SEO-024` `REQ-CM-016` `REQ-QA-023` |
| False or unapproved material claim that cannot simply be omitted | 17 | `REQ-OUT-002` `REQ-BRD-011` `REQ-BRD-012` `REQ-BRD-019` `REQ-SVC-008/009/010` `REQ-SVC-012` `REQ-CM-025` `REQ-GEO-009` |
| Missing mandatory legal or consent content | 8 | `REQ-GC-010` `REQ-CSF-019` `REQ-FRM-016` `REQ-CM-020` `REQ-CM-023` `REQ-META-006` `REQ-META-007` |
| Broken lead capture or silent data loss | 11 | `REQ-FRM-002/003/004/005/006/008/009` `REQ-PL-009` `REQ-ANL-014` |
| Broken portal continuity, login, password reset or shared links | 3 | `REQ-CSF-021` `REQ-IA-012` `REQ-EXEC-007` |
| Insecure routing or open redirect | 2 | `REQ-GP-009` plus `CTL-004` in the controls register |
| Unavailable core public routes | 22 | `REQ-IA-002` … `REQ-IA-017` `REQ-COL-010/011/012` `REQ-CSF-006` `REQ-CSF-008` |
| Invalid canonical-domain cutover | 7 | `REQ-DOC-005` `REQ-CSF-010` `REQ-SEO-030` `REQ-SEO-004` `REQ-QA-005` |
| Material redirect or indexing damage | 24 | `REQ-CSF-005/011/012/013` `REQ-SEO-001/003/006/008/012/015/016/033` `REQ-COL-014/015` `REQ-CM-027` |
| Accessibility failure preventing use of a core journey | 14 | `REQ-GC-003/017/018/019/022` `REQ-RAP-002/007/009/010/011/013/014` `REQ-FRM-015` |
| Failed release-critical functional test | 31 | all 11 `REQ-DOD-*` plus 15 `REQ-QA-*` plus `REQ-EXEC-008` |

**Blockers by delivery batch:** B0 2 · B1 15 · B2 12 · B3 17 · B4 17 · B5 4 · B6 15 · B7 16 ·
B8 2 · B9 34 · B10 10 · B11 4.

### 5.5 Placeholder policy — replacing the inconsistent Phase 0 Yes/No/Partial

| Policy | Rows | Meaning |
|---|---:|---|
| `NONE` | 237 | No unapproved fact is involved |
| `OMIT_UNTIL_APPROVED` | 168 | The value is omitted entirely until approved; the page remains complete and true without it (ruling 13) |
| `CONFIGURABLE` | 63 | Held as environment or database configuration — domain, portal URL, brand publication, CRM adapter, analytics provider, crawler policy |
| `BLOCKING_APPROVAL` | 21 | Omission is impossible and publication without an approved value would be legally incomplete or false — legal entity name, privacy notice, terms, consent wording, policy records |
| `NEUTRAL_WORDING` | 12 | Presence stated without a claimed function or coverage level (rulings 5, 6) |

The Phase 0 register's headline of **43 blocking placeholders** is superseded. Under the corrected
policy only the 21 `BLOCKING_APPROVAL` rows genuinely prevent production; the remainder resolve
through omission, neutral wording or configuration. `06_CONTENT_AND_PLACEHOLDER_REGISTER.md` has
been updated accordingly.

### 5.6 Current-status vocabulary

`COMPLETE` 14 · `PARTIAL` 48 · `MISSING` 433 · `NOT_APPLICABLE` 3 · `UNVERIFIED` 3.

`UNVERIFIED` is used only where the audit could not measure the current state: the three Core Web
Vitals metrics and the colour-contrast requirement. It is **not** used as a synonym for unknown —
`REQ-RAP-010` is `UNVERIFIED` because no headless browser was available to measure contrast, and
that limitation is recorded rather than guessed.

### 5.7 Separating derived controls from source requirements

Phase 0 mixed engineering safeguards into the `proposed_implementation` and
`acceptance_or_test_method` columns, which made audit-invented mechanisms read as employer-authored
requirements. The rule applied now:

- If the specification states the **outcome**, it stays in `03`.
- If the audit invented the **mechanism**, the mechanism moves to `03A` and `03` keeps a plain
  acceptance statement.

Worked example — `REQ-SEO-004` (staging must not be indexable) is a source requirement. *Basic
authentication plus a host-wide `X-Robots-Tag`* is not in the specification; it is `CTL-006`.
Likewise `REQ-DOD-011` (placeholders removed) is source; the `VEY_PLACEHOLDER::` token format,
registry and build gate are `CTL-008`.

Eight controls originate from the **programme rulings** rather than from the audit
(`CTL-009` … `CTL-016`) and are labelled `PROGRAMME_RULING` so they are never mistaken for
specification text.

Controls carrying forward the substance of Phase 0 rows record the old ID in their `notes` — for
example `CTL-033` preserves the visual-regression tooling that Phase 0 carried as `REQ-EXEC-008`.

### 5.8 Source ambiguities carried into the register

Registered as-is with a note rather than resolved by the audit:

1. **Location conflict.** Section 9.1 names *Italy, New York and Montreal*; Section 16.1 names
   *Germany, New York and Montreal*. Both are registered verbatim (`REQ-WHY-003`, `REQ-GP-002`)
   with cross-references. Neutral wording covers all four locations until resolved.
2. **Brand count.** Section 4.1 reports the wireframe claims eight brands while grouping Essedue
   and Kyme; Section 6.1 lists ten candidate entities; the existing code lists eight with Essedue
   and Kyme already separate. Three counts are in play. Ruling 7 makes the count derived, so no
   register row asserts a number.
3. **Category-landing copy.** `/collections/optical/`, `/collections/sun/` and `/collections/kids/`
   are P0 indexable routes (`REQ-COL-010/011/012`) for which the source supplies no title,
   description or H1. Noted in each row.
4. **Private-label enquiry route.** Section 15.2 requires an intent-specific path
   (`REQ-PL-009`) but never names it. The route name is an engineering decision, recorded in
   `05_ROUTE_TEMPLATE_MATRIX.md`, not in the register.
5. **Illustrative values are not approved values.** Section 14 contains "48-72 hour shipping",
   "six-month exchange" and "two-year warranty". These appear in `REQ-SVC-002` only as a
   description of what the source says; the register explicitly notes they are illustrative. No
   row treats them as approved.
6. **Inherited unverified findings.** Section 4's duplicate-domain and legacy-404 findings are the
   specification's own observations dated 2026-08-03. This audit confirms hash routing and absent
   metadata **from repository source**, but contacted no production system, Search Console or Bing
   property. `REQ-CSF-001` carries the first-party verification obligation.

---

## 6. Validation results

Both files pass all checks defined in Task 7.

| Check | `03` | `03A` |
|---|---|---|
| Exact expected header | PASS | PASS |
| Consistent column count on every row | PASS (15 cols × 501) | PASS (12 cols × 57) |
| UTF-8, no BOM, no non-ASCII bytes | PASS | PASS |
| Unique IDs | PASS (501/501) | PASS (57/57) |
| No blank IDs | PASS | PASS |
| Controlled vocabulary only | PASS (0 violations) | PASS (0 violations) |
| Every row has a non-empty source locator | PASS (501/501) | n/a |
| No orphan `related_requirement_ids` | n/a | PASS (0 orphans, 0 malformed) |
| No derived control remaining in `03` | PASS | n/a |
| No source requirement lost without a migration note | PASS | PASS |

---

## 7. What this changes downstream

- `00_EXECUTIVE_AUDIT.md` — counts and the traceability description corrected; ruling section added.
- `06_CONTENT_AND_PLACEHOLDER_REGISTER.md` — 43 blocking placeholders reduced to 21; policy
  vocabulary aligned; omission-first rule made explicit.
- `07_IMPLEMENTATION_PLAN.md` — gate table restated against the two registers; effort estimate
  **unchanged** (see below); next actions updated.
- `08_RISKS_AND_OPEN_DECISIONS.md` — decision split restated against the rulings; R-04 rescored.
- `09_FIRST_BUILD_PACKAGE.md` — B0/B1 exit criteria restated against the corrected register.

**The 660–820 hour estimate is unchanged.** Reclassifying a blocker changes *when* a requirement
gates the release, not how much work it is. The scope did not move: 37 net new rows are almost
entirely re-atomisation of work already estimated, and the 57 controls were already costed inside
the Phase 0 batches (principally B2, B8 and B9). The corrected classification does change the
*release-readiness* picture materially — 148 blockers against 376 means far fewer items can hold
the cutover hostage, and only 21 of them wait on Veyora content approval.
