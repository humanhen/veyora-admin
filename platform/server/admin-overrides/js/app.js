/* ================= Veyora Admin — shell: auth, nav, router (API-backed) ================= */
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

const NAV=[
  {route:'dashboard',label:'Dashboard',icon:'dashboard'},
  {route:'tasks',label:'Tasks',icon:'tasks'},
  {group:'Sales',icon:'cart',items:[
    {route:'orders',label:'Orders',icon:'orders'},
    {route:'quick-scan',label:'Quick Scan Edit',icon:'scan'},
    {route:'backorders',label:'Backorders',icon:'clock'},
    {route:'returns',label:'Returns',icon:'returns'},
    {route:'promotions',label:'Promotions',icon:'tag'},
    {route:'reports',label:'Reports',icon:'chart'},
  ]},
  {group:'Customers',icon:'users',items:[
    {route:'users',label:'Users',icon:'user'},
    {route:'leads',label:'Leads',icon:'lead'},
    {route:'chains',label:'Chains',icon:'chain'},
    {route:'suitcases',label:'Suitcases',icon:'suitcase'},
    {route:'email-templates',label:'Email Templates',icon:'mailTpl'},
  ]},
  {group:'Catalog',icon:'box',items:[
    {route:'products',label:'Products',icon:'box'},
    {route:'production',label:'Production',icon:'production'},
    {route:'inventory',label:'Inventory',icon:'inventory'},
    {route:'warehouses',label:'Warehouses',icon:'warehouse'},
    {route:'purchasing',label:'Purchasing',icon:'truck'},
    {route:'stock-csv',label:'Stock CSV Import',icon:'fileCsv'},
    {route:'inventory-csv',label:'Inventory CSV (set/adjust)',icon:'fileCsv'},
    {route:'import-data',label:'Import Data',icon:'importData'},
  ]},
  {group:'Finance',icon:'finance',items:[
    {route:'payments',label:'Payments',icon:'payments'},
    {route:'collection',label:'Collection',icon:'collection'},
    {route:'invoices',label:'Invoices',icon:'invoice'},
    {route:'statements',label:'Statements',icon:'statement'},
  ]},
  {group:'Operations',icon:'ops',items:[
    {route:'shipping',label:'Shipping Settings',icon:'truck'},
    {route:'free-shipping',label:'Free Shipping',icon:'gift'},
    {route:'agent-revenue',label:'Agent Revenue',icon:'revenue'},
  ]},
  {route:'audit',label:'Audit log',icon:'audit'},
];

const App={
  routes:{},
  ready:false,          /* snapshot loaded */
  register(route,fn){this.routes[route]=fn;},

  async boot(){
    /* try to resume an existing session (auth cookie + saved session info) */
    const sess=Auth.current();
    if(!sess){this.renderShell();return;}
    try{
      await DB.init();
      this.ready=true;
      this.renderShell();
    }catch(e){
      Auth.logout();
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
        this.ready=true;
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
    if(!sess||!this.ready){login.classList.remove('hidden');app.classList.add('hidden');return;}
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
    for(const n of NAV){
      if(n.route){
        html+=`<a class="nav-item ${cur===n.route?'active':''}" href="#/${n.route}"><span class="nav-ico">${I[n.icon]}</span>${esc(n.label)}</a>`;
      }else{
        const open=App._openGroup===n.group;
        html+=`<button class="nav-item ${open?'open':''}" data-group="${esc(n.group)}"><span class="nav-ico">${I[n.icon]}</span>${esc(n.group)}<span class="nav-caret">${I.caret}</span></button>
        <div class="nav-sub ${open?'open':''}">`;
        for(const it of n.items){
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
      DB.flush();Auth.logout();App.ready=false;location.hash='';this.renderShell();
    };
  },

  route(){
    const sess=Auth.current();
    if(!sess||!this.ready){this.renderShell();return;}
    const {route,args}=this.currentRoute();
    const fn=this.routes[route]||this.routes['dashboard'];
    /* navigating to a page opens its group (and closes the rest) */
    const grp=NAV.find(n=>n.group&&n.items.some(i=>i.route===route));
    if(grp)App._openGroup=grp.group;
    this.toggleDrawer(false); /* close the mobile drawer on navigation */
    this.renderNav();
    this.updateBell();
    const el=document.getElementById('content');
    el.scrollTop=0;window.scrollTo(0,0);
    fn(el,args);
  }
};
