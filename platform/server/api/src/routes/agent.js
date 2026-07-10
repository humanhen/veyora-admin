import { Router } from 'express';
import { q, audit } from '../db.js';
import { requireAuth, AGENT_ROLES, setPasswordLink } from '../authmw.js';
import { sendMail } from '../mail.js';
import { welcomeActivation } from '../emails.js';

const r = Router();

function customerShape(u) {
  return {
    id: u.id, customerNumber: u.customer_number, username: u.username,
    firstName: u.first_name, lastName: u.last_name, email: u.email,
    phone: u.phone, business: u.business, taxId: u.tax_id,
    country: u.country, address: u.address, city: u.city, state: u.state, zip: u.zip,
    role: u.role, agentId: u.agent_id, status: u.status,
    paymentTerms: u.payment_terms, balance: u.balance, createdAt: u.created_at,
  };
}

/** Which customers can this user see? */
function scopeClause(user) {
  if (user.role === 'admin' || user.role === 'super-agent') {
    return { sql: `role in ('customer','special customer')`, params: [] };
  }
  return { sql: `role in ('customer','special customer') and agent_id = $1`, params: [user.id] };
}

r.get('/customer-list', requireAuth(...AGENT_ROLES), async (req, res) => {
  const scope = scopeClause(req.user);
  const { rows } = await q(
    `select * from users where ${scope.sql} order by business, created_at`, scope.params);
  res.json({ customers: rows.map(customerShape) });
});

r.post('/create-customer', requireAuth(...AGENT_ROLES), async (req, res, next) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || !b.business) return res.status(400).json({ error: 'email and business required' });
    const { rows: dup } = await q(`select 1 from users where lower(email)=$1`, [email]);
    if (dup.length) return res.status(409).json({ error: 'A customer with this email already exists' });

    const username = (b.username || b.business).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
    const { rows: numRow } = await q(
      `select coalesce(max(customer_number::int), 1000) + 1 as n
         from users where customer_number ~ '^[0-9]+$'`);
    const { rows } = await q(`
      insert into users (customer_number, username, first_name, last_name, email, phone,
                         business, tax_id, country, address, city, state, zip,
                         role, agent_id, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'customer',$14,'pending')
      returning *`,
      [String(numRow[0].n), username, b.firstName || '', b.lastName || '', email,
       b.phone || '', b.business, b.taxId || '', b.country || 'US',
       b.address || '', b.city || '', b.state || '', b.zip || '', req.user.id]);

    await audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
      'customer created', b.business);
    const mail = welcomeActivation({ name: b.firstName || b.business, username,
      email, link: setPasswordLink(rows[0].id, 'activation') });
    sendMail({ to: email, subject: mail.subject, html: mail.html,
      text: `Welcome to Veyora. Set your password: ${setPasswordLink(rows[0].id, 'activation')}` }).catch(() => {});
    res.json({ ok: true, customer: customerShape(rows[0]) });
  } catch (e) { next(e); }
});

r.get('/my-customer/:id', requireAuth(...AGENT_ROLES), async (req, res) => {
  const scope = scopeClause(req.user);
  const { rows } = await q(
    `select * from users where id=$${scope.params.length + 1} and ${scope.sql}`,
    [...scope.params, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
  const { rows: orders } = await q(
    `select number, status, order_date, total from orders
      where customer_id=$1 order by created_at desc limit 20`, [req.params.id]);
  res.json({ customer: customerShape(rows[0]), recentOrders: orders });
});

r.post('/update-customer/:id', requireAuth(...AGENT_ROLES), async (req, res) => {
  const scope = scopeClause(req.user);
  const b = req.body || {};
  const { rows } = await q(`
    update users set
      first_name = coalesce($2, first_name), last_name = coalesce($3, last_name),
      phone = coalesce($4, phone), business = coalesce($5, business),
      tax_id = coalesce($6, tax_id), address = coalesce($7, address),
      city = coalesce($8, city), state = coalesce($9, state), zip = coalesce($10, zip)
    where id=$1 and ${scope.sql.replace('$1', `$${11}`)}
    returning id`,
    [req.params.id, b.firstName, b.lastName, b.phone, b.business, b.taxId,
     b.address, b.city, b.state, b.zip,
     ...(scope.params.length ? [req.user.id] : [])]);
  if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
  res.json({ ok: true });
});

/* ---------- leads (super-agent view) ---------- */

r.get('/sa/leads', requireAuth('super-agent', 'admin'), async (req, res) => {
  const { rows } = await q(`
    select l.*, u.business as agent_business
      from leads l left join users u on u.id = l.agent_id
     order by l.created_at desc`);
  res.json({ leads: rows });
});

/* ---------- internal tasks ---------- */

r.get('/tasks', requireAuth(...AGENT_ROLES, 'warehouse'), async (req, res) => {
  const { rows } = await q(`
    select t.*, ua.business as assigned_business
      from tasks t left join users ua on ua.id = t.assigned_to
     where t.assigned_to = $1 or t.created_by = $1 or $2 in ('admin','super-agent')
     order by t.created_at desc`, [req.user.id, req.user.role]);
  res.json({ tasks: rows });
});

r.get('/tasks/:id', requireAuth(...AGENT_ROLES, 'warehouse'), async (req, res) => {
  const { rows } = await q(`select * from tasks where id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: rows[0] });
});

r.post('/tasks/:id/message', requireAuth(...AGENT_ROLES, 'warehouse'), async (req, res) => {
  const msg = {
    from: req.user.business || req.user.email,
    text: String(req.body?.text || ''),
    at: new Date().toISOString(),
  };
  const { rows } = await q(`
    update tasks set messages = messages || $2::jsonb where id=$1 returning id`,
    [req.params.id, JSON.stringify([msg])]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true });
});

export default r;
