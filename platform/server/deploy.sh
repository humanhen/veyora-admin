#!/bin/sh
# Deploys the Veyora platform to the IONOS VPS (host alias: veyora-vps).
# Run from the repo root in Git Bash:  sh platform/server/deploy.sh
# Uses tar-over-ssh (no rsync dependency on Windows).
set -e

HOST=veyora-vps
DEST=/opt/veyora
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRV="$ROOT/platform/server"

# ---------------------------------------------------------------------------
# Preflight. Everything here is read-only and runs before a single file moves,
# so a misconfigured target fails while the running site is still untouched.
# ---------------------------------------------------------------------------
echo "==> preflight: local artefacts"
for required in docker-compose.yml Caddyfile Caddyfile.rc api db storefront web; do
  [ -e "$SRV/$required" ] || { echo "  MISSING: platform/server/$required"; exit 1; }
done
[ -f "$ROOT/index.html" ] || { echo "  MISSING: admin panel index.html at the repo root"; exit 1; }
echo "  ok"

echo "==> preflight: remote environment"
# The web container's own validate-env.mjs refuses to start without these, so
# checking here turns a restart loop into a clear message before anything ships.
ssh $HOST "cd $DEST 2>/dev/null || exit 0
  [ -f .env ] || exit 0
  missing=''
  for v in PUBLIC_SITE_ORIGIN PORTAL_ORIGIN; do
    grep -q \"^\$v=.\" .env || missing=\"\$missing \$v\"
  done
  if [ -n \"\$missing\" ]; then
    echo \"  .env is missing:\$missing\"
    echo '  The web service will not start without them. Add them to'
    echo \"  $DEST/.env and re-run. See platform/server/.env.example.\"
    exit 1
  fi
  echo '  ok'"

echo "==> preparing remote directories"
ssh $HOST "mkdir -p $DEST/data/import/photos $DEST/admin"

# Caddyfile.rc ships alongside the live Caddyfile but is NOT activated here.
# Compose mounts ${CADDYFILE:-./Caddyfile}, so the current topology stays live
# until an operator sets CADDYFILE=./Caddyfile.rc deliberately. See
# docs/public-website-rebuild/26_RELEASE_DEPLOYMENT_ARCHITECTURE.md.
echo "==> shipping server stack (compose, caddy, api, db, storefront, web)"
(cd "$SRV" && tar czf - docker-compose.yml Caddyfile Caddyfile.rc api db storefront \
    web/Dockerfile web/package.json web/package-lock.json web/astro.config.mjs \
    web/tsconfig.json web/scripts web/src) \
  | ssh $HOST "tar xzf - -C $DEST"

# The admin panel used to ship as "repo root UI + a deploy-time overlay" that
# replaced js/app.js and js/data.js with API-backed forks. The repo root kept a
# seeded demo store, so whenever the overlay was missed the panel silently
# served 1,107 invented orders — which is exactly what the release candidate
# was doing. There is now ONE admin: the repo root, API-backed, no overlay and
# nothing to forget.
echo "==> shipping admin panel"
(cd "$ROOT" && tar czf - index.html css js assets) \
  | ssh $HOST "tar xzf - -C $DEST/admin"

echo "==> generating .env (first run only)"
ssh $HOST "cd $DEST && if [ ! -f .env ]; then
  {
    echo DB_PASSWORD=\$(head -c32 /dev/urandom | md5sum | cut -c1-32)
    echo JWT_SECRET=\$(head -c64 /dev/urandom | md5sum | cut -c1-32)\$(head -c64 /dev/urandom | md5sum | cut -c1-32)
    echo DOMAIN=veyora.design
    echo PUBLIC_URL=https://veyora.design
  } > .env
  echo '  .env created'
else echo '  .env exists — keeping'; fi"

echo "==> building & starting containers"
ssh $HOST "cd $DEST && docker compose up -d --build"

echo "==> waiting for API health"
ssh $HOST 'for i in $(seq 1 30); do
  if curl -sf http://localhost/api/health >/dev/null 2>&1; then echo "  api healthy"; exit 0; fi
  sleep 2
done; echo "  api did NOT become healthy — check: docker compose -f /opt/veyora/docker-compose.yml logs api"; exit 1'

# The web container is reachable only on the compose network, so it is probed
# through compose rather than through Caddy — Caddy may still be serving the
# OLD topology, in which case nothing routes to it yet. That is the point:
# the public site must prove itself healthy BEFORE any cutover.
echo "==> waiting for web health"
ssh $HOST "cd $DEST && for i in \$(seq 1 40); do
  state=\$(docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '\$1==\"web\"{print \$2}')
  if [ \"\$state\" = healthy ]; then echo '  web healthy'; exit 0; fi
  sleep 3
done
echo '  web did NOT become healthy'
echo '  check: docker compose -f $DEST/docker-compose.yml logs web'
echo '  the most common cause is a missing or wrong PUBLIC_SITE_ORIGIN / PORTAL_ORIGIN in .env'
exit 1"

echo "==> release verification"
ssh $HOST "cd $DEST && {
  echo -n '  api  /api/health   '; curl -so /dev/null -w '%{http_code}\n' http://localhost/api/health
  echo -n '  admin /admin/      '; curl -so /dev/null -w '%{http_code}\n' http://localhost/admin/
  echo -n '  web  (internal)    '; docker compose exec -T web node -e \"fetch('http://127.0.0.1:4321/healthz').then(r=>console.log(r.status))\" 2>/dev/null || echo 'n/a'
}"

cat <<'NOTE'

==> done.

The web service is deployed and healthy but is NOT yet receiving public
traffic: Caddy is still serving the current topology.

CUTOVER (deliberate, supervised, reversible):
  1. Confirm PUBLIC_DOMAIN and PORTAL_DOMAIN are set in /opt/veyora/.env,
     and that DNS for PORTAL_DOMAIN already resolves to this host.
  2. Add to /opt/veyora/.env:      CADDYFILE=./Caddyfile.rc
  3. docker compose -f /opt/veyora/docker-compose.yml up -d caddy
  4. Verify: public host serves the Astro site, portal host serves the
     storefront, /admin/ still loads, and a form POST over HTTPS returns 200.

ROLLBACK (no data is touched):
  1. Remove the CADDYFILE line from /opt/veyora/.env
  2. docker compose -f /opt/veyora/docker-compose.yml up -d caddy
  The previous topology is live again. Volumes, database and uploads are
  untouched by either direction.

Full procedure: docs/public-website-rebuild/26_RELEASE_DEPLOYMENT_ARCHITECTURE.md
NOTE
