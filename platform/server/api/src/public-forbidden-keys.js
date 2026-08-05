/* THE central forbidden-data authority for the public API boundary (B2.2).
   One list, one normaliser, one recursive scanner — every serializer test
   and the public router's own dev/test assertions all go through this file,
   so there is exactly one place that decides what "forbidden" means.

   Design: match on a NORMALISED key (lowercased, separators stripped) by
   EXACT equality against a fixed set — never a substring/`.includes()`
   check. Exact-match is what makes this safe against false positives like
   "isDiscontinued" (normalises to "isdiscontinued", not equal to any
   forbidden key) or "sortOrder" (normalises to "sortorder", not equal to
   "order") — a naive substring rule would flag both. Values are checked
   separately for the one content-shaped forbidden pattern that isn't a key
   name at all: an internal `label:*` tag. */

const FORBIDDEN_KEYS = new Set([
  // commercial / pricing
  'price', 'saleprice', 'purchaseprice', 'baseprice', 'cost', 'margin',
  'wholesale', 'discount', 'promotion', 'promotions', 'pricing', 'hideprices',
  // stock / availability / warehouse
  'qty', 'quantity', 'stock', 'stockstatus', 'onhand', 'available',
  'availability', 'warehouse', 'shelf',
  // customer / user / agent / lead identity
  'customer', 'customernumber', 'customerid', 'userid', 'email', 'phone',
  'taxid', 'balance', 'paymentterms', 'agentid', 'leadid',
  // commerce records
  'order', 'orderid', 'invoice', 'credit',
  // supplier / sync internals
  'zohoitemid', 'ponumber', 'purchaseorderid', 'purchaseorderidentifier',
  // governance/administration internals (Task 3: "fact-owner user IDs",
  // "approval-row internals", "media-rights administration fields")
  'factowner', 'factownerid', 'approverid', 'rightsholder', 'rightsexpiry',
]);

/** Lowercase, strip anything that isn't a letter or digit — so
 * "sale_price", "salePrice" and "SALE-PRICE" all collapse to the same
 * comparable form. */
export function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isForbiddenKey(key) {
  return FORBIDDEN_KEYS.has(normalizeKey(key));
}

/** An internal label tag (`label:best-seller`, `LABEL:foo`, …) must never
 * appear anywhere in public output, as a value or inside an array. */
export function isForbiddenLabelValue(value) {
  return typeof value === 'string' && /^label:/i.test(value.trim());
}

/**
 * Recursively scans a value (typically a serializer's output object) for
 * any forbidden key or internal label tag, at any depth, inside plain
 * objects and arrays. Returns an array of violations, each with the exact
 * dotted/bracketed path where it was found — empty array means clean.
 *
 * This is a development/test safety net, not a production response filter:
 * the serializer layer (public-serialize.js) is the actual boundary,
 * built as a pure allowlist that never spreads a database row. This
 * scanner exists to catch a regression in that allowlist before it ships,
 * not to sanitise output at request time.
 */
export function scanForForbiddenKeys(value, path = '$') {
  const violations = [];

  function walk(node, currentPath) {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${currentPath}[${i}]`));
      return;
    }

    if (isForbiddenLabelValue(node)) {
      violations.push({ path: currentPath, key: null, reason: 'label-tag', value: node });
      return;
    }

    if (typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) {
        const childPath = `${currentPath}.${key}`;
        if (isForbiddenKey(key)) {
          violations.push({ path: childPath, key, reason: 'forbidden-key' });
          // Still recurse into the value — a forbidden key wrapping more
          // forbidden data should report every violation, not just the outer one.
        }
        walk(val, childPath);
      }
    }
  }

  walk(value, path);
  return violations;
}

/** Convenience assertion for tests: throws with every violating path
 * listed, or returns silently when the scan is clean. */
export function assertNoForbiddenKeys(value, label = 'value') {
  const violations = scanForForbiddenKeys(value);
  if (violations.length) {
    const detail = violations.map((v) => (v.key ? `${v.path} (key: ${v.key})` : `${v.path} (${v.reason}: ${v.value})`)).join(', ');
    throw new Error(`${label} contains forbidden data: ${detail}`);
  }
}
