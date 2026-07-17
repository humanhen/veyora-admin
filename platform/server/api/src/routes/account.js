import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { q, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { loadProducts } from './catalog.js';

const r = Router();
r.use(requireAuth());

const UPLOADS = process.env.UPLOADS_DIR || '/uploads';

r.get('/get-user-detail', async (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id, customerNumber: u.customer_number, username: u.username,
      firstName: u.first_name, lastName: u.last_name, email: u.email,
      phone: u.phone, business: u.business, taxId: u.tax_id,
      country: u.country, address: u.address, city: u.city, state: u.state, zip: u.zip,
      role: u.role, paymentTerms: u.payment_terms, hidePrices: u.hide_prices,
      balance: u.balance, createdAt: u.created_at,
    },
  });
});

r.post('/update-profile', async (req, res) => {
  const b = req.body || {};
  await q(`
    update users set
      first_name = coalesce($2, first_name), last_name = coalesce($3, last_name),
      phone = coalesce($4, phone), business = coalesce($5, business),
      tax_id = coalesce($6, tax_id), address = coalesce($7, address),
      city = coalesce($8, city), state = coalesce($9, state), zip = coalesce($10, zip)
    where id=$1`,
    [req.user.id, b.firstName, b.lastName, b.phone, b.business, b.taxId,
     b.address, b.city, b.state, b.zip]);
  res.json({ ok: true });
});

r.post('/change-password', async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const { rows } = await q(`select password_hash from users where id=$1`, [req.user.id]);
  if (!rows[0]?.password_hash || !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await q(`update users set password_hash=$2 where id=$1`,
    [req.user.id, await bcrypt.hash(String(next), 10)]);
  await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
    'password changed', req.user.email);
  res.json({ ok: true });
});

r.post('/toggle-hide-prices', async (req, res) => {
  const { rows } = await q(
    `update users set hide_prices = not hide_prices where id=$1 returning hide_prices`, [req.user.id]);
  res.json({ hidePrices: rows[0].hide_prices });
});

/* ---------- addresses ---------- */

function addrShape(a) {
  return { id: a.id, kind: a.kind, name: a.name, business: a.business, phone: a.phone,
           address: a.address, city: a.city, state: a.state, zip: a.zip,
           country: a.country, isDefault: a.is_default };
}

r.get('/get-addresses', async (req, res) => {
  const { rows } = await q(
    `select * from addresses where user_id=$1 order by created_at`, [req.user.id]);
  res.json({
    billing: rows.filter(a => a.kind === 'billing').map(addrShape),
    shipping: rows.filter(a => a.kind === 'shipping').map(addrShape),
  });
});

async function saveAddress(req, res, kind) {
  const b = req.body || {};
  if (b.id) {
    await q(`
      update addresses set name=$3, business=$4, phone=$5, address=$6, city=$7,
             state=$8, zip=$9, country=$10
       where id=$1 and user_id=$2 and kind=$11`,
      [b.id, req.user.id, b.name || '', b.business || '', b.phone || '', b.address || '',
       b.city || '', b.state || '', b.zip || '', b.country || req.user.country, kind]);
    return res.json({ ok: true, id: b.id });
  }
  const { rows } = await q(`
    insert into addresses (user_id, kind, name, business, phone, address, city, state, zip, country)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [req.user.id, kind, b.name || '', b.business || '', b.phone || '', b.address || '',
     b.city || '', b.state || '', b.zip || '', b.country || req.user.country]);
  res.json({ ok: true, id: rows[0].id });
}

r.post('/save-billing-address', (req, res) => saveAddress(req, res, 'billing'));
r.post('/save-shipping-address', (req, res) => saveAddress(req, res, 'shipping'));

/* ---------- shipping info ---------- */

r.get('/shipping-info', async (req, res) => {
  const { rows } = await q(
    `select country, threshold, cost from shipping_rules where active and country=$1
      order by threshold`, [req.user.country]);
  const { rows: fs } = await q(
    `select day_of_week from free_shipping where customer_id=$1 and active`, [req.user.id]);
  res.json({ rules: rows, freeShippingDays: fs.map(x => x.day_of_week) });
});

r.get('/shipping-options', async (req, res) => {
  const { rows } = await q(
    `select country, threshold, cost from shipping_rules where active and country=$1
      order by threshold`, [req.user.country]);
  res.json({ options: rows });
});

/* ---------- favourites ---------- */

r.get('/favourites', async (req, res) => {
  const { rows } = await q(`select product_id from favourites where user_id=$1`, [req.user.id]);
  if (!rows.length) return res.json({ products: [] });
  const items = await loadProducts(req.user, { ids: rows.map(x => x.product_id) });
  res.json({ products: items.map(p => ({ ...p, isFavourite: true })) });
});

r.post('/favourites/:productId/toggle', async (req, res) => {
  const { rowCount } = await q(
    `delete from favourites where user_id=$1 and product_id=$2`,
    [req.user.id, req.params.productId]);
  if (!rowCount) {
    await q(`
      insert into favourites (user_id, product_id)
      select $1, $2 where exists (select 1 from products where id=$2)
      on conflict do nothing`, [req.user.id, req.params.productId]);
  }
  res.json({ favourite: !rowCount });
});

r.post('/favourites/add-all-to-cart', async (req, res) => {
  await q(`
    insert into cart_items (user_id, sku, qty)
    select f.user_id, v.sku, 1
      from favourites f
      join variations v on v.product_id = f.product_id and v.is_active
      join stock s on s.variation_id = v.id
     where f.user_id = $1
     group by f.user_id, v.sku
    having sum(s.qty) > 0
    on conflict (user_id, sku) do nothing`, [req.user.id]);
  res.json({ ok: true });
});

/* ---------- restock notifications ---------- */

r.get('/restock-notify', async (req, res) => {
  const { rows } = await q(`select sku from restock_notifications where user_id=$1`, [req.user.id]);
  res.json({ skus: rows.map(x => x.sku) });
});

r.post('/restock-notify', async (req, res) => {
  const sku = req.body?.sku;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  const { rowCount } = await q(
    `delete from restock_notifications where user_id=$1 and sku=$2`, [req.user.id, sku]);
  if (!rowCount) {
    await q(`insert into restock_notifications (user_id, sku) values ($1,$2) on conflict do nothing`,
      [req.user.id, sku]);
  }
  res.json({ notify: !rowCount });
});

/* ---------- replenishment (reorder suggestions) ---------- */

r.get('/replenishment', async (req, res) => {
  const { rows } = await q(`
    select oi.sku, sum(oi.qty) as bought, max(o.order_date) as last_ordered,
           min(o.order_date) as first_ordered, count(distinct o.id) as times
      from order_items oi join orders o on o.id = oi.order_id
     where o.customer_id = $1 and o.status <> 'cancelled'
     group by oi.sku order by 2 desc limit 40`, [req.user.id]);
  if (!rows.length) return res.json({ items: [] });
  const modelSkus = [...new Set(rows.map(x => String(x.sku).split('.')[0]))];
  const products = await loadProducts(req.user, { skus: modelSkus });
  const bySku = new Map();
  for (const p of products) for (const v of p.variations) bySku.set(v.sku, { p, v });
  res.json({
    items: rows.filter(x => bySku.has(x.sku)).map(x => {
      const { p, v } = bySku.get(x.sku);
      return { sku: x.sku, name: p.name, brand: p.brand, color: v.color,
               image: v.image || p.images[0] || null,
               bought: Number(x.bought), lastOrdered: x.last_ordered,
               firstOrdered: x.first_ordered, times: Number(x.times),
               available: v.qty, price: v.price };
    }),
  });
});

/* ---------- scan your list (old-site "scan tray": photo of a handwritten
   SKU list → OCR via the Claude API → matched cart candidates) ---------- */

const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 },
  fileFilter: (rq, f, cb) => cb(null, /image\//.test(f.mimetype)),
});

const normSku = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

r.post('/scan-tray', scanUpload.array('photos', 8), async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'List scanning is not set up yet — ask the admin to add the scanning key.' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'no photos' });

    const content = req.files.map(f => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(f.mimetype)
          ? f.mimetype : 'image/jpeg',
        data: f.buffer.toString('base64'),
      },
    }));
    content.push({ type: 'text', text:
      'These photos show a handwritten or printed list of eyewear SKUs an optician wants to order. ' +
      'SKUs look like model.color (e.g. 2057.81, 3507.15), NAME-1234 (e.g. VEDETTE-2002, CAMERON-1), ' +
      'or plain model numbers. A quantity may be written next to a SKU (e.g. "x2" or "2x"). ' +
      'Read every line. Reply with ONLY a JSON array, one element per line, ' +
      'like [{"sku":"2057.81","qty":1}]. qty is 1 unless clearly written. ' +
      'Transcribe exactly what is written — never invent or autocomplete SKUs.' });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.SCAN_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
      }),
    });
    const j = await resp.json();
    if (!Array.isArray(j.content)) {
      throw new Error(`scan failed: ${JSON.stringify(j).slice(0, 200)}`);
    }
    const text = j.content.map(b => b.text || '').join('');
    let lines = [];
    try { lines = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); }
    catch { throw new Error('could not read the list from the photo'); }

    // match scanned lines to real variations (separator-insensitive)
    const { rows: vars } = await q(`
      select v.sku, v.price, v.image, v.color, p.name,
             coalesce((select sum(s.qty) from stock s where s.variation_id=v.id),0) as qty
        from variations v join products p on p.id=v.product_id
       where v.is_active and p.is_active`);
    const byNorm = new Map(vars.map(v => [normSku(v.sku), v]));
    const matched = [], unmatched = [];
    for (const line of lines) {
      const raw = String(line?.sku || '').trim();
      if (!raw) continue;
      const v = byNorm.get(normSku(raw));
      if (v) {
        matched.push({ scanned: raw, sku: v.sku, name: v.name, color: v.color,
          image: v.image, price: req.user.hide_prices ? null : v.price,
          available: Number(v.qty), qty: Math.max(1, parseInt(line.qty, 10) || 1) });
      } else unmatched.push(raw);
    }
    res.json({ matched, unmatched });
  } catch (e) { next(e); }
});

/* ---------- spare parts ---------- */

const spareUpload = multer({
  storage: multer.diskStorage({
    destination: (rq, f, cb) => {
      const dir = path.join(UPLOADS, 'spare-parts');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (rq, f, cb) =>
      cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (rq, f, cb) => cb(null, /image\/(jpe?g|png|webp|gif)/.test(f.mimetype)),
});

r.get('/get-spare-part', async (req, res) => {
  const { rows } = await q(
    `select * from spare_parts where user_id=$1 order by created_at desc`, [req.user.id]);
  res.json({ spareParts: rows });
});

r.post('/add-spare-part', async (req, res) => {
  const b = req.body || {};
  const { rows } = await q(`
    insert into spare_parts (user_id, model, part, notes, image)
    values ($1,$2,$3,$4,$5) returning id`,
    [req.user.id, String(b.model || ''), String(b.part || ''), String(b.notes || ''), b.image || null]);
  res.json({ ok: true, id: rows[0].id });
});

r.post('/spare-part-image', spareUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image required' });
  res.json({ path: `/s3/spare-parts/${req.file.filename}` });
});

export default r;
