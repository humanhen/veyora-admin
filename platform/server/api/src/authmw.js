import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { q } from './db.js';
import { COOKIE_OPTIONS, portalLink } from './origins.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is required');

const ACCESS_TTL = '30m';
const REFRESH_DAYS = 30;

/* Cookie security comes from the origin contract, NOT from a link variable.
   This used to read
       const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
   which meant repointing PUBLIC_URL at the public site during the cutover —
   or unsetting it, or setting it without a scheme — silently dropped `Secure`
   from both session cookies with no error and no failing test. See
   src/origins.js and 34_SECURITY_HARDENING.md §2 (finding AUTH-002). */
const COOKIE_OPTS = COOKIE_OPTIONS;

export function signAccess(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: ACCESS_TTL });
}

export function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

export async function issueSession(res, user) {
  const access = signAccess(user);
  const refresh = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + REFRESH_DAYS * 864e5);
  await q(
    `insert into refresh_tokens (token_hash, user_id, expires_at) values ($1,$2,$3)`,
    [hashToken(refresh), user.id, expires]
  );
  res.cookie('veyora_access', access, { ...COOKIE_OPTS, maxAge: 30 * 60 * 1000 });
  res.cookie('veyora_refresh', refresh, { ...COOKIE_OPTS, maxAge: REFRESH_DAYS * 864e5 });
}

export async function clearSession(req, res) {
  const refresh = req.cookies?.veyora_refresh;
  if (refresh) await q(`delete from refresh_tokens where token_hash=$1`, [hashToken(refresh)]).catch(() => {});
  res.clearCookie('veyora_access', COOKIE_OPTS);
  res.clearCookie('veyora_refresh', COOKIE_OPTS);
}

async function loadUser(id) {
  const { rows } = await q(
    `select id, customer_number, username, first_name, last_name, email, phone, business,
            tax_id, country, address, city, state, zip, role, agent_id, payment_terms,
            hide_prices, status, pricing, balance, currency, protected,
            last_login_at, prev_login_at, created_at
       from users where id=$1`, [id]);
  return rows[0] || null;
}

/** Auth middleware: verifies access token, falls back to refresh-token rotation. */
export function requireAuth(...roles) {
  return async (req, res, next) => {
    try {
      if (req.user) {   // already authenticated by an earlier router on this request
        if (roles.length && !roles.includes(req.user.role)) {
          return res.status(403).json({ error: 'forbidden' });
        }
        return next();
      }
      let userId = null;
      const access = req.cookies?.veyora_access
        || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
      if (access) {
        try { userId = jwt.verify(access, SECRET).sub; } catch { /* expired/invalid */ }
      }
      if (!userId && req.cookies?.veyora_refresh) {
        const h = hashToken(req.cookies.veyora_refresh);
        const { rows } = await q(
          `select user_id from refresh_tokens where token_hash=$1 and expires_at > now()`, [h]);
        if (rows[0]) {
          userId = rows[0].user_id;
          const u = await loadUser(userId);
          if (u && u.status === 'active') {
            res.cookie('veyora_access', signAccess(u), { ...COOKIE_OPTS, maxAge: 30 * 60 * 1000 });
          }
        }
      }
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      const user = await loadUser(userId);
      if (!user || user.status !== 'active') return res.status(401).json({ error: 'unauthorized' });
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      req.user = user;
      next();
    } catch (e) { next(e); }
  };
}

export const ADMIN_ROLES = ['admin', 'warehouse'];
export const AGENT_ROLES = ['agent', 'super-agent', 'admin'];

/** Signed 3-day token for the "set your password" magic link in emails. */
export function setPasswordToken(userId, purpose = 'activation') {
  return jwt.sign({ sub: userId, purpose }, SECRET, { expiresIn: '3d' });
}

/* A PORTAL link. Setting a password happens in the portal SPA, never on the
   public website — and after the cutover the old `PUBLIC_URL` fallback would
   have pointed at the public site, where `/#/set-password/...` does not exist.
   Reset links already sitting in customers' inboxes would have 404'd. That is
   R-01's breakage, and finding SEC-004. */
export function setPasswordLink(userId, purpose = 'activation') {
  return portalLink(`/#/set-password/${setPasswordToken(userId, purpose)}`);
}

/** Like requireAuth, but anonymous visitors get a read-only guest identity
    (prices hidden) instead of a 401 — mirrors the old site's public catalog. */
export function optionalAuth() {
  const auth = requireAuth();
  return (req, res, next) => {
    const fakeRes = {
      status: () => ({ json: () => {
        req.user = { id: null, role: 'guest', hide_prices: true, country: 'US',
                     pricing: { mode: 'none' }, status: 'active' };
        next();
      } }),
      cookie: res.cookie.bind(res),
    };
    auth(req, fakeRes, next);
  };
}
