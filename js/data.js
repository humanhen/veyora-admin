/* ================= Veyora Admin — data store (PostgreSQL / API-backed) =================

   Batch 1H. This file used to be a SEEDED DEMO STORE: it generated 1,096
   orders plus 11 named ones — the 1,107 synthetic records seen in the release
   candidate, ending at SO11876 — and kept them in localStorage under
   `veyora_db_v2`, while PostgreSQL held the real 1,128 orders including
   SO11888, SO11889 and BO5003. Staff were reading invented data.

   There is no longer any seeded dataset in this file. Orders and backorders
   come from dedicated authenticated endpoints and NOTHING else; if the API
   fails they stay EMPTY and DB.state becomes 'error', so a page can render an
   honest error with a retry instead of falling back to fiction.

   ORDERS AND BACKORDERS ARE READ-ONLY THROUGH THE SYNC ENGINE. They are
   deliberately absent from SYNCED below, so a page that mutates DB.d.orders in
   browser state changes nothing anywhere — which is why every order and
   backorder action is either wired to a real endpoint here or disabled in the
   UI. A local-only edit cannot masquerade as a saved one.                     */
'use strict';

const DB = (function(){
  const API = '/api';
  let db = null;                 // in-memory dataset (what pages read)
  let shadow = {};               // last-synced state: {collection: Map(id -> json string)}
  let syncTimer = null;
  let syncing = false;
  let dirty = false;

  /* State of the LIVE data (orders, backorders and the supporting snapshot).
     'error' is a first-class state: pages must render it, never paper over it. */
  let state = 'idle';            // idle | loading | ready | error
  let lastError = null;
  let listMeta = { orders:{returned:0,total:0,complete:true},
                   backorders:{returned:0,total:0,complete:true} };

  /* Collections that still sync row-by-row from browser state. Orders and
     backorders are NOT in this list — see the header. */
  const SYNCED = ['warehouses','users','products','returns',
    'purchaseOrders','promotions','campaigns','invoices','payments','creditNotes',
    'collectionFlags','shippingRules','freeShipping','leads','chains','suitcases',
    'spareParts','emailTemplates','tasks','audit'];

  /* Read-only live collections: filled from their own endpoints on every load. */
  const LIVE = ['orders','backorders'];

  function emptyDb(){
    const d = { meta:{}, settings:{sellingFastThreshold:20,cartRecovery:{enabled:false,delayHours:24,minValue:50}} };
    SYNCED.forEach(k => d[k] = []);
    LIVE.forEach(k => d[k] = []);
    d.nextOrderNumber = 0; d.nextBackorderNumber = 0;
    d.nextReturnNumber = 0; d.nextInvoiceNumber = 0;
    return d;
  }

  async function apiCall(method, path, body){
    const res = await fetch(API + path, {
      method, credentials: 'same-origin',
      headers: body ? {'Content-Type':'application/json'} : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch(e){}
    if (res.status === 401) { const e = new Error('Your session has expired — sign in again.'); e.status = 401; throw e; }
    if (res.status === 403) { const e = new Error('Your account does not have access to this data.'); e.status = 403; throw e; }
    if (!res.ok) {
      const e = new Error((data && (data.error||data.message)) || ('HTTP '+res.status));
      e.status = res.status;
      e.data = data;          // e.g. the 409 shortage list from backorder conversion
      throw e;
    }
    return data;
  }

  function buildShadow(){
    shadow = {};
    for (const k of SYNCED){
      shadow[k] = new Map();
      for (const row of db[k]) shadow[k].set(row.id, JSON.stringify(row));
    }
    shadow._settings = JSON.stringify(db.settings);
  }

  /* ---------- bootstrap ---------- */

  /** Orders and backorders come from their OWN endpoints, which carry the full
      record the admin screens need — customer and agent display names, the
      converted order number, stamped currency and rate, addresses, promotion,
      comments and every line. The generic snapshot never had the names or the
      converted order number, so the detail modal showed "—" for them. */
  async function loadLive(){
    const [o, b] = await Promise.all([
      apiCall('GET', '/admin/orders'),
      apiCall('GET', '/admin/backorders'),
    ]);
    db.orders     = Array.isArray(o.orders) ? o.orders : [];
    db.backorders = Array.isArray(b.backorders) ? b.backorders : [];
    listMeta = {
      orders:     { returned:o.returned??db.orders.length, total:o.total??db.orders.length, complete:o.complete!==false },
      backorders: { returned:b.returned??db.backorders.length, total:b.total??db.backorders.length, complete:b.complete!==false },
    };
  }

  async function init(){
    state = 'loading'; lastError = null;
    try {
      const snap = await apiCall('GET', '/admin/snapshot');
      db = emptyDb();
      for (const k of SYNCED){
        if (Array.isArray(snap.collections[k])) db[k] = snap.collections[k];
      }
      db.settings = snap.collections.settings || db.settings;
      db.nextOrderNumber    = snap.meta.nextOrderNumber;
      db.nextBackorderNumber= snap.meta.nextBackorderNumber;
      db.nextReturnNumber   = snap.meta.nextReturnNumber;
      db.nextInvoiceNumber  = snap.meta.nextInvoiceNumber;
      db.nextPoNumber       = snap.meta.nextPoNumber || 1;
      await loadLive();
      buildShadow();
      state = 'ready';
      return true;
    } catch(e){
      /* FAIL VISIBLY. The dataset is left empty rather than seeded, so no page
         can show a synthetic order while the real ones are unreachable. */
      db = emptyDb();
      state = 'error';
      lastError = e;
      throw e;
    }
  }

  /** Re-pull only the live collections — after a conversion, a status change or
      a Retry — without discarding unsynced edits in the other collections. */
  async function refreshLive(){
    if (!db) db = emptyDb();
    try {
      await loadLive();
      if (state !== 'ready') { state = 'ready'; lastError = null; }
      return true;
    } catch(e){
      db.orders = []; db.backorders = [];
      state = 'error'; lastError = e;
      throw e;
    }
  }

  /* ---------- sync engine (non-order collections only) ---------- */
  function computeChanges(){
    const changes = [];
    for (const k of SYNCED){
      const seen = new Set();
      const upserts = [];
      for (const row of db[k]){
        if (!row.id) row.id = uid(k.slice(0,2));
        seen.add(row.id);
        const j = JSON.stringify(row);
        if (shadow[k].get(row.id) !== j) upserts.push({ id: row.id, json: j });
      }
      const deletes = [];
      for (const id of shadow[k].keys()) if (!seen.has(id)) deletes.push(id);
      if (upserts.length || deletes.length){
        changes.push({ collection: k,
          upserts: upserts.map(u => JSON.parse(u.json)),
          deletes,
          _raw: upserts });
      }
    }
    if (JSON.stringify(db.settings) !== shadow._settings){
      changes.push({ collection: 'settings', upserts: [db.settings], deletes: [], _raw: [] });
    }
    return changes;
  }

  async function pushSync(){
    if (!db || state !== 'ready') return;
    if (syncing) { dirty = true; return; }
    const changes = computeChanges();
    if (!changes.length) return;
    syncing = true;
    setSyncBadge('saving');
    try {
      const payload = changes.map(c => ({ collection: c.collection, upserts: c.upserts, deletes: c.deletes }));
      const res = await apiCall('POST', '/admin/sync', { changes: payload });
      /* commit the shadow for exactly what we sent */
      for (const c of changes){
        if (c.collection === 'settings'){ shadow._settings = JSON.stringify(c.upserts[0]); continue; }
        for (const u of c._raw) shadow[c.collection].set(u.id, u.json);
        for (const id of c.deletes) shadow[c.collection].delete(id);
      }
      /* server may have renumbered colliding business numbers */
      if (res.remaps && res.remaps.length){
        for (const m of res.remaps){
          const row = (db[m.collection]||[]).find(r => r.id === m.id);
          if (row){ row.number = m.number; shadow[m.collection].set(row.id, JSON.stringify(row)); }
        }
      }
      setSyncBadge('saved');
    } catch(e){
      if (e.status === 401){ Auth.logout(); location.reload(); return; }
      console.error('sync failed', e);
      setSyncBadge('error');
      toast('Save failed — retrying… (' + e.message + ')', true);
      setTimeout(() => { save(); }, 5000);
    } finally {
      syncing = false;
      if (dirty){ dirty = false; save(); }
    }
  }

  function setSyncBadge(st){
    let el = document.getElementById('sync-badge');
    if (!el){
      const bar = document.querySelector('.topbar .topbar-spacer');
      if (!bar) return;
      el = document.createElement('span');
      el.id = 'sync-badge';
      el.style.cssText = 'font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;margin-left:8px';
      bar.insertAdjacentElement('afterend', el);
    }
    const styles = {
      saving: ['#fef3c7','#b45309','Saving…'],
      saved:  ['#dcfce7','#15803d','Saved'],
      error:  ['#fee2e2','#b91c1c','Save failed'],
    }[st];
    el.style.background = styles[0]; el.style.color = styles[1];
    el.textContent = styles[2];
    if (st === 'saved') setTimeout(() => { if (el.textContent === 'Saved') el.textContent = ''; el.style.background='transparent'; }, 2500);
  }

  /* ---------- public: persistence ---------- */
  function load(){
    if (!db) db = emptyDb();   // pages may touch DB.d before login; empty until init()
    return db;
  }
  function save(){
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushSync, 700);
  }
  function reset(){ location.reload(); }

  /* ---------- audit helper ---------- */
  function audit(action,target,changes,source){
    const s = Auth.current();
    load().audit.unshift({ id: uid('ev'), when: new Date().toISOString(),
      actorId: s?s.id:'system', actorName: s?s.name:'System', actorRole: s?s.role:'system',
      action, target: target||'—', source: source||'web', changes: changes||'', undone: false });
    save();
  }

  /* ---------- lookups ---------- */
  const api = {
    load, save, reset, audit, init,
    flush(){ clearTimeout(syncTimer); return pushSync(); },

    /* Live-data state. Pages MUST consult these before rendering an order or
       backorder surface — `ready` false means show the error, not a list. */
    get state(){ return state; },
    get ready(){ return state === 'ready'; },
    get failed(){ return state === 'error'; },
    get lastError(){ return lastError; },
    get liveMeta(){ return listMeta; },
    refreshLive,

    /* ---- order writes: every one of these is a real, awaited API call ----
       There is no optimistic local write. The server validates, recomputes the
       total from the stored lines, audits, and returns the saved order; the
       caller replaces its copy with that. */
    async patchOrder(idOrNumber, patch){
      const res = await apiCall('PATCH', '/admin/orders/'+encodeURIComponent(idOrNumber), patch);
      if (res && res.order) replaceOrder(res.order);
      return res;
    },
    async generateInvoice(idOrNumber){
      const res = await apiCall('POST', '/admin/orders/'+encodeURIComponent(idOrNumber)+'/invoice');
      if (res && res.invoice){
        const list = load().invoices;
        if (!list.some(i => i.id === res.invoice.id)) list.unshift(res.invoice);
        shadow.invoices && shadow.invoices.set(res.invoice.id, JSON.stringify(res.invoice));
        await refreshLive().catch(()=>{});   // the order now carries invoiceId
      }
      return res;
    },

    /* Staff stock-eligibility decision — a DEDICATED endpoint, never the
       generic row sync, so a debounced snapshot cannot regress it. */
    async setBackorderEligibility(backorderId, eligible){
      return apiCall('POST', '/admin/backorders/'+encodeURIComponent(backorderId)+'/eligibility', { eligible: eligible !== false });
    },
    /* Backorder -> order conversion is performed by the SERVER in one
       transaction (locks, full-coverage check, exact reservation, movements,
       order rebuilt from the backorder's preserved context). The browser must
       never fabricate the order or the stock change itself. Throws an error
       carrying .status and .data so the caller can render the 409 shortages. */
    async convertBackorder(backorderId){
      return apiCall('POST', '/admin/backorders/'+encodeURIComponent(backorderId)+'/convert');
    },
    /* Uploads image files to the server and returns their /s3/ paths. */
    async uploadImages(files){
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('files', f);
      const res = await fetch(API + '/admin/upload', { method:'POST', credentials:'same-origin', body: fd });
      let data = null; try { data = await res.json(); } catch(e){}
      if (!res.ok) throw new Error((data && data.error) || ('HTTP '+res.status));
      return (data && data.paths) || [];
    },
    get d(){ return load(); },
    user(id){ return load().users.find(u=>u.id===id); },
    userName(id){
      const u=api.user(id);
      return u?(u.business||((u.firstName||'')+' '+(u.lastName||'')).trim()||u.username):'—';
    },
    /* Prefer the name the SERVER resolved for this row. A bounded users list,
       a deleted account or a warehouse login that cannot see every user would
       otherwise turn a real customer into "—". */
    orderCustomerName(o){
      return (o && o.customerName) || (o && o.customerId ? api.userName(o.customerId) : '—') || '—';
    },
    orderAgentName(o){
      if (!o || !o.agentId) return '';
      return o.agentName || api.userName(o.agentId);
    },
    product(id){ return load().products.find(p=>p.id===id); },
    productBySku(sku){ sku=String(sku).trim().toLowerCase(); return load().products.find(p=>p.sku.toLowerCase()===sku); },
    variationBySku(sku){
      sku=String(sku).trim().toLowerCase();
      for(const p of load().products){
        for(const v of p.variations){
          if(v.sku.toLowerCase()===sku||String(p.ean).toLowerCase()===sku)return {p,v};
        }
        if(p.sku.toLowerCase()===sku&&p.variations.length)return {p,v:p.variations[0]};
      }
      return null;
    },
    order(id){ return load().orders.find(o=>o.id===id||o.number===id); },
    backorder(id){ return load().backorders.find(b=>b.id===id||b.number===id); },
    variationQty(v){ return Object.values(v.stock||{}).reduce((s,w)=>s+(w.qty||0),0); },
    productQty(p){ return p.variations.reduce((s,v)=>s+api.variationQty(v),0); },
    warehouse(id){ return load().warehouses.find(w=>w.id===id||w.code===id); },
    priceForCustomer(cust,p,v){
      let price=(v&&v.salePrice!=null)?v.salePrice:(v&&v.price!=null?v.price:(p.salePrice!=null?p.salePrice:p.price));
      if(!cust||!cust.pricing)return price;
      const pr=cust.pricing;
      if(pr.mode==='sku'&&pr.skuPrices&&v&&pr.skuPrices[v.sku]!=null)return pr.skuPrices[v.sku];
      if(pr.mode==='brand'&&pr.brands&&pr.brands[p.brand]!=null)return Math.round(price*(1-pr.brands[p.brand]/100)*100)/100;
      if(pr.mode==='cart'&&pr.cartPct)return Math.round(price*(1-pr.cartPct/100)*100)/100;
      if(pr.mode==='tier'&&pr.tiers&&pr.tiers[String(p.price)]!=null)return pr.tiers[String(p.price)];
      return price;
    },
    orderTotal(o){
      const t=o.items.reduce((s,i)=>s+i.qty*i.price,0);
      let disc=o.discount||0;
      if(o.discountPct)disc+=t*o.discountPct/100;
      return Math.max(0,Math.round((t-disc)*100)/100);
    },
    monthlyVelocity(){
      /* units sold per SKU over the last 90 days → per month */
      const cut=new Date(Date.now()-90*864e5);
      const vel={};
      for(const o of load().orders){
        if(o.status==='cancelled')continue;
        if(new Date(o.date)<cut)continue;
        for(const it of o.items)vel[it.sku]=(vel[it.sku]||0)+it.qty;
      }
      Object.keys(vel).forEach(k=>vel[k]=Math.round(vel[k]/3*10)/10);
      return vel;
    }
  };

  /** Swap a freshly saved order into the live list in place, keeping position. */
  function replaceOrder(fresh){
    const list = load().orders;
    const ix = list.findIndex(o => o.id === fresh.id);
    if (ix >= 0) list[ix] = fresh; else list.unshift(fresh);
  }

  return api;
})();
