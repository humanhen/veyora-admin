# 28 — Release Quality Gates

One command that runs every automated control this release has.

```
node scripts/verify-release.mjs
```

**It contacts nothing.** No production system, no VPS, no database, no DNS, no network host. Every
gate reads local files or runs a local process. It is a check, not a deployment.

---

## 1. Why this exists

Before it, "run the checks" meant knowing that there were three test suites in three directories with
three different invocations, that the production build was a fourth command with its own environment
requirements, that the forbidden-data scan was some of 1,691 assertions inside one of the suites, and
that the catalogue CLIs were never exercised by anything.

That is not a control. It is a set of things a careful person remembers. `08_RISKS_AND_OPEN_DECISIONS.md`
R-06 named the gap precisely — its mitigation asked for a forbidden-key scan "wired as a merge gate",
and every implementation update since has had to record that the scan runs inside `npm test`, which
is not the same thing.

This closes half of that. The command exists, runs everything, and fails non-zero. **Nothing runs it
automatically**, because this repository has no CI at all — see §5.

---

## 2. The gates

| Gate | What it proves |
|---|---|
| `diff-check` | `git diff --check` is clean in the working tree **and** the index. |
| `merge-markers` | No conflict marker survives in any tracked file. |
| `secret-and-host-scan` | No credential-shaped literal and no production hostname in a shipped artefact, beyond a pinned exception list (§4). |
| `api-suite` | The API suite passes. |
| `admin-frontend-suite` | The root admin panel suite passes. |
| `web-suite` | The Astro site suite passes. |
| `deployment-config` | The Compose topology, routing, health gating and rollback assertions pass. |
| `forbidden-data` | No commercial, stock or customer data can reach a public API surface. |
| `forbidden-data-rendered` | No planted secret survives into rendered HTML. |
| `json-ld` | Structured data carries no forbidden key and no commercial fact. |
| `env-validation` | The environment contract accepts a valid environment and rejects five broken ones. |
| `astro-build` | The public site builds for production. |
| `build-output-scan` | The built artefact embeds no production hostname and no credential. |
| `catalogue-chain` | The audit → plan chain runs offline, refuses to run without input, and emits no executable SQL. |
| `deploy-payload` | Every artefact `deploy.sh` ships exists, and the cutover is still opt-in. |

`--list` prints them. Naming gates on the command line runs only those, which is for iterating on one
failure; a release decision needs the full run. `--fail-fast` stops at the first failure — off by
default, because a check that stops at the first problem makes you run it five times to find five
problems.

### Gates that run the same tests twice, deliberately

`deployment-config`, `forbidden-data`, `forbidden-data-rendered` and `json-ld` run files that already
ran inside the suites above them. That is not an oversight. A release conversation asks "did the
forbidden-data scan pass", and a number that only ever appears inside a total of 1,091 cannot answer
it. Running them again by name costs about ten seconds and makes the summary a list of **controls**
rather than a list of suites.

### Gates that are genuinely new

- **`env-validation`** drives the real `validate-env.mjs` as a subprocess across five environments —
  one valid, four broken in specific ways — and asserts the exit code each time. It found a defect
  (§3).
- **`build-output-scan`** asks a question no test against a mock can: did a hostname or a credential
  get *baked into the artefact*? A mock-API test cannot see that, because the value would come from
  the build rather than from the API.
- **`catalogue-chain`** invents a synthetic export, runs the audit and the plan builder over it, and
  asserts that nothing produced is executable SQL and that each CLI refuses to run with no arguments.
  A tool that defaults to "do something" is how a dry-run planner becomes a live one.
- **`deploy-payload`** parses the file list **out of `deploy.sh`** rather than keeping a second copy.
  A second copy drifts, and the drift is invisible until a deploy is missing a file. It also asserts
  Compose still defaults to the live `Caddyfile`, so a change that silently made `Caddyfile.rc` the
  mounted config — arming R-01/R-02 — fails here.

---

## 3. A defect the gates found

`platform/server/web/src/env.ts` accepted a **wildcard hostname**. `new URL('https://*.example.com')`
parses without complaint — `*` is a legal hostname character to the parser — and every check in
`normalizeOrigin` was about protocol, path, query and fragment.

`astro.config.mjs` already refused a wildcard when deriving `security.allowedDomains`. But that guard
runs at **build** time, and `validate-env.mjs`'s own header says it exists so that "a build-only or
startup-only reimplementation" cannot diverge from the one validator. It had diverged. A container
starting from an already-built image with `PUBLIC_SITE_ORIGIN=https://*.something` passed validation,
started, and would have emitted canonical URLs and sitemap entries containing a literal `*` — the
fail-open that module exists to prevent.

Fixed in `normalizeOrigin`, with three tests: wildcards rejected on both origin variables, and an
assertion that the build-time config still refuses one too — so a future relaxation of either side
fails rather than silently reopening the divergence.

---

## 4. The exception list is a pin, not a mute

`secret-and-host-scan` scans the artefacts that are **built and shipped**: the Astro site's source and
config, the Caddyfiles, `docker-compose.yml`, `.env.example`, the API's source and the admin panel.
A production hostname in one of those is a release defect. The same string in a document is
documentation, so documents are out of scope — scoping the scan is what makes it enforceable rather
than permanently red.

Eleven occurrences exist today. Each is declared in the script with a written reason, **printed on
every run**, and:

- anything **not** on the list fails the gate, so the set can only grow deliberately;
- an entry that **no longer matches** also fails the gate, so a fixed exception cannot linger and
  hold a hole open for whatever lands at that path next;
- an exception names one exact file and one exact pattern — no directory prefixes, no catch-alls.

> **Superseded 2026-08-06 — see §9.** The three `R-01` entries below have been **deleted**: the link
> fallbacks they covered are fixed, and the scan now reports *"0 of them open release blockers"*.
> The table is retained because it records what the gate was for. The count is now nine exceptions,
> and the scan additionally detects bare routable IPv4 addresses.

Three carried an `R-01` marker and were reported on every run as open release blockers:

| File | Why it matters after the cutover |
|---|---|
| `api/src/authmw.js` | The password-reset link base falls back to `https://veyora.design`. After the catch-all switch that is the **public site**, not the portal — reset links already in inboxes would 404. |
| `api/src/emails.js` | The same fallback, for every transactional email link. |
| `api/src/routes/catalog.js` | The shared-list URL base. Links already sent to customers would land on the public site. |

These are `26_RELEASE_DEPLOYMENT_ARCHITECTURE.md` §10's R-01 items, now surfaced by a command instead
of by a paragraph. They are pinned rather than fixed here because the fix has live-email blast radius
and belongs in supervised work.

**The most useful thing this gate says is what it says about the new code:** no file under
`platform/server/web/src/` contains a production hostname. The public website is entirely
environment-driven.

---

## 5. It is a command, not a merge gate

This repository has **no CI**. There is no `.github/workflows`, no pipeline configuration of any
kind. `verify-release.mjs` is the command a gate would run. It is not itself a gate, because nothing
compels anyone to run it before merging.

That distinction is why R-06 moves from L3 × I4 = 12 to **L2 × I4 = 8** and stays **open**. Likelihood
drops because a contributor who runs one command now gets every scan with a per-control verdict, on
top of the allowlist serializers that already make a new field invisible by default. It does not
close, because "wired as a merge gate" was in the original mitigation and is still absent, and
because no scan has ever run against a real row.

Wiring it is a few lines in whatever CI the team adopts: check out, `npm ci` in the three packages,
`node scripts/verify-release.mjs`, fail the build on a non-zero exit. It is recorded as a release
blocker (category C) rather than done here, because choosing and configuring CI is not something to
do unattended.

---

## 6. Portability

Every process is spawned through `process.execPath` or `git`, with `shell: false` and an argument
array. No `npm run`, no `.cmd` shim, no `npx`, no shell operators, no `/tmp`, no `/dev/null`, no
hard-coded drive letters. Temporary work goes to `os.tmpdir()` via `mkdtempSync` and is removed in a
`finally`.

Files are read with line endings normalised, because this repository is edited on Windows and
deployed to Linux — a pattern written with `\n` must still match a file checked out with `\r\n`.
That was a real failure during Phase 1 and it is now handled centrally.

`test/verify-release.test.js` (20 tests) asserts all of this against the script's own source: that
every `spawnSync` passes `shell: false`, that the only commands spawned are node and git, that there
is no HTTP client, socket or database driver anywhere in it, and that a failing gate reaches
`process.exit(1)`.

> Note for a reader auditing the script: `ssh` appears in it exactly once, inside a regular
> expression that **parses** `deploy.sh` to learn the payload list. Reading the deploy script is not
> running it, and the "spawns only node and git" test is what tells the two apart.

---

## 7. Current result

All 15 gates pass. Approximately 110 seconds on the development laptop, dominated by the Astro suite
(~75 s) and the production build (~6 s).

| Suite | Passing |
|---|---|
| API | 1,091 |
| Root admin frontend | 186 |
| Astro web | 438 |

---

## 8. Limitations

1. **Nothing runs it automatically.** §5.
2. **No real data anywhere.** Every scan runs against fixtures, mocks and a synthetic catalogue
   fixture invented inside the gate itself.
3. **`docker compose config` and `caddy validate` are not run** — neither tool is installed on the
   development machine. The deployment gates are static assertions over the configuration files;
   executable validation remains a supervised RC prerequisite.
4. **The rendered scan covers the routes the mock can serve.** Routes whose data does not exist yet
   are not exercised, so coverage grows as the catalogue does.
5. **`--fail-fast` and gate selection are conveniences for iteration.** A release decision needs the
   full run; nothing enforces that, and a summary showing three gates is not a release verification.
6. **The build gate writes to `dist/`.** It is the real production build, so running the command
   leaves build output behind. `dist/` is not tracked.

---

## 9. Security Hardening additions — 2026-08-06

### A seventeenth gate: `release-branch`

Packaging is now checked against an approved release branch before anything else.

- **Refuses a detached HEAD outright** — there is nothing nameable in a release record.
- **Refuses a non-approved branch** unless `VEYORA_RELEASE_BRANCH_OVERRIDE` names it explicitly, so a
  supervised release from elsewhere is possible but deliberate.
- **Reports uncommitted changes**, because `deploy.sh` packages the working tree and would ship them.
- **Claims no environment binding that does not exist.** There is no branch-to-environment binding
  anywhere in this repository ([33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md) §7); this gate makes
  the operator discipline visible rather than pretending it is enforced.
- It never merges, pushes or deploys.

### `secret-and-host-scan` — three exceptions deleted, one class of host added

The three R-01 exceptions are **gone, not muted**: the link fallbacks they covered now build their
URLs from the explicit origin contract. The scan reports **"0 of them open release blockers"**.

The stale-exception rule is what surfaced the fix — when it landed, the gate failed until the
obsolete pins were removed. That is the behaviour a pin list should have.

The scan now also detects **bare routable IPv4 addresses**, excluding loopback, link-local and the
RFC-1918 private ranges. This caught a real one the hostname patterns could not see: the compose
fallback for the deprecated `PUBLIC_URL`. It is declared with a reason rather than changed
unattended.

### Suite growth

| Suite | Before | After |
|---|---:|---:|
| API | 1,091 | **1,214** |
| Root admin frontend | 186 | 187 |
| Astro web | 466 | 466 |

New API coverage: `origins.test.js` (31), `rate-limit.test.js` (28), `warehouse-boundary.test.js`
(27), `audit-integrity.test.js` (16), `bootstrap-plan.test.js` (21).
