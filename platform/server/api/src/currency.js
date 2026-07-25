/* Multi-currency helper.
   Money is stored in the BASE currency (USD). This module is the single place
   that knows the FX rates (from settings.data.fx) and converts base amounts to
   an account's operating currency. Replaces the old hardcoded ×1.37. */
import { q } from './db.js';

export const ALLOWED_CURRENCIES = ['USD', 'CAD', 'EUR'];
const SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€' };
const DEFAULT_FX = { base: 'USD', rates: { USD: 1, CAD: 1.37, EUR: 0.92 } };

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 60_000;

export function normalizeCurrency(c) {
  const u = String(c || '').toUpperCase();
  return ALLOWED_CURRENCIES.includes(u) ? u : 'USD';
}

export function symbolFor(c) {
  return SYMBOLS[normalizeCurrency(c)] || '$';
}

/** Read the FX config (cached ~60s). Always returns {base, rates} with USD:1. */
export async function getFx() {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;
  let fx = DEFAULT_FX;
  try {
    const { rows } = await q(`select data->'fx' as fx from settings where id=1`);
    if (rows[0]?.fx?.rates) fx = rows[0].fx;
  } catch { /* fall back to defaults */ }
  _cache = { base: fx.base || 'USD', rates: { ...DEFAULT_FX.rates, ...(fx.rates || {}), USD: 1 } };
  _cacheAt = now;
  return _cache;
}

/** Drop the cache so the next read reflects an admin rate change immediately. */
export function invalidateFxCache() { _cache = null; }

/** Rate to multiply a base (USD) amount by to get `currency`. Never 0/NaN. */
export function rateFor(currency, fx) {
  const r = Number(fx?.rates?.[normalizeCurrency(currency)]);
  return r > 0 ? r : 1;
}

/** Convert a base (USD) amount into `currency`, rounded to 2dp. */
export function convert(baseAmount, currency, fx) {
  const n = Number(baseAmount) || 0;
  return Math.round(n * rateFor(currency, fx) * 100) / 100;
}
