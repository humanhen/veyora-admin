import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { q, tx } from '../db.js';
import { requireAuth } from '../authmw.js';
import { SIMPLE_COLLECTIONS, rowToJs, jsToRow } from '../shape.js';
import { sendMail } from '../mail.js';

const r = Router();
r.use(requireAuth('admin', 'warehouse'));

const UPLOADS = process.env.UPLOADS_DIR || '/uploads';

/* ============================ snapshot ============================ */

const num = v => (v === '' || v == null ? null : Number(v));

async function productsSnapshot() {
  const { rows } = await q(`
    select p.*,
      coalesce((
        select json_agg(json_build_object(
          'vid', v.id, 'sku', v.sku, 'color', v.color, 'image', v.image,
          'price', v.price, 'salePrice', v.sale_price, 'stockStatus', v.stock_status,
          'isActive', v.is_active,
          'stock', coalesce((
            select json_object_agg(s.warehouse_id, json_build_object('qty', s.qty, 'shelf', s.shelf))
              from stock s where s.variation_id = v.id), '{}'::json)
        ) order by v.sku)
        from variations v where v.product_id = p.id), '[]') as variations
      from products p order by p.created_at desc`);
  return rows.map(p => ({
    id: p.id, sku: p.sku, name: p.name, description: p.description, brand: p.brand,
    size: p.size, ean: p.ean, categories: p.categories, tags: p.tags, images: p.images,
    attributes: p.attributes, price: p.price, salePrice: p.sale_price,
    productionStatus: p.production_status, estimatedArrival: p.estimated_arrival,
    isActive: p.is_active, createdAt: p.created_at, updatedAt: p.updated_at,
    variations: (p.variations || []).map(v => ({
      sku: v.sku, color: v.color, image: v.image, price: v.price, salePrice: v.salePrice,
      stockStatus: v.stockStatus, isActive: v.isActive !== false, stock: v.stock || {},
    })),
  }));
}

async function ordersSnapshot() {
  const { rows } = await q(`
    select o.*, coalesce((
      select json_agg(json_build_object(
        'sku', oi.sku, 'name', oi.name, 'color', oi.color, 'qty', oi.qty,
        'collected', oi.collected, 'price', oi.price, 'note', oi.note, 'labels', oi.labels
      ) order by oi.created_at)
      from order_items oi where oi.order_id = o.id), '[]') as items
      from orders o order by o.created_at desc`);
  return rows.map(o => ({
    id: o.id, number: o.number, customerId: o.customer_id, agentId: o.agent_id,
    source: o.source, status: o.status, date: o.order_date,
    discount: o.discount, discountPct: o.discount_pct, freeShipping: o.free_shipping,
    shipping: o.shipping, total: o.total, tracking: o.tracking, comments: o.comments,
    invoiceId: o.invoice_id, promo: o.promo,
    shippingAddress: o.shipping_address, billingAddress: o.billing_address,
    createdAt: o.created_at, items: o.items,
  }));
}

async function nestedNumberSnapshot(table, itemsTable, fk, itemCols, mapRow) {
  const { rows } = await q(`
    select t.*, coalesce((
      select json_agg(json_build_object(${itemCols}))
        from ${itemsTable} i where i.${fk} = t.id), '[]') as items
      from ${table} t order by t.created_at desc`);
  return rows.map(mapRow);
}

async function seqNext(name) {
  const { rows } = await q(`select last_value, is_called from ${name}`);
  return Number(rows[0].last_value) + (rows[0].is_called ? 1 : 0);
}

r.get('/snapshot', async (req, res, next) => {
  try {
    const out = {};
    for (const [name, cfg] of Object.entries(SIMPLE_COLLECTIONS)) {
      const limit = cfg.appendOnly ? 'limit 2000' : '';
      const order = cfg.fields.createdAt || cfg.appendOnly ? 'order by created_at desc' : '';
      const { rows } = await q(`select * from ${cfg.table} ${order} ${limit}`);
      out[name] = rows.map(row => rowToJs(cfg, row));
    }
    out.products = await productsSnapshot();
    out.orders = await ordersSnapshot();
    out.backorders = await nestedNumberSnapshot('backorders', 'backorder_items', 'backorder_id',
      `'sku', i.sku, 'name', i.name, 'color', i.color, 'qty', i.qty, 'price', i.price`,
      b => ({ id: b.id, number: b.number, orderId: b.order_id, orderNumber: b.order_number,
              customerId: b.customer_id, status: b.status, reason: b.reason,
              eligible: b.eligible, convertedOrderId: b.converted_order_id,
              createdAt: b.created_at, items: b.items }));
    out.returns = await nestedNumberSnapshot('returns', 'return_items', 'return_id',
      `'sku', i.sku, 'name', i.name, 'qty', i.qty, 'price', i.price, 'resolution', i.resolution`,
      x => ({ id: x.id, number: x.number, customerId: x.customer_id, orderNumber: x.order_number,
              status: x.status, notes: x.notes, createdAt: x.created_at, items: x.items }));
    const { rows: settingsRow } = await q(`select data from settings where id=1`);
    out.settings = settingsRow[0]?.data || {};
    res.json({
      collections: out,
      meta: {
        nextOrderNumber: await seqNext('order_number_seq'),
        nextBackorderNumber: await seqNext('backorder_number_seq'),
        nextReturnNumber: await seqNext('return_number_seq'),
        nextInvoiceNumber: await seqNext('invoice_number_seq'),
        serverTime: new Date().toISOString(),
      },
    });
  } catch (e) { next(e); }
});

/* ============================ sync ============================ */

async function upsertSimple(c, cfg, obj) {
  if (!obj.id) throw new Error(`${cfg.table}: row missing id`);
  const { cols, vals } = jsToRow(cfg, obj);
  if (!cols.includes('id')) { cols.unshift('id'); vals.unshift(obj.id); }
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter(x => x !== 'id').map(x => `${x}=excluded.${x}`);
  const conflict = cfg.appendOnly
    ? 'on conflict (id) do nothing'
    : `on conflict (id) do update set ${updates.join(', ')}`;
  await c.query(
    `insert into ${cfg.table} (${cols.join(',')}) values (${placeholders.join(',')}) ${conflict}`,
    vals);
}

async function upsertProduct(c, p) {
  if (!p.id) throw new Error('product missing id');
  await c.query(`
    insert into products (id, sku, name, description, brand, size, ean, categories, tags,
                          images, attributes, price, sale_price, production_status,
                          estimated_arrival, is_active)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    on conflict (id) do update set
      sku=excluded.sku, name=excluded.name, description=excluded.description,
      brand=excluded.brand, size=excluded.size, ean=excluded.ean,
      categories=excluded.categories, tags=excluded.tags, images=excluded.images,
      attributes=excluded.attributes, price=excluded.price, sale_price=excluded.sale_price,
      production_status=excluded.production_status, estimated_arrival=excluded.estimated_arrival,
      is_active=excluded.is_active`,
    [p.id, String(p.sku), p.name || '', p.description || '', p.brand || '', p.size || '',
     p.ean || '', p.categories || [], p.tags || [], p.images || [],
     JSON.stringify(p.attributes || {}), num(p.price), num(p.salePrice),
     p.productionStatus || 'none', p.estimatedArrival || null, p.isActive !== false]);

  const vars = Array.isArray(p.variations) ? p.variations : [];
  const skus = vars.map(v => String(v.sku));
  await c.query(
    `delete from variations where product_id=$1 and not (sku = any($2))`, [p.id, skus]);
  for (const v of vars) {
    const { rows: vr } = await c.query(`
      insert into variations (product_id, sku, color, image, price, sale_price, stock_status, is_active)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (sku) do update set
        product_id=excluded.product_id, color=excluded.color, image=excluded.image,
        price=excluded.price, sale_price=excluded.sale_price,
        stock_status=excluded.stock_status, is_active=excluded.is_active
      returning id`,
      [p.id, String(v.sku), v.color || '', v.image || null, num(v.price), num(v.salePrice),
       v.stockStatus || 'in stock', v.isActive !== false]);
    const vid = vr[0].id;
    await c.query(`delete from stock where variation_id=$1`, [vid]);
    for (const [wh, sdata] of Object.entries(v.stock || {})) {
      await c.query(`
        insert into stock (variation_id, warehouse_id, qty, shelf)
        select $1, $2, $3, $4 where exists (select 1 from warehouses where id=$2)`,
        [vid, wh, parseInt(sdata?.qty, 10) || 0, String(sdata?.shelf || '')]);
    }
  }
}

/** Upsert with per-row savepoint; on duplicate business number, renumber from sequence. */
async function upsertNumbered(c, obj, seqName, prefix, insertFn, remaps, collection) {
  await c.query('savepoint row_try');
  try {
    await insertFn(obj);
    await c.query('release savepoint row_try');
  } catch (e) {
    if (e.code === '23505' && String(e.constraint || '').includes('number')) {
      await c.query('rollback to savepoint row_try');
      const { rows } = await c.query(`select '${prefix}' || nextval('${seqName}') as n`);
      const renumbered = { ...obj, number: rows[0].n };
      await insertFn(renumbered);
      remaps.push({ collection, id: obj.id, number: rows[0].n });
    } else {
      throw e;
    }
  }
}

async function upsertOrder(c, o) {
  if (!o.id) throw new Error('order missing id');
  await c.query(`
    insert into orders (id, number, customer_id, agent_id, source, status, order_date,
                        discount, discount_pct, free_shipping, shipping, total,
                        tracking, comments, invoice_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    on conflict (id) do update set
      number=excluded.number, customer_id=excluded.customer_id, agent_id=excluded.agent_id,
      source=excluded.source, status=excluded.status, order_date=excluded.order_date,
      discount=excluded.discount, discount_pct=excluded.discount_pct,
      free_shipping=excluded.free_shipping, shipping=excluded.shipping, total=excluded.total,
      tracking=excluded.tracking, comments=excluded.comments, invoice_id=excluded.invoice_id`,
    [o.id, o.number, o.customerId || null, o.agentId || null, o.source || 'customer',
     o.status || 'pending', o.date || new Date().toISOString().slice(0, 10),
     num(o.discount) ?? 0, num(o.discountPct) ?? 0, !!o.freeShipping,
     num(o.shipping) ?? 0, num(o.total) ?? 0,
     o.tracking ? JSON.stringify(o.tracking) : null,
     JSON.stringify(o.comments || []), o.invoiceId || null]);
  await c.query(`delete from order_items where order_id=$1`, [o.id]);
  for (const i of (o.items || [])) {
    await c.query(`
      insert into order_items (order_id, sku, name, color, qty, collected, price, note, labels)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, String(i.sku), i.name || '', i.color || '', parseInt(i.qty, 10) || 0,
       parseInt(i.collected, 10) || 0, num(i.price) ?? 0, i.note || '',
       JSON.stringify(i.labels || [])]);
  }
}

async function upsertBackorder(c, b) {
  await c.query(`
    insert into backorders (id, number, order_id, order_number, customer_id, status,
                            reason, eligible, converted_order_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (id) do update set
      number=excluded.number, order_id=excluded.order_id, order_number=excluded.order_number,
      customer_id=excluded.customer_id, status=excluded.status, reason=excluded.reason,
      eligible=excluded.eligible, converted_order_id=excluded.converted_order_id`,
    [b.id, b.number, b.orderId || null, b.orderNumber || null, b.customerId || null,
     b.status || 'open', b.reason || 'out of stock', !!b.eligible, b.convertedOrderId || null]);
  await c.query(`delete from backorder_items where backorder_id=$1`, [b.id]);
  for (const i of (b.items || [])) {
    await c.query(`
      insert into backorder_items (backorder_id, sku, name, color, qty, price)
      values ($1,$2,$3,$4,$5,$6)`,
      [b.id, String(i.sku), i.name || '', i.color || '', parseInt(i.qty, 10) || 0, num(i.price) ?? 0]);
  }
}

async function upsertReturn(c, x) {
  await c.query(`
    insert into returns (id, number, customer_id, order_number, status, notes)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (id) do update set
      number=excluded.number, customer_id=excluded.customer_id,
      order_number=excluded.order_number, status=excluded.status, notes=excluded.notes`,
    [x.id, x.number, x.customerId || null, x.orderNumber || null, x.status || 'open', x.notes || '']);
  await c.query(`delete from return_items where return_id=$1`, [x.id]);
  for (const i of (x.items || [])) {
    await c.query(`
      insert into return_items (return_id, sku, name, qty, price, resolution)
      values ($1,$2,$3,$4,$5,$6)`,
      [x.id, String(i.sku), i.name || '', parseInt(i.qty, 10) || 0, num(i.price) ?? 0,
       ['credit', 'exchange'].includes(i.resolution) ? i.resolution : 'credit']);
  }
}

const SEQ_SYNC = [
  ['orders', 'order_number_seq', 'SO'],
  ['backorders', 'backorder_number_seq', 'BO'],
  ['returns', 'return_number_seq', 'RT'],
  ['invoices', 'invoice_number_seq', 'IN'],
];

r.post('/sync', async (req, res, next) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const remaps = [];
    const touched = new Set();
    await tx(async (c) => {
      for (const ch of changes) {
        const name = ch.collection;
        touched.add(name);
        const upserts = Array.isArray(ch.upserts) ? ch.upserts : [];
        const deletes = Array.isArray(ch.deletes) ? ch.deletes : [];

        if (name === 'products') {
          for (const p of upserts) await upsertProduct(c, p);
          if (deletes.length) await c.query(`delete from products where id = any($1)`, [deletes]);
        } else if (name === 'orders') {
          for (const o of upserts) {
            await upsertNumbered(c, o, 'order_number_seq', 'SO',
              row => upsertOrder(c, row), remaps, 'orders');
          }
          if (deletes.length) await c.query(`delete from orders where id = any($1)`, [deletes]);
        } else if (name === 'backorders') {
          for (const b of upserts) {
            await upsertNumbered(c, b, 'backorder_number_seq', 'BO',
              row => upsertBackorder(c, row), remaps, 'backorders');
          }
          if (deletes.length) await c.query(`delete from backorders where id = any($1)`, [deletes]);
        } else if (name === 'returns') {
          for (const x of upserts) {
            await upsertNumbered(c, x, 'return_number_seq', 'RT',
              row => upsertReturn(c, row), remaps, 'returns');
          }
          if (deletes.length) await c.query(`delete from returns where id = any($1)`, [deletes]);
        } else if (name === 'settings') {
          if (upserts[0]) {
            await c.query(`update settings set data=$1 where id=1`, [JSON.stringify(upserts[0])]);
          }
        } else if (SIMPLE_COLLECTIONS[name]) {
          const cfg = SIMPLE_COLLECTIONS[name];
          for (const obj of upserts) {
            if (cfg.sequence) {
              await upsertNumbered(c, obj, cfg.sequence.name, cfg.sequence.prefix,
                row => upsertSimple(c, cfg, row), remaps, name);
            } else {
              await upsertSimple(c, cfg, obj);
            }
          }
          if (deletes.length) {
            const guard = cfg.protectedDelete ? 'and not protected' : '';
            await c.query(`delete from ${cfg.table} where id = any($1) ${guard}`, [deletes]);
          }
        } else {
          throw Object.assign(new Error(`unknown collection: ${name}`), { status: 400 });
        }
      }
      // keep server sequences ahead of any client-assigned numbers
      for (const [coll, seq, prefix] of SEQ_SYNC) {
        if (!touched.has(coll)) continue;
        const table = coll === 'invoices' ? 'invoices' : coll;
        await c.query(`
          select setval('${seq}', greatest(
            (select last_value from ${seq}),
            coalesce((select max(substring(number from ${prefix.length + 1})::bigint)
                        from ${table} where number ~ '^${prefix}[0-9]+$'), 0)
          ))`);
      }
    });
    res.json({ ok: true, remaps });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

/* ============================ uploads ============================ */

const upload = multer({
  storage: multer.diskStorage({
    destination: (rq, f, cb) => {
      const folder = /^[a-z0-9-]+$/.test(rq.body?.folder || '') ? rq.body.folder : 'products';
      const dir = path.join(UPLOADS, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (rq, f, cb) => {
      const base = path.basename(f.originalname, path.extname(f.originalname))
        .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      cb(null, `${base}_${crypto.randomBytes(4).toString('hex')}${path.extname(f.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (rq, f, cb) => cb(null, /image\/(jpe?g|png|webp|gif|avif)/.test(f.mimetype)),
});

r.post('/upload', upload.array('files', 20), (req, res) => {
  const files = (req.files || []).map(f =>
    `/s3/${path.basename(path.dirname(f.path))}/${f.filename}`);
  if (!files.length) return res.status(400).json({ error: 'no files' });
  res.json({ paths: files });
});

/* ============================ account invitations ============================ */

/** Send (or resend) an activation email to a customer. */
r.post('/send-activation/:userId', async (req, res) => {
  const { rows } = await q(`select * from users where id=$1`, [req.params.userId]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const u = rows[0];
  await sendMail({
    to: u.email,
    subject: 'Veyora has been upgraded — set your new password',
    text: `Hi ${u.first_name || u.business},\n\nVeyora has been upgraded. Visit ${process.env.PUBLIC_URL || ''}/#/activate and use this email address to request your activation code, then set your password.\n\n— The Veyora team`,
  });
  res.json({ ok: true });
});

/** Directly set a user's password (admin action, e.g. for staff accounts). */
r.post('/set-user-password/:userId', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const { rows } = await q(
    `update users set password_hash=$2, status='active' where id=$1 returning id`,
    [req.params.userId, await bcrypt.hash(String(password), 10)]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

export default r;
