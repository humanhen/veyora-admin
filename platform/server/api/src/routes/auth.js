import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { q, audit } from '../db.js';
import { issueSession, clearSession } from '../authmw.js';
import { sendMail } from '../mail.js';
import { activationCode, passwordReset } from '../emails.js';

const r = Router();
const SECRET = process.env.JWT_SECRET;

function publicUser(u) {
  return {
    id: u.id, customerNumber: u.customer_number, username: u.username,
    firstName: u.first_name, lastName: u.last_name, email: u.email,
    phone: u.phone, business: u.business, country: u.country,
    role: u.role, hidePrices: u.hide_prices, status: u.status,
    paymentTerms: u.payment_terms, balance: u.balance,
  };
}

r.post('/login', async (req, res) => {
  const { email, username, password } = req.body || {};
  const ident = (email || username || '').trim().toLowerCase();
  if (!ident || !password) return res.status(400).json({ error: 'missing credentials' });
  const { rows } = await q(
    `select * from users where lower(email)=$1 or lower(username)=$1 limit 1`, [ident]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (u.status === 'pending') return res.status(403).json({ error: 'account_pending', message: 'Account not activated yet' });
  if (u.status !== 'active') return res.status(403).json({ error: 'account_disabled', message: 'Account disabled' });
  await q(`update users set prev_login_at = last_login_at, last_login_at = now() where id=$1`, [u.id]);
  await issueSession(res, u);
  await audit({ id: u.id, name: u.business || u.email, role: u.role }, 'login', u.email);
  res.json({ user: publicUser(u) });
});

r.post('/logout', async (req, res) => {
  await clearSession(req, res);
  res.json({ ok: true });
});

/* ---------- OTP flows (activation + forgot password) ---------- */

async function createOtp(userId, purpose) {
  const code = String(crypto.randomInt(100000, 999999));
  await q(`update otp_codes set used=true where user_id=$1 and purpose=$2`, [userId, purpose]);
  await q(
    `insert into otp_codes (user_id, purpose, code, expires_at)
     values ($1,$2,$3, now() + interval '15 minutes')`, [userId, purpose, code]);
  return code;
}

async function verifyOtp(userId, purpose, code) {
  const { rows } = await q(
    `update otp_codes set used=true
      where user_id=$1 and purpose=$2 and code=$3 and not used and expires_at > now()
      returning id`, [userId, purpose, String(code || '')]);
  return rows.length > 0;
}

function setPassToken(userId, purpose) {
  return jwt.sign({ sub: userId, purpose }, SECRET, { expiresIn: '30m' });
}

async function findByEmail(email) {
  const { rows } = await q(`select * from users where lower(email)=lower($1)`, [(email || '').trim()]);
  return rows[0] || null;
}

r.post('/request-activation-otp', async (req, res) => {
  const u = await findByEmail(req.body?.email);
  // Do not reveal whether the account exists
  if (u && u.status !== 'disabled') {
    const code = await createOtp(u.id, 'activation');
    const mail = activationCode({ name: u.first_name || u.business, email: u.email, code });
    await sendMail({ to: u.email, subject: mail.subject, html: mail.html,
      text: `Your Veyora activation code is: ${code} (expires in 15 minutes).` });
  }
  res.json({ ok: true });
});

r.post('/verify-activation-otp', async (req, res) => {
  const u = await findByEmail(req.body?.email);
  if (!u || !(await verifyOtp(u.id, 'activation', req.body?.code))) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  res.json({ token: setPassToken(u.id, 'activation') });
});

async function handleSetPassword(req, res) {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return res.status(400).json({ error: 'Invalid token' }); }
  if (!['activation', 'forgot_password'].includes(payload.purpose)) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  const hash = await bcrypt.hash(String(password), 10);
  await q(`update users set password_hash=$1, status='active' where id=$2 and status <> 'disabled'`, [hash, payload.sub]);
  await audit(null, 'password set', payload.sub, '', 'web');
  res.json({ ok: true });
}

r.post('/set-password', handleSetPassword);

r.post('/forgot-password', async (req, res) => {
  const u = await findByEmail(req.body?.email);
  // pending (not-yet-activated) accounts may also use this flow — completing
  // it sets a password and activates them, mirroring the old site's popup
  if (u && u.status !== 'disabled') {
    const code = await createOtp(u.id, 'forgot_password');
    const mail = passwordReset({ name: u.first_name || u.business, email: u.email, code });
    await sendMail({ to: u.email, subject: mail.subject, html: mail.html,
      text: `Your Veyora password reset code is: ${code} (expires in 15 minutes).` });
  }
  res.json({ ok: true });
});

r.post('/verify-forgot-otp', async (req, res) => {
  const u = await findByEmail(req.body?.email);
  if (!u || !(await verifyOtp(u.id, 'forgot_password', req.body?.code))) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  res.json({ token: setPassToken(u.id, 'forgot_password') });
});

r.post('/reset-password', handleSetPassword);

export default r;
