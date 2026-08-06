# 33 — Git History and Release-Line Diagnosis

Resolution of **DEP-009**, the audit's P0 finding that `mathew/public-website-rebuild` and `main`
share no Git ancestor.

**Diagnostic only.** No merge, rebase, cherry-pick, reset, amend, force-push or push occurred. No
application file was changed. No production system, VPS or database was contacted. One read-only
`git fetch --unshallow` was performed; it added objects and moved no reference.

---

## 1. Executive conclusion

> **DEP-009 was a false finding, and the cause was a shallow clone. The histories are not unrelated.
> `main` is a direct ancestor of `mathew/public-website-rebuild`. Integration is a fast-forward.
> `--allow-unrelated-histories` must never be used on this repository.**

The local clone had been made with `--depth`, truncating history at commit `2c749ec` and recording
that commit in `.git/shallow`. Git honours that file by presenting the grafted commit as if it had no
parents. Every ancestry query therefore returned the truth *about the local clone* — and the wrong
answer about the repository.

The decisive evidence was available without fetching anything: **the commit object for `2c749ec`
records a parent.**

```
$ git cat-file -p 2c749ec
tree   feb48f03ba861516f43ce7af20bcf9e981a8fe2f
parent 8637f49df2a41fe4452f8cb86e55ad3c72e7a8d7      ← the tip of mathew/monday-release
author mathewmljourney93 … 2026-08-04
        Document public website rebuild architecture and traceability
```

A genuine root commit has no `parent` line at all. This one names `8637f49`, which is exactly the tip
of `mathew/monday-release`.

After a read-only unshallow fetch, the repository has **exactly one root commit**, every branch
descends from it, and every merge-base resolves.

**This corrects a finding I recorded in
[30_STOREFRONT_FIX_INTEGRATION.md](30_STOREFRONT_FIX_INTEGRATION.md) §1 and escalated to P0 as
DEP-009 in [32](32_PRODUCTION_STANDARD_FUNCTIONAL_AUDIT.md). The diagnosis was wrong.** The
observation ("`git merge-base` returns nothing") was accurate; the conclusion drawn from it was not.
The lesson is recorded in §9.

---

## 2. Repository and remote state

| | |
|---|---|
| Branch | `mathew/public-website-rebuild` |
| HEAD at start | `b219e1d` — *Document production-standard functional audit* |
| Working tree | clean; `git diff --check` clean |
| Remote | `origin` → `https://github.com/humanhen/veyora-admin.git` (single remote) |
| Local branches | 1 (`mathew/public-website-rebuild`) |
| Remote-tracking branches | 9 |

The three audit files from the previous run (`32`, `32A`, `32B`) are **committed** at `b219e1d`, so
the starting stop-condition did not apply.

### Branches

| Branch | Tip | Date | Author |
|---|---|---|---|
| `main` | `b5533f1` | 2026-07-27 | BuildMindX |
| `mathew/monday-release` | `8637f49` | 2026-08-04 | mathewmljourney93 |
| `mathew/mobile-app-design` | `8637f49` | 2026-08-04 | mathewmljourney93 |
| **`mathew/public-website-rebuild`** | **`b219e1d`** | **2026-08-06** | **mathewmljourney93** |
| `feat/storefront-catalog-ux-and-homepage` | `4a5d049` | 2026-08-06 | 0x1p0 |
| `fix/storefront-catalog-thumb-selection` | `b160ded` | 2026-08-04 | 0x1p0 |
| `feat/ai-build` | `8f9e994` | 2026-07-26 | SetuG |
| `fix/stubs-and-spareparts` | `0c35898` | 2026-07-22 | BuildMindX |
| `claude/veyora-testflight-setup-82zsdj` | `1675a6f` | 2026-08-04 | Claude |

`mathew/mobile-app-design` and `mathew/monday-release` point at the **same commit**. One is a marker
for the other; neither carries work the other lacks.

---

## 3. Shallow / full-history result

| Check | Before | After |
|---|---|---|
| `git rev-parse --is-shallow-repository` | **`true`** | `false` |
| `.git/shallow` | one entry: `2c749ec` | file removed |
| `size-pack` | 8.01 MiB | 8.54 MiB |
| Free space | 8.2 GB | 8.2 GB |

**The repository was shallow, with a single graft point.**

### Why a fetch was performed, and why it was safe

The brief permits an unshallow fetch when the repository is confirmed shallow *and* the missing
history is necessary. Both held: the diagnosis required merge-base results between three branch
pairs, and those cannot resolve below a graft line.

Storage was estimated first: `.git` was 13 MB total with an 8 MB pack, over a one-month project
history, so the full history could not plausibly approach the 6 GB floor. **It grew by 0.53 MB.**

A fetch only adds objects to the object database. It cannot merge, rebase or reset, and it does not
touch the working tree. Reference SHAs were captured before and after and compared:

```
$ diff refs-before.txt refs-after.txt
(identical — no reference moved)
```

---

## 4. Root commits

**One root commit exists in the entire repository:**

```
093db1a  2026-07-07  humanhen  "Veyora Admin — full admin panel per the operator guide"
```

Every relevant branch resolves to it:

| Branch | `git rev-list --max-parents=0` |
|---|---|
| `main` | `093db1a` |
| `mathew/monday-release` | `093db1a` |
| `mathew/public-website-rebuild` | `093db1a` |
| `feat/storefront-catalog-ux-and-homepage` | `093db1a` |
| `fix/storefront-catalog-thumb-selection` | `093db1a` |

Before the fetch, this command reported **two** roots — `093db1a` and `2c749ec`. The second was the
graft, not a root.

---

## 5. Merge-base results

| Pair | Before (shallow) | **After (full history)** |
|---|---|---|
| `main` ↔ `mathew/monday-release` | `b5533f1` | `b5533f1` *(main's own tip)* |
| **`main` ↔ `mathew/public-website-rebuild`** | **NONE** | **`b5533f1`** *(main's own tip)* |
| **`mathew/monday-release` ↔ `mathew/public-website-rebuild`** | **NONE** | **`8637f49`** *(monday-release's own tip)* |
| `main` ↔ `feat/storefront-catalog-ux-and-homepage` | NONE | `b5533f1` |
| `mathew/public-website-rebuild` ↔ `feat/storefront-catalog-ux-and-homepage` | `2c749ec` | `2c749ec` |
| **`mathew/public-website-rebuild` ↔ `fix/storefront-catalog-thumb-selection`** | **NONE** | **`8637f49`** |

### Ancestry direction — the finding that decides the integration

```
$ git merge-base --is-ancestor origin/main origin/mathew/public-website-rebuild        → true
$ git merge-base --is-ancestor origin/mathew/monday-release origin/…-rebuild           → true
```

**`main` and `mathew/monday-release` are both direct ancestors.** The merge-base with each is that
branch's own tip, which is the definition of a fast-forward.

### Ahead / behind

| Branch | Behind the release branch | Ahead of it |
|---|---:|---:|
| `main` | **0** | 35 |
| `mathew/monday-release` | **0** | 26 |
| `mathew/mobile-app-design` | **0** | 26 |
| `feat/ai-build` | **0** | 39 |
| `fix/stubs-and-spareparts` | **0** | 45 |
| `fix/storefront-catalog-thumb-selection` | 1 | 26 |
| `feat/storefront-catalog-ux-and-homepage` | 2 | 25 |
| `claude/veyora-testflight-setup-82zsdj` | 4 | 35 |

Five branches are **entirely contained** in `mathew/public-website-rebuild`. It is a strict superset
of the trunk.

---

## 6. Branch lineage

```
093db1a  2026-07-07  humanhen — the only root
    │
    │   (48 commits: Humanhen, BuildMindX, SetuG — feat/ai-build and
    │    fix/stubs-and-spareparts are already merged in here)
    ▼
b5533f1  2026-07-27  main
    │
    │   9 commits, mathewmljourney93 — ordering, backorders, admin
    │   currency, credential migration, editorial homepage
    ▼
8637f49  2026-08-04  mathew/monday-release  ( = mathew/mobile-app-design )
    │                                              │
    │                                              └── b160ded  fix/storefront-catalog-thumb-selection (0x1p0)
    ▼
2c749ec  2026-08-04  ◄── THE SHALLOW GRAFT POINT (locally looked like a root)
    │
    │   25 commits, mathewmljourney93 — the public website rebuild
    │                                              │
    │                                              └── f1735e4 → 4a5d049  feat/storefront-catalog-ux-and-homepage (0x1p0)
    ▼
b219e1d  2026-08-06  mathew/public-website-rebuild  ◄── HEAD
```

The chain from `8637f49` to `b219e1d` is **entirely linear** — no merges, no branching.

Authorship on the release line since `main`: **35 commits, all `mathewmljourney93`.**

---

## 7. Production release-line evidence

### Deployment is not branch-based

`platform/server/deploy.sh` contains **no reference to any branch** — no `git checkout`, no
`git pull`, no branch name. It tars the **local working tree** and ships it over SSH:

```sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
… tar czf - docker-compose.yml Caddyfile … | ssh $HOST "tar xzf - -C $DEST"
```

**The deployment source is whatever the operator has checked out when they run the script.** There is
no branch-to-environment binding anywhere in the repository, and no CI to create one. This is itself
a release-integrity finding and is recorded as a recommendation in §11.

### Ownership conclusions

| Role | Branch | Evidence |
|---|---|---|
| **Historical trunk** | `main` | The only branch other contributors merged into; carries `feat/ai-build` and `fix/stubs-and-spareparts`; last touched 2026-07-27 by a different author (E1) |
| **Previous intended release** | `mathew/monday-release` | Name states intent; 9 commits of ordering/backorder/admin hardening on top of `main`; 2026-08-04 (E1 + E3 on the name) |
| **Public website rebuild** | `mathew/public-website-rebuild` | 25 commits of documented rebuild work; 32 numbered design documents (E1) |
| **Current de-facto release line** | **`mathew/public-website-rebuild`** | Most recent; strict linear superset of `main` and `monday-release`; contains all five fully-merged branches; the only branch with the release gate, deployment architecture and RC handoff (E1) |
| **Other developer's latest** | `feat/storefront-catalog-ux-and-homepage` | Branched from `2c749ec` — **on the rebuild line, by choice**; its own committed changelog states `Base: mathew/public-website-rebuild` (E1) |
| **Intended final release line** | **`mathew/public-website-rebuild`**, after merging the storefront branch | Follows from the above; requires owner confirmation (§12) |

Ownership was **not** inferred from names alone. `mathew/mobile-app-design` is the clearest case
against doing so: its name suggests separate mobile work, and it is byte-identical to
`mathew/monday-release`.

---

## 8. Other-developer branch relationship

Developer `0x1p0` has two branches, and they sit on **different bases**:

| Branch | Base | Merge-base with the release branch | Status |
|---|---|---|---|
| `fix/storefront-catalog-thumb-selection` | `8637f49` (monday-release tip) | `8637f49` | **Superseded** |
| `feat/storefront-catalog-ux-and-homepage` | `2c749ec` (rebuild line) | `2c749ec` | **The one to integrate** |

The older branch is not "unrelated" either — that was the same shallow artefact. It is simply **one
commit behind on an older base**, and its fix is already present in the newer branch (the distinctive
`setMainPhoto` / `thumb-swapping` construction was re-applied there). Verified in
[30](30_STOREFRONT_FIX_INTEGRATION.md) §1.

`feat/storefront-catalog-ux-and-homepage` is 2 ahead / 25 behind, merges cleanly
(`git merge-tree --write-tree`, no conflicts), and touches only two files also touched by this branch
(`index.html`, `css/styles.css`). **Nothing under `platform/server/web/` changes.**

**Correction to [30](30_STOREFRONT_FIX_INTEGRATION.md):** that document said merging
`fix/storefront-catalog-thumb-selection` would require an unrelated-histories merge. It would not —
it is an ordinary merge of an older branch. The recommendation *not* to merge it stands, but for the
correct reason: **it is superseded**, not because it is unrelated.

---

## 9. Explanation of the unrelated-history finding

### Mechanism

A shallow clone (`git clone --depth=N`) downloads only the most recent commits. Git records the
truncation boundary in `.git/shallow`. For any commit listed there, git **pretends it has no
parents** — so:

- `git rev-list --max-parents=0` reports it as a root commit;
- `git merge-base` cannot see past it and reports no common ancestor;
- `git log` stops there.

Every one of those outputs is correct about the clone and misleading about the repository.

### Ruling out the alternatives

| Candidate cause | Verdict | Evidence |
|---|---|---|
| **Shallow or partial clone** | **CONFIRMED** | `.git/shallow` contained exactly `2c749ec`; `--is-shallow-repository` was `true` |
| Remote branch visibility | Ruled out | All 9 remote branches were already fetched and visible |
| Repository recreation / history replacement | Ruled out | One root commit for the whole repository; no duplicated trees under different ancestry |
| Imported codebase | Ruled out | `2c749ec` is an ordinary commit with a parent and a normal message |
| **Orphan branch** | **Ruled out** | An orphan root has no `parent` line; `2c749ec` names `8637f49` |
| Force-pushed history | Ruled out | Chronology is monotonic; no reflog evidence of rewriting; every branch reaches the single root |
| Separate repositories later combined | Ruled out | One remote, one root |

### The lesson, recorded plainly

**I drew a structural conclusion from a query whose scope I had not checked.** `git merge-base`
returning nothing has two possible meanings — genuinely unrelated histories, or history that is not
present locally — and I reported the first without testing for the second. The one-line test that
would have caught it immediately is:

```sh
git rev-parse --is-shallow-repository
```

and the confirming test is `git cat-file -p <supposed-root>`: a real root has no `parent` line.

The consequence was a P0 finding that did not exist, in a document intended to guide a release
decision.

---

## 10. Safe integration options

| | Option | Safety | Risk | History preserved | Conflict likelihood | Suitability | Human approval |
|---|---|---|---|---|---|---|---|
| **A** | **Normal merge / fast-forward** into `main` | **High** | **Low** | **Full** | **None** — `main` is an ancestor | **Recommended** | Yes — to authorise the release |
| B | Merge after full history retrieval | — | — | — | — | **Already done.** History is now complete; A is available | — |
| C | Cherry-pick selected commits | Medium | Medium — rewrites SHAs, splits the audit trail | Partial | Medium | Unnecessary; nothing needs selecting | Yes |
| D | Patch or file-level transfer | Low | High — loses all authorship and history | **None** | High | **Reject.** Only justified for genuinely unrelated repositories | Yes |
| E | Repository-history replacement | **Very low** | **Severe** — destroys shared history, breaks every clone | None | — | **Reject outright.** Was only ever on the table because of the false finding | — |
| F | Keep release lines separate | High | Medium — permanent divergence, duplicated fixes | Full | Grows over time | Not warranted; the lines are already linear | Yes |
| G | New canonical integration branch | High | Low | Full | None | Optional belt-and-braces: cut `release/2026-08` from the release branch tip and merge there first | Yes |
| H | No integration until an owner confirms lineage | **Highest** | Only delay | Full | — | **The current state.** Lineage is now proven; what remains is authorisation, not investigation | **Yes** |

---

## 11. Recommended integration path

**Option A — a normal merge, which will resolve as a fast-forward.** No special flags, no history
surgery.

Recommended order, none of it executed here:

1. **Merge the other developer's storefront work into the release branch first**, while it is a
   simple two-commit merge:
   `git merge origin/feat/storefront-catalog-ux-and-homepage`
   Verified clean. Then fix the `?v=7` / `?v=8` cache-buster inconsistency and re-run the API and
   admin suites ([30](30_STOREFRONT_FIX_INTEGRATION.md) §5). **Gated on the font-licence question.**
2. **Run the release gate:** `node scripts/verify-release.mjs` — all 16 must pass.
3. **Fast-forward `main`:** `git checkout main && git merge --ff-only mathew/public-website-rebuild`.
   `--ff-only` is the safety: if it is not a fast-forward, something has changed since this diagnosis
   and the merge stops rather than inventing a merge commit.
4. **Do not merge `fix/storefront-catalog-thumb-selection`** — superseded (§8).
5. **Decide what happens to `mathew/monday-release` and `mathew/mobile-app-design`.** Both are fully
   contained in the release branch and both are safe to leave, or to fast-forward to the same tip so
   nobody deploys a stale working tree from them.
6. **Address the branch-to-environment gap (§7).** `deploy.sh` ships whatever is checked out, so
   until deployment is bound to a branch, "which branch is production" is a matter of operator
   discipline rather than configuration.

### What must never be used on this repository

Recorded because the false finding pointed directly at them:

```
git merge --allow-unrelated-histories     ← never. There is one root; the flag would mask a real error
git rebase                                 ← unnecessary; the line is already linear
git reset --hard                           ← no history needs discarding
git push --force / --force-with-lease      ← nothing needs rewriting
git filter-branch / filter-repo            ← option E, rejected
git clone --depth / git fetch --depth      ← the original cause. Clone this repository in full
```

---

## 12. The exact human decision still required

Lineage is settled; **authorisation is not.** Three decisions remain, and none is technical:

1. **Confirm `mathew/public-website-rebuild` is the intended release line.** Evidence in §7 is
   strong but circumstantial — it rests on chronology, containment and content, because no
   branch-to-environment binding exists. **The repository cannot answer this; an owner must.**
2. **Authorise the fast-forward of `main`.** This makes 35 commits — including the entire public
   website — the trunk. That is a release decision, not a git operation.
3. **The font licence gating the storefront merge** ([30](30_STOREFRONT_FIX_INTEGRATION.md) §4.1,
   audit D-01). Unchanged by this diagnosis.

**DEP-009 is downgraded from P0 "architecture-critical, no safe default" to P2 "confirm the release
line and authorise a fast-forward."**

---

## 13. Next supervised step

Ask the branch owner to confirm §12.1 and §12.2. On confirmation, the integration is steps 1–3 of
§11, each with the release gate run between them — perhaps thirty minutes of supervised work, with
`--ff-only` as the guard.

Nothing about this repository's history now requires investigation. What is left is a decision.

---

## 15. Release preflight — added 2026-08-06

§11's recommendation and §13's "must not be used" list are now partly enforced by a `release-branch`
gate in `scripts/verify-release.mjs`.

It **refuses a detached HEAD** outright — there is nothing nameable in a release record. It **refuses
a non-approved branch** unless `VEYORA_RELEASE_BRANCH_OVERRIDE` names it explicitly, so a supervised
release from elsewhere stays possible but deliberate. It **reports uncommitted changes**, because
`deploy.sh` packages the working tree and would ship them.

**It claims no environment binding that does not exist.** §7's finding stands: there is no
branch-to-environment binding anywhere in this repository. The gate makes the operator discipline
visible; it does not pretend the discipline is enforced.

It never merges, pushes or deploys, and it cannot: a test asserts the only commands the verification
script spawns are `node` and `git`.

**§12's human decisions are unchanged.** Confirming the release line and authorising the fast-forward
remain a person's call — this gate makes the branch you are on visible at the moment it matters, and
nothing more.
