/* ================= Veyora Admin — shell: auth, nav, router (API-backed) =================

   Batch 1H. Sign-in is a real authenticated call against the API and the panel
   refuses to render until PostgreSQL data has actually loaded. When the load
   fails the shell shows a visible, retryable error — it never falls back to a
   local dataset, because falling back is how staff came to be reading 1,107
   invented orders in the release candidate.                                   */
'use strict';

const Auth={
  KEY:'veyora_session',
  current(){
    try{return JSON.parse(sessionStorage.getItem(this.KEY)||localStorage.getItem(this.KEY)||'null');}catch(e){return null;}
  },
  async login(email,password){
    const res=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.message||data.error||'Login failed');
    /* Admin data is served only to these roles; say so here rather than letting
       every subsequent request fail with an opaque 403. */
    if(!['admin','warehouse'].includes(data.user.role))
      throw new Error('This account has no admin access');
    const sess={id:data.user.id,
      name:data.user.business==='Veyora HQ'?'Veyora admin':((data.user.firstName||'')+' '+(data.user.lastName||'')).trim()||data.user.business||data.user.email,
      role:data.user.role};
    localStorage.setItem(this.KEY,JSON.stringify(sess));
    return sess;
  },
  logout(){
    fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});
    localStorage.removeItem(this.KEY);sessionStorage.removeItem(this.KEY);
  }
};

/* `action` names a SERVER-REPORTED admin action (see GET /admin/access and
   src/admin-access.js). An entry carrying one is hidden unless the session
   holds it, which is how a `warehouse` login stops seeing screens whose every
   save would 403 since finding SEC-002.

   Entries with NO `action` are readable by any admin-router session. The
   warehouse role keeps them because reading is legitimate — an order it is
   fulfilling, the stock report, the audit trail — and because hiding
   read-only information would make the panel less useful without making it
   safer.

   `catalogue.edit`, `finance.manage`, `users.manage`, `settings.edit` and
   `imports.run` are admin-only, mirroring the sync gate exactly. */
const NAV=[
  {route:'dashboard',label:'Dashboard',icon:'dashboard'},
  {route:'tasks',label:'Tasks',icon:'tasks',action:'users.manage'},
  {group:'Sales',icon:'cart',items:[
    {route:'orders',label:'Orders',icon:'orders'},
    {route:'quick-scan',label:'Quick Scan Edit',icon:'scan'},
    {route:'backorders',label:'Backorders',icon:'clock'},
    {route:'returns',label:'Returns',icon:'returns',action:'catalogue.edit'},
    {route:'spare-parts',label:'Spare Parts',icon:'returns',action:'catalogue.edit'},
    {route:'promotions',label:'Promotions',icon:'tag',action:'finance.manage'},
    {route:'reports',label:'Reports',icon:'chart'},
  ]},
  {group:'Customers',icon:'users',items:[
    {route:'users',label:'Users',icon:'user',action:'users.manage'},
    /* `requires` is a CAPABILITY, not an action: reading the named people who
       work at a customer is a per-account grant, and `users.manage` — which
       covers a customer's commercial record — does not imply it. */
    {route:'store-contacts',label:'Store Contacts',icon:'user',requires:'customer_contacts.view'},
    {route:'leads',label:'Leads',icon:'lead',action:'users.manage'},
    {route:'chains',label:'Chains',icon:'chain',action:'users.manage'},
    {route:'suitcases',label:'Suitcases',icon:'suitcase',action:'users.manage'},
    {route:'email-templates',label:'Email Templates',icon:'mailTpl',action:'users.manage'},
  ]},
  {group:'Catalog',icon:'box',items:[
    {route:'products',label:'Products',icon:'box'},
    {route:'production',label:'Production',icon:'production',action:'catalogue.edit'},
    {route:'inventory',label:'Inventory',icon:'inventory'},
    {route:'warehouses',label:'Warehouses',icon:'warehouse'},
    {route:'purchasing',label:'Purchasing',icon:'truck',action:'catalogue.edit'},
    {route:'stock-csv',label:'Stock CSV Import',icon:'fileCsv',action:'imports.run'},
    {route:'inventory-csv',label:'Inventory CSV (set/adjust)',icon:'fileCsv',action:'imports.run'},
    {route:'import-data',label:'Import Data',icon:'importData',action:'imports.run'},
  ]},
  {group:'Finance',icon:'finance',items:[
    {route:'payments',label:'Payments',icon:'payments',action:'finance.manage'},
    {route:'collection',label:'Collection',icon:'collection',action:'finance.manage'},
    /* Deliberately NOT gated with `requires:'finance.credit_review'`. Nobody
       holds that capability yet, so the entry would be invisible to every
       account and the queue would be unreachable — including for the person
       deciding whether to grant it. The SERVER refuses every call without it,
       and the screen says so plainly instead of rendering an empty list, which
       is the honest failure. Add the gate once grants exist. */
    {route:'credit-reviews',label:'Credit Reviews',icon:'clock',action:'finance.manage'},
    {route:'invoices',label:'Invoices',icon:'invoice',action:'finance.manage'},
    {route:'statements',label:'Statements',icon:'statement',action:'finance.manage'},
  ]},
  {group:'Operations',icon:'ops',items:[
    {route:'shipping',label:'Shipping Settings',icon:'truck',action:'settings.edit'},
    {route:'free-shipping',label:'Free Shipping',icon:'gift',action:'settings.edit'},
    {route:'agent-revenue',label:'Agent Revenue',icon:'revenue',action:'finance.manage'},
  ]},
  /* `requires` names a CAPABILITY (B2.4P), not a role. The entry is hidden
     when the account does not hold it — convenience only. The API is the
     authority: the route itself re-checks, and every request is authorised
     server-side regardless of what the sidebar shows. */
  {route:'public-content',label:'Public Content',icon:'globe',requires:'public_content.view'},
  {route:'enquiries',label:'Enquiries',icon:'mailTpl',requires:'enquiries.view'},
  {route:'account-permissions',label:'Account Permissions',icon:'lock',requires:'permissions.manage'},
  {route:'audit',label:'Audit log',icon:'audit'},
];

const App={
  routes:{},
  ready:false,          /* live data loaded */
  bootError:null,       /* set when the load failed — shown, never hidden */
  register(route,fn){this.routes[route]=fn;},

  /* ---------- account capabilities (B2.4P / B2.4B1) ----------

     The signed-in session carries {id,name,role} and NO capabilities, so the
     browser cannot know from the session alone whether this account holds
     `permissions.manage`. Rather than infer it from the admin role — which
     would be exactly the role bypass account-specific permissions exist to
     remove — the shell asks the server: the capability registry endpoint is
     itself gated on `permissions.manage`, so 200 means held and 403 means not.

     The result is cached for the session because renderNav() runs on every
     navigation. It is a display hint only. It can be stale (another manager
     may revoke mid-session), and that is safe: a stale `true` shows a menu
     entry whose every request the server still refuses, and the screen renders
     the refusal honestly. Nothing is authorised here. */
  caps:null,            /* null = not yet determined; otherwise a Set */
  capsChecked:false,

  can(key){ return this.caps instanceof Set && this.caps.has(key); },

  /** Whether this session may perform an admin ACTION, as the server reported
   *  it. Fails closed: an unknown action, or discovery that has not completed
   *  or failed, is false. Rendering hint only — the API re-checks. */
  may(action){ return !!(this.access && this.access[action] === true); },

  async loadCaps(){
    this.capsChecked=false;
    /* Clear FIRST. If a previous session's capabilities were still in place
       and this probe failed, keeping them would carry one account's menu into
       another's session. */
    this.caps=null;
    const held=new Set();
    try{
      await DB.permissionRegistry();
      held.add('permissions.manage');   /* 200 — the endpoint admitted us */
    }catch(e){
      /* 403 is the normal answer for an account without the capability, and
         is not an error worth surfacing. Anything else (network, 500) also
         leaves the entry hidden: fail closed, never assume authority. */
    }

    /* Public-content capabilities (B2.4B2A). Unlike permissions.manage these
       cannot be probed by a 200/403 on a gated endpoint, because 200 on a
       read would only prove `view` — it could never distinguish a viewer from
       an editor without attempting a write. The dedicated /capabilities
       endpoint answers all three at once, and answers an account holding none.

       Every failure path — 401, 403, network, or a malformed body — leaves
       all three unheld. The client returns strict booleans, so a partial or
       unexpected payload reads as no capability rather than as truthy. */
    try{
      const pc=await DB.publicContentCapabilities();
      if(pc.view)held.add('public_content.view');
      if(pc.edit)held.add('public_content.edit');
      if(pc.publish)held.add('public_content.publish');
    }catch(e){/* fail closed — see above */}

    /* Enquiry capabilities (Fast-Track WS2 Phase 2). A separate probe against
       a separate endpoint, because they are separate capabilities: holding
       public_content.view says nothing about whether this account may read a
       member of the public's contact details, and inferring one from the
       other here would reintroduce exactly the equivalence the capability
       system exists to remove.

       The same all-paths-fail-closed rule applies. The frozen handling
       contract rides along on this response and is cached for the session as
       a rendering hint only — the API re-checks every transition. */
    try{
      const enq=await DB.enquiryCapabilities();
      if(enq.view)held.add('enquiries.view');
      if(enq.manage)held.add('enquiries.manage');
      this._enqContract={statuses:enq.statuses,transitions:enq.transitions};
    }catch(e){/* fail closed — see above */}

    /* Store contact capabilities (Final Handover Phase 2). A third separate
       probe, for the third time and the same reason: being able to publish
       brand copy, or read an enquiry, says nothing about whether this account
       may read the named people who work at a customer. The frozen contract —
       the responsibility allowlist and the channel list — rides along and is
       cached for the session as a rendering hint only.

       Same all-paths-fail-closed rule. */
    try{
      const cc=await DB.contactCapabilities();
      if(cc.view)held.add('customer_contacts.view');
      if(cc.manage)held.add('customer_contacts.manage');
      this._contactContract={
        responsibilities:cc.responsibilities,
        contactMethods:cc.contactMethods,
        methodRequires:cc.methodRequires,
        verificationStaleDays:cc.verificationStaleDays,
      };
    }catch(e){/* fail closed — see above */}

    /* Payment capabilities (Final Handover Phase 3). A fourth separate probe.
       FOUR keys come back, not one: seeing that an invoice was paid, asking a
       customer to pay, sending money back and correcting the books are four
       different authorities, and the panel must be able to show a viewer the
       state without showing them a refund button.

       `_stripe` is cached as a rendering hint so a screen can say "test mode"
       or "online payment is switched off" without a second call. It carries no
       key — the API never sends one. Same all-paths-fail-closed rule. */
    this._stripe = { enabled:false, mode:'disabled', testMode:false, disabledReason:'' };
    try{
      const pay=await DB.paymentCapabilities();
      if(pay.view)held.add('payments.view');
      if(pay.collect)held.add('payments.collect');
      if(pay.refund)held.add('payments.refund');
      if(pay.reconcile)held.add('payments.reconcile');
      this._stripe=pay.stripe;
    }catch(e){/* fail closed — see above */}

    /* Finance capabilities (Final Handover Phase 4). A fifth probe, and the
       last of the capability families. `finance.record` and `finance.credit`
       are separate for a reason the UI has to honour: recording money that
       arrived and forgiving a debt look identical on a balance and are
       completely different decisions.

       The contract carries the SERVER's offline-method list, so the payment
       form renders values the database will actually accept — the old
       hard-coded form offered "credit card" with a space, which the CHECK
       constraint would have refused. Same fail-closed rule. */
    this._financeContract = { offlineMethods:[], currencies:[] };
    try{
      const fin=await DB.financeCapabilities();
      if(fin.invoice)held.add('finance.invoice');
      if(fin.record)held.add('finance.record');
      if(fin.credit)held.add('finance.credit');
      if(fin.reconcile)held.add('finance.reconcile');
      this._financeContract={offlineMethods:fin.offlineMethods,currencies:fin.currencies};
    }catch(e){/* fail closed — see above */}

    /* Admin ACTIONS, distinct from capabilities (warehouse interface
       correction). Capabilities are per-account grants; actions describe what
       this session's ROLE may do on the admin router — above all whether it
       may use the whole-database sync, which is admin-only since finding
       SEC-002.

       Asking the server is deliberate. The alternative is `role ===
       'warehouse'` scattered through nine page files, which drifts from the
       server and teaches the next contributor that the browser decides
       authority. Same fail-closed rule: any failure leaves every action
       unheld, so a control is hidden rather than shown-and-broken. */
    this.access={};
    try{
      const access=await DB.adminAccess();
      this.access=access.actions;
    }catch(e){/* fail closed — no action is held */}

    this.caps=held;
    this.capsChecked=true;
    return held;
  },

  async boot(){
    /* try to resume an existing session (auth cookie + saved session info) */
    const sess=Auth.current();
    if(!sess){this.renderShell();return;}
    await this.loadData();
  },

  /** Load live data. A 401/403 means the session is genuinely gone, so return
      to sign-in; anything else (API down, network, 500) is shown as a
      retryable error rather than silently logging the user out. */
  async loadData(){
    this.bootError=null;
    try{
      await DB.init();
      this.ready=true;
      /* Capability probe. Deliberately not awaited before the first paint —
         the panel must not wait on it — but it re-renders the nav when it
         settles so the entry appears without a manual reload. */
      this.loadCaps().then(()=>{ if(this.ready)this.renderNav(); }).catch(()=>{});
      this.renderShell();
    }catch(e){
      this.ready=false;
      if(e&&(e.status===401||e.status===403)){
        Auth.logout();
        this.renderShell();
        return;
      }
      this.bootError=e;
      this.renderShell();
    }
  },

  init(){
    /* login form */
    document.getElementById('login-form').addEventListener('submit',async e=>{
      e.preventDefault();
      const btn=e.target.querySelector('.login-submit');
      const email=document.getElementById('login-email').value.trim();
      const password=document.getElementById('login-password').value;
      btn.disabled=true;btn.textContent='SIGNING IN…';
      try{
        await Auth.login(email,password);
        await DB.init();
        this.ready=true;this.bootError=null;
        this.loadCaps().then(()=>{ if(this.ready)this.renderNav(); }).catch(()=>{});
        DB.audit('login','—','Signed in','web');
        location.hash='#/dashboard';
        this.renderShell();
      }catch(ex){
        toast(ex.message||'Login failed',true);
      }finally{
        btn.disabled=false;btn.textContent='SIGN IN';
      }
    });
    document.getElementById('login-eye').addEventListener('click',()=>{
      const p=document.getElementById('login-password');
      p.type=p.type==='password'?'text':'password';
    });
    document.getElementById('forgot-link').addEventListener('click',e=>{
      e.preventDefault();
      Modal.open({title:'Reset password',
        body:`<div class="field"><label>Email</label><input class="input" id="fp-email" type="email" placeholder="you@example.com"></div>
              <div id="fp-step2" class="hidden">
                <div class="field"><label>6-digit code (check your email)</label><input class="input" id="fp-code" inputmode="numeric"></div>
                <div class="field"><label>New password (8+ characters)</label><input class="input" id="fp-pass" type="password"></div>
              </div>
              <div class="small muted" id="fp-hint">We'll email you a one-time code.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-send>Send code</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          const btn=ov.querySelector('[data-send]');
          let stage=1;
          btn.onclick=async()=>{
            const em=ov.querySelector('#fp-email').value.trim();
            if(!em)return toast('Enter your email',true);
            try{
              if(stage===1){
                await fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em})});
                ov.querySelector('#fp-step2').classList.remove('hidden');
                ov.querySelector('#fp-hint').textContent='Code sent — it expires in 15 minutes.';
                btn.textContent='Set new password';stage=2;
              }else{
                const code=ov.querySelector('#fp-code').value.trim();
                const pass=ov.querySelector('#fp-pass').value;
                const v=await fetch('/api/auth/verify-forgot-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,code})}).then(r=>r.json());
                if(!v.token)throw new Error(v.error||'Invalid code');
                const s=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:v.token,password:pass})}).then(r=>r.json());
                if(!s.ok)throw new Error(s.error||'Could not set password');
                close();toast('Password updated — sign in with your new password');
              }
            }catch(ex){toast(ex.message,true);}
          };
        }});
    });
    document.getElementById('bell-btn').addEventListener('click',()=>{location.hash='#/tasks';});
    window.addEventListener('hashchange',()=>this.route());
    /* push any unsent edits before the tab closes */
    window.addEventListener('beforeunload',()=>{if(this.ready)DB.flush();});
    /* mobile drawer */
    document.getElementById('menu-btn').addEventListener('click',()=>this.toggleDrawer());
    document.getElementById('sidebar-overlay').addEventListener('click',()=>this.toggleDrawer(false));
    /* card-table labels: re-apply after every page/modal render */
    const mo=new MutationObserver(()=>applyTableLabels(document));
    mo.observe(document.getElementById('content'),{childList:true,subtree:true});
    mo.observe(document.getElementById('modal-root'),{childList:true,subtree:true});
    this.boot();
  },

  toggleDrawer(force){
    const sb=document.getElementById('sidebar');
    const ov=document.getElementById('sidebar-overlay');
    const open=force!==undefined?force:!sb.classList.contains('open');
    sb.classList.toggle('open',open);
    ov.classList.toggle('hidden',!open);
    document.body.style.overflow=open?'hidden':'';
  },

  renderShell(){
    const sess=Auth.current();
    const login=document.getElementById('login-screen'),app=document.getElementById('app');
    /* The shell is shown once signed in EVEN IF the data load failed, so the
       failure is visible inside the panel with a retry — not disguised as a
       sign-in prompt. */
    if(!sess||(!this.ready&&!this.bootError)){login.classList.remove('hidden');app.classList.add('hidden');return;}
    login.classList.add('hidden');app.classList.remove('hidden');
    document.getElementById('topbar-username').textContent=sess.name;
    document.getElementById('topbar-userrole').textContent=sess.role.charAt(0).toUpperCase()+sess.role.slice(1);
    const av=document.getElementById('topbar-avatar');
    av.textContent=(sess.name||'V').charAt(0).toUpperCase();
    av.insertAdjacentHTML('beforeend','<img src="assets/avatar.jpg" alt="" onerror="this.remove()">');
    this.renderNav();
    this.updateBell();
    if(!location.hash||location.hash==='#/')location.hash='#/dashboard';
    this.route();
  },

  updateBell(){
    const sess=Auth.current();if(!sess||!this.ready)return;
    const n=DB.d.tasks.filter(t=>t.status==='open'&&t.assignedTo===sess.id&&t.unread).length;
    const b=document.getElementById('bell-badge');
    b.textContent=n;b.classList.toggle('hidden',n===0);
  },

  currentRoute(){
    const h=location.hash.replace(/^#\//,'');
    const [route,...rest]=h.split('/');
    return {route:route||'dashboard',args:rest};
  },

  renderNav(){
    const nav=document.getElementById('side-nav');
    const cur=this.currentRoute().route;
    let html='';
    /* accordion: only one group open at a time */
    if(App._openGroup===undefined)App._openGroup=null;
    /* An entry is shown only when its precondition holds:
         `requires` — a per-account CAPABILITY (B2.4P);
         `action`   — a server-reported admin ACTION (warehouse correction).
       Both are cosmetic: the route and the API refuse independently. An
       entry with neither is visible to any admin-router session. */
    const permitted=n=>(!n.requires||this.can(n.requires))&&(!n.action||this.may(n.action));
    for(const n of NAV){
      if(n.route){
        if(!permitted(n))continue;
        html+=`<a class="nav-item ${cur===n.route?'active':''}" href="#/${n.route}"><span class="nav-ico">${I[n.icon]}</span>${esc(n.label)}</a>`;
      }else{
        const items=n.items.filter(permitted);
        if(!items.length)continue;
        const open=App._openGroup===n.group;
        html+=`<button class="nav-item ${open?'open':''}" data-group="${esc(n.group)}"><span class="nav-ico">${I[n.icon]}</span>${esc(n.group)}<span class="nav-caret">${I.caret}</span></button>
        <div class="nav-sub ${open?'open':''}">`;
        for(const it of items){
          html+=`<a class="nav-item ${cur===it.route?'active':''}" href="#/${it.route}"><span class="nav-ico">${I[it.icon]}</span>${esc(it.label)}</a>`;
        }
        html+='</div>';
      }
    }
    html+=`<div class="nav-logout"><button class="nav-item" id="logout-btn"><span class="nav-ico">${I.logout}</span>Logout</button>
      <img class="sidebar-gif" src="assets/logout.gif" alt=""></div>`;
    nav.innerHTML=html;
    nav.querySelectorAll('[data-group]').forEach(b=>{
      b.onclick=()=>{
        const g=b.dataset.group;
        App._openGroup=(App._openGroup===g)?null:g; /* opening one closes the others */
        this.renderNav();
      };
    });
    document.getElementById('logout-btn').onclick=()=>{
      if(this.ready)DB.flush();
      /* Capabilities belong to the signed-in account — drop them with it, so
         the next sign-in re-probes instead of inheriting the last one's menu. */
      Auth.logout();App.ready=false;App.bootError=null;App.caps=null;App.capsChecked=false;
      location.hash='';this.renderShell();
    };
  },

  route(){
    const sess=Auth.current();
    if(!sess||(!this.ready&&!this.bootError)){this.renderShell();return;}
    const {route,args}=this.currentRoute();
    const grp=NAV.find(n=>n.group&&n.items.some(i=>i.route===route));
    if(grp)App._openGroup=grp.group;
    this.toggleDrawer(false); /* close the mobile drawer on navigation */
    this.renderNav();
    this.updateBell();
    const el=document.getElementById('content');
    el.scrollTop=0;window.scrollTo(0,0);
    /* Data never loaded: show the failure on EVERY page rather than letting
       each one render an empty table that reads like "no orders exist". */
    if(this.bootError){
      liveDataError(el,this.bootError,()=>this.loadData(),
        'The admin panel could not load data from the server.');
      return;
    }
    const fn=this.routes[route]||this.routes['dashboard'];
    fn(el,args);
  }
};
