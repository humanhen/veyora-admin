/* ================= Veyora Admin — shell: auth, nav, router ================= */
'use strict';

const Auth={
  KEY:'veyora_session',
  current(){
    try{return JSON.parse(sessionStorage.getItem(this.KEY)||localStorage.getItem(this.KEY)||'null');}catch(e){return null;}
  },
  login(email){
    const d=DB.load();
    const u=d.users.find(x=>x.email.toLowerCase()===email.toLowerCase());
    const sess=u?{id:u.id,name:(u.business==='Veyora HQ'?'Veyora admin':(u.firstName+' '+u.lastName)),role:u.role}
               :{id:'u2',name:'Veyora admin',role:'admin'};
    localStorage.setItem(this.KEY,JSON.stringify(sess));
    return sess;
  },
  logout(){localStorage.removeItem(this.KEY);sessionStorage.removeItem(this.KEY);}
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
  register(route,fn){this.routes[route]=fn;},

  init(){
    DB.load();
    /* login form */
    document.getElementById('login-form').addEventListener('submit',e=>{
      e.preventDefault();
      const email=document.getElementById('login-email').value.trim();
      Auth.login(email);
      DB.audit('login','—','Signed in','web');
      location.hash='#/dashboard';
      this.renderShell();
    });
    document.getElementById('login-eye').addEventListener('click',()=>{
      const p=document.getElementById('login-password');
      p.type=p.type==='password'?'text':'password';
    });
    document.getElementById('forgot-link').addEventListener('click',e=>{
      e.preventDefault();
      Modal.open({title:'Reset password',
        body:`<div class="field"><label>Email</label><input class="input" id="fp-email" type="email" placeholder="you@example.com"></div>
              <div class="small muted">We'll email you a link to reset your password.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-send>Send reset link</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-send]').onclick=()=>{
            const em=ov.querySelector('#fp-email').value.trim();
            if(!em)return toast('Enter your email',true);
            close();toast('Reset link sent to '+em);
          };
        }});
    });
    document.getElementById('bell-btn').addEventListener('click',()=>{location.hash='#/tasks';});
    window.addEventListener('hashchange',()=>this.route());
    /* mobile drawer */
    document.getElementById('menu-btn').addEventListener('click',()=>this.toggleDrawer());
    document.getElementById('sidebar-overlay').addEventListener('click',()=>this.toggleDrawer(false));
    /* card-table labels: re-apply after every page/modal render */
    const mo=new MutationObserver(()=>applyTableLabels(document));
    mo.observe(document.getElementById('content'),{childList:true,subtree:true});
    mo.observe(document.getElementById('modal-root'),{childList:true,subtree:true});
    this.renderShell();
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
    if(!sess){login.classList.remove('hidden');app.classList.add('hidden');return;}
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
    const sess=Auth.current();if(!sess)return;
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
      Auth.logout();location.hash='';this.renderShell();
    };
  },

  route(){
    const sess=Auth.current();
    if(!sess){this.renderShell();return;}
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
