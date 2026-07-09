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

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
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

app.get('/admin/country-list', requireAuth(), (req, res) => {
  res.json({ countries: [
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ]});
});

app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api error]', req.method, req.url, err);
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`veyora api listening on :${port}`));
