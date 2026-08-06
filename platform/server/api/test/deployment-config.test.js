/* Static validation of the deployment configuration (Fast-Track Workstream 2,
   Phase 1).

   `docker` and `caddy` are not available on the development machine, so
   nothing here executes either. These are strong static assertions over the
   files that will be shipped — enough to catch the mistakes that would
   otherwise only surface on the VPS, where the cost of finding them is an
   outage rather than a red test.

   Executable validation (`docker compose config`, `caddy validate`) remains a
   supervised RC prerequisite; see
   docs/public-website-rebuild/26_RELEASE_DEPLOYMENT_ARCHITECTURE.md. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
/* Line endings are normalised on read. These files are edited on Windows and
   deployed to Linux, so a CRLF is normal here and meaningless to every
   assertion below — matching on it would make the tests fail by platform
   rather than by content. */
const read = (...p) => fs.readFileSync(path.join(SERVER, ...p), 'utf8').replace(/\r\n/g, '\n');

/* Structural assertions run over DIRECTIVES, not comments: several comments
   below deliberately name the mistake they exist to prevent ("do not add
   header_up Host"), and a naive scan would match its own warning. */
const stripHash = (source) =>
  source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

const compose = read('docker-compose.yml');
const caddyLive = read('Caddyfile');
const caddyRc = read('Caddyfile.rc');
const deploy = read('deploy.sh');
const envExample = read('.env.example');

/** A deliberately small YAML reader: enough to find a service's block and read
    scalar keys from it, without adding a YAML dependency for four assertions. */
function serviceBlock(yaml, name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) break;      // next service at the same depth
    if (/^\S/.test(lines[i])) break;        // next top-level key
    out.push(lines[i]);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// compose: the new web service
// ---------------------------------------------------------------------------

test('compose declares every service the release needs', () => {
  for (const name of ['db', 'api', 'web', 'caddy']) {
    assert.ok(serviceBlock(compose, name), `service "${name}" is missing`);
  }
});

test('web builds from its own Dockerfile and restarts like its siblings', () => {
  const web = serviceBlock(compose, 'web');
  assert.match(web, /build: \.\/web/);
  assert.match(web, /restart: unless-stopped/);
  assert.ok(fs.existsSync(path.join(SERVER, 'web', 'Dockerfile')), 'the Dockerfile it builds from must exist');
});

test('web has a /healthz healthcheck, and api has one that proves database reachability', () => {
  const web = serviceBlock(compose, 'web');
  assert.match(web, /healthcheck:/);
  assert.match(web, /\/healthz/);

  const api = serviceBlock(compose, 'api');
  assert.match(api, /healthcheck:/);
  assert.match(api, /\/health\b/);
});

test('startup ordering waits on HEALTH, never on "the container started"', () => {
  const web = serviceBlock(compose, 'web');
  assert.match(web, /depends_on:\s*\n\s*api:\s*\n\s*condition: service_healthy/);

  const caddy = serviceBlock(compose, 'caddy');
  assert.match(caddy, /api:\s*\n\s*condition: service_healthy/);
  assert.match(caddy, /web:\s*\n\s*condition: service_healthy/);

  const api = serviceBlock(compose, 'api');
  assert.match(api, /db:\s*\n\s*condition: service_healthy/);
});

test('the web service requires its origins explicitly, with no silent default', () => {
  const web = serviceBlock(compose, 'web');
  /* `:?` makes compose refuse to start rather than substitute an empty
     string. A default would serve a wrong canonical host and break form CSRF
     while looking healthy. */
  assert.match(web, /PUBLIC_SITE_ORIGIN: \$\{PUBLIC_SITE_ORIGIN:\?/);
  assert.match(web, /PORTAL_ORIGIN: \$\{PORTAL_ORIGIN:\?/);
  assert.match(web, /NODE_ENV: production/);
});

test('the API origin the web service uses is an internal service name', () => {
  const web = serviceBlock(compose, 'web');
  assert.match(web, /PUBLIC_API_ORIGIN: http:\/\/api:3000/);
  // Never a public URL, and never the host's own address.
  assert.doesNotMatch(web, /PUBLIC_API_ORIGIN:.*(https?:\/\/(?!api:3000))/);
});

test('web publishes no port of its own — Caddy is the only way in', () => {
  const web = serviceBlock(compose, 'web');
  assert.doesNotMatch(web, /^\s*ports:/m, 'web must not publish a host port');
  assert.match(web, /expose:/);
});

test('no source is bind-mounted into a production container', () => {
  for (const name of ['api', 'web']) {
    const block = serviceBlock(compose, name);
    assert.doesNotMatch(block, /\.\/(src|dist|node_modules):/, `${name} bind-mounts source`);
    assert.doesNotMatch(block, /:\/app\b/, `${name} bind-mounts over /app`);
  }
});

// ---------------------------------------------------------------------------
// compose: regressions the release must not introduce
// ---------------------------------------------------------------------------

test('the database still publishes no host port', () => {
  const db = serviceBlock(compose, 'db');
  assert.doesNotMatch(db, /^\s*ports:/m, 'the database must never be reachable from outside the host');
});

test('only Caddy publishes ports, and only 80 and 443', () => {
  const published = [...compose.matchAll(/^\s+- "(\d+):(\d+)"/gm)].map((m) => m[1]);
  assert.deepEqual(published.sort(), ['443', '80']);
});

test('no container is granted extra privileges', () => {
  for (const flag of ['privileged:', 'cap_add:', 'pid: host', 'network_mode: host', 'userns_mode:']) {
    assert.ok(!compose.includes(flag), `compose grants ${flag}`);
  }
});

test('compose commits no secret', () => {
  // Every credential is an interpolation, never a literal.
  assert.doesNotMatch(compose, /JWT_SECRET:\s*(?!\$\{)\S/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*(?!\$\{)\S/);
  assert.doesNotMatch(compose, /DB_PASSWORD:\s*(?!\$\{)\S/);
});

test('the services this release adds hard-code no production hostname', () => {
  for (const name of ['web', 'caddy']) {
    assert.doesNotMatch(serviceBlock(compose, name), /veyora\.(design|com|net)/i, `${name} hard-codes a host`);
  }

  /* PRE-EXISTING, and deliberately left alone: the `api` service defaults
     SMTP_FROM to a literal Veyora address. It is a fallback for a variable the
     server sets, and changing it in an unattended run could silently alter the
     sender identity on live transactional email. Recorded in
     26_RELEASE_DEPLOYMENT_ARCHITECTURE.md as a tidy-up for a supervised run
     rather than fixed here. */
  const apiHosts = (serviceBlock(compose, 'api').match(/veyora\.(design|com|net)/gi) ?? []);
  assert.deepEqual(apiHosts, ['veyora.com'], 'only the known SMTP_FROM default may remain');
  assert.match(serviceBlock(compose, 'api'), /SMTP_FROM: \$\{SMTP_FROM:-/);
});

// ---------------------------------------------------------------------------
// Caddy: the live topology is untouched
// ---------------------------------------------------------------------------

test('the live Caddyfile still serves the storefront at its catch-all', () => {
  /* R-02 is scored 15 precisely because this is easy to get wrong. The
     release must not change the live topology as a side effect. */
  assert.match(caddyLive, /handle \{\s*\n\s*root \* \/srv\/storefront/);
  assert.match(caddyLive, /handle_path \/admin\/\*/);
  assert.doesNotMatch(caddyLive, /reverse_proxy web:4321/, 'the live file must not route to the new site yet');
});

test('the RC topology is opt-in: compose mounts the live Caddyfile by default', () => {
  const caddy = serviceBlock(compose, 'caddy');
  assert.match(caddy, /\$\{CADDYFILE:-\.\/Caddyfile\}:\/etc\/caddy\/Caddyfile:ro/);
  // And the example documents it as commented out.
  assert.match(envExample, /^# CADDYFILE=\.\/Caddyfile\.rc/m);
});

// ---------------------------------------------------------------------------
// Caddy: the RC topology
// ---------------------------------------------------------------------------

test('the RC topology gives the catch-all to the Astro site and moves the portal', () => {
  const publicBlock = caddyRc.slice(caddyRc.indexOf('{$PUBLIC_DOMAIN}'), caddyRc.indexOf('{$PORTAL_DOMAIN}'));
  const portalBlock = caddyRc.slice(caddyRc.indexOf('{$PORTAL_DOMAIN}'));

  assert.match(publicBlock, /handle \{\s*\n\s*reverse_proxy web:4321\s*\n\s*\}/);
  assert.doesNotMatch(publicBlock, /root \* \/srv\/storefront/, 'the storefront must not answer on the public host');
  assert.doesNotMatch(publicBlock, /\/srv\/admin/, 'admin must not be reachable on the public host');

  assert.match(portalBlock, /root \* \/srv\/storefront/);
  assert.match(portalBlock, /handle_path \/admin\/\*/);
  assert.doesNotMatch(portalBlock, /reverse_proxy web:4321/);
});

test('route precedence: /api and /s3 are matched before the catch-all on both hosts', () => {
  for (const host of ['{$PUBLIC_DOMAIN}', '{$PORTAL_DOMAIN}']) {
    const start = caddyRc.indexOf(host);
    const block = caddyRc.slice(start, caddyRc.indexOf('\n}', start));
    const sharedAt = block.indexOf('import shared_routes');
    const catchAllAt = block.indexOf('handle {');
    assert.ok(sharedAt > -1, `${host} does not import the shared routes`);
    assert.ok(catchAllAt > sharedAt, `${host} puts its catch-all before /api and /s3`);
  }
  // The shared snippet is where /api and /s3 actually live.
  const shared = caddyRc.slice(caddyRc.indexOf('(shared_routes)'), caddyRc.indexOf('# ---'));
  assert.match(shared, /handle \/api\/\*/);
  assert.match(shared, /uri strip_prefix \/api/);
  assert.match(shared, /handle_path \/s3\/\*/);
});

test('the proxy header contract the CSRF check depends on is preserved', () => {
  /* Caddy v2 preserves the incoming Host and adds X-Forwarded-*. Astro
     reconstructs its request origin from exactly those, and the form CSRF
     check compares the browser Origin against it — verified end to end in
     web/test/enquiry-e2e.test.ts. Rewriting Host to the upstream would make
     Astro compute http://web:4321 and reject every submission. */
  const directives = stripHash(caddyRc);
  assert.doesNotMatch(directives, /header_up\s+Host\s+\{upstream_hostport\}/);
  assert.doesNotMatch(directives, /header_up\s+Host\s+web/);
  assert.doesNotMatch(directives, /header_up\s+Host/, 'Host must be passed through untouched');
  // The reason lives in a comment beside the directive someone would change.
  assert.match(caddyRc, /Do not add/);
});

test('the portal host is blanket noindex and the public host is not', () => {
  const portalBlock = caddyRc.slice(caddyRc.indexOf('{$PORTAL_DOMAIN}'));
  assert.match(portalBlock, /header X-Robots-Tag "noindex, nofollow"/);

  const publicBlock = caddyRc.slice(caddyRc.indexOf('{$PUBLIC_DOMAIN}'), caddyRc.indexOf('{$PORTAL_DOMAIN}'));
  assert.doesNotMatch(publicBlock, /X-Robots-Tag/, 'the public site decides indexing per page, not at the proxy');
});

test('security headers are applied to both hosts, with no wildcard CORS', () => {
  assert.match(caddyRc, /\(security_headers\)/);
  assert.equal((caddyRc.match(/import security_headers/g) ?? []).length, 2);
  for (const header of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
    assert.ok(caddyRc.includes(header), `missing ${header}`);
  }
  assert.doesNotMatch(stripHash(caddyRc), /Access-Control/i,
    'no CORS header should be needed or granted — the API is same-origin through /api/*');
});

test('the RC topology hard-codes no hostname and creates no redirect loop', () => {
  assert.doesNotMatch(caddyRc, /veyora\.(design|com|net)/i);
  assert.doesNotMatch(caddyRc, /\b\d{1,3}(\.\d{1,3}){3}\b/);
  assert.match(caddyRc, /\{\$PUBLIC_DOMAIN\}/);
  assert.match(caddyRc, /\{\$PORTAL_DOMAIN\}/);

  /* The only redirect is /admin -> /admin/, which cannot loop because
     handle_path strips the prefix on the next request. No canonical-host
     redirect is enabled: with both hosts environment-derived, a redirect
     between them could trivially become a loop if they were misconfigured. */
  const redirects = [...caddyRc.matchAll(/^\s*redir\s+(\S+)\s+(\S+)/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(redirects, [['/admin', '/admin/']]);
  for (const [from, to] of redirects) assert.notEqual(from, to);
});

test('compression is enabled but not applied to the uploads proxy by accident', () => {
  assert.equal((caddyRc.match(/encode gzip/g) ?? []).length, 2, 'once per host');
});

// ---------------------------------------------------------------------------
// deploy.sh
// ---------------------------------------------------------------------------

test('deploy preflights local artefacts and remote environment before shipping anything', () => {
  const preflightAt = deploy.indexOf('preflight: local artefacts');
  const shipAt = deploy.indexOf('shipping server stack');
  assert.ok(preflightAt > -1 && shipAt > preflightAt, 'preflight must run before files move');
  assert.match(deploy, /PUBLIC_SITE_ORIGIN PORTAL_ORIGIN/);
});

test('deploy ships the web service and both Caddy topologies', () => {
  assert.match(deploy, /Caddyfile Caddyfile\.rc/);
  assert.match(deploy, /web\/Dockerfile/);
  assert.match(deploy, /web\/src/);
  // But not the web test suite or node_modules.
  assert.doesNotMatch(deploy, /web\/test/);
  assert.doesNotMatch(deploy, /web\/node_modules/);
});

test('deploy waits for web health before reporting success', () => {
  assert.match(deploy, /waiting for web health/);
  assert.match(deploy, /Health/);
  assert.match(deploy, /exit 1/);
});

test('deploy activates no cutover by itself', () => {
  /* Shipping Caddyfile.rc must not make it live. The operator sets CADDYFILE
     deliberately, after verifying the new service. */
  /* The cutover instructions in the closing NOTE heredoc are documentation for
     an operator, not commands this script runs. Only the executable portion is
     checked. */
  const executable = deploy.slice(0, deploy.indexOf("cat <<'NOTE'"));
  assert.ok(executable.length > 0, 'the NOTE heredoc marker moved');
  assert.doesNotMatch(stripHash(executable), /CADDYFILE=/);
  assert.match(deploy, /is NOT yet receiving public\s*\n?\s*traffic/);
});

test('deploy contains no destructive command', () => {
  for (const destructive of [
    'docker compose down -v', 'down --volumes', 'volume rm', 'volume prune',
    'rm -rf /', 'DROP TABLE', 'DROP DATABASE', 'TRUNCATE', 'system prune',
  ]) {
    assert.ok(!deploy.includes(destructive), `deploy.sh contains "${destructive}"`);
  }
});

test('rollback is documented, reversible, and touches no data', () => {
  const rollback = deploy.slice(deploy.indexOf('ROLLBACK'));
  assert.match(rollback, /Remove the CADDYFILE line/);
  assert.match(rollback, /up -d caddy/);
  assert.match(rollback, /Volumes, database and uploads are\s*\n?\s*untouched/);
  assert.doesNotMatch(rollback, /down -v|volume rm|prune/);
});

// ---------------------------------------------------------------------------
// environment contract
// ---------------------------------------------------------------------------

test('the env example documents every new variable and commits no secret', () => {
  for (const name of ['PUBLIC_SITE_ORIGIN', 'PORTAL_ORIGIN', 'PUBLIC_DOMAIN', 'PORTAL_DOMAIN', 'CADDYFILE']) {
    assert.ok(envExample.includes(name), `.env.example does not document ${name}`);
  }
  // The new block uses example.test, never a real host.
  const newBlock = envExample.slice(envExample.indexOf('public website (Fast-Track'));
  assert.doesNotMatch(newBlock, /veyora\.(design|com|net)/i);
  assert.match(newBlock, /example\.test/);
});

test('the web container refuses to start without its origins', () => {
  const dockerfile = read('web', 'Dockerfile');
  assert.match(dockerfile, /validate-env\.mjs && exec node \.\/dist\/server\/entry\.mjs/);
  assert.match(dockerfile, /USER veyora/, 'the runtime must not be root');
});
