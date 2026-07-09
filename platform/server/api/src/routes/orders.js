import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { round2 } from '../pricing.js';
import { cartSummary } from './cart.js';
import { sendMail } from '../mail.js';

const r = Router();
r.use(requireAuth());

function orderShape(o, items) {
  return {
    id: o.id, number: o.number, customerId: o.customer_id, agentId: o.agent_id,
    source: o.source, status: o.status, date: o.order_date,
    discount: o.discount, discountPct: o.discount_pct,
    freeShipping: o.free_shipping, shipping: o.shipping, total: o.total,
    tracking: o.tracking, comments: o.comments, invoiceId: o.invoice_id,
    shippingAddress: o.shipping_address, billingAddress: o.billing_address,
    promo: o.promo, createdAt: o.created_at,
    items: items?.map(i => ({
      id: i.id, sku: i.sku, name: i.name, color: i.color,
      qty: i.qty, collected: i.collected, price: i.price,
      note: i.note, labels: i.labels,
    })),
  };
}

async function shippingCost(user, subtotal, promoFreeShipping) {
  if (promoFreeShipping) return { cost: 0, free: true, reason: 'promotion' };
  const dow = new Date().getDay();
  const { rows: fs } = await q(
    `select 1 from free_shipping where customer_id=$1 and day_of_week=$2 and active`,
    [user.id, dow]);
  if (fs.length) return { cost: 0, free: true, reason: 'free shipping day' };
  const { rows } = await q(
    `select threshold, cost from shipping_rules where country=$1 and active
      order by threshold desc`, [user.country]);
  for (const rule of rows) {
    if (subtotal >= rule.threshold) return { cost: 0, free: true, reason: 'over threshold' };
  }
  const base = rows.length ? rows[rows.length - 1].cost : 0;
  return { cost: round2(base), free: base === 0, reason: base ? 'standard rate' : 'no rule' };
}

/* ---------- place order ---------- */

r.post('/place-order', async (req, res, next) => {
  try {
    const user = req.user;
    const summary = await cartSummary({ ...user, hide_prices: false });
    const usable = summary.items.filter(i => !i.missing && i.qty > 0);
    if (!usable.length) return res.status(400).json({ error: 'Cart is empty' });

    const isAgent = ['agent', 'super-agent'].includes(user.role);
    // Agents can place an order on behalf of one of their customers.
    let customer = user;
    if (isAgent && req.body?.customerId) {
      const { rows } = await q(`select * from users where id=$1 and agent_id=$2`,
        [req.body.customerId, user.id]);
      if (!rows.length) return res.status(403).json({ error: 'Not your customer' });
      customer = rows[0];
    }

    const ship = await shippingCost(customer, summary.total, summary.promotion?.freeShipping);

    const result = await tx(async (c) => {
      const orderItems = [];
      const backItems = [];

      for (const line of usable) {
        // Lock this variation's stock rows, allocate from largest pile first.
        const { rows: stockRows } = await c.query(`
          select s.variation_id, s.warehouse_id, s.qty
            from stock s join variations v on v.id = s.variation_id
           where v.sku = $1
           order by (s.warehouse_id = 'wh_main') desc, s.qty desc
           for update of s`, [line.sku]);
        let need = line.qty;
        let allocated = 0;
        for (const srow of stockRows) {
          if (need <= 0) break;
          const take = Math.min(need, Math.max(0, srow.qty));
          if (take > 0) {
            await c.query(
              `update stock set qty = qty - $1 where variation_id=$2 and warehouse_id=$3`,
              [take, srow.variation_id, srow.warehouse_id]);
            need -= take;
            allocated += take;
          }
        }
        if (allocated > 0) {
          orderItems.push({ ...line, qty: allocated });
        }
        if (need > 0) {
          backItems.push({ ...line, qty: need });
          await c.query(
            `update variations set stock_status='out of stock' where sku=$1 and stock_status='in stock'`,
            [line.sku]);
        }
      }

      let order = null;
      if (orderItems.length) {
        const subtotal = round2(orderItems.reduce((s, i) => s + i.qty * i.price, 0));
        const discount = summary.promotion?.discount
          ? Math.min(summary.promotion.discount, subtotal) : 0;
        const total = round2(subtotal - discount + ship.cost);
        const { rows: num } = await c.query(`select 'SO' || nextval('order_number_seq') as n`);
        const { rows: ord } = await c.query(`
          insert into orders (number, customer_id, agent_id, source, status, order_date,
                              discount, free_shipping, shipping, total,
                              shipping_address, billing_address, promo)
          values ($1,$2,$3,$4,'pending',current_date,$5,$6,$7,$8,$9,$10,$11)
          returning *`,
          [num[0].n, customer.id, isAgent ? user.id : customer.agent_id,
           isAgent ? 'agent' : 'customer', discount, ship.free, ship.cost, total,
           req.body?.shippingAddress ? JSON.stringify(req.body.shippingAddress) : null,
           req.body?.billingAddress ? JSON.stringify(req.body.billingAddress) : null,
           summary.promotion ? JSON.stringify(summary.promotion) : null]);
        order = ord[0];
        for (const i of orderItems) {
          await c.query(`
            insert into order_items (order_id, sku, name, color, qty, collected, price, note, labels)
            values ($1,$2,$3,$4,$5,0,$6,$7,$8)`,
            [order.id, i.sku, i.name || '', i.color || '', i.qty, i.price,
             i.note || '', JSON.stringify(i.labels || [])]);
        }
        if (summary.promotion?.id) {
          await c.query(`update promotions set used_count = used_count + 1 where id=$1`,
            [summary.promotion.id]);
        }
      }

      let backorder = null;
      if (backItems.length) {
        const { rows: bnum } = await c.query(`select 'BO' || nextval('backorder_number_seq') as n`);
        const { rows: bo } = await c.query(`
          insert into backorders (number, order_id, order_number, customer_id, status, reason)
          values ($1,$2,$3,$4,'open','out of stock') returning *`,
          [bnum[0].n, order?.id ?? null, order?.number ?? null, customer.id]);
        backorder = bo[0];
        for (const i of backItems) {
          await c.query(`
            insert into backorder_items (backorder_id, sku, name, color, qty, price)
            values ($1,$2,$3,$4,$5,$6)`,
            [backorder.id, i.sku, i.name || '', i.color || '', i.qty, i.price]);
        }
      }

      await c.query(`delete from cart_items where user_id=$1`, [user.id]);
      return { order, backorder };
    });

    const actor = { id: user.id, name: user.business || user.email, role: user.role };
    if (result.order) {
      await audit(actor, 'order placed', result.order.number, `total $${result.order.total}`);
      sendMail({
        to: customer.email,
        subject: `Veyora order ${result.order.number} received`,
        text: `Hi ${customer.first_name || customer.business},\n\nWe received your order ${result.order.number} (total $${result.order.total}). We'll email you when it ships.\n\n— The Veyora team`,
      }).catch(() => {});
    }
    if (result.backorder) {
      await audit(actor, 'backorder created', result.backorder.number, 'out of stock at order time');
    }

    res.json({
      ok: true,
      order: result.order ? orderShape(result.order) : null,
      backorder: result.backorder ? { id: result.backorder.id, number: result.backorder.number } : null,
    });
  } catch (e) { next(e); }
});

/* ---------- order list / detail ---------- */

r.get('/get-user-orders', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage, 10) || 20);
  const { rows } = await q(`
    select o.*, count(*) over() as total_count,
           (select count(*) from order_items oi where oi.order_id = o.id) as item_count,
           u.business as customer_business
      from orders o left join users u on u.id = o.customer_id
     where o.customer_id = $1 or o.agent_id = $1
     order by o.created_at desc
     limit $2 offset $3`, [req.user.id, perPage, (page - 1) * perPage]);
  res.json({
    orders: rows.map(o => ({ ...orderShape(o), itemCount: Number(o.item_count), customerBusiness: o.customer_business })),
    total: rows[0]?.total_count ?? 0, page, perPage,
  });
});

r.get('/get-order-detail/:id', async (req, res) => {
  const { rows } = await q(`
    select * from orders where (id=$1 or number=$1) and (customer_id=$2 or agent_id=$2)`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await q(
    `select * from order_items where order_id=$1 order by created_at`, [rows[0].id]);
  res.json({ order: orderShape(rows[0], items) });
});

r.post('/repeat-order', async (req, res) => {
  const { rows } = await q(`
    select o.id from orders o
     where (o.id=$1 or o.number=$1) and (o.customer_id=$2 or o.agent_id=$2)`,
    [req.body?.orderId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await q(`select sku, qty from order_items where order_id=$1`, [rows[0].id]);
  for (const it of items) {
    await q(`
      insert into cart_items (user_id, sku, qty)
      select $1, $2, $3 where exists (select 1 from variations where sku=$2 and is_active)
      on conflict (user_id, sku) do update set qty = cart_items.qty + excluded.qty`,
      [req.user.id, it.sku, it.qty]);
  }
  res.json(await cartSummary(req.user));
});

/** Remove an item from a still-pending order (restores stock). */
r.delete('/orders/:orderId/items/:itemId', async (req, res, next) => {
  try {
    const result = await tx(async (c) => {
      const { rows: ord } = await c.query(`
        select * from orders where id=$1 and (customer_id=$2 or agent_id=$2)
          and status in ('pending','processing') for update`,
        [req.params.orderId, req.user.id]);
      if (!ord.length) return null;
      const { rows: item } = await c.query(
        `delete from order_items where id=$1 and order_id=$2 returning *`,
        [req.params.itemId, ord[0].id]);
      if (!item.length) return null;
      // restore stock to main warehouse
      await c.query(`
        insert into stock (variation_id, warehouse_id, qty)
        select v.id, 'wh_main', $2 from variations v where v.sku = $1
        on conflict (variation_id, warehouse_id) do update set qty = stock.qty + excluded.qty`,
        [item[0].sku, item[0].qty]);
      const { rows: tot } = await c.query(
        `select coalesce(sum(qty*price),0) as subtotal from order_items where order_id=$1`, [ord[0].id]);
      const total = round2(Number(tot[0].subtotal) - Number(ord[0].discount) + Number(ord[0].shipping));
      await c.query(`update orders set total=$2 where id=$1`, [ord[0].id, Math.max(0, total)]);
      return { number: ord[0].number, sku: item[0].sku };
    });
    if (!result) return res.status(404).json({ error: 'Not found or order already processed' });
    await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
      'order item removed', result.number, result.sku);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- backorders ---------- */

r.get('/backorders', async (req, res) => {
  const { rows } = await q(`
    select b.*, coalesce((
      select json_agg(json_build_object('sku', bi.sku, 'name', bi.name, 'color', bi.color,
                                        'qty', bi.qty, 'price', bi.price))
        from backorder_items bi where bi.backorder_id = b.id), '[]') as items
      from backorders b where b.customer_id=$1 order by b.created_at desc`, [req.user.id]);
  res.json({
    backorders: rows.map(b => ({
      id: b.id, number: b.number, orderNumber: b.order_number, status: b.status,
      reason: b.reason, eligible: b.eligible, createdAt: b.created_at, items: b.items,
    })),
  });
});

r.post('/backorders/:id/approve', async (req, res) => {
  const { rows } = await q(`
    update backorders set status='approved', eligible=true
     where id=$1 and customer_id=$2 and status='open' returning number`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Backorder not found or not open' });
  await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
    'backorder approved', rows[0].number);
  res.json({ ok: true });
});

r.post('/backorders/:id/cancel', async (req, res) => {
  const { rows } = await q(`
    update backorders set status='cancelled'
     where id=$1 and customer_id=$2 and status in ('open','approved') returning number`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Backorder not found' });
  await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
    'backorder cancelled', rows[0].number);
  res.json({ ok: true });
});

/* ---------- returns ---------- */

r.get('/returns', async (req, res) => {
  const { rows } = await q(`
    select rt.*, coalesce((
      select json_agg(json_build_object('sku', ri.sku, 'name', ri.name, 'qty', ri.qty,
                                        'price', ri.price, 'resolution', ri.resolution))
        from return_items ri where ri.return_id = rt.id), '[]') as items
      from returns rt where rt.customer_id=$1 order by rt.created_at desc`, [req.user.id]);
  res.json({
    returns: rows.map(x => ({
      id: x.id, number: x.number, orderNumber: x.order_number, status: x.status,
      notes: x.notes, createdAt: x.created_at, items: x.items,
    })),
  });
});

r.get('/returns/:id', async (req, res) => {
  const { rows } = await q(
    `select * from returns where id=$1 and customer_id=$2`, [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Return not found' });
  const { rows: items } = await q(`select * from return_items where return_id=$1`, [rows[0].id]);
  res.json({ return: { ...rows[0], items } });
});

r.post('/returns', async (req, res, next) => {
  try {
    const { orderNumber, items, notes } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items required' });
    }
    const created = await tx(async (c) => {
      const { rows: num } = await c.query(`select 'RT' || nextval('return_number_seq') as n`);
      const { rows: ret } = await c.query(`
        insert into returns (number, customer_id, order_number, status, notes)
        values ($1,$2,$3,'open',$4) returning *`,
        [num[0].n, req.user.id, orderNumber || null, String(notes || '')]);
      for (const it of items) {
        const { rows: v } = await c.query(`
          select v.sku, p.name, coalesce(v.sale_price, v.price, p.sale_price, p.price, 0) as price
            from variations v join products p on p.id=v.product_id where v.sku=$1`, [it.sku]);
        await c.query(`
          insert into return_items (return_id, sku, name, qty, price, resolution)
          values ($1,$2,$3,$4,$5,$6)`,
          [ret[0].id, it.sku, v[0]?.name || it.name || '', Math.max(1, parseInt(it.qty, 10) || 1),
           it.price ?? v[0]?.price ?? 0,
           ['credit', 'exchange'].includes(it.resolution) ? it.resolution : 'credit']);
      }
      return ret[0];
    });
    await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
      'return created', created.number);
    res.json({ ok: true, return: { id: created.id, number: created.number } });
  } catch (e) { next(e); }
});

/* ---------- invoices ---------- */

r.get('/invoices', async (req, res) => {
  const { rows } = await q(
    `select * from invoices where customer_id=$1 order by issued_on desc`, [req.user.id]);
  res.json({
    invoices: rows.map(i => ({
      id: i.id, number: i.number, orderNumber: i.order_number, amount: i.amount,
      provider: i.provider, status: i.status, issuedOn: i.issued_on,
    })),
  });
});

r.get('/invoice/:id', async (req, res) => {
  const { rows } = await q(
    `select * from invoices where (id=$1 or number=$1) and customer_id=$2`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ invoice: rows[0] });
});

export default r;
