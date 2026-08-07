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

  /* Whether this session may use the whole-database sync at all. Set from the
     server's own answer (GET /admin/access) during boot; null until then.
     A warehouse session is false, and must never reach pushSync — see below. */
  let canSync = null;

  async function pushSync(){
    if (!db || state !== 'ready') return;

    /* DO NOT ATTEMPT A SYNC THIS SESSION CANNOT PERFORM.
       The panel is a whole-database editor, and POST /admin/sync is
       admin-only since finding SEC-002. Without this guard a warehouse login
       got a 403 on every save — and the catch below retried it every five
       seconds forever, with a toast each time. Refusing locally turns an
       endless failure loop into one honest message. */
    if (canSync === false){
      const changes = computeChanges();
      if (!changes.length) return;
      setSyncBadge('readonly');
      return;
    }

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
      /* A 403 is a decision, not a transient failure. Retrying it forever —
         which is what this did — produces an endless toast loop and never
         succeeds. Stop, record that this session cannot sync, and say so
         once. */
      if (e.status === 403){
        canSync = false;
        setSyncBadge('readonly');
        toast('Your account cannot change this data. Nothing was saved.', true);
        return;
      }
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
      /* Not an error — this account is not permitted to change this data, and
         saying "Save failed" would send someone looking for a fault. */
      readonly: ['#e5e7eb','#4b5563','View only'],
    }[st];
    if (!styles) return;
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

  /* ---------- account capability permissions (B2.4B1) ----------

     Explicit, allowlisted shaping of the permission endpoints' responses.
     Nothing is spread: the screen reads exactly these fields and would not
     surface an unrelated field the API might add later. `granted_by` and
     `revoked_by` are read-only here — the server takes the actor from the
     authenticated session and ignores anything a client might send. */
  function shapePermissions(res){
    const r = res || {};
    const u = r.user || {};
    return {
      user: { id:String(u.id||''), displayName:String(u.displayName||''),
              role:String(u.role||''), status:String(u.status||'') },
      permissions: (r.permissions||[]).map(p => ({
        permissionKey: String(p.permissionKey),
        isActive: p.isActive === true,
        grantedBy: p.grantedBy==null?null:String(p.grantedBy),
        grantedAt: p.grantedAt==null?null:String(p.grantedAt),
        revokedBy: p.revokedBy==null?null:String(p.revokedBy),
        revokedAt: p.revokedAt==null?null:String(p.revokedAt),
      })),
      activePermissions: (r.activePermissions||[]).map(String),
      concurrencyToken: r.concurrencyToken==null?null:String(r.concurrencyToken),
      granted: (r.granted||[]).map(String),
      revoked: (r.revoked||[]).map(String),
    };
  }

  /* ---------- enquiry operations shaping (Fast-Track WS2 Phase 2) ----------

     Explicit, allowlisted shaping of the enquiry endpoints' responses.
     Nothing is spread, so a field the API might add later — a delivery state,
     an internal id — cannot arrive on a screen nobody designed it for.

     `fields` is the one place a submitted value reaches the browser. It is
     copied key by key with String() coercion rather than assigned wholesale,
     so a non-string that reached the payload column cannot become a live
     object in the page. */
  function shapeTransitions(map){
    const out = {};
    if (!map || typeof map !== 'object') return out;
    for (const key of Object.keys(map)) {
      if (Array.isArray(map[key])) out[String(key)] = map[key].map(String);
    }
    return out;
  }

  function shapeEnquirySummary(e){
    const r = e || {};
    return {
      id: String(r.id||''),
      formType: String(r.formType||''),
      name: String(r.name||''),
      company: String(r.company||''),
      region: String(r.region||''),
      businessType: String(r.businessType||''),
      handlingStatus: String(r.handlingStatus||''),
      handledAt: r.handledAt==null?null:String(r.handledAt),
      createdAt: r.createdAt==null?null:String(r.createdAt),
    };
  }

  /* One queued staff alert (Final Handover Phase 1).

     The API's serializer already masks the recipient and omits the template
     data; this repeats the allowlist rather than trusting that, because the
     screen below renders these values and a field added to the API later must
     not reach it unreviewed. There is deliberately no provider name, no
     message id and no credential here — an operator needs to know whether
     somebody was told, not how the mail was carried. */
  function shapeNotification(n){
    const r = n || {};
    return {
      id: String(r.id||''),
      notificationType: String(r.notificationType||''),
      status: String(r.status||''),
      recipientMasked: String(r.recipientMasked||''),
      attemptCount: Number(r.attemptCount)||0,
      lastAttemptedAt: r.lastAttemptedAt==null?null:String(r.lastAttemptedAt),
      nextAttemptAt: r.nextAttemptAt==null?null:String(r.nextAttemptAt),
      deliveredAt: r.deliveredAt==null?null:String(r.deliveredAt),
      failedAt: r.failedAt==null?null:String(r.failedAt),
      lastError: String(r.lastError||''),
      createdAt: r.createdAt==null?null:String(r.createdAt),
    };
  }

  function shapeEnquiryDetail(e){
    const r = e || {};
    const fields = {};
    const raw = r.fields;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of Object.keys(raw)) {
        if (typeof raw[key] === 'string') fields[String(key)] = raw[key];
      }
    }
    const ret = r.retention || {};
    return {
      id: String(r.id||''),
      formType: String(r.formType||''),
      fields,
      sourcePath: String(r.sourcePath||''),
      region: String(r.region||''),
      businessType: String(r.businessType||''),
      consentVersion: String(r.consentVersion||''),
      consentAt: r.consentAt==null?null:String(r.consentAt),
      handlingStatus: String(r.handlingStatus||''),
      handledBy: r.handledBy==null?null:String(r.handledBy),
      handledAt: r.handledAt==null?null:String(r.handledAt),
      handlingNote: String(r.handlingNote||''),
      allowedTransitions: Array.isArray(r.allowedTransitions) ? r.allowedTransitions.map(String) : [],
      retention: {
        retentionDays: Number(ret.retentionDays)||0,
        retainUntil: ret.retainUntil==null?null:String(ret.retainUntil),
        daysRemaining: ret.daysRemaining==null?null:Number(ret.daysRemaining),
        expired: ret.expired === true,
      },
      createdAt: r.createdAt==null?null:String(r.createdAt),
      concurrencyToken: r.concurrencyToken==null?null:String(r.concurrencyToken),
      /* `configured: false` with an empty list is the honest "no recipient is
         configured" state, and is distinct from "queued and not yet sent". A
         detail response from an older API has neither, which shapes to the
         same not-configured state rather than to a false all-clear. */
      delivery: {
        configured: (r.delivery||{}).configured === true,
        notifications: Array.isArray((r.delivery||{}).notifications)
          ? r.delivery.notifications.map(shapeNotification) : [],
      },
    };
  }

  /* ---------- store contact shaping (Final Handover Phase 2) ----------

     Explicit, allowlisted shaping. Nothing is spread, so a column the API
     might expose later — `email_normalised`, an internal flag — cannot arrive
     on a screen nobody designed it for.

     A store contact is a named person at a customer, with a mobile number and
     a job. That is why this is an allowlist and not a copy. */
  function shapeContact(c){
    const r = c || {};
    const v = r.verification || {};
    return {
      id: String(r.id||''),
      customerId: String(r.customerId||''),
      firstName: String(r.firstName||''),
      lastName: String(r.lastName||''),
      jobTitle: String(r.jobTitle||''),
      responsibilities: Array.isArray(r.responsibilities) ? r.responsibilities.map(String) : [],
      mobile: String(r.mobile||''),
      officePhone: String(r.officePhone||''),
      officeExtension: String(r.officeExtension||''),
      email: String(r.email||''),
      preferredContactMethod: String(r.preferredContactMethod||'email'),
      preferredLanguage: String(r.preferredLanguage||''),
      isPrimary: r.isPrimary === true,
      isActive: r.isActive !== false,
      portalUserId: r.portalUserId==null?null:String(r.portalUserId),
      notes: String(r.notes||''),
      lastVerifiedAt: r.lastVerifiedAt==null?null:String(r.lastVerifiedAt),
      createdAt: r.createdAt==null?null:String(r.createdAt),
      updatedAt: r.updatedAt==null?null:String(r.updatedAt),
      concurrencyToken: r.concurrencyToken==null?null:String(r.concurrencyToken),
      verification: {
        verifiedAt: v.verifiedAt==null?null:String(v.verifiedAt),
        state: String(v.state||'never'),
        daysSince: v.daysSince==null?null:Number(v.daysSince),
      },
    };
  }

  /* ---------- account statement shaping (Final Handover Phase 6) ----------

     Amounts arrive as display strings alongside minor units, and both are
     carried through unchanged. The browser must never recompute a balance and
     must never format a figure differently from the PDF the customer gets. */
  function shapeStatement(s){
    const r = s || {};
    const p = r.period || {};
    const t = r.totals || {};
    const a = r.ageing || {};
    return {
      currency: String(r.currency||'USD'),
      customer: {
        id: String((r.customer||{}).id||''),
        business: String((r.customer||{}).business||''),
        customerNumber: String((r.customer||{}).customerNumber||''),
      },
      period: { from: String(p.from||''), to: String(p.to||''), label: String(p.label||'') },
      openingMinor: Number(r.openingMinor)||0, opening: String(r.opening||'0.00'),
      closingMinor: Number(r.closingMinor)||0, closing: String(r.closing||'0.00'),
      totals: { debit: String(t.debit||'0.00'), credit: String(t.credit||'0.00') },
      ageing: {
        current: String(a.current||'0.00'), days30: String(a.days30||'0.00'),
        days60: String(a.days60||'0.00'), days90plus: String(a.days90plus||'0.00'),
      },
      lines: Array.isArray(r.lines) ? r.lines.map(l => ({
        kind: String(l.kind||''), date: String(l.date||''),
        reference: String(l.reference||''), description: String(l.description||''),
        debit: String(l.debit||''), credit: String(l.credit||''), balance: String(l.balance||''),
      })) : [],
      generatedAt: String(r.generatedAt||''),
    };
  }

  function shapeStatementRecord(s){
    const r = s || {};
    const d = r.delivery;
    return {
      id: String(r.id||''),
      customerId: String(r.customerId||''),
      periodFrom: String(r.periodFrom||''),
      periodTo: String(r.periodTo||''),
      currency: String(r.currency||''),
      openingMinor: Number(r.openingMinor)||0,
      closingMinor: Number(r.closingMinor)||0,
      lineCount: Number(r.lineCount)||0,
      /* Defaults to 'draft', never to anything that reads as delivered. */
      status: String(r.status||'draft'),
      recipientAddress: String(r.recipientAddress||''),
      recipientReason: String(r.recipientReason||''),
      recipientReasonLabel: String(r.recipientReasonLabel||''),
      generatedAt: r.generatedAt==null?null:String(r.generatedAt),
      sentAt: r.sentAt==null?null:String(r.sentAt),
      lastError: String(r.lastError||''),
      /* Delivery state comes from the outbox. Null means nothing carries it. */
      delivery: d ? {
        status: String(d.status||''),
        attemptCount: Number(d.attemptCount)||0,
        lastAttemptedAt: d.lastAttemptedAt==null?null:String(d.lastAttemptedAt),
        deliveredAt: d.deliveredAt==null?null:String(d.deliveredAt),
        lastError: String(d.lastError||''),
        recipientMasked: String(d.recipientMasked||''),
      } : null,
    };
  }

  /* ---------- finance operation shaping (Final Handover Phase 4) ----------

     The append-only ledger and the payment/credit-note records, allowlisted.
     `idempotencyKey` is deliberately absent from every shape: it is a server
     concern and a browser holding one could replay an operation. */
  function shapeFinancePayment(p){
    const r = p || {};
    return {
      id: String(r.id||''),
      customerId: r.customerId==null?null:String(r.customerId),
      invoiceId: r.invoiceId==null?null:String(r.invoiceId),
      amount: String(r.amount||'0'),
      currency: String(r.currency||'USD'),
      method: String(r.method||''),
      reference: String(r.reference||''),
      paidOn: r.paidOn==null?null:String(r.paidOn),
      notes: String(r.notes||''),
      voidedAt: r.voidedAt==null?null:String(r.voidedAt),
      voidReason: String(r.voidReason||''),
      providerReference: String(r.providerReference||''),
    };
  }

  function shapeFinanceEvent(e){
    const r = e || {};
    return {
      id: String(r.id||''),
      eventType: String(r.eventType||''),
      customerId: r.customerId==null?null:String(r.customerId),
      invoiceId: r.invoiceId==null?null:String(r.invoiceId),
      amountMinor: Number(r.amountMinor)||0,
      currency: String(r.currency||''),
      balanceBefore: r.balanceBefore==null?null:String(r.balanceBefore),
      balanceAfter: r.balanceAfter==null?null:String(r.balanceAfter),
      reference: String(r.reference||''),
      reason: String(r.reason||''),
      /* The actor's name AS RECORDED at the time, not a live lookup: the
         ledger must still read correctly after an account is renamed. */
      actorName: String(r.actorName||''),
      capability: String(r.capability||''),
      createdAt: r.createdAt==null?null:String(r.createdAt),
    };
  }

  /* ---------- invoice payment shaping (Final Handover Phase 3) ----------

     Explicit and allowlisted, like every other shaping function here. Two
     things are deliberately absent and can never arrive: a Stripe key of any
     kind (the API never sends one) and a raw provider event (there isn't one
     to send — only an allowlisted summary is ever stored).

     `hostedUrl` is a BEARER LINK: anyone holding it can pay. It is carried
     only when the API chose to include it, and the pages below never put it in
     a list or a log. */
  function shapePaymentSession(s){
    if(!s) return null;
    const r = s;
    const out = {
      id: String(r.id||''),
      invoiceId: String(r.invoiceId||''),
      status: String(r.status||''),
      amountMinor: Number(r.amountMinor)||0,
      currency: String(r.currency||''),
      providerReference: String(r.providerReference||''),
      expiresAt: r.expiresAt==null?null:String(r.expiresAt),
      completedAt: r.completedAt==null?null:String(r.completedAt),
      lastError: String(r.lastError||''),
      createdAt: r.createdAt==null?null:String(r.createdAt),
    };
    if (typeof r.hostedUrl === 'string' && r.hostedUrl) out.hostedUrl = r.hostedUrl;
    return out;
  }

  function shapeInvoicePayment(p){
    const r = p || {};
    return {
      invoiceId: String(r.invoiceId||''),
      invoiceNumber: String(r.invoiceNumber||''),
      amount: String(r.amount||'0'),
      currency: String(r.currency||'USD'),
      /* Defaults to the honest base state rather than to anything that reads
         as settled: an unrecognised or missing value must never render as
         "paid". */
      settlementState: String(r.settlementState||'on_terms'),
      amountSettledMinor: Number(r.amountSettledMinor)||0,
      amountRefundedMinor: Number(r.amountRefundedMinor)||0,
      settledAt: r.settledAt==null?null:String(r.settledAt),
      settlementReference: String(r.settlementReference||''),
      issuedOn: r.issuedOn==null?null:String(r.issuedOn),
      session: shapePaymentSession(r.session),
    };
  }

  /* ---------- public-content administration shaping (B2.4B2A) ----------

     PUBLIC_CONTENT_EDITABLE mirrors EDITABLE_FIELDS in the API's
     admin-public-serialize.js. The API is the source of truth and re-checks
     everything; this copy exists so the browser cannot even attempt to send a
     field the API would reject, and so an accidental spread of a response
     back into a PATCH is impossible.

     `is_published`, `id`, `sku`, `brand`, `price`, `fact_owner`, `approver_id`
     and `approved_at` are absent on purpose — they are the API's immutable
     set. Publication is a gated operation with its own endpoint, and this
     batch ships no control for it. */
  const PUBLIC_CONTENT_EDITABLE = {
    brand: ['slug','name','short_name','segment','headline','summary','story','ideal_retailer',
      'price_tier_label','design_origin','manufacturing_origin','style_traits','approved_materials',
      'logo_media_id','hero_media_id','publication_state','verification_status','source_reference',
      'last_reviewed_at','scheduled_review_at'],
    product: ['public_slug','name','brand_id','line','shape','segment','public_description',
      'is_featured','is_discontinued','replacement_product_id','publication_state',
      'verification_status','source_reference','last_reviewed_at','scheduled_review_at'],
    variation: ['color','color_code','swatch_media_id'],
  };
  Object.keys(PUBLIC_CONTENT_EDITABLE).forEach(k=>Object.freeze(PUBLIC_CONTENT_EDITABLE[k]));
  Object.freeze(PUBLIC_CONTENT_EDITABLE);

  function pickEditable(entity, changes){
    const allowed = PUBLIC_CONTENT_EDITABLE[entity] || [];
    const out = {};
    for (const key of allowed){
      if (changes && Object.prototype.hasOwnProperty.call(changes, key)) out[key] = changes[key];
    }
    return out;
  }

  /** A response that does not match the documented contract is an error, not
      an empty record — rendering "no content" for a malformed payload is how
      a broken deploy reads as an empty catalogue. */
  function malformed(){
    const e = new Error('The server returned an unexpected response.');
    e.status = 502;
    return e;
  }

  const str = v => v == null ? '' : String(v);
  const idOrNull = v => v == null ? null : String(v);
  const strList = v => Array.isArray(v) ? v.map(String) : [];

  function shapeGovernance(g){
    const o = g || {};
    return {
      publicationState: idOrNull(o.publicationState),
      verificationStatus: idOrNull(o.verificationStatus),
      sourceReference: str(o.sourceReference),
      lastReviewedAt: idOrNull(o.lastReviewedAt),
      scheduledReviewAt: idOrNull(o.scheduledReviewAt),
      contentUpdatedAt: idOrNull(o.contentUpdatedAt),
      factOwnerId: idOrNull(o.factOwnerId),
    };
  }

  /* Each shaper lists every field the screen may read. Nothing about price,
     cost, stock, availability, customers or orders appears in the
     administrative contract, and nothing is copied here by wildcard, so none
     can reach the editor even if the API were to start returning it. */
  function shapeAdminBrand(b){
    return {
      id: str(b.id), slug: idOrNull(b.slug), name: idOrNull(b.name),
      shortName: str(b.shortName), segment: str(b.segment), headline: str(b.headline),
      summary: str(b.summary), story: str(b.story), idealRetailer: str(b.idealRetailer),
      priceTierLabel: str(b.priceTierLabel), designOrigin: str(b.designOrigin),
      manufacturingOrigin: str(b.manufacturingOrigin),
      styleTraits: strList(b.styleTraits), approvedMaterials: strList(b.approvedMaterials),
      logoMediaId: idOrNull(b.logoMediaId), heroMediaId: idOrNull(b.heroMediaId),
      governance: shapeGovernance(b.governance),
      isPublished: b.isPublished === true,
      concurrencyToken: idOrNull(b.concurrencyToken),
      updatedAt: idOrNull(b.updatedAt), createdAt: idOrNull(b.createdAt),
    };
  }

  function shapeAdminProduct(p){
    return {
      id: str(p.id), sku: idOrNull(p.sku), name: idOrNull(p.name),
      publicSlug: idOrNull(p.publicSlug), brandId: idOrNull(p.brandId),
      legacyBrandText: str(p.legacyBrandText), line: str(p.line), shape: str(p.shape),
      segment: str(p.segment), size: str(p.size), publicDescription: str(p.publicDescription),
      categories: strList(p.categories),
      isPublished: p.isPublished === true, isFeatured: p.isFeatured === true,
      isDiscontinued: p.isDiscontinued === true,
      replacementProductId: idOrNull(p.replacementProductId),
      isActiveInPortal: p.isActiveInPortal === true,
      governance: shapeGovernance(p.governance),
      /* Advisories are NON-blocking notes and are returned only on the
         product detail — never by the evaluate endpoint. Kept separate from
         gate reasons so the screen can never present a note as a blocker or
         a blocker as a note. */
      advisories: Array.isArray(p.advisories) ? p.advisories.map(shapeGateReason) : [],
      variations: Array.isArray(p.variations) ? p.variations.map(shapeAdminVariation) : [],
      concurrencyToken: idOrNull(p.concurrencyToken),
      updatedAt: idOrNull(p.updatedAt), createdAt: idOrNull(p.createdAt),
    };
  }

  function shapeAdminVariation(v){
    return {
      id: str(v.id), productId: idOrNull(v.productId), sku: idOrNull(v.sku),
      colorName: str(v.colorName), colorCode: str(v.colorCode),
      swatchMediaId: idOrNull(v.swatchMediaId),
      isPublished: v.isPublished === true, isActiveInPortal: v.isActiveInPortal === true,
      concurrencyToken: idOrNull(v.concurrencyToken), createdAt: idOrNull(v.createdAt),
    };
  }

  /* ---------- publication gate shaping (B2.4B2B) ----------

     A gate reason is {code, message, field}. The API sorts reasons by code so
     two evaluations of the same record are byte-identical; that ORDER IS PART
     OF THE CONTRACT and is preserved exactly here — nothing is re-sorted,
     re-grouped, deduplicated or reworded. A code the browser does not
     recognise still renders, carrying the server's own message.

     `allowed` is read strictly: only an explicit `true` permits publication,
     so a malformed or partial verdict reads as blocked. */
  function shapeGateReason(r){
    return {
      code: str(r && r.code),
      message: str(r && r.message),
      field: (r && r.field) == null ? null : String(r.field),
    };
  }

  function shapeGate(g){
    if (!g || typeof g !== 'object' || !Array.isArray(g.reasons)) return null;
    return {
      allowed: g.allowed === true,
      reasons: g.reasons.map(shapeGateReason),   // server order preserved
    };
  }

  /* The three segment names the administrative router mounts, and the
     serializer for each. Fixed here so no caller can name a path. */
  const PC_SEGMENTS = { brands:'brand', products:'product', variations:'variation' };
  const PC_SHAPERS = { brand:shapeAdminBrand, product:shapeAdminProduct, variation:shapeAdminVariation };

  function pcPath(segment, id, action){
    if (!Object.prototype.hasOwnProperty.call(PC_SEGMENTS, segment)) throw malformed();
    return '/admin/public-content/'+segment+'/'+encodeURIComponent(id)+'/'+action;
  }

  /** Runs the publication gate. Read-only: no body, no token, no mutation. */
  async function gateCall(segment, id){
    const res = await apiCall('POST', pcPath(segment, id, 'evaluate'));
    const gate = shapeGate(res && res.gate);
    if (!gate) throw malformed();
    return gate;
  }

  /** Publish or unpublish. The body carries the token and an optional note —
      never an identity, a state or a flag. */
  async function decide(segment, action, id, concurrencyToken, note, entity){
    const body = { concurrencyToken };
    if (typeof note === 'string' && note.trim() !== '') body.note = note.trim().slice(0, 2000);
    const res = await apiCall('POST', pcPath(segment, id, action), body);
    if (!res || !res[entity]) throw malformed();
    return PC_SHAPERS[entity](res[entity]);
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
    /* ---- server-derived action discovery (warehouse interface correction) ----

       The panel is a whole-database editor and POST /admin/sync is admin-only
       since finding SEC-002. Rather than scatter `role === 'warehouse'` checks
       through nine page files — which drift from the server and teach the next
       contributor that the browser decides authority — the server answers.

       This is a RENDERING HINT. Every request is still authorised server-side;
       hiding a control is a courtesy, not a control. */
    async adminAccess(){
      const res = await apiCall('GET', '/admin/access');
      const a = (res && res.actions) || {};
      /* Strict booleans: a partial or malformed response must read as "no
         action", never as truthy. */
      const actions = {};
      for (const key of Object.keys(a)) actions[String(key)] = a[key] === true;
      canSync = actions['sync.write'] === true;
      return { role: String((res && res.role) || ''), actions };
    },

    /** True only once the server has said so. Null-safe for callers that run
        before discovery completes — they get `false`, which fails closed. */
    get canSync(){ return canSync === true; },

    /* ---- narrow warehouse inventory workflows ----

       These replace the stock edits that used to ride on the whole-database
       sync. Fixed paths built here, `apiCall` still private, and the server
       takes the actor from the session — there is no way to send one. */

    /** One quantity change. `delta` is a signed integer; `reason` is one of
        the server's closed set (receipt, count, damage, return, correction). */
    /** Moves stock by a signed delta.
     *
     *  `idempotencyKey` identifies THE PRESS, not the content (Final Handover
     *  Phase 7). An adjustment is inherently non-idempotent — two genuine
     *  +10s legitimately mean +20 — so the server cannot derive a key from
     *  the request and refuse a repeat. What must not repeat is one press
     *  reaching the server twice through a retry or a resubmitted fetch, and
     *  a per-press key is exactly that. Omitting it keeps the old behaviour. */
    async adjustStock(sku, warehouseId, delta, reason, note, idempotencyKey){
      const res = await apiCall('POST', '/admin/inventory/adjust',
        { sku: String(sku), warehouseId: String(warehouseId),
          delta: Number(delta), reason: String(reason),
          note: note == null ? '' : String(note),
          ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}) });
      if (!res || !res.stock) throw malformed();
      return { sku: String(res.stock.sku), warehouseId: String(res.stock.warehouseId),
               qty: Number(res.stock.qty) || 0 };
    },

    /** An atomic move between two warehouses. */
    async transferStock(sku, fromWarehouseId, toWarehouseId, qty, note){
      const res = await apiCall('POST', '/admin/inventory/transfer',
        { sku: String(sku), fromWarehouseId: String(fromWarehouseId),
          toWarehouseId: String(toWarehouseId), qty: Number(qty),
          note: note == null ? '' : String(note) });
      if (!res || !res.transfer) throw malformed();
      const t = res.transfer;
      return {
        sku: String(t.sku),
        from: { warehouseId: String(t.from.warehouseId), qty: Number(t.from.qty) || 0 },
        to: { warehouseId: String(t.to.warehouseId), qty: Number(t.to.qty) || 0 },
      };
    },

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
    /* ---- account capability permissions (B2.4B1) ----
       Three narrowly scoped calls against the B2.4P endpoints. Each has a
       FIXED path built here — no caller supplies a URL, and `apiCall` stays
       private, so this cannot become a general-purpose API escape hatch.
       Nothing is retried automatically: a mutation that may already have been
       applied must never be replayed without an administrator deciding to.

       The capability set is authorised by the SERVER on every one of these
       calls. Anything the browser believes about permissions is convenience
       only. */

    /** The fixed capability registry. A 403 here is the browser's only honest
        signal that this account does not hold permissions.manage, because the
        session object carries a role and no capabilities. */
    async permissionRegistry(){
      const res = await apiCall('GET', '/admin/account-permissions/registry');
      const list = (res && res.permissions) || [];
      /* Explicit field pick — never spread a response row into the UI. */
      return list.map(p => ({ key:String(p.key), label:String(p.label||p.key),
                              description:String(p.description||'') }));
    },

    /** One account's grants, plus the concurrency token that a later save
        must return unchanged. */
    async accountPermissions(userId){
      const res = await apiCall('GET', '/admin/account-permissions/users/'+encodeURIComponent(userId));
      return shapePermissions(res);
    },

    /** Replaces the account's ACTIVE capability set. `keys` is the complete
        intended set; anything omitted is revoked server-side. The token comes
        from the matching read and is what makes a concurrent overwrite fail
        with 409 instead of silently winning. */
    async saveAccountPermissions(userId, keys, concurrencyToken){
      const res = await apiCall('PUT', '/admin/account-permissions/users/'+encodeURIComponent(userId),
        { permissions: keys, concurrencyToken });
      return shapePermissions(res);
    },

    /* ---- public-content administration (B2.4B2A) ----
       Narrow calls against the B2.4A administrative routes. Fixed paths built
       here, `apiCall` still private, no generic helper, and every response
       shaped through an explicit allowlist below rather than spread.

       Deliberately ABSENT: publish, unpublish and evaluate. Those exist on
       the API but are B2.4B2B's surface — a client function for them here
       would be a publish control waiting for a button. */

    /** The caller's own three public-content capabilities. Authenticated but
        ungated, so an account holding none still gets an honest answer. */
    /** The editable-field allowlist, frozen. Exposed so the editors render
        controls from the same list the client sends, rather than a second
        hand-maintained copy that could drift. */
    get publicContentEditable(){ return PUBLIC_CONTENT_EDITABLE; },

    async publicContentCapabilities(){
      const res = await apiCall('GET', '/admin/public-content/capabilities');
      const c = (res && res.capabilities) || {};
      /* Strict booleans: a malformed or partial response must read as "no
         capability", never as truthy. */
      return { view: c.view === true, edit: c.edit === true, publish: c.publish === true };
    },

    async adminBrands(){
      const res = await apiCall('GET', '/admin/public-content/brands');
      if (!res || !Array.isArray(res.brands)) throw malformed();
      return res.brands.map(shapeAdminBrand);
    },
    async adminBrand(id){
      const res = await apiCall('GET', '/admin/public-content/brands/'+encodeURIComponent(id));
      if (!res || !res.brand) throw malformed();
      return shapeAdminBrand(res.brand);
    },
    async adminProducts(brandId){
      const qs = brandId ? '?brandId='+encodeURIComponent(brandId) : '';
      const res = await apiCall('GET', '/admin/public-content/products'+qs);
      if (!res || !Array.isArray(res.products)) throw malformed();
      return res.products.map(shapeAdminProduct);
    },
    async adminProduct(id){
      const res = await apiCall('GET', '/admin/public-content/products/'+encodeURIComponent(id));
      if (!res || !res.product) throw malformed();
      return shapeAdminProduct(res.product);
    },
    async adminVariation(id){
      const res = await apiCall('GET', '/admin/public-content/variations/'+encodeURIComponent(id));
      if (!res || !res.variation) throw malformed();
      return shapeAdminVariation(res.variation);
    },

    /* PATCH takes an object of CHANGED fields only, already keyed by the
       API's snake_case column names, plus the token from the matching read.
       Callers cannot smuggle anything else: `pickEditable` drops every key
       that is not on the API's own allowlist for that entity. */
    async patchAdminBrand(id, changes, concurrencyToken){
      const res = await apiCall('PATCH', '/admin/public-content/brands/'+encodeURIComponent(id),
        Object.assign(pickEditable('brand', changes), { concurrencyToken }));
      if (!res || !res.brand) throw malformed();
      return shapeAdminBrand(res.brand);
    },
    async patchAdminProduct(id, changes, concurrencyToken){
      const res = await apiCall('PATCH', '/admin/public-content/products/'+encodeURIComponent(id),
        Object.assign(pickEditable('product', changes), { concurrencyToken }));
      if (!res || !res.product) throw malformed();
      return shapeAdminProduct(res.product);
    },
    async patchAdminVariation(id, changes, concurrencyToken){
      const res = await apiCall('PATCH', '/admin/public-content/variations/'+encodeURIComponent(id),
        Object.assign(pickEditable('variation', changes), { concurrencyToken }));
      if (!res || !res.variation) throw malformed();
      return shapeAdminVariation(res.variation);
    },

    /* ---- publication workflow (B2.4B2B) ----

       Nine calls against the governed B2.4A endpoints. Fixed paths, `apiCall`
       still private, no generic helper.

       EVALUATE IS A READ. It runs the gate against stored server state and
       mutates nothing — it does not publish, does not write, and does not
       return a refreshed concurrency token, so callers must leave their token
       untouched across an evaluation.

       PUBLISH AND UNPUBLISH send only the concurrency token and an optional
       note. There is deliberately no way to send an actor, an approver, an
       approval timestamp, `is_published` or `publication_state`: the server
       takes the decision-maker from the authenticated session and writes the
       content_approvals row itself. Crossing the publication boundary is
       possible ONLY through these two endpoints (see the boundary guard in
       routes/admin-public-content.js).

       Nothing is retried automatically — a publication decision that may
       already have been applied must never be replayed by a machine. */

    async evaluateBrand(id){ return gateCall('brands', id); },
    async evaluateProduct(id){ return gateCall('products', id); },
    async evaluateVariation(id){ return gateCall('variations', id); },

    async publishBrand(id, token, note){ return decide('brands', 'publish', id, token, note, 'brand'); },
    async publishProduct(id, token, note){ return decide('products', 'publish', id, token, note, 'product'); },
    async publishVariation(id, token, note){ return decide('variations', 'publish', id, token, note, 'variation'); },

    async unpublishBrand(id, token, note){ return decide('brands', 'unpublish', id, token, note, 'brand'); },
    async unpublishProduct(id, token, note){ return decide('products', 'unpublish', id, token, note, 'product'); },
    async unpublishVariation(id, token, note){ return decide('variations', 'unpublish', id, token, note, 'variation'); },

    /* ---- governed enquiry operations (Fast-Track WS2 Phase 2) ----

       Four calls against /admin/enquiries. Fixed paths built here, `apiCall`
       still private, and every response shaped through an explicit allowlist
       below rather than spread into the UI.

       Deliberately ABSENT: any delete. The API has no DELETE route and this
       client has no function that could reach one — a submission is closed or
       marked spam, never erased from a screen.

       Nothing is retried automatically: a transition that may already have
       been applied must never be replayed by a machine. */

    /** The caller's own two enquiry capabilities, plus the frozen handling
        contract the screen renders its filters and buttons from. Authenticated
        but ungated, so an account holding neither gets an honest answer. */
    async enquiryCapabilities(){
      const res = await apiCall('GET', '/admin/enquiries/capabilities');
      const c = (res && res.capabilities) || {};
      const contract = (res && res.contract) || {};
      /* Strict booleans: a malformed or partial response must read as "no
         capability", never as truthy. */
      return {
        view: c.view === true,
        manage: c.manage === true,
        statuses: Array.isArray(contract.statuses) ? contract.statuses.map(String) : [],
        transitions: shapeTransitions(contract.transitions),
      };
    },

    /** One page of submissions. `status` and `formType` are optional; the
        server validates both against closed sets and 400s on anything else,
        so a stale filter fails loudly instead of quietly listing everything. */
    async enquiries({ status = '', formType = '', limit = 0, offset = 0 } = {}){
      const qs = [];
      if (status) qs.push('status=' + encodeURIComponent(status));
      if (formType) qs.push('formType=' + encodeURIComponent(formType));
      if (limit) qs.push('limit=' + encodeURIComponent(limit));
      if (offset) qs.push('offset=' + encodeURIComponent(offset));
      const res = await apiCall('GET', '/admin/enquiries' + (qs.length ? '?' + qs.join('&') : ''));
      if (!res || !Array.isArray(res.enquiries)) throw malformed();
      return {
        enquiries: res.enquiries.map(shapeEnquirySummary),
        total: Number(res.total) || 0,
        limit: Number(res.limit) || 0,
        offset: Number(res.offset) || 0,
      };
    },

    async enquiry(id){
      const res = await apiCall('GET', '/admin/enquiries/' + encodeURIComponent(id));
      if (!res || !res.enquiry) throw malformed();
      return shapeEnquiryDetail(res.enquiry);
    },

    /** Records a handling decision. The token comes from the matching read and
        is what makes a concurrent overwrite fail with 409 instead of silently
        winning. There is no way to send a handler id: the server takes the
        decision-maker from the authenticated session. */
    async setEnquiryStatus(id, status, concurrencyToken, note){
      const res = await apiCall('POST', '/admin/enquiries/' + encodeURIComponent(id) + '/status',
        { status: String(status), concurrencyToken, note: note == null ? '' : String(note) });
      if (!res || !res.enquiry) throw malformed();
      return shapeEnquiryDetail(res.enquiry);
    },

    /* ---- governed finance operations (Final Handover Phase 4) ----

       These replace direct writes to DB.d.payments, DB.d.creditNotes and
       `user.balance` followed by DB.save(). That path went through the
       whole-database row-diff sync, which the API now refuses for these
       collections — a browser setting a balance is not an edit, it is an
       assertion that the ledger is wrong, and it left no trace of what it
       replaced.

       Deliberately ABSENT: anything that sets a balance, anything that records
       a Stripe payment, and any delete. A payment keyed in error is VOIDED
       with a reason. */

    async financeCapabilities(){
      const res = await apiCall('GET', '/admin/finance/capabilities');
      const c = (res && res.capabilities) || {};
      const k = (res && res.contract) || {};
      return {
        invoice: c.invoice === true,
        record: c.record === true,
        credit: c.credit === true,
        reconcile: c.reconcile === true,
        /* The offline methods the SERVER accepts. Rendered from this rather
           than from a hard-coded list in the page, which is how the old form
           came to offer "credit card" with a space — a value the database
           CHECK constraint would have refused. */
        offlineMethods: Array.isArray(k.offlineMethods) ? k.offlineMethods.map(String) : [],
        currencies: Array.isArray(k.currencies) ? k.currencies.map(String) : [],
      };
    },

    /** Records money that arrived outside Stripe. The server derives the
        idempotency key, so a double-click records the money once. */
    async recordOfflinePayment(fields){
      const res = await apiCall('POST', '/admin/finance/payments', fields);
      if (!res || !res.payment) throw malformed();
      return shapeFinancePayment(res.payment);
    },

    /** Reverses a payment recorded in error. Not a delete: the row stays. */
    async voidPayment(paymentId, reason){
      const res = await apiCall('POST',
        '/admin/finance/payments/' + encodeURIComponent(paymentId) + '/void',
        { confirm: true, reason: String(reason||'') });
      if (!res || !res.payment) throw malformed();
      return shapeFinancePayment(res.payment);
    },

    async issueCreditNote(fields){
      const res = await apiCall('POST', '/admin/finance/credit-notes', fields);
      if (!res || !res.creditNote) throw malformed();
      const n = res.creditNote;
      return {
        id: String(n.id||''), customerId: n.customerId==null?null:String(n.customerId),
        invoiceId: n.invoiceId==null?null:String(n.invoiceId),
        amount: String(n.amount||'0'), currency: String(n.currency||'USD'),
        reason: String(n.reason||''), reference: String(n.reference||''),
        issuedOn: n.issuedOn==null?null:String(n.issuedOn),
      };
    },

    /** Closes a payment-event exception with a note. Settles nothing. */
    async resolvePaymentException(eventId, note){
      const res = await apiCall('POST',
        '/admin/finance/reconciliation/' + encodeURIComponent(eventId) + '/resolve',
        { note: String(note||'') });
      if (!res || !res.event) throw malformed();
      return {
        id: String(res.event.id||''), status: String(res.event.status||''),
        resolutionNote: String(res.event.resolutionNote||''),
      };
    },

    /** The append-only financial ledger. `customerId` optional. */
    async financeLedger(customerId){
      const path = customerId
        ? '/admin/finance/ledger/' + encodeURIComponent(customerId)
        : '/admin/finance/ledger';
      const res = await apiCall('GET', path);
      if (!res || !Array.isArray(res.events)) throw malformed();
      return res.events.map(shapeFinanceEvent);
    },

    /* ---- account statements (Final Handover Phase 6) ----

       Replaces a screen that computed the whole statement in the browser and
       a "Send" button that toasted success having sent nothing.

       Every figure now comes from the SERVER. Deliberately absent: anything
       that marks a statement sent — only the notification outbox's confirmed
       delivery does that. */

    async statementCapabilities(){
      const res = await apiCall('GET', '/admin/statements/capabilities');
      const c = (res && res.capabilities) || {};
      return { view: c.view === true, send: c.send === true };
    },

    /** The currencies a customer has activity in, so one can be chosen. A
        statement covers ONE currency; a running balance mixing two is
        arithmetic nobody can defend. */
    async statementCurrencies(customerId){
      const res = await apiCall('GET',
        '/admin/statements/' + encodeURIComponent(customerId) + '/currencies');
      if (!res || !Array.isArray(res.currencies)) throw malformed();
      return res.currencies.map(c => ({
        currency: String(c.currency||''), movements: Number(c.movements)||0,
      }));
    },

    /** Where a statement WOULD go, and why. Shown before the operator
        commits, so the address is never a surprise. */
    async statementRecipient(customerId, override){
      const qs = override ? '?override=' + encodeURIComponent(override) : '';
      const res = await apiCall('GET',
        '/admin/statements/' + encodeURIComponent(customerId) + '/recipient' + qs);
      const r = (res && res.recipient) || {};
      if (r.ok !== true) return { ok: false, error: String(r.error||''), code: String(r.code||'') };
      return {
        ok: true, address: String(r.address||''), contactId: r.contactId==null?null:String(r.contactId),
        reason: String(r.reason||''), reasonLabel: String(r.reasonLabel||''), name: String(r.name||''),
      };
    },

    /** A preview. Creates NO record — checking a figure must not litter the
        history. Amounts arrive as display strings AND minor units; the
        browser never does the arithmetic. */
    async statementPreview(customerId, from, to, currency){
      const qs = 'from=' + encodeURIComponent(from||'') + '&to=' + encodeURIComponent(to||'')
        + (currency ? '&currency=' + encodeURIComponent(currency) : '');
      const res = await apiCall('GET',
        '/admin/statements/' + encodeURIComponent(customerId) + '/preview?' + qs);
      if (!res || !res.statement) throw malformed();
      return shapeStatement(res.statement);
    },

    async statementHistory(customerId){
      const res = await apiCall('GET',
        '/admin/statements/' + encodeURIComponent(customerId) + '/history');
      if (!res || !Array.isArray(res.statements)) throw malformed();
      return res.statements.map(shapeStatementRecord);
    },

    /** Queues a statement for delivery. Returns it as `queued`, never `sent` —
        the outbox decides that, and only against a provider confirmation. */
    async sendStatement(customerId, fields){
      const res = await apiCall('POST',
        '/admin/statements/' + encodeURIComponent(customerId) + '/send', fields);
      if (!res || !res.statement) throw malformed();
      return shapeStatementRecord(res.statement);
    },

    /* ---- governed invoice payments (Final Handover Phase 3) ----

       Five calls against /admin/payments. Deliberately ABSENT: anything that
       could mark an invoice paid. The API has no such route — only a verified
       Stripe webhook settles an invoice — so there is no client method that
       could reach one, and no amount of UI state can assert a payment. */

    /** The caller's own four payment capabilities, plus whether online payment
        is configured at all. The `stripe` block carries no key: it is
        `enabled`, `mode`, `testMode` and a reason. */
    async paymentCapabilities(){
      const res = await apiCall('GET', '/admin/payments/capabilities');
      const c = (res && res.capabilities) || {};
      const s = (res && res.stripe) || {};
      return {
        view: c.view === true,
        collect: c.collect === true,
        refund: c.refund === true,
        reconcile: c.reconcile === true,
        stripe: {
          enabled: s.enabled === true,
          mode: String(s.mode||'disabled'),
          testMode: s.testMode === true,
          disabledReason: String(s.disabledReason||''),
        },
      };
    },

    async invoicePayment(invoiceId){
      const res = await apiCall('GET', '/admin/payments/invoice/' + encodeURIComponent(invoiceId));
      if (!res || !res.payment) throw malformed();
      return shapeInvoicePayment(res.payment);
    },

    /** Creates the secure link, or returns the live one. Safe to press twice:
        the server reuses an open session rather than opening another. */
    async collectInvoicePayment(invoiceId){
      const res = await apiCall('POST',
        '/admin/payments/invoice/' + encodeURIComponent(invoiceId) + '/collect', {});
      if (!res || !res.payment) throw malformed();
      return { reused: res.reused === true, payment: shapeInvoicePayment(res.payment) };
    },

    /** Sends money back. `confirm` is sent explicitly rather than implied by
        calling this: a refund reached by a mis-click is money gone, and the
        server refuses a body without it. */
    async refundInvoicePayment(invoiceId, reason, amount){
      const body = { confirm: true, reason: String(reason||'') };
      if (amount) body.amount = String(amount);
      const res = await apiCall('POST',
        '/admin/payments/invoice/' + encodeURIComponent(invoiceId) + '/refund', body);
      if (!res || !res.refund) throw malformed();
      const r = res.refund;
      return {
        refundId: String(r.refundId||''), amountMinor: Number(r.amountMinor)||0,
        currency: String(r.currency||''), status: String(r.status||''),
        providerReference: String(r.providerReference||''),
        settlementState: String(r.settlementState||''),
      };
    },

    /** Payment events that could not be applied. Returns the summary the API
        built — there is no raw payload to return. */
    async paymentReconciliation(){
      const res = await apiCall('GET', '/admin/payments/reconciliation');
      if (!res || !Array.isArray(res.exceptions)) throw malformed();
      return res.exceptions.map(e => ({
        id: String(e.id||''),
        providerEventId: String(e.providerEventId||''),
        eventType: String(e.eventType||''),
        status: String(e.status||''),
        invoiceId: e.invoiceId==null?null:String(e.invoiceId),
        amountMinor: e.amountMinor==null?null:Number(e.amountMinor),
        currency: String(e.currency||''),
        lastError: String(e.lastError||''),
        receivedAt: String(e.receivedAt||''),
      }));
    },

    /* ---- governed store contacts (Final Handover Phase 2) ----

       Ten calls against /admin/customer-contacts. Every path segment is
       encoded, every response is shaped through the allowlist above, and every
       write carries the concurrency token from the matching read.

       Deliberately ABSENT: any delete. The API has no DELETE route and this
       client has no function that could reach one — a contact is archived,
       never erased, because an order that names the buyer must still resolve
       to a person after that person moves on.

       Also absent: anything that creates a portal account, records consent,
       or sends a message. The screen renders tel:, mailto: and WhatsApp links
       for a human to click; nothing here contacts anybody. */

    /** The caller's own two contact capabilities, plus the frozen contract the
        screen renders its responsibility and channel pickers from. */
    async contactCapabilities(){
      const res = await apiCall('GET', '/admin/customer-contacts/capabilities');
      const c = (res && res.capabilities) || {};
      const k = (res && res.contract) || {};
      return {
        view: c.view === true,
        manage: c.manage === true,
        responsibilities: Array.isArray(k.responsibilities) ? k.responsibilities.map(String) : [],
        contactMethods: Array.isArray(k.contactMethods) ? k.contactMethods.map(String) : [],
        methodRequires: (k.methodRequires && typeof k.methodRequires === 'object') ? { ...k.methodRequires } : {},
        verificationStaleDays: Number(k.verificationStaleDays) || 0,
      };
    },

    /** Every contact for one store, plus the assigned Veyora sales rep. */
    async storeContacts(customerId){
      const res = await apiCall('GET', '/admin/customer-contacts/' + encodeURIComponent(customerId));
      if (!res || !Array.isArray(res.contacts)) throw malformed();
      const rep = res.salesRep || null;
      const cu = res.customer || {};
      return {
        customer: {
          id: String(cu.id||''), business: String(cu.business||''),
          customerNumber: String(cu.customerNumber||''), status: String(cu.status||''),
        },
        /* Null is a real answer — a store with no rep assigned — and is shown
           as that rather than as a blank name. */
        salesRep: rep ? {
          id: String(rep.id||''), name: String(rep.name||''),
          role: String(rep.role||''), email: String(rep.email||''),
        } : null,
        contacts: res.contacts.map(shapeContact),
        hasPrimary: res.hasPrimary === true,
      };
    },

    async createStoreContact(customerId, fields){
      const res = await apiCall('POST', '/admin/customer-contacts/' + encodeURIComponent(customerId), fields);
      if (!res || !res.contact) throw malformed();
      return shapeContact(res.contact);
    },

    /* One private helper behind six named actions. The ACTION is part of the
       path, not a mode field in the body: a single endpoint that can archive
       or promote depending on a payload key is one whose authorisation has to
       be re-derived from the payload every time somebody reads the code. */
    async _contactAction(customerId, contactId, action, body){
      const res = await apiCall('POST',
        '/admin/customer-contacts/' + encodeURIComponent(customerId)
        + '/' + encodeURIComponent(contactId) + '/' + action, body || {});
      if (!res || !res.contact) throw malformed();
      return shapeContact(res.contact);
    },

    async updateStoreContact(customerId, contactId, fields, concurrencyToken){
      return api._contactAction(customerId, contactId, 'update',
        Object.assign({}, fields, { concurrencyToken }));
    },
    async makeStoreContactPrimary(customerId, contactId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'make-primary', { concurrencyToken });
    },
    async archiveStoreContact(customerId, contactId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'archive', { concurrencyToken });
    },
    async reactivateStoreContact(customerId, contactId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'reactivate', { concurrencyToken });
    },
    async verifyStoreContact(customerId, contactId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'verify', { concurrencyToken });
    },
    async linkStoreContactPortal(customerId, contactId, portalUserId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'link-portal', { portalUserId, concurrencyToken });
    },
    async unlinkStoreContactPortal(customerId, contactId, concurrencyToken){
      return api._contactAction(customerId, contactId, 'unlink-portal', { concurrencyToken });
    },

    /** Re-queues one failed staff alert (Final Handover Phase 1).

        Both ids are path segments and both are encoded. The server checks the
        notification actually belongs to this enquiry, so an id alone cannot
        reach an unrelated message; it also refuses anything not in a retryable
        state with 409, which is why this is never called automatically. */
    async retryEnquiryNotification(enquiryId, notificationId){
      const res = await apiCall('POST', '/admin/enquiries/' + encodeURIComponent(enquiryId)
        + '/notifications/' + encodeURIComponent(notificationId) + '/retry', {});
      if (!res || !res.notification) throw malformed();
      return shapeNotification(res.notification);
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
