/* THE capability registry (B2.4P) — the only place a permission key exists.

   Deliberately a frozen, hand-written constant with no database access and
   no I/O of any kind. Three properties follow from that, and each matters:

     1. Capabilities cannot be invented at runtime. A key must appear here
        AND in the `account_permissions` CHECK constraint (db/migrations/
        0008, widened by 0009, plus their ensureSchema mirror), so adding
        one is a deliberate, reviewable code + migration change — not
        something a request body, a database row, or a misconfigured admin
        screen can do.
     2. There is no wildcard, no prefix matching and no hierarchy. A grant
        of `public_content.edit` confers exactly that and nothing else.
        `public_content.*` is not a key and will never resolve.
     3. No role implies any capability. Nothing here mentions `users.role`,
        and no function returns a capability derived from one — an `admin`
        role does not grant `public_content.publish`. That separation is the
        entire point of the batch; a role fallback would silently restore
        the "every admin is equivalent" behaviour this replaces.

   The dotted key names are a readability convention only. Nothing splits on
   the dot or treats the prefix as meaningful. */

/** The approved capabilities. Order is stable so listings and tests can rely
 * on it. */
const DEFINITIONS = [
  {
    key: 'public_content.view',
    label: 'View public content administration',
    description:
      'Read brand, product and variation records in the public-content admin API, including ' +
      'governance state and publication-gate verdicts. Confers no ability to change anything.',
  },
  {
    key: 'public_content.edit',
    label: 'Edit public content',
    description:
      'Change editable public-content fields on brands, products and variations. Does NOT ' +
      'confer the ability to publish — that is a separate capability.',
  },
  {
    key: 'public_content.publish',
    label: 'Publish and unpublish public content',
    description:
      'Make a brand, product or variation publicly visible, or withdraw it. Every publish is ' +
      'still subject to the publication gate and is recorded in content_approvals.',
  },
  {
    key: 'permissions.manage',
    label: 'Manage account permissions',
    description:
      'Grant and revoke capabilities for other accounts. This capability can grant itself, so ' +
      'it is the most sensitive one in the system.',
  },
  /* Enquiry operations (Fast-Track WS2 Phase 2). Deliberately NOT folded into
     the public_content capabilities: publishing brand copy and reading a
     member of the public's name, email address and message are different
     authorities held by different people. Reusing `public_content.view` here
     would silently hand every existing content reviewer a personal-data
     inbox they were never granted. */
  {
    key: 'enquiries.view',
    label: 'View public enquiries',
    description:
      "Read submissions from the public website's enquiry forms, including the enquirer's own " +
      'contact details and message. Confers no ability to change anything.',
  },
  {
    key: 'enquiries.manage',
    label: 'Manage public enquiries',
    description:
      'Record how an enquiry is being handled — under review, responded, closed, or spam. ' +
      'Never deletes a submission and never edits what was submitted.',
  },
  /* Store contacts (Final Handover Phase 2). Deliberately NOT folded into any
     existing capability. A store contact is a named person at a customer with
     a mobile number and a job — reading the list is reading personal data
     about people who never dealt with Veyora directly, and it is not implied
     by being able to edit a customer's payment terms. */
  {
    key: 'customer_contacts.view',
    label: 'View store contacts',
    description:
      'Read the people who work at a customer — names, job titles, responsibilities, phone ' +
      'numbers and email addresses. Confers no ability to change anything.',
  },
  {
    key: 'customer_contacts.manage',
    label: 'Manage store contacts',
    description:
      'Add, edit, archive and reactivate store contacts, set which one is primary, and link ' +
      'or unlink an existing portal account. Never creates a login, never deletes a contact, ' +
      'and never sends anything.',
  },
];

/* Frozen at every level: a caller cannot push a new definition, mutate a
   key, or reach in and widen a description that an admin screen displays. */
export const PERMISSION_DEFINITIONS = Object.freeze(
  DEFINITIONS.map((definition) => Object.freeze({ ...definition }))
);

export const PERMISSION_KEYS = Object.freeze(PERMISSION_DEFINITIONS.map((d) => d.key));

const KEY_SET = new Set(PERMISSION_KEYS);

/** True only for an exact, registered key. Rejects wildcards, prefixes,
 * role names, unknown strings and non-strings alike — there is no
 * normalisation, trimming or case-folding, because a key that needs
 * cleaning up before it matches is not a key this system issued. */
export function isRegisteredPermission(key) {
  return typeof key === 'string' && KEY_SET.has(key);
}

/** The definition for an exact key, or null. Returns the frozen object, so
 * a caller cannot mutate the registry through the value it receives. */
export function getPermissionDefinition(key) {
  if (!isRegisteredPermission(key)) return null;
  return PERMISSION_DEFINITIONS.find((d) => d.key === key) ?? null;
}

/**
 * Validates a caller-supplied list of permission keys.
 *
 * Used by the management API's PUT body. Rejects — rather than silently
 * dropping — anything unregistered or duplicated, so an admin screen
 * sending a key this system does not understand finds out immediately
 * instead of believing a grant succeeded.
 */
export function validatePermissionKeyList(value) {
  if (!Array.isArray(value)) {
    return { ok: false, errors: [{ field: 'permissions', code: 'INVALID_TYPE', message: 'Must be an array of permission keys.' }] };
  }
  if (value.length > PERMISSION_KEYS.length) {
    return { ok: false, errors: [{ field: 'permissions', code: 'TOO_MANY', message: 'More keys supplied than exist.' }] };
  }

  const errors = [];
  const seen = new Set();
  for (const key of value) {
    if (!isRegisteredPermission(key)) {
      errors.push({
        field: 'permissions',
        code: 'UNKNOWN_PERMISSION',
        message: `"${typeof key === 'string' ? key.slice(0, 80) : typeof key}" is not a recognised permission key.`,
      });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ field: 'permissions', code: 'DUPLICATE_PERMISSION', message: `"${key}" was supplied more than once.` });
      continue;
    }
    seen.add(key);
  }

  if (errors.length) {
    errors.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
    return { ok: false, errors };
  }
  // Returned in registry order, not caller order, so the resulting set is
  // canonical regardless of how it was sent.
  return { ok: true, keys: PERMISSION_KEYS.filter((k) => seen.has(k)) };
}
