/* Balance & Payments (client feedback items G and H).

   One screen answering the three questions an optician rings up to ask: what
   do I owe, what have I paid, and how much can I still order.

   THE CREDIT LIMIT. `creditLimitConfigured: false` means nobody has set one —
   it does NOT mean unlimited. Every account reads that way until Veyora
   decides otherwise, so the page says so in those words and shows no headroom
   figure at all. Rendering "unlimited", "—", or a blank would each let a
   customer draw the opposite conclusion from the truth.

   Nothing here writes. There is no edit control because there is no write
   route: a credit limit is a commercial decision Veyora makes about the
   customer, not a profile field. */
'use strict';

Routes['#/balance'] = {
  title: 'Balance & Payments',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Balance &amp; Payments</h1>
      <div id="balWrap">Loading…</div>`;
    const wrap = el.querySelector('#balWrap');

    let b;
    try {
      b = await API.get('/user/balance');
    } catch (ex) {
      wrap.innerHTML = `<div class="card"><div class="empty">${
        esc(ex.message || 'Your account could not be loaded.')}</div></div>`;
      return;
    }

    const cur = (v) => money(v);

    /* The credit block is built as one of two mutually exclusive shapes, so
       there is no path where a headroom figure is rendered from a limit that
       does not exist. */
    const creditBlock = b.creditLimitConfigured
      ? `<div class="bal-stat">
           <div class="bal-k">Credit limit</div>
           <div class="bal-v">${cur(b.creditLimit)}</div>
         </div>
         <div class="bal-stat${b.overLimit ? ' over' : ''}">
           <div class="bal-k">${b.overLimit ? 'Over limit by' : 'Credit available'}</div>
           <div class="bal-v">${cur(b.overLimit
             ? String(Math.abs(Number(b.creditAvailable))) : b.creditAvailable)}</div>
         </div>`
      : `<div class="bal-stat bal-unset">
           <div class="bal-k">Credit limit</div>
           <div class="bal-v">Not configured</div>
           <div class="bal-note">No credit limit has been set for this account.
             Please contact us if you need one.</div>
         </div>`;

    wrap.innerHTML = `
      <div class="card"><div class="pad">
        <div class="bal-stats">
          <div class="bal-stat">
            <div class="bal-k">Account balance</div>
            <div class="bal-v">${cur(b.balance)}</div>
          </div>
          <div class="bal-stat">
            <div class="bal-k">Outstanding invoices</div>
            <div class="bal-v">${cur(b.outstanding)}</div>
          </div>
          ${creditBlock}
        </div>
        ${b.paymentTerms ? `<p class="sub" style="margin-top:12px">Payment terms:
          <b>${esc(b.paymentTerms)}</b></p>` : ''}
      </div></div>

      <div class="card" style="margin-top:14px"><div class="pad">
        <h3 class="bal-h">${icon('fileText', { size: 15 })} Invoices</h3>
        ${b.invoices.length ? `<table class="list"><tbody>${b.invoices.map(i => `
          <tr>
            <td><b>${esc(i.number)}</b><div class="sub">${esc(i.issuedOn || '')}</div></td>
            <td>${invoiceStateNote(i) || (i.outstanding
              ? '<span class="pill pending">Outstanding</span>'
              : '<span class="pill completed">Settled</span>')}</td>
            <td style="text-align:right"><b>${cur(i.amount)}</b></td>
            <td style="text-align:right">${payButton(i)}</td>
          </tr>`).join('')}</tbody></table>`
          : '<p class="sub">No invoices yet</p>'}
        <p class="sub" style="margin-top:10px">Your invoices are payable on your usual
          account terms. Paying by card here is optional and changes nothing about
          those terms.</p>
      </div></div>

      <div class="card" style="margin-top:14px"><div class="pad">
        <h3 class="bal-h">${icon('currency', { size: 15 })} Payments received</h3>
        ${b.payments.length ? `<table class="list"><tbody>${b.payments.map(p => `
          <tr>
            <td>${esc(p.paidOn || '')}</td>
            <td class="sub">${esc(p.method || '')}${p.reference
              ? ' · ' + esc(p.reference) : ''}</td>
            <td style="text-align:right"><b>${cur(p.amount)}</b></td>
          </tr>`).join('')}</tbody></table>`
          : '<p class="sub">No payments recorded yet</p>'}
      </div></div>

      ${b.creditNotes.length ? `<div class="card" style="margin-top:14px"><div class="pad">
        <h3 class="bal-h">${icon('undo', { size: 15 })} Credit notes</h3>
        <table class="list"><tbody>${b.creditNotes.map(c => `
          <tr>
            <td>${esc(c.issuedOn || '')}</td>
            <td class="sub">${esc(c.reason || '')}</td>
            <td style="text-align:right"><b>${cur(c.amount)}</b></td>
          </tr>`).join('')}</tbody></table>
      </div></div>` : ''}`;

    /* The same payment control as the account page — one implementation, so
       the two screens can never disagree about which invoice is payable. */
    wrap.querySelectorAll('[data-pay]').forEach(btn =>
      btn.onclick = () => startInvoicePayment(btn, btn.dataset.pay));
  },
};
