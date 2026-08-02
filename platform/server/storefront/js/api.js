/* Thin fetch wrapper for the Veyora API (cookie-based auth). */
'use strict';

const API = (function () {
  const BASE = '/api';

  async function call(method, path, body, opts = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401 && !opts.noRedirect) {
      Store.session = null;
      if (!location.hash.startsWith('#/login')) location.hash = '#/login';
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    }
    if (!res.ok) {
      throw Object.assign(new Error(data?.error || data?.message || `HTTP ${res.status}`),
        { status: res.status, data });
    }
    return data;
  }

  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
  };
})();

/* Global client state */
const Store = {
  session: null,        // {user}
  fx: { currency: 'USD', rate: 1, symbol: '$' },  // account currency for price display
  // Server-owned feature switches (from /user/get-user-detail). The default
  // mirrors the API default so the UI is right even before the call lands.
  features: { allowBackorders: true },
  cartCount: 0,
  /* Salesperson "ordering for" context. A convenience only — the server
     re-checks the customer and the actor's permission on every priced request
     and again at checkout, so tampering with this buys nothing. Session-scoped
     so it dies with the tab rather than surprising the next order. */
  actingFor: (() => {
    try { return JSON.parse(sessionStorage.getItem('veyora_acting_for') || 'null'); }
    catch { return null; }
  })(),
  // The TARGET customer's currency/rate while assisting, supplied by the server
  // with every priced response. Null when ordering as yourself.
  orderingFx: null,
  favourites: new Set(),
  // Presentation mode: temporarily hide the customer's own prices so they can
  // show frames to their retail customers. Per-browser, not saved to the server.
  presenting: (() => { try { return localStorage.getItem('veyora_present') === '1'; } catch { return false; } })(),
  realHide: false,      // the account's actual hide-prices setting (from server)
};
