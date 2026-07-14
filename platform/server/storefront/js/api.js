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
  cartCount: 0,
  favourites: new Set(),
  // Presentation mode: temporarily hide the customer's own prices so they can
  // show frames to their retail customers. Per-browser, not saved to the server.
  presenting: (() => { try { return localStorage.getItem('veyora_present') === '1'; } catch { return false; } })(),
  realHide: false,      // the account's actual hide-prices setting (from server)
};
