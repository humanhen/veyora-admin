import express from 'express';
import cookieParser from 'cookie-parser';
import { pool } from './db.js';
import { requireAuth } from './authmw.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import cartRoutes from './routes/cart.js';
import orderRoutes from './routes/orders.js';
import accountRoutes from './routes/account.js';
import agentRoutes from './routes/agent.js';
import adminRoutes from './routes/admin.js';
import adminPublicContentRoutes from './routes/admin-public-content.js';
import accountPermissionRoutes from './routes/account-permissions.js';
import adminEnquiryRoutes from './routes/admin-enquiries.js';
import adminInventoryRoutes from './routes/admin-inventory.js';
import adminCustomerContactRoutes from './routes/admin-customer-contacts.js';
import adminPaymentRoutes from './routes/admin-payments.js';
import { customerPaymentRoutes, stripeWebhookRoutes } from './routes/payments.js';
import publicRoutes from './routes/public.js';
import publicFormRoutes from './routes/public-forms.js';
import nodemailer from 'nodemailer';
import { origins } from './origins.js';
import { selectAdapter } from './notifications/delivery.js';
import { startNotificationWorker } from './notifications/worker.js';
import { notificationWorkerSettings } from './config.js';
import { initStripeClient } from './payments/client-instance.js';
import { ensureSchema } from './migrate.js';
import { startZohoSchedule } from './zoho.js';
import { startServer } from './startup.js';

const app = express();

/* Trust EXACTLY the number of reverse proxies in front of this service — one
   (Caddy) in the approved topology, configurable via TRUST_PROXY_HOPS.
 *
 * This was `true`, which means "trust every hop". Express then takes `req.ip`
 * from the LEFT-MOST X-Forwarded-For entry, a value the client fully controls,
 * so any IP-keyed decision — rate limiting above all — could be bypassed by
 * varying one header per request. With a hop count, Express counts in from the
 * right and returns the address the proxy itself observed.
 *
 * See src/origins.js and 34_SECURITY_HARDENING.md §3. */
app.set('trust proxy', origins.trustProxyHops);

/* THE STRIPE WEBHOOK IS MOUNTED BEFORE THE JSON PARSER, deliberately.
 *
 * A Stripe signature is computed over the exact bytes Stripe sent.
 * `express.json()` parses them and discards them, and re-serialising the
 * resulting object changes whitespace and key order — so a signature verified
 * against a re-serialised body would never match, and the only way to make it
 * "work" would be to stop verifying. That is the one thing standing between
 * the internet and "this invoice is paid".
 *
 * `express.raw()` therefore applies to this path and this path only. The 1 MB
 * cap is far above any real Stripe event and far below anything that could be
 * used to exhaust memory. This ordering is load-bearing and a test asserts it.
 */
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhookRoutes);

app.use(express.json({ limit: '64mb' }));
app.use(cookieParser());

app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.use('/auth', authRoutes);

// The storefront's user/* surface is served by several focused routers;
// they all mount on /user and each ignores paths it doesn't define.
app.use('/user', catalogRoutes);
app.use('/user', cartRoutes);
app.use('/user', orderRoutes);
app.use('/user', accountRoutes);
app.use('/user', agentRoutes);
/* Customer payment: read the state of their OWN invoice, and ask for a secure
   hosted link. Neither route can report a payment - only the signed webhook
   above may settle an invoice. */
app.use('/user', customerPaymentRoutes);

app.get('/admin/country-list', requireAuth(), (req, res) => {
  res.json({ countries: [
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ]});
});

/* Public-content administration (B2.4A). Mounted BEFORE the general /admin
   router so its own, stricter permission gate is the one that runs:
   adminRoutes admits 'warehouse' for fulfilment work, which has no reason
   to edit public brand copy or publish a model. Deliberately under /admin,
   never under /public — the public router is unauthenticated and read-only. */
app.use('/admin/public-content', adminPublicContentRoutes);

/* Account capability management (B2.4P). Also mounted before the general
   /admin router: it is gated on the `permissions.manage` capability, not on
   a role, so the broader role check must not run first and admit an admin
   who holds no grant. */
app.use('/admin/account-permissions', accountPermissionRoutes);

/* Governed enquiry operations (Fast-Track WS2 Phase 2). Also mounted before
   the general /admin router, for the same reason and more sharply: adminRoutes
   admits several roles for operational work, and none of them has any business
   reading a member of the public's name, email address and message. Authority
   here is `enquiries.view` / `enquiries.manage` — two capabilities nobody
   holds until they are granted one account at a time. */
app.use('/admin/enquiries', adminEnquiryRoutes);

/* Narrow warehouse inventory operations (Security Hardening Phase 3). Mounted
   before the general /admin router so its own role gate runs first. These are
   the routes a `warehouse` login uses instead of the whole-database sync,
   which now refuses every non-admin caller (finding SEC-002). They move
   quantities and record a ledger movement; they touch no price and no
   commercial field. */
app.use('/admin/inventory', adminInventoryRoutes);

/* Governed store contacts (Final Handover Phase 2). Mounted before the general
   /admin router for the same reason as the enquiry router: a store contact is
   a named person at a customer with a mobile number, and none of the roles
   adminRoutes admits implies authority to read one. Authority here is
   `customer_contacts.view` / `customer_contacts.manage`, neither of which is
   granted by any migration or implied by any role. */
app.use('/admin/customer-contacts', adminCustomerContactRoutes);

/* Governed payment operations (Final Handover Phase 3). Mounted before the
   general /admin router: authority here is four separate payment
   capabilities, none granted by any migration and none implied by a role.
   No route on it can mark an invoice paid. */
app.use('/admin/payments', adminPaymentRoutes);

app.use('/admin', adminRoutes);

// Unauthenticated, read-only public API boundary for the future Astro
// public website (B2.2) — no auth middleware, no write methods. See
// routes/public.js and public-serialize.js for the allowlist boundary.
app.use('/public', publicRoutes);

/* Public enquiry form submission (Fast-Track Phase 3). A dedicated namespace,
   deliberately NOT under /public: that prefix is documented and tested as a
   read-only boundary with no write methods, and adding a POST beneath it
   would falsify a contract other tests depend on. This router applies its own
   tight body limit — the 64mb above exists for image uploads. */
app.use('/forms', publicFormRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api error]', req.method, req.url, err);
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
});

const port = process.env.PORT || 3000;

/* FAIL CLOSED. Schema readiness is a precondition for serving: if ensureSchema
   fails the process logs a fatal error and exits non-zero rather than starting
   and letting /health report success against a schema it does not have.
   Sequencing lives in startup.js so both outcomes are testable without binding
   a port. */
startServer({
  ensureSchema,
  listen: p => new Promise((resolve, reject) => {
    const server = app.listen(p, resolve);
    server.on('error', reject);
  }),
  startSchedule: () => {
    startZohoSchedule();
    /* The notification worker. Safe to start unconditionally: with no email
       provider configured, the adapter reports NOT_CONFIGURED and the queue
       simply holds — nothing is lost, and nothing is falsely reported as
       delivered (findings ENQ-006 / NOT-006). */
    const adapter = selectAdapter(process.env, { createTransport: nodemailer.createTransport });
    if (!adapter.configured) {
      console.warn('[notifications] no email provider configured — notifications will queue, not send');
    }
    initStripeClient().then((client) => {
      if (!client.enabled && client.mode === 'disabled') {
        console.warn('[payments] Stripe is not configured - online payment is unavailable; ordering on account terms is unaffected');
      }
    }).catch(() => {});

    startNotificationWorker(
      { query: (sql, params) => pool.query(sql, params) },
      adapter,
      notificationWorkerSettings()
    );
  },
  port,
});
