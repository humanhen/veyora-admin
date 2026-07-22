/* ================= Pages: Catalog — Products, Product form/detail, Production, Inventory, Warehouses, CSV imports, Import Data ================= */
'use strict';

function pickCSVFile(cb){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.csv,.txt';
  inp.onchange=()=>{
    const f=inp.files[0];if(!f)return;
    const rd=new FileReader();
    rd.onload=()=>{
      const rows=String(rd.result).split(/\r?\n/).filter(Boolean).map(l=>l.split(',').map(c=>c.replace(/^"|"$/g,'').trim()));
      cb(rows,f.name);
    };
    rd.readAsText(f);
  };
  inp.click();
}

/* ============================================================ PRODUCTS LIST */
App.register('products',function(el){
  const state=App._prod||(App._prod={q:'',brand:'',page:1});

  function importModal(){
    Modal.open({title:'Import CSV — Products & Variations',size:'wide',
      body:`
      <div class="info-banner">${I.eye}<div>Two separate uploads, each with a downloadable template. They're independent — upload products then variations, in any order. They do <b>not</b> import stock quantities — use the Stock CSV import for that.</div></div>
      <div class="two-col">
        <div class="card card-pad">
          <div class="card-title">Products CSV</div>
          <div class="small muted" style="margin-bottom:10px">Creates/updates products (matched by SKU): name, SKU, size, description, prices, categories, brand, EAN, tags, attributes.</div>
          <div class="flex"><button class="btn btn-sm" id="ip-tpl">${I.download} Template</button>
          <button class="btn btn-dark btn-sm" id="ip-up">${I.upload} Upload Products CSV</button></div>
        </div>
        <div class="card card-pad">
          <div class="card-title">Variations CSV</div>
          <div class="small muted" style="margin-bottom:10px">Adds/updates variations (matched to an existing product by SKU): variation SKU, color, prices, stock status.</div>
          <div class="flex"><button class="btn btn-sm" id="iv-tpl">${I.download} Template</button>
          <button class="btn btn-dark btn-sm" id="iv-up">${I.upload} Upload Variations CSV</button></div>
        </div>
      </div>`,
      foot:`<button class="btn" data-x>Close</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('#ip-tpl').onclick=()=>downloadCSV('products-template.csv',
          [['sku','name','size','description','regular_price','sale_price','categories','brand','ean','tags','lens_w','bridge','lens_h','temple']]);
        ov.querySelector('#iv-tpl').onclick=()=>downloadCSV('variations-template.csv',
          [['product_sku','variation_sku','color','regular_price','sale_price','stock_status']]);
        ov.querySelector('#ip-up').onclick=()=>pickCSVFile(rows=>{
          const head=rows[0].map(h=>h.toLowerCase());
          const g=(r,k)=>{const i=head.indexOf(k);return i>=0?r[i]:'';};
          let created=0,updated=0;
          for(const r of rows.slice(1)){
            const sku=g(r,'sku');if(!sku)continue;
            let p=DB.productBySku(sku);
            const vals={name:g(r,'name'),size:g(r,'size'),description:g(r,'description'),
              price:parseFloat(g(r,'regular_price'))||0,salePrice:g(r,'sale_price')?parseFloat(g(r,'sale_price')):null,
              categories:(g(r,'categories')||'').split(';').filter(Boolean),brand:g(r,'brand')||'Charlett',
              ean:g(r,'ean'),tags:(g(r,'tags')||'').split(';').filter(Boolean),updatedAt:todayISO()};
            if(p){Object.assign(p,vals);updated++;}
            else{DB.d.products.push(Object.assign({id:uid('p'),sku,images:[],variations:[],
              attributes:{lens_w:+g(r,'lens_w')||null,bridge:+g(r,'bridge')||null,lens_h:+g(r,'lens_h')||null,temple:+g(r,'temple')||null,lensType:'',caseCode:''},
              createdAt:todayISO()},vals));created++;}
          }
          DB.save();DB.audit('product.import',created+' created / '+updated+' updated','Products CSV','csv');
          toast(created+' created, '+updated+' updated');render();
        });
        ov.querySelector('#iv-up').onclick=()=>pickCSVFile(rows=>{
          const head=rows[0].map(h=>h.toLowerCase());
          const g=(r,k)=>{const i=head.indexOf(k);return i>=0?r[i]:'';};
          let n=0,skipped=0;
          for(const r of rows.slice(1)){
            const p=DB.productBySku(g(r,'product_sku'));
            if(!p){skipped++;continue;}
            const vsku=g(r,'variation_sku');if(!vsku)continue;
            let v=p.variations.find(x=>x.sku===vsku);
            const vals={color:g(r,'color'),price:parseFloat(g(r,'regular_price'))||p.price,
              salePrice:g(r,'sale_price')?parseFloat(g(r,'sale_price')):null,
              stockStatus:g(r,'stock_status')||'in stock'};
            if(v)Object.assign(v,vals);
            else{const st={};DB.d.warehouses.forEach(w=>st[w.id]={qty:0,shelf:''});
              p.variations.push(Object.assign({sku:vsku,image:null,stock:st},vals));}
            n++;
          }
          DB.save();DB.audit('variation.import',n+' variations','Variations CSV'+(skipped?' — '+skipped+' rows skipped (product not found)':''),'csv');
          toast(n+' variations imported'+(skipped?', '+skipped+' skipped':''));render();
        });
      }});
  }

  function render(){
    const d=DB.d;
    const brands=[...new Set(d.products.map(p=>p.brand))].sort();
    let list=d.products.slice();
    if(state.brand)list=list.filter(p=>p.brand===state.brand);
    if(state.q){const q=state.q.toLowerCase();
      list=list.filter(p=>p.name.toLowerCase().includes(q)||p.sku.toLowerCase().includes(q)||(p.description||'').toLowerCase().includes(q));}
    list.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const p=paginate(list,state.page);

    el.innerHTML=`
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex" style="justify-content:space-between">
        <div class="flex">
          <div class="search-wrap">${I.search}<input class="input" id="pr-q" placeholder="Search here…" value="${esc(state.q)}"></div>
          <select class="select" id="pr-brand"><option value="">Brand</option>
            ${brands.map(b=>`<option ${state.brand===b?'selected':''}>${b}</option>`).join('')}</select>
        </div>
        <div class="flex">
          <button class="btn" id="pr-import">${I.fileCsv} Import CSV</button>
          <button class="btn btn-dark" id="pr-add">${I.plus} Add Product</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Image</th><th>Name</th><th>SKU</th><th>Stock</th><th>Price</th><th>Categories</th><th>Created Date</th><th>Updated Date</th><th>Actions</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(pr=>{
          const stock=DB.productQty(pr);
          const c0=pr.variations[0]?COLOR_HEX[(pr.variations[0].color||'').toLowerCase()]:null;
          return `<tr>
            <td><div class="thumb-box">${glassesSVG(c0)}</div></td>
            <td class="cell-main">${esc(pr.name)}</td>
            <td>${esc(pr.sku)}</td>
            <td>${stock}</td>
            <td>${pr.salePrice!=null?`<s class="muted small">${money0(pr.price)}</s> ${money0(pr.salePrice)}`:(Number.isInteger(pr.price)?'$'+pr.price:money(pr.price))}</td>
            <td class="small" style="max-width:190px">${pr.categories.join(', ')}</td>
            <td>${fmtDate(pr.createdAt)}</td>
            <td>${fmtDate(pr.updatedAt)}</td>
            <td><div class="row-actions">
              <button class="icon-btn" data-edit="${pr.id}" title="Edit">${I.pencil}</button>
              <button class="icon-btn" data-view="${pr.id}" title="View details">${I.eye}</button>
              <button class="icon-btn danger" data-del="${pr.id}" title="Delete">${I.trash}</button>
            </div></td>
          </tr>`;}).join(''):`<tr><td colspan="9" class="empty-cell">No products found</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;

    const q=el.querySelector('#pr-q');
    q.oninput=debounce(()=>{state.q=q.value;state.page=1;render();const nq=el.querySelector('#pr-q');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelector('#pr-brand').onchange=e=>{state.brand=e.target.value;state.page=1;render();};
    el.querySelector('#pr-add').onclick=()=>{location.hash='#/product-edit/new';};
    el.querySelector('#pr-import').onclick=importModal;
    bindPager(el,pg=>{state.page=pg;render();});
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{location.hash='#/product/'+b.dataset.view;});
    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const pr=DB.product(b.dataset.edit);
      Modal.confirm('Edit product','Open <b>'+esc(pr.name)+'</b> for editing?',()=>{location.hash='#/product-edit/'+pr.id;},'Edit');
    });
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const pr=DB.product(b.dataset.del);
      Modal.confirm('Delete product','Delete <b>'+esc(pr.name)+'</b> ('+esc(pr.sku)+')? This cannot be undone.',()=>{
        DB.d.products=DB.d.products.filter(x=>x.id!==pr.id);
        DB.save();DB.audit('product.delete',pr.sku,pr.name);
        render();toast('Product deleted');
      },'Delete');
    });
  }
  render();
});

/* ============================================================ PRODUCT CREATE / EDIT */
App.register('product-edit',function(el,args){
  const isNew=args[0]==='new';
  const p=isNew?{id:null,name:'',sku:'',size:'',categories:[],ean:'',brand:'',tags:[],images:[],description:'',
    attributes:{lens_w:'',bridge:'',lens_h:'',temple:'',lensType:'',caseCode:''},
    price:'',salePrice:'',variations:[]}:JSON.parse(JSON.stringify(DB.product(args[0])||{}));
  if(!isNew&&!p.id){el.innerHTML='<div class="card card-pad">Product not found.</div>';return;}
  const CATS=['Charlett','Spike','Saint Cloud','Liv','Specterfeid','Monroe','Aster','Eyeglasses','Sunglasses','Women','Men','Kids','Plastic','Metal','Titanium'];

  function render(){
    const inv=p.variations.reduce((s,v)=>s+Object.values(v.stock||{}).reduce((a,w)=>a+(w.qty||0),0),0);
    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <a class="back-btn" href="#/products">&larr;</a>
      <div class="page-title" style="font-size:16px">${isNew?'Add Product':'Edit Product — '+esc(p.name||p.sku)}</div>
      <button class="btn btn-dark right" id="pf-save">${I.check} Save Product</button>
    </div>
    <div class="card card-pad">
      <div class="grid g3">
        <div class="field"><label>Product Name</label><input class="input" id="pf-name" placeholder="Enter product name" value="${esc(p.name)}"></div>
        <div class="field"><label>SKU</label><input class="input" id="pf-sku" placeholder="Enter SKU" value="${esc(p.sku)}"></div>
        <div class="field"><label>Size</label><select class="select" id="pf-size"><option value=""></option>
          ${['46-22','48-20','50-21','52-18','54-17'].map(s=>`<option ${p.size===s?'selected':''}>${s}</option>`).join('')}</select></div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="field"><label>Inventory (computed)</label><input class="input" value="${inv}" disabled>
          <div class="hint">Sum across all variants and warehouses</div></div>
        <div class="field"><label>Category</label>
          <div class="flex" style="gap:6px">${CATS.map(c=>`<button type="button" class="chip ${p.categories.includes(c)?'active':''}" data-cat="${c}" style="padding:4px 11px;font-size:11px">${c}</button>`).join('')}</div></div>
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div class="field"><label>EAN barcode</label><input class="input" id="pf-ean" placeholder="e.g. 3700123456789" value="${esc(p.ean)}">
          <div class="hint">Optional. 12–14 digits.</div></div>
        <div class="field"><label>Brand</label><input class="input" id="pf-brand" placeholder="e.g. Charlett" value="${esc(p.brand)}">
          <div class="hint">Used for brand-targeted promotions.</div></div>
        <div class="field"><label>Tags</label><input class="input" id="pf-tags" placeholder="Add tag and press Enter" value="${esc(p.tags.join(', '))}">
          <div class="hint">Shown as badges on product cards.</div></div>
      </div>
      <div class="field" style="margin-top:14px"><label>Product Images</label>
        <div class="hint" style="margin-bottom:6px">Upload multiple images (JPG, PNG, WEBP - Max 5MB each)</div>
        <div class="flex">
          <div class="img-drop" id="pf-img" title="Add images">${I.image}</div>
          ${p.images.map((im,ix)=>`<div class="img-drop" style="background:#fff;position:relative;overflow:hidden">${photoThumb(im)}
            <button class="icon-btn danger" data-rmimg="${ix}" style="position:absolute;top:-6px;right:-6px;background:#fff;border:1px solid var(--line);z-index:1">${I.x}</button></div>`).join('')}
        </div></div>
      <div class="field" style="margin-top:14px"><label>Description</label>
        <textarea class="input" id="pf-desc" placeholder="Enter product description">${esc(p.description)}</textarea></div>

      <div class="section-label">ATTRIBUTES</div>
      <div class="grid g4">
        <div class="field"><label>Lens Width (lens_w)</label><input class="input" type="number" id="pf-lensw" value="${p.attributes.lens_w||''}" onwheel="this.blur()"></div>
        <div class="field"><label>Bridge (bridge)</label><input class="input" type="number" id="pf-bridge" value="${p.attributes.bridge||''}" onwheel="this.blur()"></div>
        <div class="field"><label>Lens Height (lens_h)</label><input class="input" type="number" id="pf-lensh" value="${p.attributes.lens_h||''}" onwheel="this.blur()"></div>
        <div class="field"><label>Temple (temple)</label><input class="input" type="number" id="pf-temple" value="${p.attributes.temple||''}" onwheel="this.blur()"></div>
        <div class="field"><label>Lens type</label><input class="input" id="pf-lenst" value="${esc(p.attributes.lensType||'')}"></div>
        <div class="field"><label>Case code</label><input class="input" id="pf-case" value="${esc(p.attributes.caseCode||'')}"></div>
      </div>

      <div class="section-label">PRICING</div>
      <div class="grid g2" style="max-width:480px">
        <div class="field"><label>Regular Price ($)</label><input class="input" type="number" step="0.01" id="pf-price" value="${p.price}" onwheel="this.blur()"></div>
        <div class="field"><label>Sale Price ($)</label><input class="input" type="number" step="0.01" id="pf-sale" value="${p.salePrice==null?'':p.salePrice}" onwheel="this.blur()">
          <div class="hint">If set, that's what shows in the store.</div></div>
      </div>

      <div class="section-label">VARIATIONS <span style="font-weight:400">(colors / different SKUs of the same model)</span></div>
      <div class="flex-col" id="pf-vars">
        ${p.variations.map((v,ix)=>`
        <div class="variation-row">
          <div class="spread">
            <div class="flex">${glassesSVG(COLOR_HEX[(v.color||'').toLowerCase()])}<b>${esc(v.sku||'(new)')}</b></div>
            <button class="icon-btn danger" data-rmvar="${ix}">${I.trash}</button>
          </div>
          <div class="grid g4" style="margin-top:10px">
            <div class="field"><label>Variation SKU</label><input class="input" data-vsku="${ix}" value="${esc(v.sku)}"></div>
            <div class="field"><label>Color</label><input class="input" data-vcolor="${ix}" value="${esc(v.color)}"></div>
            <div class="field"><label>Regular price</label><input class="input" type="number" step="0.01" data-vprice="${ix}" value="${v.price==null?'':v.price}" onwheel="this.blur()"></div>
            <div class="field"><label>Sale price</label><input class="input" type="number" step="0.01" data-vsale="${ix}" value="${v.salePrice==null?'':v.salePrice}" onwheel="this.blur()"></div>
            <div class="field"><label>Stock status</label><select class="select" data-vstatus="${ix}">
              ${['in stock','out of stock','in production'].map(s=>`<option ${v.stockStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
            <div class="field"><label>Quantity (computed)</label><input class="input" value="${Object.values(v.stock||{}).reduce((a,w)=>a+(w.qty||0),0)}" disabled></div>
            <div class="field"><label>Image</label>
              <div class="flex" style="align-items:center;gap:8px">
                ${v.image?`<div class="img-drop" style="width:44px;height:28px;flex:none;overflow:hidden;background:#fff">${photoThumb(v.image)}</div>`:''}
                <button class="btn btn-sm" type="button" data-vimg="${ix}">${I.upload} ${v.image?'Replace':'Upload'}</button>
                ${v.image?`<button class="icon-btn danger" type="button" data-vimgrm="${ix}" title="Remove image">${I.x}</button>`:''}
              </div></div>
          </div>
        </div>`).join('')}
      </div>
      <button class="btn" id="pf-addvar" style="margin-top:12px">${I.plus} Add variation</button>
      <div class="note-banner" style="margin-top:16px">Stock by warehouse — after saving, set quantity and shelf per warehouse on the product detail page. The total stock is calculated automatically from the sum of the variations and warehouses.</div>
    </div>`;

    el.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{
      const c=b.dataset.cat;
      collect();
      if(p.categories.includes(c))p.categories=p.categories.filter(x=>x!==c);
      else p.categories.push(c);
      render();
    });
    function pickImages(multiple){
      return new Promise(resolve=>{
        const inp=document.createElement('input');
        inp.type='file';inp.accept='image/*';inp.multiple=!!multiple;
        inp.onchange=()=>resolve(inp.files&&inp.files.length?inp.files:null);
        inp.click();
      });
    }
    el.querySelector('#pf-img').onclick=async()=>{
      const files=await pickImages(true);
      if(!files)return;
      collect();
      try{ const paths=await DB.uploadImages(files); p.images.push(...paths); render(); }
      catch(e){ toast('Image upload failed: '+e.message,true); }
    };
    el.querySelectorAll('[data-rmimg]').forEach(b=>b.onclick=()=>{collect();p.images.splice(+b.dataset.rmimg,1);render();});
    el.querySelectorAll('[data-vimg]').forEach(b=>b.onclick=async()=>{
      const files=await pickImages(false);
      if(!files)return;
      collect();
      try{ const paths=await DB.uploadImages(files); if(paths[0])p.variations[+b.dataset.vimg].image=paths[0]; render(); }
      catch(e){ toast('Image upload failed: '+e.message,true); }
    });
    el.querySelectorAll('[data-vimgrm]').forEach(b=>b.onclick=()=>{collect();p.variations[+b.dataset.vimgrm].image=null;render();});
    el.querySelector('#pf-addvar').onclick=()=>{
      collect();
      const st={};DB.d.warehouses.forEach(w=>st[w.id]={qty:0,shelf:''});
      p.variations.push({sku:p.sku?p.sku+'.'+(p.variations.length+1):'',color:'',image:null,
        price:parseFloat(el.querySelector('#pf-price').value)||null,salePrice:null,stockStatus:'in stock',stock:st});
      render();
    };
    el.querySelectorAll('[data-rmvar]').forEach(b=>b.onclick=()=>{collect();p.variations.splice(+b.dataset.rmvar,1);render();});

    function collect(){
      p.name=el.querySelector('#pf-name').value.trim();
      p.sku=el.querySelector('#pf-sku').value.trim();
      p.size=el.querySelector('#pf-size').value;
      p.ean=el.querySelector('#pf-ean').value.trim();
      p.brand=el.querySelector('#pf-brand').value.trim();
      p.tags=el.querySelector('#pf-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
      p.description=el.querySelector('#pf-desc').value;
      p.attributes={lens_w:el.querySelector('#pf-lensw').value,bridge:el.querySelector('#pf-bridge').value,
        lens_h:el.querySelector('#pf-lensh').value,temple:el.querySelector('#pf-temple').value,
        lensType:el.querySelector('#pf-lenst').value,caseCode:el.querySelector('#pf-case').value};
      p.price=parseFloat(el.querySelector('#pf-price').value)||0;
      const sp=el.querySelector('#pf-sale').value;
      p.salePrice=sp===''?null:parseFloat(sp);
      el.querySelectorAll('[data-vsku]').forEach(i=>p.variations[+i.dataset.vsku].sku=i.value.trim());
      el.querySelectorAll('[data-vcolor]').forEach(i=>p.variations[+i.dataset.vcolor].color=i.value.trim());
      el.querySelectorAll('[data-vprice]').forEach(i=>p.variations[+i.dataset.vprice].price=i.value===''?null:parseFloat(i.value));
      el.querySelectorAll('[data-vsale]').forEach(i=>p.variations[+i.dataset.vsale].salePrice=i.value===''?null:parseFloat(i.value));
      el.querySelectorAll('[data-vstatus]').forEach(i=>p.variations[+i.dataset.vstatus].stockStatus=i.value);
    }

    el.querySelector('#pf-save').onclick=()=>{
      collect();
      p.updatedAt=todayISO();
      if(isNew&&!p.id){
        p.id=uid('p');p.createdAt=todayISO();
        DB.d.products.unshift(p);
        DB.audit('product.create',p.sku||'(no sku)',p.name);
      }else{
        const orig=DB.product(p.id);
        Object.assign(orig,p);
        DB.audit('product.edit',p.sku,p.name);
      }
      DB.save();
      toast('Product saved');
      location.hash='#/product/'+p.id;
    };
  }
  render();
});

/* ============================================================ PRODUCT DETAIL (read-only + stock per warehouse) */
App.register('product',function(el,args){
  const p=DB.product(args[0]);
  if(!p){el.innerHTML='<div class="card card-pad">Product not found.</div>';return;}

  function render(){
    const total=DB.productQty(p);
    const usd=p.salePrice!=null?p.salePrice:p.price;
    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <a class="back-btn" href="#/products">&larr;</a>
      <div class="page-title" style="font-size:16px">${esc(p.name||p.sku)}</div>
      <button class="btn right" id="pd-edit">${I.pencil} Edit</button>
    </div>
    <div class="two-col">
      <div class="flex-col">
        <div class="card card-pad" style="display:flex;align-items:center;justify-content:center;min-height:200px">
          ${glassesSVG(COLOR_HEX[((p.variations[0]||{}).color||'').toLowerCase()]).replace('width="44" height="22"','width="200" height="100"')}
        </div>
        <div class="card card-pad">
          <div class="small muted">SKU:</div><b>${esc(p.sku)}</b>
          <div class="flex" style="margin-top:10px">
            <span class="badge ${total>0?'green':'red'}">${I.box} Stock: ${total} Units</span>
            ${total===0?'<span class="badge gray">Inactive</span>':''}
            ${p.tags.map(t=>`<span class="tag-pill">${esc(t)}</span>`).join('')}
          </div>
          <div class="divider"></div>
          <div class="small muted">Description</div>
          <div class="small">${esc(p.description||'No description available')}</div>
          <div class="divider"></div>
          <dl class="kv">
            <dt>Brand</dt><dd>${esc(p.brand)}</dd>
            <dt>Size</dt><dd>${esc(p.size||'—')}</dd>
            <dt>EAN</dt><dd>${esc(p.ean||'—')}</dd>
            <dt>Categories</dt><dd>${p.categories.join(', ')||'—'}</dd>
            <dt>Lens width</dt><dd>${p.attributes.lens_w||'—'}</dd>
            <dt>Bridge</dt><dd>${p.attributes.bridge||'—'}</dd>
            <dt>Lens height</dt><dd>${p.attributes.lens_h||'—'}</dd>
            <dt>Temple</dt><dd>${p.attributes.temple||'—'}</dd>
          </dl>
        </div>
      </div>
      <div class="flex-col">
        <div class="card card-pad">
          <div class="card-title">💰 Pricing (Multi-Currency)</div>
          <div class="price-cards">
            <div class="price-card"><div class="cur">USD</div><div class="val">$${(usd||0).toFixed(2)}</div>
              <div class="sale">Sale: ${p.salePrice!=null?'$'+p.salePrice.toFixed(2):'$—'}</div></div>
            <div class="price-card"><div class="cur">CAD</div><div class="val">CA$${((usd||0)*1.37).toFixed(2)}</div>
              <div class="sale">Sale: ${p.salePrice!=null?'CA$'+(p.salePrice*1.37).toFixed(2):'CA$—'}</div></div>
          </div>
        </div>
        <div class="card card-pad">
          <div class="card-title">Variations &amp; Stock by Warehouse</div>
          ${p.variations.map((v,vi)=>`
            <div style="margin-bottom:18px">
              <div class="flex">${glassesSVG(COLOR_HEX[(v.color||'').toLowerCase()])}
                <b>${esc(v.sku)}</b><span class="muted">${esc(v.color)}</span>
                <span class="badge ${v.stockStatus==='in stock'?'green':v.stockStatus==='in production'?'blue':'red'}">${esc(v.stockStatus)}</span>
                <span class="right small muted">Total: <b>${DB.variationQty(v)}</b></span></div>
              <div class="table-wrap" style="margin-top:8px"><table class="tbl">
                <thead><tr><th>Warehouse</th><th style="width:110px">Quantity</th><th style="width:110px">Shelf</th><th style="width:80px"></th></tr></thead>
                <tbody>${DB.d.warehouses.map(w=>{
                  const st=(v.stock||{})[w.id]||{qty:0,shelf:''};
                  return `<tr>
                    <td>${esc(w.name)} <span class="muted small">(${esc(w.code)})</span></td>
                    <td><input class="input" type="number" style="width:90px;padding:5px 8px" data-q="${vi}:${w.id}" value="${st.qty}" onwheel="this.blur()"></td>
                    <td><input class="input" style="width:90px;padding:5px 8px" data-s="${vi}:${w.id}" value="${esc(st.shelf)}"></td>
                    <td><button class="btn btn-sm" data-save="${vi}:${w.id}">Save</button></td>
                  </tr>`;}).join('')}
                </tbody></table></div>
            </div>`).join('')||'<div class="muted small">No variations.</div>'}
          <div class="dashed-banner">The product's total stock = the sum of stock across all variations and warehouses.</div>
        </div>
      </div>
    </div>`;

    el.querySelector('#pd-edit').onclick=()=>{location.hash='#/product-edit/'+p.id;};
    el.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>{
      const [vi,wid]=b.dataset.save.split(':');
      const v=p.variations[+vi];
      v.stock=v.stock||{};v.stock[wid]=v.stock[wid]||{qty:0,shelf:''};
      v.stock[wid].qty=parseInt(el.querySelector(`[data-q="${vi}:${wid}"]`).value,10)||0;
      v.stock[wid].shelf=el.querySelector(`[data-s="${vi}:${wid}"]`).value.trim();
      DB.save();DB.audit('stock.set',v.sku,DB.warehouse(wid).code+' qty='+v.stock[wid].qty+' shelf='+v.stock[wid].shelf);
      toast('Stock saved');render();
    });
  }
  render();
});

/* ============================================================ PRODUCTION */
App.register('production',function(el){
  const d=DB.d;

  /* Production state lives on the product itself (productionStatus +
     estimatedArrival), which persists through sync — the old d.production
     array was never a synced collection, so it vanished on every reload. */
  function inProduction(){ return d.products.filter(p=>p.productionStatus==='in_production'); }

  function render(){
    const list=inProduction();
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Production Management</div>
      <button class="btn btn-dark" id="pd-add">${I.plus} Add To Production</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Image</th><th>Name</th><th>SKU</th><th>Stock</th><th>Estimated Arrival</th><th>Days Left</th><th>Actions</th></tr></thead>
        <tbody>${list.length?list.map(p=>{
          const days=p.estimatedArrival?Math.ceil((new Date(p.estimatedArrival)-new Date())/864e5):null;
          const cls=days==null?'blue':days<0?'red':days<=7?'orange':'blue';
          return `<tr>
            <td><div class="thumb-box" style="overflow:hidden">${photoThumb(p.images&&p.images[0])}</div></td>
            <td class="cell-main">${esc(p.name)}</td>
            <td>${esc(p.sku)}</td>
            <td>${DB.productQty(p)}</td>
            <td>${p.estimatedArrival?fmtDateShort(p.estimatedArrival):'—'}</td>
            <td><span class="badge ${cls}">${days==null?'—':days<0?'Overdue':days+' days'}</span></td>
            <td><button class="btn btn-sm btn-dark" data-back="${p.id}">Back in Stock</button></td>
          </tr>`;}).join(''):`<tr><td colspan="7" class="empty-cell">No products currently in production</td></tr>`}
        </tbody></table></div>
    </div>`;

    el.querySelector('#pd-add').onclick=()=>{
      Modal.open({title:'Add To Production',
        body:`
        <div class="field"><label>Product SKU</label><input class="input" id="ap-sku" placeholder="Type a product SKU"></div>
        <div class="field"><label>Estimated Arrival</label><input type="date" class="input" id="ap-eta" value="${isoDay(new Date(Date.now()+30*864e5))}"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Add</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const p=DB.productBySku(ov.querySelector('#ap-sku').value);
            if(!p)return toast('Product not found',true);
            p.productionStatus='in_production';
            p.estimatedArrival=ov.querySelector('#ap-eta').value||null;
            p.variations.forEach(v=>v.stockStatus='in production');
            DB.save();DB.audit('production.add',p.sku,'ETA '+(p.estimatedArrival||'—'));
            close();render();toast('Added to production');
          };
        }});
    };
    el.querySelectorAll('[data-back]').forEach(b=>b.onclick=()=>{
      const p=DB.product(b.dataset.back);
      if(!p)return;
      p.productionStatus='none';
      p.estimatedArrival=null;
      p.variations.forEach(v=>v.stockStatus='in stock');
      DB.save();DB.audit('production.back-in-stock',p.sku,'');
      render();toast('Marked back in stock');
    });
  }
  render();
});

/* ============================================================ INVENTORY */
App.register('inventory',function(el){
  const state=App._inv||(App._inv={tab:'Inventory Dashboard',sort:'velocity',dir:-1,page:1,vel:null});

  function render(){
    const d=DB.d;
    if(!state.vel)state.vel=DB.monthlyVelocity();
    const thr=d.settings.sellingFastThreshold;

    let inner='';
    if(state.tab==='Inventory Dashboard'){
      let rows=d.products.map(p=>{
        const stock=DB.productQty(p);
        const vel=p.variations.reduce((s,v)=>s+(state.vel[v.sku]||0),0);
        const fast=vel>=thr;
        const reorder=Math.max(0,Math.ceil(vel*3-stock));
        return {p,stock,vel,fast,reorder};
      });
      rows.sort((a,b)=>{
        const k=state.sort;
        const va=k==='velocity'?a.vel:k==='stock'?a.stock:k==='reorder'?a.reorder:a.p.name;
        const vb=k==='velocity'?b.vel:k==='stock'?b.stock:k==='reorder'?b.reorder:b.p.name;
        return (va>vb?1:va<vb?-1:0)*state.dir;
      });
      const p=paginate(rows,state.page,12);
      inner=`
      <div class="table-wrap"><table class="tbl">
        <thead><tr>
          <th>Image</th>
          <th class="sortable" data-sort="name">Product Name</th>
          <th>SKU</th>
          <th class="sortable" data-sort="stock">Current Stock</th>
          <th class="sortable" data-sort="velocity">Monthly Velocity ${state.sort==='velocity'?(state.dir<0?'↓':'↑'):''}</th>
          <th>Selling Fast</th>
          <th class="sortable" data-sort="reorder">Suggested Reorder</th>
        </tr></thead>
        <tbody>${p.slice.length?p.slice.map(r=>`<tr>
          <td><div class="thumb-box">${glassesSVG()}</div></td>
          <td class="cell-main">${esc(r.p.name)}</td>
          <td>${esc(r.p.sku)}</td>
          <td><span class="badge ${r.stock<=0?'red':r.stock<10?'orange':'gray'}">${r.stock}</span></td>
          <td>${r.vel.toFixed(1)} / mo</td>
          <td>${r.fast?'<span class="badge orange">Selling Fast</span>':''}</td>
          <td>${r.reorder>0?'<b>'+r.reorder+'</b> units':'—'}</td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No products found</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}`;
    }else{
      inner=`
      <div class="card card-pad" style="max-width:520px;box-shadow:none;border:1px solid var(--line)">
        <div class="field"><label>"Selling fast" threshold — monthly sales above this marks a product as selling fast</label>
          <input class="input" type="number" id="rl-thr" value="${thr}" style="max-width:160px"></div>
        <div class="small muted" style="margin:10px 0">Affects the badge and the reorder recommendation.</div>
        <button class="btn btn-dark" id="rl-save">Save Rule</button>
      </div>`;
    }

    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Inventory Management</div>
      <button class="btn btn-dark" id="inv-recalc">${I.refresh} Recalculate Velocity</button>
    </div>
    <div class="card card-pad">
      <div class="tabs">
        ${['Inventory Dashboard','Rules'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}
      </div>
      ${inner}
    </div>`;

    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
    el.querySelector('#inv-recalc').onclick=()=>{state.vel=DB.monthlyVelocity();toast('Velocity recalculated from historical data');render();};
    el.querySelectorAll('.sortable').forEach(th=>th.onclick=()=>{
      const k=th.dataset.sort;
      if(state.sort===k)state.dir*=-1;else{state.sort=k;state.dir=-1;}
      render();
    });
    bindPager(el,pg=>{state.page=pg;render();});
    const rs=el.querySelector('#rl-save');
    if(rs)rs.onclick=()=>{
      DB.d.settings.sellingFastThreshold=+el.querySelector('#rl-thr').value||20;
      DB.save();DB.audit('inventory.rules','threshold','= '+DB.d.settings.sellingFastThreshold);
      toast('Rule saved');
    };
  }
  render();
});

/* ============================================================ WAREHOUSES */
App.register('warehouses',function(el){
  const state=App._wh||(App._wh={wh:'wh_rs',q:'',page:1,transfer:[]});

  function render(){
    const d=DB.d;
    const rows=[];
    for(const p of d.products){
      for(const v of p.variations){
        const st=(v.stock||{})[state.wh];
        if(!st)continue;
        if(state.q){
          const q=state.q.toLowerCase();
          if(!v.sku.toLowerCase().includes(q)&&!p.name.toLowerCase().includes(q)&&!p.brand.toLowerCase().includes(q))continue;
        }
        if(st.qty>0||state.q)rows.push({p,v,st});
      }
    }
    rows.sort((a,b)=>b.st.qty-a.st.qty);
    const p=paginate(rows,state.page,12);

    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Warehouses</div>
      <button class="btn btn-dark" id="wh-manage">${I.warehouse} Manage Warehouses</button>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex">
        <div class="fieldset-outline" style="min-width:220px"><label>Warehouse</label>
          <select id="wh-sel">${d.warehouses.map(w=>`<option value="${w.id}" ${state.wh===w.id?'selected':''}>${esc(w.name)}</option>`).join('')}</select></div>
        <input class="input" id="wh-q" placeholder="Search SKU / product / brand" style="flex:1" value="${esc(state.q)}">
      </div>
      <div class="flex" style="justify-content:flex-end;margin-top:10px">
        <button class="btn" id="wh-refresh">${I.refresh} Refresh</button>
        <button class="btn" id="wh-transfer" ${!state.transfer.length?'disabled':''}>${I.transfer} Transfer (${state.transfer.length})</button>
      </div>
    </div>
    <div class="card">
      ${rows.length?`
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th style="width:30px"></th><th>Product</th><th>SKU</th><th>Color</th><th>Qty</th><th>Shelf</th></tr></thead>
        <tbody>${p.slice.map(r=>`<tr>
          <td><input type="checkbox" data-tr="${r.v.sku}" ${state.transfer.includes(r.v.sku)?'checked':''}></td>
          <td class="cell-main">${esc(r.p.name)}</td><td>${esc(r.v.sku)}</td><td>${esc(r.v.color)}</td>
          <td><b>${r.st.qty}</b></td><td>${esc(r.st.shelf||'—')}</td>
        </tr>`).join('')}</tbody></table></div>
      ${pagerHTML(p)}`:
      `<div class="task-empty">No stock rows in this warehouse yet.</div>`}
    </div>`;

    el.querySelector('#wh-sel').onchange=e=>{state.wh=e.target.value;state.page=1;state.transfer=[];render();};
    const q=el.querySelector('#wh-q');
    q.oninput=debounce(()=>{state.q=q.value;state.page=1;render();const nq=el.querySelector('#wh-q');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelector('#wh-refresh').onclick=()=>{render();toast('Refreshed');};
    bindPager(el,pg=>{state.page=pg;render();});
    el.querySelectorAll('[data-tr]').forEach(c=>c.onchange=()=>{
      const sku=c.dataset.tr;
      if(c.checked)state.transfer.push(sku);
      else state.transfer=state.transfer.filter(x=>x!==sku);
      el.querySelector('#wh-transfer').disabled=!state.transfer.length;
      el.querySelector('#wh-transfer').innerHTML=I.transfer+' Transfer ('+state.transfer.length+')';
    });
    el.querySelector('#wh-transfer').onclick=()=>{
      if(!state.transfer.length)return;
      const others=d.warehouses.filter(w=>w.id!==state.wh);
      Modal.open({title:'Transfer stock',
        body:`<div class="small">Move ${state.transfer.length} SKU(s) from <b>${esc(DB.warehouse(state.wh).name)}</b> to:</div>
        <div class="field"><select class="select" id="tr-to">${others.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Quantity per SKU (blank = all)</label><input class="input" type="number" id="tr-qty" min="1"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Transfer</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const to=ov.querySelector('#tr-to').value;
            const qv=ov.querySelector('#tr-qty').value;
            for(const sku of state.transfer){
              const hit=DB.variationBySku(sku);if(!hit)continue;
              const from=hit.v.stock[state.wh];hit.v.stock[to]=hit.v.stock[to]||{qty:0,shelf:''};
              const n=qv?Math.min(+qv,from.qty):from.qty;
              from.qty-=n;hit.v.stock[to].qty+=n;
            }
            DB.save();DB.audit('stock.transfer',state.transfer.join(', '),DB.warehouse(state.wh).code+' → '+DB.warehouse(to).code);
            state.transfer=[];close();render();toast('Stock transferred');
          };
        }});
    };
    el.querySelector('#wh-manage').onclick=()=>{
      Modal.open({title:'Manage Warehouses',
        body:`
        <div class="flex-col">${d.warehouses.map(w=>`
          <div class="flex" style="border:1px solid var(--line);border-radius:9px;padding:10px 14px">
            <b>${esc(w.name)}</b><span class="muted small">${esc(w.code)}</span>
          </div>`).join('')}</div>
        <div class="flex">
          <input class="input" id="mw-name" placeholder="New warehouse name" style="flex:1">
          <input class="input" id="mw-code" placeholder="code_snake_case" style="width:170px">
          <button class="btn btn-dark" id="mw-add">${I.plus} Add</button>
        </div>`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('#mw-add').onclick=()=>{
            const name=ov.querySelector('#mw-name').value.trim(),code=ov.querySelector('#mw-code').value.trim();
            if(!name||!code)return toast('Name and code are required',true);
            const w={id:uid('wh'),code,name};
            d.warehouses.push(w);
            d.products.forEach(pp=>pp.variations.forEach(v=>{v.stock=v.stock||{};v.stock[w.id]={qty:0,shelf:''};}));
            DB.save();DB.audit('warehouse.create',code,name);
            close();render();toast('Warehouse added');
          };
        }});
    };
  }
  render();
});

/* ============================================================ STOCK CSV IMPORT */
App.register('stock-csv',function(el){
  el.innerHTML=`
  <div class="flex" style="margin-bottom:14px">${I.fileCsv}<div class="page-title" style="font-size:16px">Stock CSV Import</div></div>
  <div class="info-banner">${I.eye}<div>Upload a stock count for a quick update of quantities for many products.
    Columns: <b>variation_sku, qty</b> — quantities are <b>set</b> in the main warehouse.</div></div>
  <div class="card card-pad" style="margin-top:14px">
    <div class="flex">
      <button class="btn" id="sc-tpl">${I.download} Download Template</button>
      <button class="btn" id="sc-choose">📎 Choose CSV</button>
      <button class="btn btn-dark" id="sc-apply" disabled>${I.upload} Apply Stock Update</button>
    </div>
    <div id="sc-preview" style="margin-top:14px"></div>
  </div>`;
  let rows=null;
  el.querySelector('#sc-tpl').onclick=()=>downloadCSV('stock-template.csv',[['variation_sku','qty'],['158.1','80']]);
  el.querySelector('#sc-choose').onclick=()=>pickCSVFile((r,name)=>{
    rows=r;
    el.querySelector('#sc-apply').disabled=false;
    el.querySelector('#sc-preview').innerHTML=`<div class="small"><b>${esc(name)}</b> — ${r.length-1} data row(s) ready.</div>`;
  });
  el.querySelector('#sc-apply').onclick=()=>{
    if(!rows)return;
    const head=rows[0].map(h=>h.toLowerCase());
    const si=head.indexOf('variation_sku'),qi=head.indexOf('qty');
    if(si<0||qi<0)return toast('Columns variation_sku and qty are required',true);
    let n=0,bad=0;
    for(const r of rows.slice(1)){
      const hit=DB.variationBySku(r[si]);
      if(!hit||isNaN(parseInt(r[qi],10))){bad++;continue;}
      hit.v.stock.wh_us=hit.v.stock.wh_us||{qty:0,shelf:''};
      hit.v.stock.wh_us.qty=parseInt(r[qi],10);n++;
    }
    DB.save();DB.audit('stock.import',n+' rows','Stock CSV'+(bad?' — '+bad+' invalid rows skipped':''),'csv');
    el.querySelector('#sc-preview').innerHTML=`<div class="small money-green">${n} rows applied${bad?' · '+bad+' skipped':''}.</div>`;
    toast('Stock updated');
  };
});

/* ============================================================ INVENTORY CSV (set/adjust) */
App.register('inventory-csv',function(el){
  el.innerHTML=`
  <div class="flex" style="margin-bottom:14px">${I.warehouse}<div class="page-title" style="font-size:16px">Inventory CSV import</div></div>
  <div class="info-banner">${I.eye}<div>
    Upload a CSV with columns <b>variation_sku, warehouse_code, mode, qty</b>.<br>
    <b>warehouse_code</b> must be one of <code>israel_fulfillment</code>, <code>eu_fulfillment</code>, or <code>reserve</code>.<br>
    <b>mode</b> is <span class="badge gray">set</span> for absolute stock count or <span class="badge gray">adjust</span> for a signed delta (+/-).<br>
    Any invalid row rejects the whole file — no partial applies.</div></div>
  <div class="card card-pad" style="margin-top:14px">
    <div class="flex">
      <button class="btn" id="ic-tpl">${I.download} Download Template</button>
      <button class="btn" id="ic-choose">📎 Choose CSV</button>
      <button class="btn btn-dark" id="ic-apply" disabled>${I.upload} Apply Inventory Changes</button>
    </div>
    <div id="ic-preview" style="margin-top:14px"></div>
  </div>`;
  let rows=null;
  el.querySelector('#ic-tpl').onclick=()=>downloadCSV('inventory-template.csv',
    [['variation_sku','warehouse_code','mode','qty'],['158.1','israel_fulfillment','set','80'],['158.2','reserve','adjust','-3']]);
  el.querySelector('#ic-choose').onclick=()=>pickCSVFile((r,name)=>{
    rows=r;el.querySelector('#ic-apply').disabled=false;
    el.querySelector('#ic-preview').innerHTML=`<div class="small"><b>${esc(name)}</b> — ${r.length-1} data row(s) ready.</div>`;
  });
  el.querySelector('#ic-apply').onclick=()=>{
    if(!rows)return;
    const head=rows[0].map(h=>h.toLowerCase());
    const g=(r,k)=>{const i=head.indexOf(k);return i>=0?r[i]:'';};
    /* validate everything first — any invalid row rejects the whole file */
    const ops=[];
    for(let i=1;i<rows.length;i++){
      const r=rows[i];
      const hit=DB.variationBySku(g(r,'variation_sku'));
      const wh=DB.warehouse(g(r,'warehouse_code'));
      const mode=g(r,'mode');
      const qty=parseInt(g(r,'qty'),10);
      if(!hit||!wh||!['set','adjust'].includes(mode)||isNaN(qty)){
        el.querySelector('#ic-preview').innerHTML=`<div class="small" style="color:var(--red)">Row ${i+1} is invalid — whole file rejected (no partial applies).</div>`;
        return toast('Row '+(i+1)+' invalid — file rejected',true);
      }
      ops.push({hit,wh,mode,qty});
    }
    for(const op of ops){
      op.hit.v.stock[op.wh.id]=op.hit.v.stock[op.wh.id]||{qty:0,shelf:''};
      if(op.mode==='set')op.hit.v.stock[op.wh.id].qty=op.qty;
      else op.hit.v.stock[op.wh.id].qty=Math.max(0,op.hit.v.stock[op.wh.id].qty+op.qty);
    }
    DB.save();DB.audit('inventory.import',ops.length+' rows','Inventory CSV (set/adjust)','csv');
    el.querySelector('#ic-preview').innerHTML=`<div class="small money-green">${ops.length} rows applied.</div>`;
    toast('Inventory updated');
  };
});

/* ============================================================ IMPORT DATA (customers / balances / statements) */
App.register('import-data',function(el){
  const state=App._imp||(App._imp={tab:'Customers'});

  function render(){
    let inner='';
    if(state.tab==='Customers'){
      inner=`
      <div class="info-banner">${I.eye}<div>Upload a CSV file to import or update customer records. Existing customers (matched by email) will be updated.</div></div>
      <button class="btn" id="id-tpl" style="margin-top:12px">${I.download} Download Template</button>
      <div class="upload-zone" id="id-up" style="margin-top:12px">📄 Choose Customers CSV File</div>
      <button class="btn btn-dark" id="id-apply" style="margin-top:12px;width:100%;justify-content:center" disabled>${I.upload} Upload Customers CSV</button>
      <div id="id-note" class="small" style="margin-top:8px"></div>`;
    }else if(state.tab==='Balances'){
      inner=`
      <div class="info-banner">${I.eye}<div>Update a customer's opening balance by email. Columns: <b>email, balance</b>.</div></div>
      <button class="btn" id="ib-tpl" style="margin-top:12px">${I.download} Download Template</button>
      <div class="upload-zone" id="ib-up" style="margin-top:12px">📄 Choose Balances CSV File</div>
      <div id="ib-note" class="small" style="margin-top:8px"></div>`;
    }else{
      inner=`
      <div class="info-banner">${I.eye}<div>Upload account-statement documents (PDF) for customers.</div></div>
      <div class="field" style="margin-top:12px"><label>Customer</label>
        <select class="select" id="is-cust">${DB.d.users.filter(u=>['customer','special customer'].includes(u.role)).map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}</select></div>
      <div class="upload-zone" id="is-up" style="margin-top:12px">📄 Choose PDF statement</div>
      <div id="is-note" class="small" style="margin-top:8px"></div>`;
    }
    el.innerHTML=`
    <div class="page-head"><div class="page-title">Import Data</div></div>
    <div class="card card-pad" style="max-width:760px">
      <div class="tabs">${['Customers','Balances','Statements'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}</div>
      ${inner}
    </div>`;

    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
    const idt=el.querySelector('#id-tpl');
    if(idt){
      let rows=null;
      idt.onclick=()=>downloadCSV('customers-template.csv',[['email','business','first_name','last_name','phone','country','city','address','zip']]);
      el.querySelector('#id-up').onclick=()=>pickCSVFile((r,name)=>{
        rows=r;el.querySelector('#id-apply').disabled=false;
        el.querySelector('#id-note').textContent=name+' — '+(r.length-1)+' rows ready';
      });
      el.querySelector('#id-apply').onclick=()=>{
        if(!rows)return;
        const head=rows[0].map(h=>h.toLowerCase());
        const ei=head.indexOf('email');
        if(ei<0)return toast('email column required',true);
        let created=0,updated=0;
        for(const r of rows.slice(1)){
          const email=(r[ei]||'').trim();if(!email)continue;
          const g=k=>{const i=head.indexOf(k);return i>=0?(r[i]||'').trim():'';};
          let u=DB.d.users.find(x=>x.email.toLowerCase()===email.toLowerCase());
          if(u){['business','city','address','zip','phone'].forEach(k=>{const v=g(k==='business'?'business':k);if(v)u[k]=v;});updated++;}
          else{
            const maxNum=Math.max(...DB.d.users.map(x=>+x.customerNumber||0));
            DB.d.users.push({id:uid('u'),username:email.split('@')[0],email,business:g('business'),
              firstName:g('first_name'),lastName:g('last_name'),phone:g('phone'),
              country:g('country')||'US',city:g('city'),address:g('address'),zip:g('zip'),state:'',taxId:'',
              customerNumber:String(maxNum+1),role:'customer',agentId:null,paymentTerms:30,
              hidePrices:false,status:'pending',pricing:{mode:'none'},balance:0,createdAt:todayISO()});
            created++;
          }
        }
        DB.save();DB.audit('user.import',created+' created / '+updated+' updated','Customers CSV','csv');
        el.querySelector('#id-note').textContent=created+' created, '+updated+' updated';
        toast('Customers imported');
      };
    }
    const ibt=el.querySelector('#ib-tpl');
    if(ibt){
      ibt.onclick=()=>downloadCSV('balances-template.csv',[['email','balance'],['customer@example.com','1250.00']]);
      el.querySelector('#ib-up').onclick=()=>pickCSVFile(rows=>{
        const head=rows[0].map(h=>h.toLowerCase());
        const ei=head.indexOf('email'),bi=head.indexOf('balance');
        if(ei<0||bi<0)return toast('email and balance columns required',true);
        let n=0;
        for(const r of rows.slice(1)){
          const u=DB.d.users.find(x=>x.email.toLowerCase()===(r[ei]||'').toLowerCase());
          if(u&&!isNaN(parseFloat(r[bi]))){u.balance=parseFloat(r[bi]);n++;}
        }
        DB.save();DB.audit('balance.import',n+' balances','Balances CSV','csv');
        el.querySelector('#ib-note').textContent=n+' balances updated';
        toast(n+' balances updated');
      });
    }
    const isu=el.querySelector('#is-up');
    if(isu)isu.onclick=()=>{
      const inp=document.createElement('input');
      inp.type='file';inp.accept='.pdf';
      inp.onchange=()=>{
        const f=inp.files[0];if(!f)return;
        const cid=el.querySelector('#is-cust').value;
        DB.audit('statement.upload',DB.userName(cid),f.name);
        el.querySelector('#is-note').textContent=f.name+' attached to '+DB.userName(cid);
        toast('Statement uploaded');
      };
      inp.click();
    };
  }
  render();
});
