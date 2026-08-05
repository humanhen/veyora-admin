/* ================= Pages: Public Content administration (B2.4B2A) =================

   Review and draft-editing for the public website's brand, product and
   variation records, over the B2.4A administrative API.

   Three things are load-bearing:

   1. VIEW AND EDIT ARE SEPARATE. `public_content.view` renders the screens
      read-only; controls become editable only with `public_content.edit`.
      Neither implies the other and neither implies publish. The API enforces
      this independently — the disabled attribute is a courtesy, not a
      control.

   2. THERE IS NO PUBLISH CONTROL ANYWHERE IN THIS FILE. Publication is a
      gated, transactional, approval-recorded operation with its own endpoint
      and its own capability, and it is B2.4B2B's surface. `is_published` is
      on the API's immutable list, and `publication_state` cannot cross the
      published boundary through PATCH (see the publication boundary guard in
      routes/admin-public-content.js). The state select below therefore offers
      only the editorial states.

   3. NOTHING IS SAVED UNTIL SAVE IS PRESSED, and a save sends only the fields
      that actually changed, filtered through the API's own allowlist.        */
'use strict';

/* Editorial publication states. 'published' is deliberately absent: reaching
   it is the publish action's job, not a dropdown's. */
const PC_EDITORIAL_STATES=['draft','verified','approved','retired'];
const PC_VERIFICATION_STATES=['unverified','sourced','verified'];

/* Field descriptors per entity, keyed by the API's snake_case column name and
   carrying the camelCase reader for the serialized record. This list is the
   screen's rendering order; DB.publicContentEditable remains the authority on
   what may be SENT. */
const PC_FIELDS={
  brand:[
    {col:'name',read:'name',label:'Brand name',kind:'text'},
    {col:'slug',read:'slug',label:'Public slug',kind:'text',hint:'Lower-case letters, numbers and hyphens. Used in the public URL.'},
    {col:'short_name',read:'shortName',label:'Short name',kind:'text'},
    {col:'segment',read:'segment',label:'Segment',kind:'text'},
    {col:'headline',read:'headline',label:'Headline',kind:'text'},
    {col:'summary',read:'summary',label:'Summary',kind:'textarea'},
    {col:'story',read:'story',label:'Brand story',kind:'textarea'},
    {col:'ideal_retailer',read:'idealRetailer',label:'Ideal retailer',kind:'text'},
    {col:'price_tier_label',read:'priceTierLabel',label:'Price tier label',kind:'text',
      hint:'A descriptive label only — never an amount.'},
    {col:'design_origin',read:'designOrigin',label:'Design origin',kind:'text'},
    {col:'manufacturing_origin',read:'manufacturingOrigin',label:'Manufacturing origin',kind:'text'},
    {col:'style_traits',read:'styleTraits',label:'Style traits',kind:'list'},
    {col:'approved_materials',read:'approvedMaterials',label:'Approved materials',kind:'list'},
    {col:'logo_media_id',read:'logoMediaId',label:'Logo media ID',kind:'idref'},
    {col:'hero_media_id',read:'heroMediaId',label:'Hero media ID',kind:'idref'},
  ],
  product:[
    {col:'name',read:'name',label:'Model name',kind:'text'},
    {col:'public_slug',read:'publicSlug',label:'Public slug',kind:'text',hint:'Lower-case letters, numbers and hyphens.'},
    {col:'brand_id',read:'brandId',label:'Brand ID',kind:'idref',hint:'The public brand record this model belongs to.'},
    {col:'line',read:'line',label:'Line',kind:'text'},
    {col:'shape',read:'shape',label:'Shape',kind:'text'},
    {col:'segment',read:'segment',label:'Segment',kind:'text'},
    {col:'public_description',read:'publicDescription',label:'Public description',kind:'textarea'},
    {col:'is_featured',read:'isFeatured',label:'Featured on the brand page',kind:'boolean'},
    {col:'is_discontinued',read:'isDiscontinued',label:'Discontinued',kind:'boolean'},
    {col:'replacement_product_id',read:'replacementProductId',label:'Replacement model ID',kind:'idref',
      hint:'Shown to visitors when this model is discontinued.'},
  ],
  variation:[
    {col:'color',read:'colorName',label:'Public colour name',kind:'text'},
    {col:'color_code',read:'colorCode',label:'Colour code',kind:'text'},
    {col:'swatch_media_id',read:'swatchMediaId',label:'Swatch media ID',kind:'idref'},
  ],
};

/* Governance fields are shared by brands and products. */
const PC_GOVERNANCE=[
  {col:'publication_state',read:'publicationState',label:'Publication state',kind:'enum',values:PC_EDITORIAL_STATES},
  {col:'verification_status',read:'verificationStatus',label:'Verification status',kind:'enum',values:PC_VERIFICATION_STATES},
  {col:'source_reference',read:'sourceReference',label:'Source reference',kind:'textarea',
    hint:'Where this content was verified from. Required before publication.'},
  {col:'last_reviewed_at',read:'lastReviewedAt',label:'Last reviewed',kind:'date'},
  {col:'scheduled_review_at',read:'scheduledReviewAt',label:'Scheduled review',kind:'date'},
];

/* ---------------------------------------------------------------------------
   Shared helpers — the minimum needed by three editors, not a form framework
   --------------------------------------------------------------------------- */

/** Reads the current value of a descriptor from a serialized record. */
function pcRead(record,f){
  const src=f.governance?(record.governance||{}):record;
  const v=src[f.read];
  if(f.kind==='list')return Array.isArray(v)?v.slice():[];
  if(f.kind==='boolean')return v===true;
  if(f.kind==='idref'||f.kind==='date')return v==null?'':String(v);
  return v==null?'':String(v);
}

/** Normalises a control's value to what the API expects for that kind. */
function pcCoerce(f,raw){
  if(f.kind==='boolean')return raw===true;
  if(f.kind==='list'){
    return String(raw||'').split('\n').map(s=>s.trim()).filter(Boolean);
  }
  if(f.kind==='idref'||f.kind==='date'){
    const t=String(raw||'').trim();
    return t===''?null:t;   // the API's idOrNull / dateOrNull kinds
  }
  return String(raw==null?'':raw);
}

/** True when two field values differ, list- and null-aware. */
function pcDiffers(f,a,b){
  if(f.kind==='list'){
    const x=Array.isArray(a)?a:[],y=Array.isArray(b)?b:[];
    return x.length!==y.length||x.some((v,i)=>v!==y[i]);
  }
  if(f.kind==='idref'||f.kind==='date'){
    return (a==null?'':String(a))!==(b==null?'':String(b));
  }
  return a!==b;
}

/** The changed subset, keyed by API column name. Unchanged fields are never
    sent, so an editor cannot accidentally rewrite a field they never touched. */
function pcChangedFields(fields,original,draft){
  const out={};
  for(const f of fields){
    const was=pcRead(original,f);
    const now=draft[f.col];
    if(now===undefined)continue;
    if(pcDiffers(f,was,now))out[f.col]=pcCoerce(f,now);
  }
  return out;
}

/** Status → operator sentence. The raw body is never rendered. */
function pcDescribe(e,what){
  const s=e&&e.status;
  if(s===400)return {kind:'err',text:'Some fields could not be saved. Check the messages below and try again.'};
  if(s===401)return {kind:'err',text:'Your session has expired. Sign in again to continue — nothing was changed.'};
  if(s===403)return {kind:'err',text:'Your account does not have permission to edit public content. Nothing was changed.'};
  if(s===404)return {kind:'err',text:'This '+(what||'record')+' no longer exists. It may have been removed by another editor.'};
  if(s===409)return {kind:'warn',text:'Another editor changed this '+(what||'record')+' while you were working. Your changes were NOT saved. Reload the current version, then reapply what you need.',action:'reload'};
  return {kind:'err',text:'The changes could not be saved. Nothing was changed — check your connection and try again.'};
}

/** Field-level errors from a 400, keyed by column. */
function pcFieldErrors(e){
  const list=(e&&e.data&&Array.isArray(e.data.fieldErrors))?e.data.fieldErrors:[];
  const out={};
  for(const fe of list){
    if(fe&&typeof fe.field==='string'&&typeof fe.message==='string')out[fe.field]=fe.message;
  }
  return out;
}

function pcBadge(state){
  const s=String(state||'').toLowerCase();
  const cls=s==='published'?'green':(s==='approved'?'blue':(s==='retired'?'red':'gray'));
  return `<span class="badge ${cls}">${esc(s||'—')}</span>`;
}

function pcPublishedBadge(on){
  return on?'<span class="badge green">Published</span>':'<span class="badge gray">Not published</span>';
}

/** Renders one control. `editable` false produces a disabled control that
    still shows the value, so a viewer sees exactly what an editor would. */
function pcControl(f,value,editable,error){
  const id='pc-f-'+f.col.replace(/[^a-z0-9]+/gi,'-');
  const dis=editable?'':' disabled';
  let control;
  if(f.kind==='textarea'||f.kind==='list'){
    const text=f.kind==='list'?(Array.isArray(value)?value.join('\n'):''):esc(value);
    control=`<textarea class="input" id="${id}" data-pc-field="${esc(f.col)}" rows="${f.kind==='list'?4:5}"${dis}>${esc(text)}</textarea>`;
  }else if(f.kind==='boolean'){
    control=`<label class="checkbox-row" for="${id}"><input type="checkbox" id="${id}" data-pc-field="${esc(f.col)}" ${value?'checked':''}${dis}> <span>${esc(f.label)}</span></label>`;
  }else if(f.kind==='enum'){
    control=`<select class="select" id="${id}" data-pc-field="${esc(f.col)}"${dis}>
      ${f.values.map(v=>`<option value="${esc(v)}"${String(value)===v?' selected':''}>${esc(v)}</option>`).join('')}
      ${f.values.indexOf(String(value))<0&&value?`<option value="${esc(value)}" selected disabled>${esc(value)}</option>`:''}
    </select>`;
  }else if(f.kind==='date'){
    control=`<input class="input" type="date" id="${id}" data-pc-field="${esc(f.col)}" value="${esc(String(value||'').slice(0,10))}"${dis}>`;
  }else{
    control=`<input class="input" id="${id}" data-pc-field="${esc(f.col)}" value="${esc(value)}"${dis}>`;
  }

  if(f.kind==='boolean'){
    return `<div class="field pc-field${error?' has-error':''}">${control}
      ${f.hint?`<div class="small muted">${esc(f.hint)}</div>`:''}
      ${error?`<div class="small pc-error" role="alert" id="${id}-err">${esc(error)}</div>`:''}</div>`;
  }
  return `<div class="field pc-field${error?' has-error':''}">
    <label for="${id}">${esc(f.label)}</label>
    ${control}
    ${f.hint?`<div class="small muted">${esc(f.hint)}</div>`:''}
    ${error?`<div class="small pc-error" role="alert" id="${id}-err">${esc(error)}</div>`:''}
  </div>`;
}

function pcDeniedHTML(){
  return `<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
    <div class="card-title" style="margin-bottom:6px">Access denied</div>
    <div class="small" style="margin-bottom:4px">
      Your account does not have the <b>View public content administration</b> capability, so this section is unavailable.
    </div>
    <div class="small muted">
      This capability is granted per account and is not implied by the administrator role.
      Ask someone who holds <b>Manage account permissions</b> to grant it to you.
    </div>
  </div>`;
}

function pcLoadFailedHTML(message){
  /* A failed load is NEVER rendered as "no records" — that is how an outage
     reads as an empty catalogue. */
  return `<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
    <div class="card-title" style="margin-bottom:6px">Could not load public content</div>
    <div class="small" style="margin-bottom:4px">${esc(message)}</div>
    <div class="small muted" style="margin-bottom:12px">
      No records are shown because none could be read. This is not an empty catalogue.
    </div>
    <button class="btn btn-dark btn-sm" data-pc-retry>Retry</button>
  </div>`;
}

/* Guards an unsaved edit before any navigation away. */
function pcConfirmLeave(dirty,label,onLeave){
  if(!dirty)return onLeave();
  Modal.confirm('Discard unsaved changes?',
    'You have unsaved changes to <b>'+esc(label)+'</b>. They have not been saved and will be lost.',
    onLeave,'Discard changes');
}

/* ---------------------------------------------------------------------------
   Landing — Brands / Products
   --------------------------------------------------------------------------- */

/* One registered route. App.currentRoute() splits the hash on '/', so the
   route name is always the FIRST segment and everything after it arrives as
   args — the same shape #/suitcases/<id> already uses. Sub-screens are
   therefore dispatched here rather than registered separately. */
App.register('public-content',function(el,args){
  const a=args||[];
  if(a[0]==='brands'&&a[1])return pcBrandScreen(el,a[1]);
  if(a[0]==='products'&&a[1]&&a[2]==='variations'&&a[3])return pcVariationScreen(el,a[1],a[3]);
  if(a[0]==='products'&&a[1])return pcProductScreen(el,a[1]);
  return pcListScreen(el,a);
});

function pcListScreen(el,args){
  if(!pcGate(el))return;
  const tab=(args&&args[0])==='products'?'products':'brands';
  const state=App._pc||(App._pc={q:'',page:1});
  if(App._pcTab!==tab){App._pcTab=tab;state.page=1;state.q='';}

  let rows=null,failure=null,loading=true;

  function shell(inner){
    el.innerHTML=`
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="flex" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div class="pc-tabs" role="tablist">
            <a class="btn ${tab==='brands'?'btn-dark':''}" role="tab" aria-selected="${tab==='brands'}" href="#/public-content/brands">Brands</a>
            <a class="btn ${tab==='products'?'btn-dark':''}" role="tab" aria-selected="${tab==='products'}" href="#/public-content/products">Products</a>
          </div>
          <div class="search-wrap">${I.search}<input class="input" id="pc-q" placeholder="Filter loaded records…" value="${esc(state.q)}"></div>
        </div>
        <div class="small muted" style="margin-top:8px">
          Public website content. ${App.can('public_content.edit')?'You may edit drafts.':'You have read-only access.'}
          Publishing is a separate action and is not available here.
        </div>
      </div>
      ${inner}`;
    const q=el.querySelector('#pc-q');
    if(q)q.oninput=debounce(()=>{state.q=q.value;state.page=1;paint();
      const n=el.querySelector('#pc-q');if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length);}});
    const retry=el.querySelector('[data-pc-retry]');
    if(retry)retry.onclick=()=>{retry.disabled=true;load();};
    bindPager(el,pg=>{state.page=pg;paint();});
  }

  function listHTML(){
    if(loading)return `<div class="card card-pad"><div class="muted small">Loading…</div></div>`;
    if(failure)return pcLoadFailedHTML(failure);

    let list=rows.slice();
    if(state.q){
      const q=state.q.toLowerCase();
      list=list.filter(r=>String(r.name||'').toLowerCase().includes(q)
        ||String(tab==='brands'?r.slug:r.publicSlug||'').toLowerCase().includes(q)
        ||String(r.sku||'').toLowerCase().includes(q));
    }
    if(!list.length){
      return `<div class="card card-pad"><div class="muted small">${rows.length
        ?'No records match that filter.'
        :'No '+tab+' exist yet. Records are created by the catalogue import, not here.'}</div></div>`;
    }
    const p=paginate(list,state.page,20);
    return `<div class="card"><div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th>${tab==='brands'?'Brand':'Model'}</th>
        <th>Public slug</th>
        <th>State</th>
        <th>Verification</th>
        <th>Public</th>
      </tr></thead>
      <tbody>${p.slice.map(r=>{
        const href=tab==='brands'?`#/public-content/brands/${encodeURIComponent(r.id)}`
                                 :`#/public-content/products/${encodeURIComponent(r.id)}`;
        const g=r.governance||{};
        return `<tr>
          <td><a class="linklike" href="${href}"><span class="cell-main">${esc(r.name||'—')}</span>
              ${tab==='products'&&r.sku?`<span class="cell-sub">${esc(r.sku)}</span>`:''}</a></td>
          <td class="muted">${esc((tab==='brands'?r.slug:r.publicSlug)||'—')}</td>
          <td>${pcBadge(g.publicationState)}</td>
          <td>${pcBadge(g.verificationStatus)}</td>
          <td>${pcPublishedBadge(r.isPublished)}</td>
        </tr>`;}).join('')}
      </tbody></table></div>${pagerHTML(p,tab)}</div>`;
  }

  function paint(){shell(listHTML());}

  async function load(){
    loading=true;failure=null;paint();
    try{
      rows=tab==='brands'?await DB.adminBrands():await DB.adminProducts();
      loading=false;
    }catch(e){
      loading=false;rows=null;
      failure=pcDescribe(e,tab==='brands'?'brand':'product').text;
    }
    paint();
  }
  load();
}

/** Shared entry guard: view capability, probing first if not yet known. */
function pcGate(el){
  if(App.can('public_content.view'))return true;
  if(App.capsChecked){el.innerHTML=pcDeniedHTML();return false;}
  el.innerHTML=`<div class="card card-pad"><div class="muted small">Checking your permissions…</div></div>`;
  App.loadCaps().then(()=>{App.renderNav();App.route();});
  return false;
}

/* ---------------------------------------------------------------------------
   Record editor — one implementation, three entities
   --------------------------------------------------------------------------- */

function pcEditor(el,cfg){
  if(!pcGate(el))return;

  const canEdit=App.can('public_content.edit');
  let record=null,draft={},errors={},notice=null,busy=false,loading=true,failure=null;

  const fields=()=>cfg.fields.concat(cfg.governance?PC_GOVERNANCE.map(f=>({...f,governance:true})):[]);
  const sendable=()=>{
    const allowed=DB.publicContentEditable[cfg.entity]||[];
    return fields().filter(f=>allowed.indexOf(f.col)>=0);
  };
  const changed=()=>record?pcChangedFields(sendable(),record,draft):{};
  const dirty=()=>Object.keys(changed()).length>0;

  async function load(){
    loading=true;failure=null;paint();
    try{
      record=await cfg.fetch();
      draft={};errors={};
      loading=false;
    }catch(e){
      loading=false;record=null;
      failure=pcDescribe(e,cfg.label).text;
    }
    paint();
  }

  async function save(){
    if(!record||busy||!dirty())return;
    const changes=changed();
    busy=true;notice=null;errors={};paint();
    try{
      record=await cfg.save(changes,record.concurrencyToken);
      /* Replaced from the SERVER's response, and the returned token replaces
         the spent one. The draft is cleared because the saved state is now
         the baseline. */
      draft={};
      notice={kind:'ok',text:'Saved. '+Object.keys(changes).length+' field(s) updated.'};
      DB.audit('public-content.save',cfg.entity+':'+record.id,Object.keys(changes).join(', '),'web');
      toast('Changes saved');
    }catch(e){
      /* No retry, and `record` is untouched — the screen must never imply a
         save the server refused. */
      notice=pcDescribe(e,cfg.label);
      if(e&&e.status===400)errors=pcFieldErrors(e);
    }finally{
      busy=false;paint();
    }
  }

  function headerHTML(){
    const g=record.governance||{};
    return `<div class="card card-pad" style="margin-bottom:12px">
      <div class="flex" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin-bottom:2px">${esc(cfg.title(record))}</div>
          <div class="small muted">${cfg.subtitle(record)}</div>
        </div>
        <div class="flex" style="gap:6px;align-items:flex-start">
          ${cfg.governance?pcBadge(g.publicationState):''}
          ${pcPublishedBadge(record.isPublished)}
        </div>
      </div>
      ${record.isPublished?`<div class="small muted" style="margin-top:8px">
        This record is live on the public website. Edits here change the published content when saved.</div>`:''}
      ${!canEdit?`<div class="small muted" style="margin-top:8px">
        You have read-only access. Editing requires the <b>Edit public content</b> capability.</div>`:''}
    </div>`;
  }

  function formHTML(){
    const allowed=DB.publicContentEditable[cfg.entity]||[];
    const groups=[{title:cfg.groupLabel,items:cfg.fields}];
    if(cfg.governance)groups.push({title:'Governance',items:PC_GOVERNANCE.map(f=>({...f,governance:true}))});

    return `<form class="card card-pad" id="pc-form" novalidate>
      ${groups.map(g=>`<div class="section-label">${esc(g.title.toUpperCase())}</div>
        <div class="grid g2">
        ${g.items.map(f=>{
          const editable=canEdit&&!busy&&allowed.indexOf(f.col)>=0;
          const value=draft[f.col]!==undefined?draft[f.col]:pcRead(record,f);
          return pcControl(f,value,editable,errors[f.col]);
        }).join('')}
        </div>`).join('')}

      ${cfg.governance?`<div class="small muted">
        Publication is a separate, gated action with its own capability and is not available on this screen.
        A record cannot be published or unpublished by changing its publication state here.</div>`:''}

      ${cfg.readOnlyNote?`<div class="section-label">READ-ONLY CONTEXT</div>
        <div class="small muted">${cfg.readOnlyNote(record)}</div>`:''}

      <div class="flex" style="justify-content:flex-end;gap:8px;margin-top:14px">
        <span class="small ${dirty()?'':'muted'}" id="pc-dirty" role="status" aria-live="polite">${dirty()?'Unsaved changes':'No unsaved changes'}</span>
        <button type="button" class="btn" data-pc-reset ${dirty()&&!busy&&canEdit?'':'disabled'}>Reset</button>
        <button type="submit" class="btn btn-dark" data-pc-save ${dirty()&&!busy&&canEdit?'':'disabled'}>${busy?'Saving…':'Save changes'}</button>
      </div>
    </form>`;
  }

  function paint(){
    if(loading){el.innerHTML=`<div class="card card-pad"><div class="muted small">Loading…</div></div>`;return;}
    if(failure||!record){
      el.innerHTML=`${cfg.backHTML()}${pcLoadFailedHTML(failure||'This record could not be loaded.')}`;
      const retry=el.querySelector('[data-pc-retry]');
      if(retry)retry.onclick=()=>{retry.disabled=true;load();};
      bindBack();
      return;
    }

    el.innerHTML=`${cfg.backHTML()}
      ${headerHTML()}
      ${notice?`<div class="card card-pad pc-notice ${notice.kind}" style="margin-bottom:12px">
        <div class="small">${esc(notice.text)}</div>
        ${notice.action==='reload'?'<button class="btn btn-sm" data-pc-reload style="margin-top:10px">Reload current version</button>':''}
      </div>`:''}
      ${formHTML()}
      ${cfg.extraHTML?cfg.extraHTML(record):''}`;

    bindBack();

    el.querySelectorAll('[data-pc-field]').forEach(ctl=>{
      const col=ctl.dataset.pcField;
      const f=fields().find(x=>x.col===col);
      if(!f)return;
      const handler=()=>{
        draft[col]=f.kind==='boolean'?ctl.checked:ctl.value;
        paintDirty();
      };
      if(f.kind==='boolean')ctl.onchange=handler;
      else if(f.kind==='enum'||f.kind==='date')ctl.onchange=handler;
      else ctl.oninput=handler;
    });

    const form=el.querySelector('#pc-form');
    if(form)form.onsubmit=e=>{e.preventDefault();save();};
    const reset=el.querySelector('[data-pc-reset]');
    if(reset)reset.onclick=()=>{draft={};errors={};notice=null;paint();};
    const reload=el.querySelector('[data-pc-reload]');
    if(reload)reload.onclick=()=>{reload.disabled=true;load();};
  }

  function bindBack(){
    el.querySelectorAll('[data-pc-back]').forEach(a=>a.onclick=e=>{
      e.preventDefault();
      const href=a.getAttribute('href');
      pcConfirmLeave(dirty(),cfg.title(record||{}),()=>{draft={};location.hash=href;});
    });
  }

  /** Repaints only the save affordances, so the control being typed into is
      not torn out from under the caret. */
  function paintDirty(){
    const on=dirty()&&!busy&&canEdit;
    const s=el.querySelector('[data-pc-save]'),r=el.querySelector('[data-pc-reset]'),d=el.querySelector('#pc-dirty');
    if(s)s.disabled=!on;
    if(r)r.disabled=!on;
    if(d){d.textContent=dirty()?'Unsaved changes':'No unsaved changes';d.classList.toggle('muted',!dirty());}
  }

  load();
  return {isDirty:dirty};
}

/* ---------------------------------------------------------------------------
   Brand
   --------------------------------------------------------------------------- */

function pcBrandScreen(el,id){
  return pcEditor(el,{
    entity:'brand',label:'brand',governance:true,groupLabel:'Brand content',
    fields:PC_FIELDS.brand,
    fetch:()=>DB.adminBrand(id),
    save:(changes,token)=>DB.patchAdminBrand(id,changes,token),
    title:r=>r.name||r.id||'Brand',
    subtitle:r=>esc(r.slug||'no slug')+' · '+esc(r.id||''),
    backHTML:()=>`<div style="margin-bottom:12px"><a class="btn btn-sm" data-pc-back href="#/public-content/brands">&lsaquo; All brands</a></div>`,
  });
}

/* ---------------------------------------------------------------------------
   Product (with its variations, from the same administrative detail)
   --------------------------------------------------------------------------- */

function pcProductScreen(el,id){
  return pcEditor(el,{
    entity:'product',label:'model',governance:true,groupLabel:'Model content',
    fields:PC_FIELDS.product,
    fetch:()=>DB.adminProduct(id),
    save:(changes,token)=>DB.patchAdminProduct(id,changes,token),
    title:r=>r.name||r.id||'Model',
    subtitle:r=>esc(r.sku||'no sku')+' · '+esc(r.id||''),
    backHTML:()=>`<div style="margin-bottom:12px"><a class="btn btn-sm" data-pc-back href="#/public-content/products">&lsaquo; All models</a></div>`,
    /* Context the API returns but this API can never write. Shown so an
       editor understands what they are looking at without being able to
       change it here. */
    readOnlyNote:r=>'Imported brand text: <b>'+esc(r.legacyBrandText||'—')+'</b>. '
      +'Size: <b>'+esc(r.size||'—')+'</b>. '
      +'Orderable in the portal: <b>'+(r.isActiveInPortal?'yes':'no')+'</b> — '
      +'this is the ordering flag and is entirely separate from public publication.',
    extraHTML:r=>`<div class="card" style="margin-top:16px">
      <div class="card-pad"><div class="card-title">Variations</div>
        <div class="small muted">Colourways of this model. Open one to edit its public colour details.</div></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Colour</th><th>Code</th><th>SKU</th><th>Public</th></tr></thead>
        <tbody>${r.variations.length?r.variations.map(v=>`<tr>
          <td><a class="linklike" data-pc-back href="#/public-content/products/${encodeURIComponent(r.id)}/variations/${encodeURIComponent(v.id)}">
            <span class="cell-main">${esc(v.colorName||'—')}</span></a></td>
          <td class="muted">${esc(v.colorCode||'—')}</td>
          <td class="muted">${esc(v.sku||'—')}</td>
          <td>${pcPublishedBadge(v.isPublished)}</td>
        </tr>`).join(''):`<tr><td colspan="4" class="empty-cell">This model has no variations.</td></tr>`}
        </tbody></table></div></div>`,
  });
}

/* ---------------------------------------------------------------------------
   Variation — reached through its product, never a global directory
   --------------------------------------------------------------------------- */

function pcVariationScreen(el,productId,id){
  return pcEditor(el,{
    entity:'variation',label:'variation',governance:false,groupLabel:'Variation content',
    fields:PC_FIELDS.variation,
    /* Its OWN token, from its own endpoint — a variation is never saved with
       the token of the product it was reached through. */
    fetch:()=>DB.adminVariation(id),
    save:(changes,token)=>DB.patchAdminVariation(id,changes,token),
    title:r=>r.colorName||r.id||'Variation',
    subtitle:r=>esc(r.sku||'no sku')+' · '+esc(r.id||''),
    backHTML:()=>`<div style="margin-bottom:12px"><a class="btn btn-sm" data-pc-back href="#/public-content/products/${encodeURIComponent(productId)}">&lsaquo; Back to model</a></div>`,
    readOnlyNote:r=>'Orderable in the portal: <b>'+(r.isActiveInPortal?'yes':'no')+'</b> — separate from public publication.',
  });
}
