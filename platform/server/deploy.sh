#!/bin/sh
# Deploys the Veyora platform to the IONOS VPS (host alias: veyora-vps).
# Run from the repo root in Git Bash:  sh platform/server/deploy.sh
# Uses tar-over-ssh (no rsync dependency on Windows).
set -e

HOST=veyora-vps
DEST=/opt/veyora
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRV="$ROOT/platform/server"

echo "==> preparing remote directories"
ssh $HOST "mkdir -p $DEST/data/import/photos $DEST/admin"

echo "==> shipping server stack (compose, caddy, api, db, storefront)"
(cd "$SRV" && tar czf - docker-compose.yml Caddyfile api db storefront) \
  | ssh $HOST "tar xzf - -C $DEST"

echo "==> shipping admin panel (repo root UI + API overrides)"
(cd "$ROOT" && tar czf - index.html css js assets) \
  | ssh $HOST "tar xzf - -C $DEST/admin"
(cd "$SRV/admin-overrides" && tar czf - js) \
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

echo "==> done. Storefront: http://209.46.125.226  Admin: http://209.46.125.226/admin/"
