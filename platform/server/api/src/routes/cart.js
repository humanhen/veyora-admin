import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../authmw.js';
import { priceForCustomer, previewPromotions, round2 } from '../pricing.js';

const r = Router();
r.use(requireAuth());

/** Cart lines joined with live product/variation/stock data + customer price. */
export async function cartLines(user) {
  const { rows } = await q(`
    select ci.id, ci.sku, ci.qty, ci.note, ci.labels, ci.created_at,
           v.color, v.image as v_image, v.price as v_price, v.sale_price as v_sale,
           v.stock_status,
           p.id as product_id, p.sku as model_sku, p.name, p.brand, p.images,
           p.price as p_price, p.sale_price as p_sale,
           coalesce((select sum(s.qty) from stock s where s.variation_id = v.id), 0) as available
      from cart_items ci
      left join variations v on v.sku = ci.sku
      left join products p on p.id = v.product_id
     where ci.user_id = $1
     order by ci.created_at`, [user.id]);
  return rows.map(row => {
    const product = { brand: row.brand, price: row.p_price, sale_price: row.p_sale };
    const variation = { sku: row.sku, price: row.v_price, sale_price: row.v_sale };
    const price = user.hide_prices ? null : priceForCustomer(user, product, variation);
    return {
      id: row.id, sku: row.sku, qty: row.qty, note: row.note, labels: row.labels,
      name: row.name, color: row.color, brand: row.brand,
      image: row.v_image || (row.images && row.images[0]) || null,
      modelSku: row.model_sku, productId: row.product_id,
      available: Number(row.available) || 0,
      stockStatus: row.stock_status,
      price,
      lineTotal: price == null ? null : round2(price * row.qty),
      missing: !row.product_id,   // variation no longer exists
    };
  });
}

async function activePromos() {
  const { rows } = await q(`select * from promotions where active`);
  return rows;
}

export async function cartSummary(user) {
  const items = await cartLines(user);
  const lines = items.filter(i => !i.missing && i.price != null)
    .map(i => ({ sku: i.sku, qty: i.qty, price: i.price }));
  const promo = previewPromotions(await activePromos(), user,
    lines, ['agent', 'super-agent'].includes(user.role));
  const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  const discount = promo.applied?.discount || 0;
  return {
    items,
    subtotal,
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    promotion: promo.applied,
    total: round2(subtotal - discount),
  };
}

r.post('/add-to-cart', async (req, res) => {
  const { sku, qty } = req.body || {};
  const n = parseInt(qty, 10);
  if (!sku || Number.isNaN(n)) return res.status(400).json({ error: 'sku and qty required' });
  const { rows } = await q(`select id from variations where sku=$1 and is_active`, [sku]);
  if (!rows.length) return res.status(404).json({ error: 'unknown sku' });
  if (n <= 0) {
    await q(`delete from cart_items where user_id=$1 and sku=$2`, [req.user.id, sku]);
  } else {
    await q(`
      insert into cart_items (user_id, sku, qty) values ($1,$2,$3)
      on conflict (user_id, sku) do update set qty = $3`, [req.user.id, sku, n]);
  }
  res.json(await cartSummary(req.user));
});

r.get('/get-cart', async (req, res) => res.json(await cartSummary(req.user)));

async function deleteCartItem(req, res) {
  const sku = req.params.sku || req.body?.sku;
  await q(`delete from cart_items where user_id=$1 and sku=$2`, [req.user.id, sku]);
  res.json(await cartSummary(req.user));
}
r.delete('/delete-cart-item/:sku', deleteCartItem);
r.post('/delete-cart-item', deleteCartItem);

r.post('/cart-item-note', async (req, res) => {
  const { sku, note } = req.body || {};
  await q(`update cart_items set note=$3 where user_id=$1 and sku=$2`, [req.user.id, sku, String(note || '')]);
  res.json({ ok: true });
});

r.post('/cart-item-labels', async (req, res) => {
  const { sku, labels } = req.body || {};
  await q(`update cart_items set labels=$3 where user_id=$1 and sku=$2`,
    [req.user.id, sku, JSON.stringify(Array.isArray(labels) ? labels : [])]);
  res.json({ ok: true });
});

/* ---------- cart drafts ---------- */

r.get('/cart/drafts', async (req, res) => {
  const { rows } = await q(
    `select id, name, items, created_at from cart_drafts where user_id=$1 order by created_at desc`,
    [req.user.id]);
  res.json({ drafts: rows.map(d => ({ ...d, itemCount: (d.items || []).reduce((s, i) => s + (i.qty || 0), 0) })) });
});

r.post('/cart/drafts', async (req, res) => {
  const name = String(req.body?.name || `Draft ${new Date().toISOString().slice(0, 10)}`);
  const { rows } = await q(
    `select sku, qty, note, labels from cart_items where user_id=$1`, [req.user.id]);
  if (!rows.length) return res.status(400).json({ error: 'cart is empty' });
  const { rows: ins } = await q(
    `insert into cart_drafts (user_id, name, items) values ($1,$2,$3) returning id`,
    [req.user.id, name, JSON.stringify(rows)]);
  res.json({ ok: true, id: ins[0].id });
});

r.post('/cart/drafts/:id/load', async (req, res) => {
  const { rows } = await q(
    `select items from cart_drafts where id=$1 and user_id=$2`, [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'draft not found' });
  for (const it of rows[0].items || []) {
    await q(`
      insert into cart_items (user_id, sku, qty, note, labels)
      select $1, $2, $3, $4, $5
       where exists (select 1 from variations where sku=$2 and is_active)
      on conflict (user_id, sku) do update
        set qty = cart_items.qty + excluded.qty`,
      [req.user.id, it.sku, it.qty || 1, it.note || '', JSON.stringify(it.labels || [])]);
  }
  res.json(await cartSummary(req.user));
});

r.delete('/cart/drafts/:id', async (req, res) => {
  await q(`delete from cart_drafts where id=$1 and user_id=$2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

/* ---------- promotions ---------- */

r.post('/promotions/preview-cart', async (req, res) => res.json(await cartSummary(req.user)));

r.get('/promotions/eligible', async (req, res) => {
  const { eligiblePromotions } = await import('../pricing.js');
  const promos = eligiblePromotions(await activePromos(), req.user,
    ['agent', 'super-agent'].includes(req.user.role));
  res.json({
    promotions: promos.map(p => ({
      id: p.id, name: p.name, description: p.description,
      rewardType: p.reward_type, minQty: p.min_qty,
      endsOn: p.ends_on, tiers: p.tiers, percent: p.percent, fixed: p.fixed,
    })),
  });
});

export default r;
