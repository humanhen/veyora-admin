/* Shared frame lists — a curated set of frames behind one link.
     #/list/<slug>  → public view (guest sees frames, customer sees their prices)
     #/lists        → staff page to create & manage those links
   Reuses productCard() from pages_catalog.js and the home header for guests. */
'use strict';

const STAFF_LIST_ROLES = ['agent', 'super-agent', 'admin'];

function copyToClipboard(text, okMsg) {
  navigator.clipboard?.writeText(text)
    .then(() => toast(okMsg || 'Link copied'))
    .catch(() => toast('Copy failed — long-press the link to copy', true));
}

/* ---------- public: view a shared list ---------- */
Routes['#/list'] = {
  title: 'Frames', optional: true,
  async render(el, args) {
    const slug = (args[0] || '').trim();
    const guest = !Store.session;
    if (guest) {
      el.innerHTML = `<div class="guest-head">${homeHeader()}</div>
        <main class="page prod-page"><div id="guestPage"></div></main>
        ${whatsappFloat()}`;
      document.body.classList.remove('hm-dark');
      el = el.querySelector('#guestPage');
    } else {
      el.classList.add('prod-page-inner');
    }

    el.innerHTML = `
      <div class="prod-head"><h1 id="listName">Selected frames</h1>
        <span class="sub" id="listCount"></span></div>
      <div id="grid" class="pgrid2"></div>`;
    const grid = el.querySelector('#grid');
    grid.innerHTML = Array(6).fill('<div class="skeleton" style="height:430px"></div>').join('');

    if (!slug) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🔗</div>No list link given.</div>`;
      return;
    }
    let res;
    try {
      res = await API.get('/user/shared-lists/' + encodeURIComponent(slug));
    } catch (e) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🔍</div>
        ${e.status === 404 ? 'This list link isn’t available — it may have been removed.'
          : 'Couldn’t load this list. Please try again.'}</div>`;
      return;
    }

    const title = res.list.name || 'Selected frames';
    el.querySelector('#listName').textContent = title;
    document.title = title + ' — Veyora';
    el.querySelector('#listCount').textContent =
      res.products.length ? `${res.products.length} frame${res.products.length === 1 ? '' : 's'}` : '';

    grid.innerHTML = '';
    if (!res.products.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🕶️</div>
        These frames aren’t available right now.</div>`;
      return;
    }
    for (const p of res.products) grid.appendChild(productCard(p));
  },
};

/* ---------- staff: create & manage shared lists ---------- */
Routes['#/lists'] = {
  title: 'Frame Lists',
  async render(el) {
    const role = Store.session?.user?.role;
    if (!STAFF_LIST_ROLES.includes(role)) {
      el.innerHTML = `<div class="empty"><div class="big">🔒</div>This page is for Veyora staff.</div>`;
      return;
    }

    el.innerHTML = `
      <h1 class="pagetitle">Shareable frame lists</h1>
      <p class="sub" style="margin:-8px 0 16px">Turn a list of SKUs into one link you can send a customer.
        They open it with no login — your prices stay hidden.</p>

      <div class="card"><div class="pad">
        <div class="field">
          <label>List name <span class="sub">(shown at the top of the page)</span></label>
          <input id="lName" placeholder="e.g. 81 frames for Avi" maxlength="120"/>
        </div>
        <div class="field">
          <label>Custom link code <span class="sub">(optional — leave blank for an automatic one)</span></label>
          <input id="lCode" placeholder="veyora81" autocapitalize="off" autocorrect="off" spellcheck="false"/>
        </div>
        <div class="field">
          <label>SKUs — paste from your list, one per line or comma-separated</label>
          <textarea id="lSkus" rows="7" placeholder="2057&#10;2058.81&#10;CH1420&#10;…"></textarea>
        </div>
        <button class="btn" id="lCreate">Create link</button>
        <div id="lResult" style="margin-top:14px"></div>
      </div></div>

      <h2 style="font-size:16px;margin:24px 0 8px">Your lists</h2>
      <div id="lList" class="card"><div class="pad"><span class="sub">Loading…</span></div></div>`;

    const resultBox = el.querySelector('#lResult');
    const listBox = el.querySelector('#lList');

    async function refreshLists() {
      try {
        const { lists } = await API.get('/user/shared-lists');
        if (!lists.length) {
          listBox.innerHTML = `<div class="pad"><span class="sub">No lists yet — create one above.</span></div>`;
          return;
        }
        listBox.innerHTML = `<div class="pad" style="display:flex;flex-direction:column;gap:10px">
          ${lists.map(l => `
            <div class="ll-row" data-slug="${esc(l.slug)}"
                 style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px">
              <div style="flex:1;min-width:180px">
                <div style="font-weight:600">${esc(l.name || l.slug)}</div>
                <div class="sub">${l.count} frame${l.count === 1 ? '' : 's'} ·
                  <a href="#/list/${esc(l.slug)}" target="_blank" rel="noopener">/#/list/${esc(l.slug)}</a>
                  ${l.createdBy ? ' · by ' + esc(l.createdBy) : ''}</div>
              </div>
              <button class="btn sm ghost" data-act="copy">Copy link</button>
              <button class="btn sm ghost" data-act="del">Delete</button>
            </div>`).join('')}
        </div>`;
        listBox.querySelectorAll('.ll-row').forEach(row => {
          const l = lists.find(x => x.slug === row.dataset.slug);
          row.querySelector('[data-act="copy"]').onclick = () => copyToClipboard(l.url, 'Link copied — paste it to your customer');
          row.querySelector('[data-act="del"]').onclick = async () => {
            if (!confirm(`Delete "${l.name || l.slug}"? The link will stop working.`)) return;
            await API.del('/user/shared-lists/' + encodeURIComponent(l.slug));
            toast('List deleted');
            refreshLists();
          };
        });
      } catch {
        listBox.innerHTML = `<div class="pad"><span class="sub">Couldn’t load your lists.</span></div>`;
      }
    }

    const btn = el.querySelector('#lCreate');
    btn.onclick = async () => {
      const name = el.querySelector('#lName').value.trim();
      const code = el.querySelector('#lCode').value.trim();
      const skus = el.querySelector('#lSkus').value.trim();
      if (!skus) { toast('Paste some SKUs first', true); return; }
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const res = await API.post('/user/shared-lists', { name, code, skus });
        const warn = res.unmatched.length
          ? `<div class="sub" style="margin-top:8px;color:var(--warn)">
               ${res.matched} of ${res.total} SKUs matched a product. Not found:
               ${res.unmatched.map(esc).join(', ')}</div>`
          : `<div class="sub" style="margin-top:8px">All ${res.total} SKUs matched.</div>`;
        resultBox.innerHTML = `
          <div class="card" style="background:var(--card)"><div class="pad">
            <div style="font-weight:600;margin-bottom:6px">✓ Your link is ready</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input readonly value="${esc(res.url)}" id="lUrl"
                style="flex:1;min-width:220px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff"/>
              <button class="btn sm" id="lCopy">Copy</button>
              <a class="btn sm ghost" href="#/list/${esc(res.slug)}" target="_blank" rel="noopener">Preview</a>
            </div>${warn}
          </div></div>`;
        resultBox.querySelector('#lCopy').onclick = () => copyToClipboard(res.url, 'Link copied — paste it to your customer');
        resultBox.querySelector('#lUrl').onclick = e => e.target.select();
        el.querySelector('#lName').value = '';
        el.querySelector('#lCode').value = '';
        el.querySelector('#lSkus').value = '';
        refreshLists();
      } catch (e) {
        toast(e.message || 'Could not create the list', true);
      } finally {
        btn.disabled = false; btn.textContent = 'Create link';
      }
    };

    refreshLists();
  },
};
