/* One-time migration ingest endpoint.
   The browser (logged into the OLD veyora.com) harvests the customer/order
   data via the old site's session and POSTs it here, cross-origin. Gated by a
   secret key from the environment (INGEST_KEY); no platform login required
   because the call originates from a different origin without our cookies.
   Writes each payload to the import dir for the importer to consume. */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const r = Router();
const IMPORT = process.env.IMPORT_DIR || '/import';
const KEY = process.env.INGEST_KEY || '';

// permissive CORS just for this endpoint (old-site origin), preflight included
function cors(req, res) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Key');
  res.set('Access-Control-Max-Age', '3600');
}

r.options('/:name', (req, res) => { cors(req, res); res.sendStatus(204); });

r.post('/:name', (req, res) => {
  cors(req, res);
  if (!KEY || req.get('X-Ingest-Key') !== KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const name = String(req.params.name).replace(/[^a-z0-9_-]/gi, '');
  if (!name) return res.status(400).json({ error: 'bad name' });
  const file = path.join(IMPORT, `ingest-${name}.json`);
  fs.mkdirSync(IMPORT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(req.body));
  const count = Array.isArray(req.body) ? req.body.length
    : (req.body && typeof req.body === 'object' ? Object.keys(req.body).length : 0);
  res.json({ ok: true, saved: file, count });
});

export default r;
