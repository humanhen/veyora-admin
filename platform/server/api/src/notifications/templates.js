/* Notification templates (Final Handover, Phase 1).
 *
 * Pure string rendering over an EXPLICIT template-data allowlist. No database,
 * no driver, no request object.
 *
 * WHAT AN ENQUIRY NOTIFICATION DELIBERATELY DOES NOT CONTAIN
 *
 * Not the enquirer's message. Not their email address. Not their phone number.
 *
 * The alert says an enquiry arrived, which form it came from, and where to
 * read it. Putting the content in the email would copy personal data into
 * however many staff inboxes, mail archives and phones the alert reaches —
 * outside the capability system that governs who may read an enquiry at all
 * (`enquiries.view`, 27_ENQUIRY_OPERATIONS.md). The alert is a pointer, and
 * the governed screen is the place.
 *
 * That is also why `buildEnquiryTemplateData()` takes named arguments rather
 * than a submission row: there is no code path here that could spread one.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const TEMPLATE_VERSION = 'v1';

const FORM_LABELS = Object.freeze({
  'contact': 'Contact',
  'request-b2b-account': 'B2B account request',
  'private-label-enquiry': 'Private label enquiry',
});

/** The complete, explicit data an enquiry alert may carry. */
export function buildEnquiryTemplateData({ formType, submittedAt, region = '', businessType = '', adminUrl = '' }) {
  return {
    formLabel: FORM_LABELS[formType] || 'Enquiry',
    formType: String(formType || ''),
    submittedAt: String(submittedAt || ''),
    /* Region and business type are coarse routing facts, not identity: they
       let an operations inbox triage without exposing who sent it. */
    region: String(region || ''),
    businessType: String(businessType || ''),
    adminUrl: String(adminUrl || ''),
  };
}

export function buildStatementTemplateData({ customerName, periodLabel, closingBalance, currency, adminUrl = '' }) {
  return {
    customerName: String(customerName || ''),
    periodLabel: String(periodLabel || ''),
    closingBalance: String(closingBalance ?? ''),
    currency: String(currency || ''),
    adminUrl: String(adminUrl || ''),
  };
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f2ef;font-family:Segoe UI,Arial,sans-serif;color:#2b2b2b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0"
         style="max-width:560px;width:100%;background:#fff;border-radius:10px;overflow:hidden">
    <tr><td style="background:#221F20;padding:26px 24px;text-align:center">
      <div style="color:#bda0d3;font-size:11px;letter-spacing:4px;text-transform:uppercase">Veyora</div>
      <div style="color:#fff;font-size:20px;font-weight:300;margin-top:6px">${esc(title)}</div>
    </td></tr>
    <tr><td style="padding:28px 30px">${body}</td></tr>
  </table>
</td></tr></table></body></html>`;

const row = (label, value) => value
  ? `<div style="margin:6px 0;font-size:14px"><span style="color:#8a857f;display:inline-block;width:130px;font-size:12px;text-transform:uppercase;letter-spacing:.5px">${esc(label)}</span> <b>${esc(value)}</b></div>`
  : '';

const TEMPLATES = Object.freeze({
  enquiry_received: (data) => ({
    subject: `[Veyora] New ${String(data.formLabel || 'website').toLowerCase()} enquiry`,
    html: shell('New enquiry received',
      `<p style="font-size:14.5px;line-height:1.7;margin:0 0 18px">
         A new enquiry has been submitted through the public website.</p>
       ${row('Form', data.formLabel)}
       ${row('Received', data.submittedAt)}
       ${row('Region', data.region)}
       ${row('Business type', data.businessType)}
       <p style="font-size:13px;line-height:1.7;color:#6b665f;margin:20px 0 0">
         The enquirer's details and message are deliberately not included in this alert.
         Open the Enquiries screen in the admin panel to read and handle it.</p>
       ${data.adminUrl ? `<div style="text-align:center;margin-top:22px">
         <a href="${esc(data.adminUrl)}" style="display:inline-block;padding:13px 30px;background:#5c4a4a;border-radius:26px;color:#fff;font-size:13px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;text-decoration:none">Open Enquiries</a></div>` : ''}`),
    text: [
      'A new enquiry has been submitted through the public website.',
      '',
      `Form: ${data.formLabel}`,
      data.submittedAt ? `Received: ${data.submittedAt}` : '',
      data.region ? `Region: ${data.region}` : '',
      data.businessType ? `Business type: ${data.businessType}` : '',
      '',
      "The enquirer's details and message are deliberately not included in this alert.",
      'Open the Enquiries screen in the admin panel to read and handle it.',
      data.adminUrl ? '' : null,
      data.adminUrl || null,
    ].filter((l) => l !== null && l !== '').join('\n'),
  }),

  statement_delivery: (data) => ({
    subject: `Veyora account statement — ${data.periodLabel}`,
    html: shell('Your account statement',
      `<p style="font-size:14.5px;line-height:1.7;margin:0 0 18px">
         Dear ${esc(data.customerName || 'customer')},</p>
       <p style="font-size:14.5px;line-height:1.7;margin:0 0 18px">
         Your Veyora account statement for ${esc(data.periodLabel)} is attached as a PDF.</p>
       ${row('Closing balance', data.closingBalance ? `${data.closingBalance} ${data.currency}` : '')}
       <p style="font-size:13px;line-height:1.7;color:#6b665f;margin:20px 0 0">
         If anything looks wrong, reply to this message and we will look into it.</p>`),
    text: [
      `Dear ${data.customerName || 'customer'},`,
      '',
      `Your Veyora account statement for ${data.periodLabel} is attached as a PDF.`,
      data.closingBalance ? `Closing balance: ${data.closingBalance} ${data.currency}` : '',
      '',
      'If anything looks wrong, reply to this message and we will look into it.',
    ].filter(Boolean).join('\n'),
  }),
});

export function hasTemplate(key) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, key);
}

/**
 * Renders one notification.
 *
 * An unknown template throws rather than sending something empty: a message
 * with no body is worse than a failed attempt, because it looks delivered.
 */
export function render(templateKey, templateData = {}) {
  if (!hasTemplate(templateKey)) {
    throw new Error(`Unknown notification template: ${templateKey}`);
  }
  /* Missing fields are normalised to empty strings rather than left undefined.
     A template must not throw because one optional value is absent: the
     notification would fail terminally and nobody would be told an enquiry
     arrived, which is precisely the failure this system exists to prevent.
     Every field is optional at render time; the builders decide what is worth
     including. */
  const data = new Proxy(Object.assign(Object.create(null), templateData || {}), {
    get: (target, key) => (key in target && target[key] != null ? target[key] : ''),
  });
  return TEMPLATES[templateKey](data);
}

export const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));
