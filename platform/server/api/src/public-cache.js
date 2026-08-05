/* A small in-process read cache for the public API boundary (B2.2) —
   deliberately not the existing catalogue cache in routes/catalog.js
   (`_catalogRows`/`_shapedCache`): that cache is keyed by pricing identity
   and this one must never be, since /public/* has no identity at all. Same
   idea (TTL'd in-memory map, cheap and correct for a single-process API),
   kept as its own small module so the public boundary owns its own cache
   lifecycle independent of the authenticated catalogue's.

   Holds only what a router handler explicitly puts in it — published,
   already-serialized response bodies. No prices, no session/user identity
   is ever part of a key or a value here, by construction of what calls
   into this module (see routes/public.js — the request's query state is
   the only key input). */

const TTL_MS = 60_000;
const MAX_ENTRIES = 500; // bounded so an unbounded query-string space can't grow this forever

const store = new Map(); // key -> { at, value }

/** Stable cache key: endpoint name + every query param, sorted so
 * `?brand=a&shape=b` and `?shape=b&brand=a` hit the same entry. Only
 * plain scalars are expected — no session/user identity is ever passed
 * in here. */
export function buildCacheKey(endpoint, params = {}) {
  const sortedEntries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  const normalised = sortedEntries.map(([k, v]) => `${k}=${String(v)}`).join('&');
  return `${endpoint}?${normalised}`;
}

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Only ever call this with a successful, already-serialized response —
 * never a validation error, a 404, or a server error (routes/public.js
 * enforces this by only calling setCached on the success path). */
export function setCached(key, value) {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    // Map preserves insertion order — evict the oldest entry rather than
    // let the key space grow without bound.
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { at: Date.now(), value });
}

/** Exported for later admin/Zoho wiring (B2.4+) — publishing or
 * unpublishing a brand/model/location should call this so a stale
 * response doesn't outlive its 60-second TTL unnecessarily. Not called
 * from any admin or Zoho module in this batch; that wiring is explicitly
 * out of scope for B2.2. */
export function invalidatePublicCache() {
  store.clear();
}

/** Test/diagnostic only — never used by a route handler. */
export function _cacheSizeForTesting() {
  return store.size;
}
