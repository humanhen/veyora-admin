/* ================= Pages: Customers — Users, Leads, Chains, Suitcases, Email Templates ================= */
'use strict';

/* ============================================================ USERS (customers & agents) */
App.register('users',function(el){
  const state=App._users||(App._users={role:'',activation:'',country:'',q:'',page:1});
  const US_STATES=['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  const CA_PROV=['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];

  function userForm(existing){
    const d=DB.d;
    const u=existing||{firstName:'',lastName:'',username:'',email:'',phone:'',business:'',
      customerNumber:'(auto)',taxId:'',country:'US',address:'',city:'',state:'',zip:'',
      role:'customer',agentId:'',paymentTerms:30,hidePrices:false,pricing:{mode:'none'}};
    const agents=d.users.filter(x=>['agent','super-agent'].includes(x.role));
    const pr=u.pricing||{mode:'none'};
    const tiers=[...new Set(d.products.map(p=>p.price))].sort((a,b)=>a-b).slice(0,8);
    const brands=[...new Set(d.products.map(p=>p.brand))];
    Modal.open({title:existing?'Edit Customer':'Add User',size:'xwide',
      body:`
      <div class="section-label">IDENTITY DETAILS</div>
      <div class="grid g3">
        <div class="field"><label>Username</label><input class="input" id="uf-username" value="${esc(u.username)}"></div>
        <div class="field"><label>First name</label><input class="input" id="uf-fn" value="${esc(u.firstName)}"></div>
        <div class="field"><label>Last name</label><input class="input" id="uf-ln" value="${esc(u.lastName)}"></div>
        <div class="field"><label>Email (required, unique)</label><input class="input" id="uf-email" type="email" value="${esc(u.email||'')}"></div>
        <div class="field"><label>Phone</label><input class="input" id="uf-phone" value="${esc(u.phone)}"></div>
        <div class="field"><label>Business name</label><input class="input" id="uf-biz" value="${esc(u.business)}"></div>
        <div class="field"><label>Customer number</label><input class="input" value="${esc(u.customerNumber)}" disabled></div>
        <div class="field"><label>Tax / VAT number</label><input class="input" id="uf-tax" value="${esc(u.taxId)}"></div>
      </div>
      <div class="section-label">ADDRESS</div>
      <div class="grid g3">
        <div class="field"><label>Country</label><select class="select" id="uf-country"><option ${u.country==='US'?'selected':''}>US</option><option ${u.country==='CA'?'selected':''}>CA</option></select></div>
        <div class="field"><label>Address</label><input class="input" id="uf-addr" value="${esc(u.address)}"></div>
        <div class="field"><label>City</label><input class="input" id="uf-city" value="${esc(u.city)}"></div>
        <div class="field"><label>State / Province</label><select class="select" id="uf-state"><option value="">—</option>${US_STATES.concat(CA_PROV).map(s=>`<option ${u.state===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Zip code</label><input class="input" id="uf-zip" value="${esc(u.zip)}"></div>
      </div>
      <div class="section-label">ROLE &amp; TERMS</div>
      <div class="grid g3">
        <div class="field"><label>Role</label><select class="select" id="uf-role">
          ${['customer','special customer','agent','super-agent','warehouse','admin'].map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label>Agent assignment</label><select class="select" id="uf-agent"><option value="">—</option>
          ${agents.map(a=>`<option value="${a.id}" ${u.agentId===a.id?'selected':''}>${esc(a.firstName+' '+a.lastName)} (${a.role})</option>`).join('')}</select></div>
        <div class="field"><label>Payment terms (days)</label><input class="input" type="number" id="uf-terms" value="${u.paymentTerms}"></div>
      </div>
      ${existing?`<label class="checkbox-row"><input type="checkbox" id="uf-hide" ${u.hidePrices?'checked':''}> Hide Prices — hides prices from the customer in the catalog</label>`:''}
      ${existing?`
      <div class="section-label">CUSTOM PRICING <span style="font-weight:400">(choose one mode)</span></div>
      <div class="field"><select class="select" id="uf-pmode">
        <option value="none" ${pr.mode==='none'?'selected':''}>None — default prices</option>
        <option value="tier" ${pr.mode==='tier'?'selected':''}>Price Group Override — custom price per tier</option>
        <option value="cart" ${pr.mode==='cart'?'selected':''}>Cart Total % — fixed discount on the whole order</option>
        <option value="brand" ${pr.mode==='brand'?'selected':''}>Brand % — discount by brand</option>
        ${u.role==='special customer'?`<option value="sku" ${pr.mode==='sku'?'selected':''}>SKU price list (CSV) — Special Customer</option>`:''}
      </select></div>
      <div id="uf-pcfg"></div>
      <div class="small muted">Order of precedence: SKU price &gt; brand % &gt; cart % &gt; price tier &gt; default.</div>`:''}`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>${existing?'Save Changes':'Create User'}</button>`,
      setup(ov,close){
        const pcfg=ov.querySelector('#uf-pcfg');
        function paintPricing(){
          if(!pcfg)return;
          const m=ov.querySelector('#uf-pmode').value;
          if(m==='tier'){
            pcfg.innerHTML='<div class="grid g4">'+tiers.map(t=>`<div class="field"><label>$${t} items become</label><input class="input" type="number" step="0.01" data-tier="${t}" value="${(pr.tiers&&pr.tiers[String(t)])!=null?pr.tiers[String(t)]:''}" placeholder="$${t}"></div>`).join('')+'</div>';
          }else if(m==='cart'){
            pcfg.innerHTML=`<div class="field" style="max-width:220px"><label>Discount on whole order (%)</label><input class="input" type="number" id="uf-cartpct" value="${pr.cartPct||''}" placeholder="e.g. 5"></div>`;
          }else if(m==='brand'){
            pcfg.innerHTML='<div class="grid g4">'+brands.map(b=>`<div class="field"><label>${esc(b)} (%)</label><input class="input" type="number" data-brand="${esc(b)}" value="${(pr.brands&&pr.brands[b])!=null?pr.brands[b]:''}"></div>`).join('')+'</div>';
          }else if(m==='sku'){
            pcfg.innerHTML=`<div class="upload-zone" id="uf-skucsv">${I.upload} Upload CSV — a price for every SKU (columns: sku, price)</div>
            <div class="small muted">${pr.skuPrices?Object.keys(pr.skuPrices).length+' SKU prices loaded':''}</div>`;
            pcfg.querySelector('#uf-skucsv').onclick=()=>pickCSV(rows=>{
              pr.skuPrices={};
              rows.forEach(r=>{if(r[0]&&!isNaN(parseFloat(r[1])))pr.skuPrices[r[0].trim()]=parseFloat(r[1]);});
              toast(Object.keys(pr.skuPrices).length+' SKU prices loaded');paintPricing();
            });
          }else pcfg.innerHTML='';
        }
        if(pcfg){ov.querySelector('#uf-pmode').onchange=paintPricing;paintPricing();}
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('[data-ok]').onclick=()=>{
          const email=ov.querySelector('#uf-email').value.trim();
          if(!email)return toast('Email is required',true);
          const dup=DB.d.users.find(x=>x.email.toLowerCase()===email.toLowerCase()&&(!existing||x.id!==existing.id));
          if(dup)return toast('Email must be unique — already used by '+(dup.business||dup.username),true);
          const vals={username:ov.querySelector('#uf-username').value.trim(),
            firstName:ov.querySelector('#uf-fn').value.trim(),lastName:ov.querySelector('#uf-ln').value.trim(),
            email,phone:ov.querySelector('#uf-phone').value.trim(),business:ov.querySelector('#uf-biz').value.trim(),
            taxId:ov.querySelector('#uf-tax').value.trim(),country:ov.querySelector('#uf-country').value,
            address:ov.querySelector('#uf-addr').value.trim(),city:ov.querySelector('#uf-city').value.trim(),
            state:ov.querySelector('#uf-state').value,zip:ov.querySelector('#uf-zip').value.trim(),
            role:ov.querySelector('#uf-role').value,agentId:ov.querySelector('#uf-agent').value||null,
            paymentTerms:+ov.querySelector('#uf-terms').value||30};
          if(existing){
            vals.hidePrices=ov.querySelector('#uf-hide').checked;
            const pm=ov.querySelector('#uf-pmode');
            if(pm){
              pr.mode=pm.value;
              if(pr.mode==='tier'){pr.tiers={};ov.querySelectorAll('[data-tier]').forEach(i=>{if(i.value!=='')pr.tiers[i.dataset.tier]=parseFloat(i.value);});}
              if(pr.mode==='cart')pr.cartPct=parseFloat((ov.querySelector('#uf-cartpct')||{}).value)||0;
              if(pr.mode==='brand'){pr.brands={};ov.querySelectorAll('[data-brand]').forEach(i=>{if(i.value!=='')pr.brands[i.dataset.brand]=parseFloat(i.value);});}
              vals.pricing=pr;
            }
            Object.assign(existing,vals);
            DB.save();DB.audit('user.edit',existing.business||existing.email,'Details updated');
            toast('Customer updated');
          }else{
            const d=DB.d;
            const maxNum=Math.max(...d.users.map(x=>+x.customerNumber||0));
            d.users.push(Object.assign({id:uid('u'),customerNumber:String(maxNum+1),hidePrices:false,
              status:'pending',pricing:{mode:'none'},balance:0,createdAt:todayISO()},vals));
            DB.save();DB.audit('user.create',vals.business||email,'Role: '+vals.role);
            toast('User created (pending — send an activation email)');
          }
          close();render();
        };
      }});
  }

  function pickCSV(cb){
    const inp=document.createElement('input');
    inp.type='file';inp.accept='.csv,.txt,.xlsx';
    inp.onchange=()=>{
      const f=inp.files[0];if(!f)return;
      const rd=new FileReader();
      rd.onload=()=>{
        const rows=String(rd.result).split(/\r?\n/).filter(Boolean).map(l=>l.split(',').map(c=>c.replace(/^"|"$/g,'')));
        cb(rows);
      };
      rd.readAsText(f);
    };
    inp.click();
  }

  function bulkImport(){
    Modal.open({title:'Bulk Import Customers',size:'wide',
      body:`
      <div class="info-banner">${I.eye}<div>Upload a CSV / Excel file. The <b>email</b> column is required. Customers are created with <b>pending</b> status — no emails are sent yet. In the review step, choose who to send an activation email to.</div></div>
      <div class="flex">
        <button class="btn" id="bi-tpl">${I.download} Download template</button>
        <button class="btn btn-dark" id="bi-choose">${I.upload} Choose CSV file</button>
      </div>
      <div id="bi-review"></div>
      <div class="dashed-banner">Always start with one test customer (your own email) before sending to everyone.</div>`,
      foot:`<button class="btn" data-x>Close</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('#bi-tpl').onclick=()=>downloadCSV('customers-template.csv',
          [['email','business','first_name','last_name','phone','country','city','address','zip']]);
        ov.querySelector('#bi-choose').onclick=()=>pickCSV(rows=>{
          const head=rows[0].map(h=>h.toLowerCase().trim());
          const ei=head.indexOf('email');
          if(ei<0)return toast('The email column is required',true);
          const created=[];
          for(const r of rows.slice(1)){
            const email=(r[ei]||'').trim();if(!email)continue;
            if(DB.d.users.some(u=>u.email.toLowerCase()===email.toLowerCase()))continue;
            const g=k=>{const i=head.indexOf(k);return i>=0?(r[i]||'').trim():'';};
            const maxNum=Math.max(...DB.d.users.map(x=>+x.customerNumber||0));
            const nu={id:uid('u'),username:email.split('@')[0],email,business:g('business'),
              firstName:g('first_name'),lastName:g('last_name'),phone:g('phone'),
              country:g('country')||'US',city:g('city'),address:g('address'),zip:g('zip'),state:'',taxId:'',
              customerNumber:String(maxNum+1),role:'customer',agentId:null,paymentTerms:30,
              hidePrices:false,status:'pending',pricing:{mode:'none'},balance:0,createdAt:todayISO()};
            DB.d.users.push(nu);created.push(nu);
          }
          DB.save();DB.audit('user.bulk-import',created.length+' customers','Created pending — no emails sent','csv');
          const rev=ov.querySelector('#bi-review');
          rev.innerHTML=`<div class="card-title">Review — ${created.length} customer(s) created (pending)</div>
            ${created.length?`
            <div class="flex-col" style="max-height:220px;overflow-y:auto">
              ${created.map(u=>`<label class="checkbox-row"><input type="checkbox" value="${u.id}" checked> ${esc(u.business||u.email)} — ${esc(u.email)}</label>`).join('')}
            </div>
            <button class="btn btn-dark" id="bi-send" style="margin-top:10px">${I.send} Send activation emails to selected</button>`:
            '<div class="muted small">No new customers (duplicates were skipped).</div>'}`;
          const send=rev.querySelector('#bi-send');
          if(send)send.onclick=()=>{
            const n=rev.querySelectorAll('input:checked').length;
            DB.audit('user.activation-email',n+' customers','Activation batch sent');
            toast('Activation email sent to '+n+' customer(s)');
          };
          render();
        });
      }});
  }

  function render(){
    const d=DB.d;
    let list=d.users.slice();
    if(state.role)list=list.filter(u=>u.role===state.role);
    if(state.activation)list=list.filter(u=>u.status===state.activation);
    if(state.country)list=list.filter(u=>u.country===state.country);
    if(state.q){
      const q=state.q.toLowerCase();
      list=list.filter(u=>(u.business||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q)||(u.username||'').toLowerCase().includes(q)||((u.firstName||'')+' '+(u.lastName||'')).toLowerCase().includes(q));
    }
    const p=paginate(list,state.page);

    el.innerHTML=`
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex" style="justify-content:space-between">
        <div class="search-wrap">${I.search}<input class="input" id="us-q" placeholder="Search here…" value="${esc(state.q)}"></div>
        <div class="flex">
          <select class="select" id="us-role"><option value="">All Users</option>
            ${['customer','special customer','agent','super-agent','warehouse','admin'].map(r=>`<option ${state.role===r?'selected':''} value="${r}">${r}</option>`).join('')}</select>
          <select class="select" id="us-act"><option value="">All Activation</option>
            <option value="active" ${state.activation==='active'?'selected':''}>Active</option>
            <option value="pending" ${state.activation==='pending'?'selected':''}>Pending</option></select>
          <select class="select" id="us-country"><option value="">Country</option>
            <option ${state.country==='US'?'selected':''}>US</option><option ${state.country==='CA'?'selected':''}>CA</option></select>
          <button class="btn" id="us-bulk">${I.fileCsv} Bulk Import</button>
          <button class="btn btn-dark" id="us-add">${I.plus} Add User</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th style="width:30px"><input type="checkbox" id="us-all"></th><th>ID</th><th>Name</th><th>Email</th><th>Role / Status</th><th>Actions</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(u=>{
          const isAgent=['agent','super-agent'].includes(u.role);
          return `<tr>
            <td>${u.protected?'—':`<input type="checkbox" data-sel="${u.id}">`}</td>
            <td class="muted">${esc(u.customerNumber||'–')}</td>
            <td><div class="cell-main">${esc(u.business||(u.firstName+' '+u.lastName))}</div><div class="cell-sub">@${esc(u.username)}</div></td>
            <td>${esc(u.email)}</td>
            <td><span class="badge outline">${esc(u.role)}</span> ${u.status==='pending'?statusBadge('pending'):''}</td>
            <td><div class="row-actions">
              <button class="icon-btn" data-edit="${u.id}" title="Edit">${I.pencil}</button>
              <button class="icon-btn" data-lock="${u.id}" title="Reset password">${I.lock}</button>
              ${u.protected?'':`<button class="icon-btn danger" data-del="${u.id}" title="Delete">${I.trash}</button>`}
              ${u.status==='pending'?`<button class="icon-btn warn" data-act="${u.id}" title="Send activation email">${I.envelope}</button>`:''}
              ${isAgent?`<button class="icon-btn" data-suit="${u.id}" title="Sample suitcases">${I.suitcase}</button>`:''}
            </div></td>
          </tr>`;}).join(''):`<tr><td colspan="6" class="empty-cell">No users found</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;

    const q=el.querySelector('#us-q');
    q.oninput=debounce(()=>{state.q=q.value;state.page=1;render();const nq=el.querySelector('#us-q');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelector('#us-role').onchange=e=>{state.role=e.target.value;state.page=1;render();};
    el.querySelector('#us-act').onchange=e=>{state.activation=e.target.value;state.page=1;render();};
    el.querySelector('#us-country').onchange=e=>{state.country=e.target.value;state.page=1;render();};
    el.querySelector('#us-add').onclick=()=>userForm(null);
    el.querySelector('#us-bulk').onclick=bulkImport;
    bindPager(el,pg=>{state.page=pg;render();});
    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>userForm(DB.user(b.dataset.edit)));
    el.querySelectorAll('[data-lock]').forEach(b=>b.onclick=()=>{
      const u=DB.user(b.dataset.lock);
      Modal.confirm('Reset password','Send a password-reset email to <b>'+esc(u.email)+'</b>?',()=>{
        DB.audit('user.password-reset',u.email,'Reset link emailed');
        toast('Reset link sent to '+u.email);
      },'Send reset link');
    });
    el.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
      const u=DB.user(b.dataset.act);
      Modal.confirm('Activation email','Send an activation email to <b>'+esc(u.email)+'</b>? The customer gets a link to set a password.',()=>{
        DB.audit('user.activation-email',u.email,'Activation email sent');
        toast('Activation email sent');
      },'Send');
    });
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const u=DB.user(b.dataset.del);
      Modal.confirm('Delete customer','Delete <b>'+esc(u.business||u.email)+'</b>? This cannot be undone.',()=>{
        DB.d.users=DB.d.users.filter(x=>x.id!==u.id);
        DB.save();DB.audit('user.delete',u.business||u.email,'');
        render();toast('Customer deleted');
      },'Delete');
    });
    el.querySelectorAll('[data-suit]').forEach(b=>b.onclick=()=>{location.hash='#/suitcases/'+b.dataset.suit;});
  }
  render();
});

/* ============================================================ LEADS */
App.register('leads',function(el,args){
  const state=App._leads||(App._leads={stage:'All',q:'',sel:null});
  if(args&&args[0])state.sel=args[0];
  const STAGES=['Prospecting','Contacted','Qualified','Converted','Lost'];

  function leadForm(existing){
    const agents=DB.d.users.filter(x=>['agent','super-agent'].includes(x.role));
    const L=existing||{business:'',email:'',contact:'',phone:'',city:'',agentId:'',rating:3};
    Modal.open({title:existing?'Edit Lead':'Add Lead',
      body:`
      <div class="two-col">
        <div class="field"><label>Business name</label><input class="input" id="ld-biz" value="${esc(L.business)}"></div>
        <div class="field"><label>Email</label><input class="input" id="ld-email" value="${esc(L.email)}"></div>
        <div class="field"><label>Contact person</label><input class="input" id="ld-contact" value="${esc(L.contact)}"></div>
        <div class="field"><label>Phone</label><input class="input" id="ld-phone" value="${esc(L.phone)}"></div>
        <div class="field"><label>City</label><input class="input" id="ld-city" value="${esc(L.city)}"></div>
        <div class="field"><label>Agent assignment</label><select class="select" id="ld-agent"><option value="">—</option>
          ${agents.map(a=>`<option value="${a.id}" ${L.agentId===a.id?'selected':''}>${esc(a.firstName+' '+a.lastName)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Potential rating</label>
        <div class="stars" id="ld-stars">${[1,2,3,4,5].map(n=>`<span data-star="${n}" style="cursor:pointer;opacity:${n<=L.rating?1:.25}">${I.star}</span>`).join('')}</div></div>`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save Lead</button>`,
      setup(ov,close){
        let rating=L.rating;
        ov.querySelectorAll('[data-star]').forEach(s=>s.onclick=()=>{
          rating=+s.dataset.star;
          ov.querySelectorAll('[data-star]').forEach(x=>x.style.opacity=+x.dataset.star<=rating?1:.25);
        });
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('[data-ok]').onclick=()=>{
          const biz=ov.querySelector('#ld-biz').value.trim();
          if(!biz)return toast('Business name is required',true);
          const vals={business:biz,email:ov.querySelector('#ld-email').value.trim(),
            contact:ov.querySelector('#ld-contact').value.trim(),phone:ov.querySelector('#ld-phone').value.trim(),
            city:ov.querySelector('#ld-city').value.trim(),agentId:ov.querySelector('#ld-agent').value||null,rating};
          if(existing){Object.assign(existing,vals);DB.audit('lead.edit',biz,'');}
          else DB.d.leads.unshift(Object.assign({id:uid('ld'),stage:'Prospecting',visits:[],
            questionnaire:{frames:'',brands:'',volume:''},createdAt:todayISO(),customerId:null},vals));
          if(!existing)DB.audit('lead.create',biz,'');
          DB.save();close();render();toast(existing?'Lead updated':'Lead created');
        };
      }});
  }

  function renderDetail(L){
    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <button class="back-btn" id="ld-back">&larr;</button>
      <div><div class="page-title" style="font-size:16px">${esc(L.business)}</div>
      <div class="page-sub">${esc(L.city||'')} ${L.agentId?'&middot; Agent: '+esc(DB.userName(L.agentId)):''}</div></div>
      <span class="right"></span>
      <span class="badge ${L.stage==='Converted'?'green':L.stage==='Lost'?'red':'yellow'}">${L.stage}</span>
      <div class="stars">${[1,2,3,4,5].map(n=>`<span style="opacity:${n<=L.rating?1:.25}">${I.star}</span>`).join('')}</div>
    </div>
    <div class="two-col">
      <div class="card card-pad">
        <div class="spread"><div class="card-title" style="margin:0">Details</div>
          <button class="btn btn-sm" id="ld-edit">${I.pencil} Edit</button></div>
        <div class="divider"></div>
        <dl class="kv">
          <dt>Email</dt><dd>${esc(L.email||'—')}</dd>
          <dt>Contact person</dt><dd>${esc(L.contact||'—')}</dd>
          <dt>Phone</dt><dd>${esc(L.phone||'—')}</dd>
          <dt>City</dt><dd>${esc(L.city||'—')}</dd>
          <dt>Created</dt><dd>${fmtDateShort(L.createdAt)}</dd>
          ${L.customerId?`<dt>Customer</dt><dd><span class="badge green">Converted</span> ${esc(DB.userName(L.customerId))}</dd>`:''}
        </dl>
        <div class="section-label">STAGE</div>
        <div class="chip-row">${STAGES.map(s=>`<button class="chip ${L.stage===s?'active':''}" data-stage="${s}">${s}</button>`).join('')}</div>
        ${L.stage!=='Converted'?`<button class="btn btn-dark" id="ld-convert" style="margin-top:16px">${I.check} Convert to customer</button>`:''}
        <div class="section-label">FIT QUESTIONNAIRE</div>
        <div class="field"><label>How many frames do they carry?</label><input class="input" id="qq-frames" value="${esc(L.questionnaire.frames)}"></div>
        <div class="field" style="margin-top:8px"><label>Current brands</label><input class="input" id="qq-brands" value="${esc(L.questionnaire.brands)}"></div>
        <div class="field" style="margin-top:8px"><label>Monthly volume estimate</label><input class="input" id="qq-volume" value="${esc(L.questionnaire.volume)}"></div>
        <button class="btn btn-sm" id="qq-save" style="margin-top:10px">Save questionnaire</button>
      </div>
      <div class="card card-pad">
        <div class="card-title">Visit log</div>
        <div class="flex">
          <input class="input" id="vl-note" placeholder="Log a visit / call…" style="flex:1">
          <button class="btn btn-dark" id="vl-add">${I.plus} Log</button>
        </div>
        <div class="timeline" style="margin-top:16px">
          ${L.visits.length?L.visits.map(v=>`<div class="tl-item"><b>${fmtDateTime(v.at)}</b><div class="small">${esc(v.note)}</div></div>`).join(''):'<div class="muted small">No visits logged yet.</div>'}
        </div>
      </div>
    </div>`;

    el.querySelector('#ld-back').onclick=()=>{state.sel=null;location.hash='#/leads';};
    el.querySelector('#ld-edit').onclick=()=>leadForm(L);
    el.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{
      L.stage=b.dataset.stage;DB.save();DB.audit('lead.stage',L.business,'→ '+L.stage);renderDetail(L);
    });
    el.querySelector('#qq-save').onclick=()=>{
      L.questionnaire={frames:el.querySelector('#qq-frames').value,brands:el.querySelector('#qq-brands').value,volume:el.querySelector('#qq-volume').value};
      DB.save();toast('Questionnaire saved');
    };
    el.querySelector('#vl-add').onclick=()=>{
      const n=el.querySelector('#vl-note').value.trim();if(!n)return;
      L.visits.unshift({note:n,at:new Date().toISOString()});
      DB.save();renderDetail(L);
    };
    const cv=el.querySelector('#ld-convert');
    if(cv)cv.onclick=()=>{
      if(!L.email)return toast('An email is required to convert — edit the lead first',true);
      Modal.confirm('Convert to customer','Create a customer account for <b>'+esc(L.business)+'</b>? The email, business name, and contact person are copied.',()=>{
        const maxNum=Math.max(...DB.d.users.map(x=>+x.customerNumber||0));
        const nu={id:uid('u'),username:L.email.split('@')[0],email:L.email,business:L.business,
          firstName:(L.contact||'').split(' ')[0]||'',lastName:(L.contact||'').split(' ').slice(1).join(' '),
          phone:L.phone,country:'US',city:L.city,address:'',state:'',zip:'',taxId:'',
          customerNumber:String(maxNum+1),role:'customer',agentId:L.agentId,paymentTerms:30,
          hidePrices:false,status:'pending',pricing:{mode:'none'},balance:0,createdAt:todayISO()};
        DB.d.users.push(nu);
        L.stage='Converted';L.customerId=nu.id;
        DB.save();DB.audit('lead.convert',L.business,'→ customer '+nu.customerNumber);
        renderDetail(L);
        toast('Customer created — send them an activation email from Users');
      },'Convert');
    };
  }

  function render(){
    if(state.sel){
      const L=DB.d.leads.find(x=>x.id===state.sel);
      if(L)return renderDetail(L);
      state.sel=null;
    }
    let list=DB.d.leads.slice();
    const counts={All:list.length};
    STAGES.forEach(s=>counts[s]=list.filter(l=>l.stage===s).length);
    if(state.stage!=='All')list=list.filter(l=>l.stage===state.stage);
    if(state.q){const q=state.q.toLowerCase();
      list=list.filter(l=>l.business.toLowerCase().includes(q)||(l.email||'').toLowerCase().includes(q)||(l.contact||'').toLowerCase().includes(q));}

    el.innerHTML=`
    <div class="card card-pad">
      <div class="spread" style="margin-bottom:12px">
        <div class="page-title" style="font-size:16px">Leads</div>
        <div class="flex">
          <div class="search-wrap">${I.search}<input class="input" id="ld-q" placeholder="Search by name, business, email" value="${esc(state.q)}"></div>
          <button class="btn btn-dark" id="ld-new">${I.plus} Add Lead</button>
        </div>
      </div>
      <div class="chip-row" style="margin-bottom:14px">
        <button class="chip ${state.stage==='All'?'active':''}" data-stg="All">All (${counts.All})</button>
        ${STAGES.map(s=>`<button class="chip ${state.stage===s?'active':''}" data-stg="${s}">${s} (${counts[s]})</button>`).join('')}
      </div>
      ${list.length?`
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Business</th><th>Contact</th><th>City</th><th>Agent</th><th>Stage</th><th>Rating</th><th>Visits</th><th></th></tr></thead>
        <tbody>${list.map(l=>`<tr class="clickable" data-open="${l.id}">
          <td class="cell-main">${esc(l.business)}</td>
          <td>${esc(l.contact||'—')}<div class="cell-sub">${esc(l.email||'')}</div></td>
          <td>${esc(l.city||'—')}</td>
          <td>${l.agentId?esc(DB.userName(l.agentId)):'—'}</td>
          <td><span class="badge ${l.stage==='Converted'?'green':l.stage==='Lost'?'red':'yellow'}">${l.stage}</span></td>
          <td><div class="stars">${[1,2,3,4,5].map(n=>`<span style="opacity:${n<=l.rating?1:.2}">${I.star}</span>`).join('')}</div></td>
          <td>${l.visits.length}</td>
          <td>${I.caret}</td>
        </tr>`).join('')}</tbody></table></div>`:
      `<div class="task-empty">${I.lead}<div><b>No leads yet</b><br>Click "Add lead" to capture your first prospect.</div></div>`}
    </div>`;

    el.querySelectorAll('[data-stg]').forEach(b=>b.onclick=()=>{state.stage=b.dataset.stg;render();});
    const q=el.querySelector('#ld-q');
    q.oninput=debounce(()=>{state.q=q.value;render();const nq=el.querySelector('#ld-q');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelector('#ld-new').onclick=()=>leadForm(null);
    el.querySelectorAll('[data-open]').forEach(tr=>tr.onclick=()=>{state.sel=tr.dataset.open;render();});
  }
  render();
});

/* ============================================================ CHAINS */
App.register('chains',function(el){
  const state=App._chains||(App._chains={sel:null,tab:'Branches'});

  function render(){
    const d=DB.d;
    if(state.sel){
      const ch=d.chains.find(c=>c.id===state.sel);
      if(!ch){state.sel=null;}else return renderDetail(ch);
    }
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Chains</div>
      <button class="btn btn-dark" id="ch-new">${I.plus} Create Chain</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Owner</th><th>Branch Count</th><th>Actions</th></tr></thead>
        <tbody>${d.chains.length?d.chains.map(c=>`<tr>
          <td class="cell-main">${esc(c.name)}</td>
          <td>${esc(DB.userName(c.ownerId))}</td>
          <td>${c.branchIds.length}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-open="${c.id}">${I.eye}</button>
            <button class="icon-btn danger" data-del="${c.id}">${I.trash}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="4" class="empty-cell">No chains found</td></tr>`}
        </tbody></table></div>
    </div>`;

    el.querySelector('#ch-new').onclick=()=>{
      const customers=d.users.filter(u=>['customer','special customer'].includes(u.role));
      Modal.open({title:'Create Chain',
        body:`<div class="field"><label>Chain name</label><input class="input" id="ch-name" placeholder="e.g. Hakim Optical Group"></div>
        <div class="field"><label>Owner (customer / holding company)</label>
          <select class="select" id="ch-owner">${customers.map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}</select></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Create Chain</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const name=ov.querySelector('#ch-name').value.trim();
            if(!name)return toast('Name is required',true);
            d.chains.unshift({id:uid('ch'),name,ownerId:ov.querySelector('#ch-owner').value,branchIds:[]});
            DB.save();DB.audit('chain.create',name,'');close();render();toast('Chain created');
          };
        }});
    };
    el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{state.sel=b.dataset.open;state.tab='Branches';render();});
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const c=d.chains.find(x=>x.id===b.dataset.del);
      Modal.confirm('Delete chain','Delete <b>'+esc(c.name)+'</b>? Branches are unlinked, customers are not deleted.',()=>{
        d.chains=d.chains.filter(x=>x.id!==c.id);DB.save();DB.audit('chain.delete',c.name,'');render();
      },'Delete');
    });
  }

  function renderDetail(ch){
    const d=DB.d;
    const branchOrders=d.orders.filter(o=>ch.branchIds.includes(o.customerId)).sort((a,b)=>b.number>a.number?1:-1);
    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <button class="back-btn" id="ch-back">&larr;</button>
      <div><div class="page-title" style="font-size:16px">${esc(ch.name)}</div>
      <div class="page-sub">Owner: ${esc(DB.userName(ch.ownerId))} &middot; ${ch.branchIds.length} branches</div></div>
    </div>
    <div class="card card-pad">
      <div class="tabs">
        ${['Branches','Orders'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}
      </div>
      ${state.tab==='Branches'?`
        <div class="flex" style="margin-bottom:12px">
          <select class="select" id="ch-add-sel" style="flex:1">
            ${d.users.filter(u=>['customer','special customer'].includes(u.role)&&!ch.branchIds.includes(u.id)).map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}
          </select>
          <button class="btn btn-dark" id="ch-add">${I.plus} Add branch</button>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Branch</th><th>City</th><th>Email</th><th></th></tr></thead>
          <tbody>${ch.branchIds.length?ch.branchIds.map(id=>{
            const u=DB.user(id)||{};
            return `<tr><td class="cell-main">${esc(u.business||'—')}</td><td>${esc(u.city||'—')}</td><td>${esc(u.email||'—')}</td>
              <td><button class="btn btn-sm" data-rm="${id}">Remove</button></td></tr>`;}).join(''):
            `<tr><td colspan="4" class="empty-cell">No branches yet</td></tr>`}
          </tbody></table></div>
        <div class="small muted" style="margin-top:8px">Removing unlinks the branch from the chain — it doesn't delete the customer.</div>`:`
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Order</th><th>Branch</th><th>Date</th><th>Status</th><th>Total</th><th></th></tr></thead>
          <tbody>${branchOrders.length?branchOrders.slice(0,50).map(o=>`<tr>
            <td class="cell-main">${esc(o.number)}</td><td>${esc(DB.userName(o.customerId))}</td>
            <td>${fmtDateShort(o.date)}</td><td>${statusBadge(o.status)}</td><td>${money(o.total)}</td>
            <td><button class="icon-btn" data-view="${o.id}">${I.eye}</button></td>
          </tr>`).join(''):`<tr><td colspan="6" class="empty-cell">No orders from chain branches yet</td></tr>`}
          </tbody></table></div>`}
    </div>`;

    el.querySelector('#ch-back').onclick=()=>{state.sel=null;render();};
    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;renderDetail(ch);});
    const add=el.querySelector('#ch-add');
    if(add)add.onclick=()=>{
      const id=el.querySelector('#ch-add-sel').value;
      if(!id)return;
      ch.branchIds.push(id);DB.save();DB.audit('chain.branch.add',ch.name,DB.userName(id));renderDetail(ch);
    };
    el.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{
      ch.branchIds=ch.branchIds.filter(x=>x!==b.dataset.rm);
      DB.save();DB.audit('chain.branch.remove',ch.name,DB.userName(b.dataset.rm));renderDetail(ch);
    });
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{location.hash='#/order/'+b.dataset.view;});
  }
  render();
});

/* ============================================================ SUITCASES */
App.register('suitcases',function(el,args){
  const state=App._suit||(App._suit={agent:null,q:''});
  if(args&&args[0])state.agent=args[0];

  function render(){
    const d=DB.d;
    const agents=d.users.filter(u=>['agent','super-agent'].includes(u.role));
    if(state.agent){
      const a=DB.user(state.agent);
      if(a)return renderAgent(a);
      state.agent=null;
    }
    const list=state.q?agents.filter(a=>((a.firstName+' '+a.lastName).toLowerCase().includes(state.q.toLowerCase()))):agents;
    el.innerHTML=`
    <div class="page-head">
      <div><div class="page-title">Suitcases</div>
      <div class="page-sub">Pick an agent to view or edit their planogram</div></div>
      <div class="search-wrap">${I.search}<input class="input" id="su-q" placeholder="Search agents…" value="${esc(state.q)}"></div>
    </div>
    <div class="card card-pad">
      ${list.length?`<div class="agent-cards">${list.map(a=>{
        const scount=d.suitcases.filter(s=>s.agentId===a.id).length;
        return `<div class="agent-card" data-agent="${a.id}">
          <div class="flex"><div class="avatar">${esc((a.firstName||'A').charAt(0))}</div>
          <div><div class="cell-main">${esc(a.firstName+' '+a.lastName)}</div>
          <div class="cell-sub">${esc(a.role)} &middot; ${scount} suitcase${scount!==1?'s':''}</div></div></div>
        </div>`;}).join('')}</div>`:
      '<div class="task-empty">No agents found.</div>'}
    </div>`;
    const q=el.querySelector('#su-q');
    q.oninput=debounce(()=>{state.q=q.value;render();const nq=el.querySelector('#su-q');nq.focus();});
    el.querySelectorAll('[data-agent]').forEach(c=>c.onclick=()=>{state.agent=c.dataset.agent;render();});
  }

  function renderAgent(a){
    const d=DB.d;
    const cases=d.suitcases.filter(s=>s.agentId===a.id);
    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <button class="back-btn" id="su-back">&larr;</button>
      <div><div class="page-title" style="font-size:16px">${esc(a.firstName+' '+a.lastName)} — Suitcases</div>
      <div class="page-sub">SKU layout (planogram). Changes save automatically.</div></div>
      <button class="btn btn-dark right" id="su-create">${I.plus} Create Suitcase</button>
    </div>
    ${cases.length?cases.map(sc=>`
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="spread">
        <div class="card-title" style="margin:0">${esc(sc.name)}</div>
        <div class="flex">
          <select class="select" data-tray-size="${sc.id}"><option value="6">6 slots</option><option value="12">12 slots</option><option value="15">15 slots</option></select>
          <button class="btn btn-sm" data-add-tray="${sc.id}">${I.plus} Add Tray</button>
          <button class="icon-btn danger" data-del-case="${sc.id}">${I.trash}</button>
        </div>
      </div>
      ${sc.trays.map((tr,ti)=>`
      <div class="tray" style="margin-top:12px">
        <div class="spread"><b class="small">Tray ${ti+1} — ${tr.size} slots</b>
          <button class="icon-btn danger" data-del-tray="${sc.id}:${ti}">${I.trash}</button></div>
        <div class="tray-grid s${tr.size}">
          ${tr.slots.map((sku,si)=>{
            const hit=sku?DB.variationBySku(sku):null;
            return `<div class="slot ${hit?'filled':''}">
              ${hit?glassesSVG(COLOR_HEX[(hit.v.color||'').toLowerCase()]):''}
              <input placeholder="SKU" value="${esc(sku||'')}" data-slot="${sc.id}:${ti}:${si}">
              ${hit?`<div class="slot-color">${esc(hit.p.name)} &middot; ${esc(hit.v.color)}</div>`:''}
            </div>`;}).join('')}
        </div>
      </div>`).join('')}
      ${!sc.trays.length?'<div class="muted small" style="margin-top:10px">No trays yet — add one above.</div>':''}
    </div>`).join(''):`<div class="card card-pad"><div class="task-empty">${I.suitcase}<div>No suitcases yet — create one.</div></div></div>`}`;

    el.querySelector('#su-back').onclick=()=>{state.agent=null;location.hash='#/suitcases';};
    el.querySelector('#su-create').onclick=()=>{
      d.suitcases.push({id:uid('sc'),agentId:a.id,name:'Suitcase '+(cases.length+1),trays:[]});
      DB.save();DB.audit('suitcase.create',a.firstName+' '+a.lastName,'');renderAgent(a);
    };
    el.querySelectorAll('[data-add-tray]').forEach(b=>b.onclick=()=>{
      const sc=d.suitcases.find(x=>x.id===b.dataset.addTray);
      const size=+el.querySelector(`[data-tray-size="${sc.id}"]`).value;
      sc.trays.push({size,slots:new Array(size).fill('')});
      DB.save();renderAgent(a);
    });
    el.querySelectorAll('[data-del-tray]').forEach(b=>b.onclick=()=>{
      const [cid,ti]=b.dataset.delTray.split(':');
      const sc=d.suitcases.find(x=>x.id===cid);
      sc.trays.splice(+ti,1);DB.save();renderAgent(a);
    });
    el.querySelectorAll('[data-del-case]').forEach(b=>b.onclick=()=>{
      Modal.confirm('Delete suitcase','Delete this suitcase and its trays?',()=>{
        DB.d.suitcases=DB.d.suitcases.filter(x=>x.id!==b.dataset.delCase);
        DB.save();renderAgent(a);
      },'Delete');
    });
    el.querySelectorAll('[data-slot]').forEach(inp=>{
      inp.onchange=()=>{
        const [cid,ti,si]=inp.dataset.slot.split(':');
        const sc=d.suitcases.find(x=>x.id===cid);
        sc.trays[+ti].slots[+si]=inp.value.trim();
        DB.save();renderAgent(a); /* auto-save */
      };
    });
  }
  render();
});

/* ============================================================ EMAIL TEMPLATES */
App.register('email-templates',function(el){
  const state=App._et||(App._et={purpose:''});

  function tplForm(existing){
    const t=existing||{name:'',language:'EN',purpose:'activation',subject:'',body:'',isDefault:false};
    Modal.open({title:existing?'Edit Template':'New Template',size:'wide',
      body:`
      <div class="grid g3">
        <div class="field"><label>Name</label><input class="input" id="et-name" value="${esc(t.name)}"></div>
        <div class="field"><label>Language</label><select class="select" id="et-lang">
          <option value="EN" ${t.language==='EN'?'selected':''}>English</option>
          <option value="FR" ${t.language==='FR'?'selected':''}>French</option></select></div>
        <div class="field"><label>Purpose</label><select class="select" id="et-purpose">
          ${['activation','order confirmation','shipping','debt reminder','promotion','other'].map(p=>`<option ${t.purpose===p?'selected':''}>${p}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Subject line</label><input class="input" id="et-subject" value="${esc(t.subject)}"></div>
      <div class="field"><label>HTML body — variables like {{name}} are replaced per recipient</label>
        <textarea class="input" id="et-body" style="min-height:160px;font-family:monospace">${esc(t.body)}</textarea></div>
      <label class="checkbox-row"><input type="checkbox" id="et-default" ${t.isDefault?'checked':''}> Is Default — auto-selected when sending an activation email</label>`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save Template</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('[data-ok]').onclick=()=>{
          const name=ov.querySelector('#et-name').value.trim();
          if(!name)return toast('Name is required',true);
          const vals={name,language:ov.querySelector('#et-lang').value,
            purpose:ov.querySelector('#et-purpose').value,
            subject:ov.querySelector('#et-subject').value,
            body:ov.querySelector('#et-body').value,
            isDefault:ov.querySelector('#et-default').checked};
          if(vals.isDefault)DB.d.emailTemplates.forEach(x=>x.isDefault=false);
          if(existing)Object.assign(existing,vals);
          else DB.d.emailTemplates.unshift(Object.assign({id:uid('et'),createdAt:todayISO()},vals));
          DB.save();DB.audit(existing?'template.edit':'template.create',name,'');
          close();render();toast('Template saved');
        };
      }});
  }

  function render(){
    const d=DB.d;
    let list=d.emailTemplates.slice();
    if(state.purpose)list=list.filter(t=>t.purpose===state.purpose);
    el.innerHTML=`
    <div class="info-banner" style="margin-bottom:14px">${I.eye}
      <div>Looking for cart-recovery drip emails? They're system templates (EN/FR) managed in <b>Promotions &rarr; Cart recovery</b>.</div>
      <a class="link right" href="#/promotions" style="white-space:nowrap">Open &rarr;</a></div>
    <div class="page-head">
      <div><div class="page-title">Email templates</div>
      <div class="page-sub">Library of customer-facing emails — activation, order lifecycle, drops, reminders</div></div>
      <div class="flex">
        <select class="select" id="et-fpurpose"><option value="">Purpose</option>
          ${['activation','order confirmation','shipping','debt reminder','promotion','other'].map(p=>`<option ${state.purpose===p?'selected':''}>${p}</option>`).join('')}</select>
        <button class="btn btn-dark" id="et-new">${I.plus} New Template</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Subject</th><th>Language</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>${list.length?list.map(t=>`<tr>
          <td class="cell-main">${esc(t.name)}</td>
          <td>${esc(t.subject)}</td>
          <td><span class="badge outline">${esc(t.language)}</span></td>
          <td>${t.isDefault?'<span class="badge dark">Default</span>':''}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-bc="${t.id}" title="Preview / Broadcast">${I.send}</button>
            <button class="icon-btn" data-edit="${t.id}" title="Edit">${I.pencil}</button>
            <button class="icon-btn danger" data-del="${t.id}" title="Delete">${I.trash}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="5" class="empty-cell">No templates found</td></tr>`}
        </tbody></table></div>
    </div>`;

    el.querySelector('#et-fpurpose').onchange=e=>{state.purpose=e.target.value;render();};
    el.querySelector('#et-new').onclick=()=>tplForm(null);
    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>tplForm(d.emailTemplates.find(x=>x.id===b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const t=d.emailTemplates.find(x=>x.id===b.dataset.del);
      Modal.confirm('Delete template','Delete <b>'+esc(t.name)+'</b>?',()=>{
        d.emailTemplates=d.emailTemplates.filter(x=>x.id!==t.id);DB.save();render();
      },'Delete');
    });
    el.querySelectorAll('[data-bc]').forEach(b=>b.onclick=()=>{
      const t=d.emailTemplates.find(x=>x.id===b.dataset.bc);
      Modal.open({title:'Preview / Broadcast — '+t.name,size:'wide',
        body:`
        <div class="field"><label>Preview</label>
          <div style="border:1px solid var(--line);border-radius:10px;padding:16px;background:#fdfcf8">
            <div class="small muted">Subject: <b>${esc(t.subject)}</b></div><div class="divider"></div>
            <div style="font-size:13px">${t.body.replace(/\{\{name\}\}/g,'<b>Sample Customer</b>').replace(/\{\{activation_link\}\}/g,'<a class="link">https://veyora.com/activate/…</a>')}</div>
          </div></div>
        <div class="field"><label>Broadcast audience</label><select class="select" id="bc-aud">
          <option>All customers</option><option>US customers</option><option>CA customers</option>
          <option>Customers only</option><option>Agents only</option></select></div>`,
        foot:`<button class="btn" data-x>Close</button><button class="btn btn-dark" data-send>${I.send} Broadcast</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-send]').onclick=()=>{
            const aud=ov.querySelector('#bc-aud').value;
            DB.audit('template.broadcast',t.name,'Audience: '+aud);
            close();toast('Broadcast queued — '+aud);
          };
        }});
    });
  }
  render();
});
