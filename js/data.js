/* ================= Veyora Admin — data store (localStorage, seeded demo data) =================
   Front-end demo store. Swap DB.* calls for real API calls when connecting a backend. */
'use strict';

const DB = (function(){
  const KEY='veyora_db_v2';
  let db=null;

  /* deterministic RNG so demo data is stable across reloads */
  function rng(seed){let s=seed>>>0;return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

  const BRANDS=['Charlett','Spike','Saint Cloud','Liv','Specterfeid','Monroe','Aster'];
  const COLORS=['Black','Havana','Crystal','Tortoise','Gold','Silver','Rose','Green','Blue','Brown','Grey','Champagne','Navy','Olive'];
  const CITIES_US=['New York','Brooklyn','Monsey','Los Angeles','Chicago','Miami','Boston','Houston','Atlanta','Seattle','Denver','Augusta','Lakewood','Baltimore','Philadelphia'];
  const CITIES_CA=['Toronto','Montreal','Vancouver','Ottawa','Calgary','Delson','Laval','Quebec City'];
  const FIRST=['Sarah','David','Rachel','Michael','Leah','Daniel','Esti','Jacob','Mira','Aaron','Chana','Isaac','Rivka','Nathan','Tova','Eli','Dina','Sam','Yael','Ben'];
  const LAST=['Cohen','Levi','Schrier','Gefen','Shelle','Ibrahim','Paul','Klein','Weiss','Gross','Adler','Stern','Roth','Katz','Berger','Fried','Blum','Hass','Perl','Marcus'];
  const BIZWORDS=['Optical','Optics','Vision','Eye Care','Eyewear','Lunettes','Optique','Sight','Lens Studio','Vue'];

  function seed(){
    const R=rng(20260706);
    const pick=a=>a[Math.floor(R()*a.length)];
    const d={meta:{seeded:true,version:1},
      settings:{sellingFastThreshold:20,cartRecovery:{enabled:false,delayHours:24,minValue:50}}};

    /* ---- warehouses ---- */
    d.warehouses=[
      {id:'wh_us',code:'israel_fulfillment',name:'Main Fulfillment'},
      {id:'wh_eu',code:'eu_fulfillment',name:'EU Fulfillment'},
      {id:'wh_rs',code:'reserve',name:'Reserve (backstock)'},
    ];

    /* ---- users ---- */
    const users=[];
    let custNum=1001;
    function addUser(u){
      const base={id:'u'+(users.length+1),username:'',firstName:'',lastName:'',phone:'',business:'',
        customerNumber:String(custNum++),taxId:'',country:'US',address:'',city:'',state:'',zip:'',
        role:'customer',agentId:null,paymentTerms:30,hidePrices:false,status:'active',
        pricing:{mode:'none'},balance:0,createdAt:'2026-01-15'};
      users.push(Object.assign(base,u));return users[users.length-1];
    }
    addUser({username:'office',firstName:'Office',lastName:'Veyora',business:'Veyora HQ',email:'office@veyora.com',role:'admin',protected:true});
    addUser({username:'admin',firstName:'Veyora',lastName:'Admin',business:'Veyora HQ',email:'admin@veyora.com',role:'admin',protected:true});
    const agents=[
      addUser({username:'m.rosen',firstName:'Mendy',lastName:'Rosen',business:'Veyora Sales',email:'mendy@veyora.com',role:'agent',city:'Brooklyn'}),
      addUser({username:'s.dahan',firstName:'Sarah',lastName:'Dahan',business:'Veyora Sales',email:'sarah.d@veyora.com',role:'agent',city:'Montreal',country:'CA'}),
      addUser({username:'j.perl',firstName:'Jack',lastName:'Perl',business:'Veyora Sales',email:'jack.p@veyora.com',role:'super-agent',city:'Los Angeles'}),
      addUser({username:'l.stern',firstName:'Lea',lastName:'Stern',business:'Veyora Sales',email:'lea.s@veyora.com',role:'agent',city:'Toronto',country:'CA'}),
    ];
    addUser({username:'warehouse',firstName:'Ware',lastName:'House',business:'Veyora HQ',email:'warehouse@veyora.com',role:'warehouse'});
    const namedCustomers=[
      {business:'Eye Optical',username:'eye-optical',email:'eye-optical@import.veyora.local',status:'pending'},
      {business:'Smart Eye Care - Augusta',username:'smart-eye-care-augusta',email:'smart-eye-care-augusta@import.veyora.local',status:'pending',city:'Augusta'},
      {business:'Misson Optics',username:'misson-optics',email:'misson-optics@import.veyora.local',status:'pending'},
      {business:'Clinique Visuelle simple vision Delson inc',username:'clinique-visuelle-simple-vision-delson-i',email:'clinique-visuelle-simple-vision-delson-i@import.veyora.local',status:'pending',country:'CA',city:'Delson'},
      {business:'Hakim Optical Canada',username:'hakim-optical-canada',email:'hakim-optical-canada@import.veyora.local',status:'pending',country:'CA',city:'Toronto'},
      {business:'Schrier Optical',username:'schrier-optical',email:'schrier@optonline.net',city:'Monsey'},
      {business:'Gefen Optical LLC',username:'gefen-optical',email:'gefen.optical@gmail.com',city:'Brooklyn'},
      {business:'LA Optics New York',username:'la-optics-ny',email:'laoptics.ny@gmail.com',city:'New York'},
      {business:'Shelle Optical',username:'shelle-optical',email:'shelleoptical@gmail.com',city:'Lakewood'},
      {business:'Pierre Ibrahim',username:'pierre-ibrahim',email:'pierre.ibrahim@videotron.ca',country:'CA',city:'Montreal'},
      {business:'Fashion In Optics',username:'fashion-in-optics',email:'fashioninoptics@aol.com',city:'Brooklyn'},
      {business:'Paul Optical',username:'paul-optical',email:'pauloptical@gmail.com',city:'Baltimore'},
      {business:'Main Street Optical Monsey',username:'mainst-optical',email:'mainst.optical@gmail.com',city:'Monsey'},
    ];
    namedCustomers.forEach((c,i)=>{
      addUser(Object.assign({firstName:pick(FIRST),lastName:pick(LAST),role:'customer',
        agentId:agents[i%agents.length].id,city:c.city||pick(CITIES_US)},c));
    });
    while(users.length<156){
      const fn=pick(FIRST),ln=pick(LAST);
      const ca=R()<0.22;const city=ca?pick(CITIES_CA):pick(CITIES_US);
      const biz=(R()<.5?city+' ':fn+' ')+pick(BIZWORDS)+(R()<.12?' Inc':'');
      const uname=biz.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')+'-'+users.length;
      addUser({username:uname,firstName:fn,lastName:ln,business:biz,
        email:uname+'@import.veyora.local',country:ca?'CA':'US',city,
        role:R()<.05?'special customer':'customer',
        agentId:agents[Math.floor(R()*agents.length)].id,
        status:R()<.4?'pending':'active',
        balance:R()<.3?Math.round(R()*4200):0,
        paymentTerms:pick([15,30,30,45,60]),
        createdAt:'2026-0'+(1+Math.floor(R()*6))+'-'+String(1+Math.floor(R()*28)).padStart(2,'0')});
    }
    d.users=users;
    const customers=users.filter(u=>['customer','special customer'].includes(u.role));

    /* ---- products ---- */
    const products=[];
    function addProduct(p){
      const brand=p.brand||pick(BRANDS);
      const base={id:'p'+(products.length+1),name:'',sku:'',size:pick(['48-20','50-21','52-18','54-17','46-22']),
        categories:[],ean:'',brand,tags:[],images:[],description:'',
        attributes:{lens_w:44+Math.floor(R()*14),bridge:16+Math.floor(R()*8),lens_h:30+Math.floor(R()*14),temple:135+Math.floor(R()*15),lensType:pick(['CR-39','Polycarbonate','Demo']),caseCode:'C'+(100+Math.floor(R()*60))},
        price:0,salePrice:null,variations:[],createdAt:'2026-06-09',updatedAt:'2026-06-18'};
      const prod=Object.assign(base,p);
      if(!prod.variations.length){
        const n=1+Math.floor(R()*3);
        for(let i=0;i<n;i++){
          const color=COLORS[Math.floor(R()*COLORS.length)];
          const st={};
          d.warehouses.forEach(w=>{st[w.id]={qty:Math.floor(R()*(w.id==='wh_rs'?40:90)),shelf:(w.id==='wh_rs'?'R':'A')+(1+Math.floor(R()*20))+'-'+(1+Math.floor(R()*6))};});
          prod.variations.push({sku:prod.sku+'.'+(i+1),color,image:null,price:prod.price,salePrice:prod.salePrice,stockStatus:'in stock',stock:st});
        }
      }
      products.push(prod);return prod;
    }
    addProduct({name:'Charlett 158',sku:'158',brand:'Charlett',price:35,
      categories:['Charlett','Eyeglasses','Sunglasses','Women','Plastic'],tags:['acetate','handmade'],
      createdAt:'2026-06-17',updatedAt:'2026-06-17',ean:'3700123456789',
      variations:[
        {sku:'158.1',color:'Black',image:null,price:35,salePrice:null,stockStatus:'in stock',stock:{wh_us:{qty:80,shelf:'A3-1'},wh_eu:{qty:40,shelf:'B1-2'},wh_rs:{qty:30,shelf:'R2-1'}}},
        {sku:'158.2',color:'Havana',image:null,price:35,salePrice:null,stockStatus:'out of stock',stock:{wh_us:{qty:0,shelf:'A3-2'},wh_eu:{qty:0,shelf:'B1-3'},wh_rs:{qty:0,shelf:'R2-2'}}},
      ]});
    addProduct({name:'Spike 709',sku:'709',brand:'Spike',price:17,categories:['Spike','Eyeglasses','Women','Men','Kids','Plastic'],createdAt:'2026-06-09'});
    addProduct({name:'Spike 708',sku:'708',brand:'Spike',price:17,categories:['Spike','Eyeglasses','Women','Men','Kids','Plastic'],createdAt:'2026-06-09'});
    addProduct({name:'Spike 683',sku:'683',brand:'Spike',price:17,categories:['Spike','Eyeglasses','Women','Metal'],createdAt:'2026-06-09'});
    addProduct({name:'Spike 650',sku:'650',brand:'Spike',price:17,categories:['Spike','Eyeglasses','Women','Metal'],createdAt:'2026-06-09'});
    addProduct({name:'Liv London 20858',sku:'20858',brand:'Liv',price:65,categories:['Liv','Eyeglasses','Women','Plastic']});
    addProduct({name:'Specterfeid Plastic Optical Frame',sku:'SPF-2201',brand:'Specterfeid',price:29,categories:['Specterfeid','Eyeglasses','Men','Plastic']});
    let skuN=1600;
    while(products.length<921){
      const brand=pick(BRANDS);
      const sku=String(skuN++);
      const price=pick([15,17,22,29,35,35,45,55,65,79]);
      addProduct({name:brand+' '+sku,sku,brand,price,salePrice:R()<.12?Math.round(price*.8):null,
        categories:[brand,pick(['Eyeglasses','Sunglasses']),pick(['Women','Men','Kids']),pick(['Plastic','Metal'])],
        tags:R()<.15?['new']:[],
        createdAt:'2026-0'+(1+Math.floor(R()*6))+'-'+String(1+Math.floor(R()*28)).padStart(2,'0')});
    }
    d.products=products;

    /* ---- orders ---- */
    const orders=[];
    function mkItems(n){
      const items=[];
      for(let i=0;i<n;i++){
        const p=products[Math.floor(R()*products.length)];
        const v=p.variations[Math.floor(R()*p.variations.length)];
        items.push({sku:v.sku,name:p.name,color:v.color,qty:1+Math.floor(R()*5),
          price:(v.salePrice!=null?v.salePrice:p.price),collected:0});
      }
      return items;
    }
    function calcTotal(o){
      const t=o.items.reduce((s,i)=>s+i.qty*i.price,0);
      return Math.max(0,Math.round((t-(o.discount||0))*100)/100);
    }
    function addOrder(o){
      const base={id:'o'+(orders.length+1),number:'',customerId:null,agentId:null,
        date:'2026-06-01',status:'completed',source:'customer',items:[],discount:0,
        tracking:null,comments:[],invoiceId:null,total:0};
      const ord=Object.assign(base,o);
      if(!ord.items.length)ord.items=mkItems(1+Math.floor(R()*5));
      ord.total=(o.total!=null)?o.total:calcTotal(ord);
      orders.push(ord);return ord;
    }
    /* generated history: SO10769 … SO11864 */
    const NGEN=1096;
    for(let i=0;i<NGEN;i++){
      const n=10769+i;
      if(n===11816)continue; /* reserved for the named order-collection example below */
      const num='SO'+n;
      const cust=customers[Math.floor(R()*customers.length)];
      const isAgent=R()<.3;
      const month=1+Math.floor(i/NGEN*6); /* Jan..Jun 2026 */
      const day=1+Math.floor(R()*28);
      const st=R()<.78?'completed':(R()<.5?'cancelled':'shipped');
      addOrder({number:num,customerId:cust.id,agentId:isAgent?(cust.agentId||agents[0].id):null,
        source:isAgent?'agent':'customer',
        date:'2026-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'),status:st});
    }
    /* named recent orders (match guide screenshots) */
    const byBiz=b=>customers.find(c=>c.business===b);
    addOrder({number:'SO11865',customerId:byBiz('Fashion In Optics').id,date:'2026-06-01',status:'completed',total:65,items:[{sku:'20858.1',name:'Liv London 20858',color:'Black',qty:1,price:65,collected:1}]});
    addOrder({number:'SO11866',customerId:byBiz('Paul Optical').id,date:'2026-06-01',status:'approved',total:3640});
    addOrder({number:'SO11867',customerId:byBiz('Fashion In Optics').id,date:'2026-06-01',status:'approved',total:66});
    addOrder({number:'SO11868',customerId:byBiz('Pierre Ibrahim').id,date:'2026-06-02',status:'approved',total:1276});
    addOrder({number:'SO11869',customerId:byBiz('Shelle Optical').id,date:'2026-06-02',status:'approved',total:3222});
    addOrder({number:'SO11870',customerId:byBiz('LA Optics New York').id,date:'2026-06-02',status:'pending',total:2034});
    addOrder({number:'SO11872',customerId:byBiz('Gefen Optical LLC').id,date:'2026-06-02',status:'completed',total:0,items:[{sku:'709.1',name:'Spike 709',color:'Black',qty:1,price:0,collected:1}]});
    addOrder({number:'SO11873',customerId:byBiz('Schrier Optical').id,date:'2026-06-02',status:'approved',total:127});
    /* the order-collection example */
    addOrder({number:'SO11816',customerId:byBiz('Main Street Optical Monsey').id,date:'2026-05-25',status:'pending',total:302,
      items:[
        {sku:'20858.1',name:'Liv London 20858',color:'Black',qty:1,price:65,collected:0},
        {sku:'SPF-2201.1',name:'Specterfeid Plastic Optical Frame',color:'Havana',qty:1,price:29,collected:0},
        {sku:'158.1',name:'Charlett 158',color:'Black',qty:4,price:35,collected:0},
        {sku:'709.1',name:'Spike 709',color:'Black',qty:4,price:17,collected:0},
      ]});
    /* a couple of pending orders for scanning demos */
    ['SO11874','SO11875','SO11876'].forEach((num,i)=>{
      addOrder({number:num,customerId:customers[(i*7+3)%customers.length].id,date:'2026-06-0'+(3+i),status:'pending'});
    });
    d.orders=orders;
    d.nextOrderNumber=11877;

    /* ---- other collections ---- */
    d.backorders=[];d.nextBackorderNumber=5001;
    d.returns=[];d.nextReturnNumber=3001;
    d.promotions=[];d.campaigns=[];
    d.tasks=[];
    d.leads=[];
    d.chains=[];
    d.suitcases=[];
    d.spareParts=[
      {id:'sp1',userId:users[0]&&users[0].id,model:'CAMERON',part:'Right temple / arm',
       notes:'Snapped at the hinge, customer still has the frame.',image:null,status:'open',createdAt:'2026-07-18'},
      {id:'sp2',userId:users[1]&&users[1].id,model:'VEDETTE-2002',part:'Nose pads',
       notes:'Both pads missing.',image:null,status:'shipped',createdAt:'2026-07-12'}
    ];
    d.emailTemplates=[
      {id:'et1',name:'Account refresh (site upgrade)',language:'EN',purpose:'activation',
       subject:'Veyora has been upgraded — set your new password',
       body:'<p>Hi {{name}},</p><p>Veyora has been upgraded. Click the link below to set your new password.</p><p>{{activation_link}}</p><p>— The Veyora team</p>',
       isDefault:true,createdAt:'2026-06-20'}
    ];
    d.payments=[];d.creditNotes=[];
    d.collectionFlags=[];
    d.invoices=[];d.nextInvoiceNumber=70001;
    d.shippingRules=[];
    d.freeShipping=[];
    d.audit=[];
    /* pre-existing collection flags from the "daily background process" */
    users.filter(u=>u.balance>2000&&['customer','special customer'].includes(u.role)).slice(0,6).forEach((u,i)=>{
      d.collectionFlags.push({id:'cf'+(i+1),customerId:u.id,status:'flagged',auto:true,
        notes:'Auto-flagged: balance past credit terms',log:[],createdAt:'2026-06-28',
        daysOverdue:5+Math.floor(R()*40),lastPayment:R()<.6?('2026-0'+(1+Math.floor(R()*5))+'-15'):null});
    });
    return d;
  }

  /* ---------- persistence ---------- */
  function load(){
    if(db)return db;
    try{
      const raw=localStorage.getItem(KEY);
      if(raw){db=JSON.parse(raw);return db;}
    }catch(e){}
    db=seed();save();
    return db;
  }
  function save(){
    try{localStorage.setItem(KEY,JSON.stringify(db));}
    catch(e){console.warn('localStorage save failed',e);}
  }
  function reset(){localStorage.removeItem(KEY);db=null;load();}

  /* ---------- audit helper ---------- */
  function audit(action,target,changes,source){
    const s=Auth.current();
    load().audit.unshift({id:uid('ev'),when:new Date().toISOString(),
      actorId:s?s.id:'system',actorName:s?s.name:'System',actorRole:s?s.role:'system',
      action,target:target||'—',source:source||'web',changes:changes||'',undone:false});
    save();
  }

  /* ---------- lookups ---------- */
  const api={
    load,save,reset,audit,
    /* Demo build has no server — inline the images as data: URLs so the UI still works. */
    uploadImages(files){
      return Promise.all(Array.from(files).map(f=>new Promise((resolve,reject)=>{
        const r=new FileReader();
        r.onload=()=>resolve(r.result);
        r.onerror=()=>reject(new Error('read failed'));
        r.readAsDataURL(f);
      })));
    },
    get d(){return load();},
    user(id){return load().users.find(u=>u.id===id);},
    userName(id){const u=api.user(id);return u?(u.business||((u.firstName||'')+' '+(u.lastName||'')).trim()||u.username):'—';},
    product(id){return load().products.find(p=>p.id===id);},
    productBySku(sku){sku=String(sku).trim().toLowerCase();return load().products.find(p=>p.sku.toLowerCase()===sku);},
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
    order(id){return load().orders.find(o=>o.id===id||o.number===id);},
    variationQty(v){return Object.values(v.stock||{}).reduce((s,w)=>s+(w.qty||0),0);},
    productQty(p){return p.variations.reduce((s,v)=>s+api.variationQty(v),0);},
    warehouse(id){return load().warehouses.find(w=>w.id===id||w.code===id);},
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
      const cut=new Date('2026-04-07');
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
