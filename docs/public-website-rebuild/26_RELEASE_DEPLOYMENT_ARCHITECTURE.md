# 26 — Release Deployment Architecture

How the public website, API, admin panel and B2B portal are deployed together, and how the cutover to
the new public site is performed and reversed.

**Nothing was deployed.** No production system, VPS or live database was contacted. `docker` and
`caddy` are not installed on the development machine, so every check here is static; executable
validation is a supervised RC prerequisite (§9).

---

## 1. What was missing

The Astro site had a production-shaped `Dockerfile` and a `/healthz` endpoint, but:

- it was **not a service in Compose**, so it was never built or run;
- `deploy.sh` **did not ship `web/`**, so its source never reached the server;
- Caddy had no route to it.

The public website has therefore never been deployable. This phase makes it deployable **additively**
— the service builds and runs, but receives no public traffic until an operator deliberately cuts
over.

---

## 2. Service topology

```
                    ┌──────────────────────────── caddy (80/443) ────────────────────────────┐
                    │                                                                         │
  {$PUBLIC_DOMAIN}  │  /api/*  → api:3000     /s3/* → uploads volume     /*  → web:4321       │
  {$PORTAL_DOMAIN}  │  /api/*  → api:3000     /s3/* → uploads volume                          │
                    │  /admin/* → /srv/admin (static)   /*  → /srv/storefront (static)        │
                    └─────────────────────────────────────────────────────────────────────────┘
                                   │                          │
                              web:4321 (Astro)           api:3000 (Express)
                                   │                          │
                                   └── PUBLIC_API_ORIGIN ─────┘
                                       http://api:3000                  db:5432 (postgres)
                                       internal network only            no published port
```

| Service | Image / build | Published ports | Health |
|---|---|---|---|
| `db` | `postgres:16-alpine` | **none** | `pg_isready` |
| `api` | `./api` | none | `GET /health` — runs `select 1`, so a pass proves database reachability |
| `web` | `./web` | none (`expose: 4321`) | `GET /healthz` |
| `caddy` | `caddy:2-alpine` | 80, 443 | — |

**Only Caddy publishes ports**, and only 80/443. The database publishes none, `web` publishes none,
and no container is granted `privileged`, `cap_add`, host networking or host PID. No source is
bind-mounted into a production container. All asserted by test.

### Why the public site takes the catch-all

`04_TARGET_ARCHITECTURE.md` §5.2. Astro owns unmatched paths so the public site returns a **real 404
with real metadata**, rather than a static SPA shell answering `200` at every URL — which is the
R-02 failure mode (score 15) and a total SEO loss. The portal moves to its own host so the two
applications never share an origin, a cookie scope or a `try_files` fallback.

---

## 3. Environment contract

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `PUBLIC_SITE_ORIGIN` | `web` | **yes** | Exact public origin including scheme. Drives canonical URLs, `robots.txt`, the sitemap and Astro's `security.allowedDomains`. |
| `PORTAL_ORIGIN` | `web` | **yes** | Where the B2B Login link points. |
| `PUBLIC_DOMAIN` | `caddy` (RC only) | for cutover | Host name for the public site block. |
| `PORTAL_DOMAIN` | `caddy` (RC only) | for cutover | Host name for the portal/admin block. |
| `CADDYFILE` | `caddy` | no | Selects the topology. **Unset = current live routing.** |
| `DB_PASSWORD`, `JWT_SECRET`, `DOMAIN`, … | existing | yes | Unchanged. |

`PUBLIC_SITE_ORIGIN` and `PORTAL_ORIGIN` are declared in Compose with `${VAR:?…}`, so Compose
**refuses to start** rather than substituting an empty string. A default would serve a wrong
canonical host and break form CSRF while the container still looked healthy — failing loudly is the
correct outcome. The container's own `validate-env.mjs` enforces the same contract a second time.

No secret and no production hostname appears in any file this release adds. (One pre-existing
exception is recorded in §10.)

---

## 4. Request routing and the CSRF proxy contract

**This is the part most easily broken by a well-meaning edit.**

Caddy v2's `reverse_proxy` **preserves the incoming `Host`** and adds `X-Forwarded-For`, `-Proto` and
`-Host`. Astro's `NodeApp.createRequest()` reconstructs the request URL from exactly those headers,
validating them against `security.allowedDomains` (derived from `PUBLIC_SITE_ORIGIN`). Its CSRF
`checkOrigin` middleware then compares the browser's `Origin` against that reconstructed origin.

Adding `header_up Host {upstream_hostport}` — a common "fix" copied from nginx habits — would make
Astro compute `http://web:4321` as its origin and **reject every form submission with 403**. The
`Caddyfile.rc` carries that warning beside the directive, and a test asserts no `header_up Host`
appears anywhere.

This contract is verified end to end in `platform/server/web/test/enquiry-e2e.test.ts`, which drives
real POSTs through a Node-core reverse proxy reproducing exactly these headers
([24_PUBLIC_ENQUIRY_FORMS.md](24_PUBLIC_ENQUIRY_FORMS.md) §10).

### Precedence

On both hosts, `/api/*` and `/s3/*` are matched **before** the catch-all, so neither can be swallowed
by it — asserted by test. The only redirect is `/admin` → `/admin/`, which cannot loop because
`handle_path` strips the prefix. **No canonical-host redirect is enabled**: with both hosts
environment-derived, a redirect between them becomes a loop the moment they are misconfigured, and
the benefit does not justify that failure mode at cutover.

### Headers

`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and
removal of `X-Powered-By`/`Server`, applied to both hosts. The portal host additionally carries a
**blanket `X-Robots-Tag: noindex, nofollow`** — structural, so it cannot be forgotten when a route is
added. The public host carries none, because the site decides indexing per page.

**No CORS header is set anywhere.** The API is same-origin through `/api/*` and the Astro server
calls it over the internal network, so cross-origin access is not needed; granting it would be
widening the boundary for nothing.

---

## 5. Health checks and startup ordering

Every dependency waits on **health**, never on "the container started":

```
db (pg_isready) → api (GET /health, which does select 1) → web (GET /healthz) → caddy
```

That distinction is what stops a deploy reporting success against a stack that cannot serve a
request. `api`'s healthcheck is new in this phase; without it, `depends_on: api` meant only that the
process had been launched.

---

## 6. Migration ordering

Unchanged, and worth restating because it is easy to misread:

- `db/migrations/*.sql` are mounted at `/docker-entrypoint-initdb.d` and run **only on a fresh
  volume** — they are not an incremental migration mechanism.
- `api/src/migrate.js`'s `ensureSchema()` is the real one. It runs at API startup, is idempotent, and
  mirrors every migration additively.
- Therefore: **the API must reach a healthy state before anything depends on new columns existing.**
  The health gate above enforces that ordering.

A disposable-PostgreSQL migration rehearsal remains outstanding (§9).

---

## 7. Deployment phases

`sh platform/server/deploy.sh` now performs:

1. **Preflight — local.** Verifies every artefact it is about to ship exists. Fails before a single
   file moves.
2. **Preflight — remote.** Verifies `PUBLIC_SITE_ORIGIN` and `PORTAL_ORIGIN` are present in the
   server's `.env`. Without them the web container cannot start, so this converts a restart loop into
   a clear message while the running site is untouched.
3. **Ship** compose, both Caddyfiles, api, db, storefront, and the web service's source (Dockerfile,
   manifests, config, `scripts/`, `src/` — **not** its test suite or `node_modules`).
4. **Ship** the admin panel (`index.html css js assets`), unchanged.
5. **Build and start** — `docker compose up -d --build`.
6. **Wait for API health**, then **wait for web health** via `docker compose ps`, because Caddy may
   still be serving the old topology and nothing routes to `web` yet. The new site must prove itself
   healthy *before* any cutover.
7. **Release verification** — status codes for `/api/health`, `/admin/`, and the web container's
   internal `/healthz`.
8. **Print** the cutover and rollback procedures. It performs neither.

---

## 8. Cutover and rollback

The deploy **never cuts over**. Compose mounts `${CADDYFILE:-./Caddyfile}`, so the current live
routing stays in place until an operator opts in.

### Cutover

1. Confirm `PUBLIC_DOMAIN` and `PORTAL_DOMAIN` are set in `/opt/veyora/.env`, and that **DNS for
   `PORTAL_DOMAIN` already resolves to this host** — otherwise the portal becomes unreachable the
   moment it moves.
2. Add to `/opt/veyora/.env`: `CADDYFILE=./Caddyfile.rc`
3. `docker compose -f /opt/veyora/docker-compose.yml up -d caddy`
4. Verify: the public host serves the Astro site; the portal host serves the storefront; `/admin/`
   loads; and **a form POST over HTTPS returns 200** (the check §4 exists for).

### Rollback

1. Remove the `CADDYFILE` line from `/opt/veyora/.env`
2. `docker compose -f /opt/veyora/docker-compose.yml up -d caddy`

The previous topology is live again. **Volumes, database and uploads are untouched in either
direction** — rollback is a proxy configuration change, not a data operation. `deploy.sh` contains no
`down -v`, no `volume rm`, no `prune` and no destructive SQL; a test asserts it.

---

## 9. Supervised RC prerequisites

Not doable from here, and required before the cutover is trustworthy:

1. **`docker compose config`** — parse and interpolation check with a real `.env`.
2. **`caddy validate --config Caddyfile.rc`** — syntax and adapter check.
3. **Disposable-PostgreSQL migration rehearsal** — bring up `db` on a fresh volume, start `api`,
   confirm `ensureSchema()` completes and `/health` passes.
4. **RC deployment** to the staging host, with the current storefront preserved.
5. **HTTPS form smoke test** — submit all three enquiry forms from a real browser and confirm 200
   plus a `pending` row. This is the only check that proves Caddy's real header behaviour matches the
   contract the local proxy reproduces.
6. **Rollback test** — perform the cutover, then roll back, and confirm the storefront returns.

---

## 10. Limitations

- **Nothing here was executed.** `docker` and `caddy` are absent locally; all 30 tests are static
  assertions over the configuration files. They catch structure, precedence, header contracts,
  privilege and destructiveness — not syntax the tools themselves would reject.
- **A pre-existing hard-coded address remains** in the `api` service: `SMTP_FROM` defaults to a
  literal Veyora address. It is a fallback for a variable the server sets, and changing it in an
  unattended run could silently alter the sender identity on live transactional email. Left alone
  deliberately; a supervised tidy-up.
- **`deploy.sh` still targets a fixed host alias** (`veyora-vps`) and prints fixed URLs in its
  original sections. Unchanged by this phase.
- **The legacy hash bridge and the `setPasswordLink`/`listUrl` changes** required by R-01 are **not**
  part of this phase. The cutover must not happen until those are handled, or password-reset and
  shared-list links already in customers' inboxes will land on the public site.
- **No canonical-host redirect** and no `www` handling is configured.
- **TLS** is Caddy's automatic certificate management, unchanged and untested here.

---

## 11. Origin and cookie contract — Security Hardening Phase 1, 2026-08-06

§3's environment table is extended. The API now has its own validated origin contract
(`api/src/origins.js`), because cookie security used to be a side effect of a link variable.

| Variable | Used by | Required | Notes |
|---|---|---|---|
| `PORTAL_ORIGIN` | `api`, `web` | **yes in production** | Where portal links point. Falls back to the deprecated `PUBLIC_URL` with a logged notice. |
| `ADMIN_ORIGIN` | `api` | no | Defaults to `<PORTAL_ORIGIN>/admin`, the current topology. May carry a path. |
| `COOKIE_SECURE` | `api` | no | Session cookie `Secure`. Defaults **on** in production. |
| `TRUST_PROXY_HOPS` | `api` | no | Reverse proxies in front of the API. **Default 1** — matches this topology exactly. |
| `PUBLIC_URL` | `api` | **deprecated** | Still read as a fallback for `PORTAL_ORIGIN`. No longer affects security in any way. |

**Set `PORTAL_ORIGIN` explicitly before the cutover.** That is the moment `PUBLIC_URL` stops meaning
"the portal", and it is exactly when the ambiguity became dangerous.

**Do not raise `TRUST_PROXY_HOPS` without adding a proxy.** Each hop is one more `X-Forwarded-For`
entry a client can forge to choose its own apparent address and defeat the authentication rate
limits. It was previously `true` — trust every hop — which made that trivial.

Two related notes for §10's limitations list: the `PUBLIC_URL` compose default is a **bare IP**, now
declared in the release gate's host-scan exception list; and the host scan itself now detects bare
routable IPv4 addresses, which it previously could not see.
