/* ================= Veyora Admin — data store (API-backed) =================
   Same DB.* interface as the demo version, but the dataset lives in Postgres.
   - DB.init() pulls a full snapshot from /api/admin/snapshot.
   - Pages mutate DB.d and call DB.save(); a debounced row-level diff is pushed
     to /api/admin/sync (only rows that actually changed travel).             */
'use strict';

const DB = (function(){
  const API = '/api';
  let db = null;                 // in-memory dataset (what pages read/mutate)
  let shadow = {};               // last-synced state: {collection: Map(id -> json string)}
  let syncTimer = null;
  let syncing = false;
  let dirty = false;

  /* collections that sync row-by-row (order matters: parents before children refs) */
  const SYNCED = ['warehouses','users','products','orders','backorders','returns',
    'purchaseOrders','promotions','campaigns','invoices','payments','creditNotes',
    'collectionFlags','shippingRules','freeShipping','leads','chains','suitcases',
    'emailTemplates','tasks','audit'];

  function emptyDb(){
    const d = { meta:{}, settings:{sellingFastThreshold:20,cartRecovery:{enabled:false,delayHours:24,minValue:50}} };
    SYNCED.forEach(k => d[k] = []);
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
    if (res.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
    if (!res.ok) { const e = new Error((data && (data.error||data.message)) || ('HTTP '+res.status)); e.status = res.status; throw e; }
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
  async function init(){
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
    buildShadow();
    return true;
  }

  /* ---------- sync engine ---------- */
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

  function setSyncBadge(state){
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
    }[state];
    el.style.background = styles[0]; el.style.color = styles[1];
    el.textContent = styles[2];
    if (state === 'saved') setTimeout(() => { if (el.textContent === 'Saved') el.textContent = ''; el.style.background='transparent'; }, 2500);
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

  /* ---------- lookups (unchanged from the demo version) ---------- */
  const api = {
    load, save, reset, audit, init,
    flush(){ clearTimeout(syncTimer); return pushSync(); },
    get d(){ return load(); },
    user(id){ return load().users.find(u=>u.id===id); },
    userName(id){ const u=api.user(id); return u?(u.business||((u.firstName||'')+' '+(u.lastName||'')).trim()||u.username):'—'; },
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
  return api;
})();
