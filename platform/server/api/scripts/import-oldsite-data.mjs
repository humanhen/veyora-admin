/* Imports customers + order history harvested from the old veyora.com admin
   session (via the /ingest endpoint) into the new platform.
   Reads /import/ingest-customers.json, ingest-order-summaries.json,
   ingest-order-details.json. Idempotent: upserts users by email and orders
   by number. Order line-items are set only for orders whose detail we have. */
import fs from 'fs';
import pg from 'pg';

const DIR = process.env.IMPORT_DIR || '/import';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const read = f => JSON.parse(fs.readFileSync(`${DIR}/${f}`));

const customers = read('ingest-customers.json');
const summaries = read('ingest-order-summaries.json');
let details = [];
try { details = read('ingest-order-details.json'); } catch { /* optional */ }
console.log(`customers=${customers.length} summaries=${summaries.length} details=${details.length}`);

const num = v => (v === '' || v == null ? null : Number(v));
const ROLE_MAP = { customer: 'customer', 'special customer': 'special customer',
  agent: 'agent', 'super-agent': 'super-agent', super_agent: 'super-agent',
  warehouse: 'warehouse', admin: 'admin' };

const client = await pool.connect();
try {
  await client.query('begin');

  /* ---------- users ---------- */
  const oldToNew = new Map();       // old user id -> new user id
  const agentPairs = [];            // [newUserId, oldAgentId]
  let nUsers = 0;
  for (const c of customers) {
    if (c.role === 'admin') continue;              // don't import old admins
    const email = String(c.email || '').trim().toLowerCase()
      || `oldid-${c.id}@import.veyora.local`;
    const role = ROLE_MAP[c.role] || 'customer';
    const business = c.business_name || '';
    const username = (c.user_name || business || email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || null;
    const country = (c.country_code || c.country || 'US').slice(0, 2).toUpperCase() || 'US';
    const status = c.status === 'disabled' ? 'disabled' : 'pending';   // activate via email
    const custNo = /^[0-9]+$/.test(String(c.external_id || '')) ? String(c.external_id) : null;

    const { rows } = await client.query(`
      insert into users (customer_number, username, first_name, last_name, email, phone,
                         business, tax_id, country, address, city, zip, role,
                         hide_prices, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      on conflict (email) do update set
        first_name=excluded.first_name, last_name=excluded.last_name,
        business=excluded.business, phone=excluded.phone, tax_id=excluded.tax_id,
        country=excluded.country, address=excluded.address, city=excluded.city,
        zip=excluded.zip, role=excluded.role, hide_prices=excluded.hide_prices
      returning id`,
      [custNo, username, c.first_name || '', c.last_name || '', email,
       c.phone_number || c.mobile_phone || '', business, c.vat_number || '',
       country, c.address || '', c.city || '', c.zip_code || '', role,
       !!c.hide_prices, status]);
    const newId = rows[0].id;
    oldToNew.set(c.id, newId);
    if (c.agent_id) agentPairs.push([newId, c.agent_id]);
    nUsers++;
  }
  // second pass: link agents
  let nAgent = 0;
  for (const [newId, oldAgentId] of agentPairs) {
    const agentNew = oldToNew.get(oldAgentId);
    if (agentNew) { await client.query(`update users set agent_id=$1 where id=$2`, [agentNew, newId]); nAgent++; }
  }
  console.log(`users upserted=${nUsers}, agent links=${nAgent}`);

  /* ---------- orders ---------- */
  const detailByNum = new Map(details.map(d => [String(d.order_number), d]));
  const custByBiz = new Map();      // business/name (lower) -> new user id
  for (const c of customers) {
    const key = String(c.business_name || `${c.first_name} ${c.last_name}`).trim().toLowerCase();
    if (key && oldToNew.has(c.id)) custByBiz.set(key, oldToNew.get(c.id));
  }

  let nOrders = 0, nItems = 0, maxSO = 0;
  for (const s of summaries) {
    const number = String(s.order_number);
    const m = number.match(/^SO0*(\d+)$/i);
    if (m) maxSO = Math.max(maxSO, parseInt(m[1], 10));
    const custId = custByBiz.get(String(s.customer_name || '').trim().toLowerCase()) || null;
    const status = ['pending','processing','approved','collecting','collected','completed','shipped','cancelled']
      .includes(s.status) ? s.status : 'completed';
    const source = s.order_by === 'agent' ? 'agent' : 'customer';
    const det = detailByNum.get(number);
    const orderDate = (s.date || det?.order_date || '').slice(0, 10) || null;

    const { rows } = await client.query(`
      insert into orders (number, customer_id, source, status, order_date, total,
                          discount, tracking, comments)
      values ($1,$2,$3,$4, coalesce($5::date, current_date), $6,$7,$8,$9)
      on conflict (number) do update set
        customer_id=coalesce(excluded.customer_id, orders.customer_id),
        status=excluded.status, order_date=excluded.order_date, total=excluded.total
      returning id`,
      [number, custId, source, status, orderDate, num(s.total_price) ?? 0,
       num(det?.discount_value) ?? 0,
       det?.tracking_number ? JSON.stringify({ company: det.shipping_company || '', number: det.tracking_number }) : null,
       JSON.stringify(det?.comments || [])]);
    const orderId = rows[0].id;
    nOrders++;

    if (det && Array.isArray(det.products)) {
      await client.query(`delete from order_items where order_id=$1`, [orderId]);
      for (const p of det.products) {
        const vd = p.variation_details || {};
        const price = p.quantity ? num(p.total) / p.quantity : num(p.total);
        await client.query(`
          insert into order_items (order_id, sku, name, color, qty, collected, price)
          values ($1,$2,$3,$4,$5,$6,$7)`,
          [orderId, String(vd.sku || p.sku || ''), p.name || '', vd.color || '',
           parseInt(p.quantity, 10) || 0, parseInt(p.scanned_count, 10) || 0,
           Math.round((price || 0) * 100) / 100]);
        nItems++;
      }
    }
  }
  // keep the SO sequence ahead of imported historical SO numbers
  await client.query(`select setval('order_number_seq', greatest((select last_value from order_number_seq), $1))`, [maxSO + 1]);
  console.log(`orders upserted=${nOrders}, line items=${nItems}, maxSO=${maxSO}`);

  await client.query('commit');

  const { rows: sums } = await client.query(`
    select (select count(*) from users) as users,
           (select count(*) from orders) as orders,
           (select count(*) from order_items) as items,
           (select count(*) from orders where customer_id is not null) as linked_orders`);
  console.log('db now:', sums[0]);
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  client.release();
  await pool.end();
}
