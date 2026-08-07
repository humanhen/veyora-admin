/* Veyora document identity (Final Handover, Phase 5).
 *
 * Every legal and business fact a generated document prints comes from HERE,
 * and every one of them is an environment variable with an explicit
 * placeholder default.
 *
 * WHY NOTHING IS INVENTED
 *
 * A generated invoice is a legal and commercial artefact. A company number, a
 * VAT registration, a registered office or a bank account that this codebase
 * made up would look exactly as authoritative as a real one, and would be
 * wrong on every invoice Veyora ever sends. So the defaults are not plausible
 * guesses — they are visibly-unset markers, and `configurationGaps()` reports
 * every one that is still unset so the handover checklist can be generated
 * from the code rather than maintained by hand.
 *
 * An unset field is OMITTED from the document rather than printed as
 * "«NOT CONFIGURED»" — an invoice with no VAT line is a normal invoice, while
 * one carrying a placeholder is a document nobody should send. The gaps are
 * surfaced to STAFF, in the admin panel and in this module's report, never to
 * a customer.
 *
 * Pure and dependency-free: takes an environment map, reads nothing itself.
 */

/** Marks a value the deployment has not supplied. Deliberately not empty
 *  string: a caller can tell "unset" from "set to nothing on purpose". */
export const UNSET = null;

const text = (raw) => {
  const v = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return v === '' ? UNSET : v;
};

/* Each field carries whether a production invoice genuinely NEEDS it. That
   distinction drives the handover checklist: a missing bank IBAN blocks
   offline payment instructions, whereas a missing tagline blocks nothing. */
const FIELDS = Object.freeze([
  // ---- identity ----
  { key: 'legalName', env: 'VEYORA_LEGAL_NAME', required: true,
    label: 'Registered legal name', note: 'Printed as the issuer. Must match the company register.' },
  { key: 'tradingName', env: 'VEYORA_TRADING_NAME', required: false,
    label: 'Trading name', note: 'Shown if the trading name differs from the legal name.' },
  { key: 'companyNumber', env: 'VEYORA_COMPANY_NUMBER', required: true,
    label: 'Company registration number', note: 'Required on invoices in most jurisdictions.' },
  { key: 'taxNumber', env: 'VEYORA_TAX_NUMBER', required: true,
    label: 'VAT / tax registration number', note: 'Required wherever tax is charged.' },

  // ---- address ----
  { key: 'addressLine1', env: 'VEYORA_ADDRESS_LINE1', required: true, label: 'Registered address line 1' },
  { key: 'addressLine2', env: 'VEYORA_ADDRESS_LINE2', required: false, label: 'Registered address line 2' },
  { key: 'addressCity', env: 'VEYORA_ADDRESS_CITY', required: true, label: 'City' },
  { key: 'addressRegion', env: 'VEYORA_ADDRESS_REGION', required: false, label: 'State / region' },
  { key: 'addressPostcode', env: 'VEYORA_ADDRESS_POSTCODE', required: true, label: 'Postcode' },
  { key: 'addressCountry', env: 'VEYORA_ADDRESS_COUNTRY', required: true, label: 'Country' },

  // ---- contact ----
  { key: 'contactEmail', env: 'VEYORA_CONTACT_EMAIL', required: true, label: 'Billing contact email' },
  { key: 'contactPhone', env: 'VEYORA_CONTACT_PHONE', required: false, label: 'Billing contact phone' },
  { key: 'websiteUrl', env: 'VEYORA_WEBSITE_URL', required: false, label: 'Website' },

  // ---- offline payment instructions ----
  { key: 'bankName', env: 'VEYORA_BANK_NAME', required: false, label: 'Bank name',
    note: 'Omitted entirely if unset — an invoice with no bank block is normal.' },
  { key: 'bankAccountName', env: 'VEYORA_BANK_ACCOUNT_NAME', required: false, label: 'Bank account name' },
  { key: 'bankIban', env: 'VEYORA_BANK_IBAN', required: false, label: 'IBAN / account number' },
  { key: 'bankSwift', env: 'VEYORA_BANK_SWIFT', required: false, label: 'SWIFT / BIC / routing' },

  // ---- footer ----
  { key: 'footerText', env: 'VEYORA_INVOICE_FOOTER', required: false, label: 'Invoice footer / legal text',
    note: 'e.g. retention of title, late-payment terms. Legal wording is the client’s to supply.' },
]);

export const BRAND_FIELDS = FIELDS;

/**
 * Resolves the document identity.
 *
 * @param env an environment map. Never `process.env` read internally.
 */
export function resolveBrand(env = {}) {
  const brand = {};
  for (const field of FIELDS) brand[field.key] = text(env[field.env]);

  /* The one thing that is NOT configurable, because it is not a legal fact and
     it is not in doubt: the product name. */
  brand.productName = 'Veyora';

  /* A logo is a file path on the server, read at generation time. Absent is
     normal and the document falls back to the wordmark — a missing image must
     never fail an invoice. */
  brand.logoPath = text(env.VEYORA_INVOICE_LOGO);

  return Object.freeze(brand);
}

/** Every required field the deployment has not supplied yet. */
export function configurationGaps(brand) {
  return FIELDS
    .filter((f) => f.required && brand[f.key] === UNSET)
    .map((f) => ({ key: f.key, env: f.env, label: f.label, note: f.note || '' }));
}

/** Optional-but-recommended fields that are unset. Reported separately so a
 *  handover checklist can distinguish "must fix" from "should decide". */
export function optionalGaps(brand) {
  return FIELDS
    .filter((f) => !f.required && brand[f.key] === UNSET)
    .map((f) => ({ key: f.key, env: f.env, label: f.label, note: f.note || '' }));
}

/** True when a document would print a complete issuer identity. */
export const isBrandComplete = (brand) => configurationGaps(brand).length === 0;

/** The issuer address, as the lines that are actually set. */
export function addressLines(brand) {
  return [
    brand.addressLine1, brand.addressLine2,
    [brand.addressCity, brand.addressRegion].filter(Boolean).join(', ') || null,
    brand.addressPostcode, brand.addressCountry,
  ].filter((line) => line !== UNSET && line !== '' && line != null);
}

/** The bank block, or null when no bank details are configured. An invoice
 *  with no bank block is a normal invoice; one with half a bank block is not. */
export function bankBlock(brand) {
  const lines = [
    brand.bankName ? `Bank: ${brand.bankName}` : null,
    brand.bankAccountName ? `Account name: ${brand.bankAccountName}` : null,
    brand.bankIban ? `IBAN / account: ${brand.bankIban}` : null,
    brand.bankSwift ? `SWIFT / BIC: ${brand.bankSwift}` : null,
  ].filter(Boolean);
  return lines.length ? lines : null;
}

/* Memoised at first use, from the real environment. */
let cached = null;
export function brandConfig(env = process.env) {
  if (!cached) cached = resolveBrand(env);
  return cached;
}
export function resetBrandCache() { cached = null; }
