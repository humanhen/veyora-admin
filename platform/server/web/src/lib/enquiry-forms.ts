/* Public enquiry forms — web side (Fast-Track Phase 3).

   The browser posts to the page's OWN url. Astro handles the POST in page
   frontmatter and calls the API server-side.

   That indirection is the point. A plain HTML form posting straight to the
   API would put PUBLIC_API_ORIGIN in the markup, need CORS, and only work if
   the API is publicly reachable — none of which is true or desirable. Posting
   to the same path keeps the API origin entirely server-side, works with no
   JavaScript at all, and re-renders the page with errors or a success state
   the way a form has worked since 1995.

   Field definitions are duplicated from the API deliberately and narrowly:
   the API remains the authority and re-validates everything, but a form
   cannot render a control it does not know about, and a round-trip per page
   render to discover the field list would be worse. A test asserts the two
   lists agree. */

export const ENQUIRY_FORMS = ['contact', 'request-b2b-account', 'private-label-enquiry'] as const;
export type EnquiryForm = (typeof ENQUIRY_FORMS)[number];

/** Must match src/public-forms.js on the API. Asserted by test. */
export const HONEYPOT_FIELD = 'website';

export type FieldKind = 'text' | 'email' | 'phone' | 'longtext' | 'choice' | 'consent';

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  max?: number;
  values?: string[];
  /** Shown under the control. Only ever factual — never a promise. */
  hint?: string;
  autocomplete?: string;
}

const CONSENT: FieldSpec = {
  name: 'consent',
  kind: 'consent',
  required: true,
  label: 'I am happy for Veyora to use these details to reply to this enquiry.',
};

export const FORM_FIELDS: Record<EnquiryForm, FieldSpec[]> = {
  contact: [
    { name: 'name', kind: 'text', label: 'Your name', required: true, max: 120, autocomplete: 'name' },
    { name: 'email', kind: 'email', label: 'Email address', required: true, max: 120, autocomplete: 'email' },
    { name: 'company', kind: 'text', label: 'Company', required: false, max: 120, autocomplete: 'organization' },
    { name: 'phone', kind: 'phone', label: 'Phone', required: false, max: 40, autocomplete: 'tel' },
    { name: 'message', kind: 'longtext', label: 'Message', required: true, max: 4000 },
    CONSENT,
  ],
  'request-b2b-account': [
    { name: 'name', kind: 'text', label: 'Your name', required: true, max: 120, autocomplete: 'name' },
    { name: 'email', kind: 'email', label: 'Business email address', required: true, max: 120, autocomplete: 'email' },
    { name: 'company', kind: 'text', label: 'Business name', required: true, max: 120, autocomplete: 'organization' },
    {
      name: 'businessType', kind: 'choice', label: 'Business type', required: true,
      values: ['Independent optician', 'Optical chain', 'Distributor', 'Online retailer', 'Other'],
    },
    { name: 'country', kind: 'text', label: 'Country', required: true, max: 80, autocomplete: 'country-name' },
    { name: 'phone', kind: 'phone', label: 'Phone', required: false, max: 40, autocomplete: 'tel' },
    { name: 'message', kind: 'longtext', label: 'Anything else', required: false, max: 4000 },
    CONSENT,
  ],
  'private-label-enquiry': [
    { name: 'name', kind: 'text', label: 'Your name', required: true, max: 120, autocomplete: 'name' },
    { name: 'email', kind: 'email', label: 'Business email address', required: true, max: 120, autocomplete: 'email' },
    { name: 'company', kind: 'text', label: 'Business name', required: true, max: 120, autocomplete: 'organization' },
    { name: 'country', kind: 'text', label: 'Country', required: true, max: 80, autocomplete: 'country-name' },
    {
      name: 'projectType', kind: 'choice', label: 'Project type', required: false,
      values: ['New private label', 'Existing label extension', 'Capsule collection', 'Not yet decided'],
    },
    { name: 'message', kind: 'longtext', label: 'Tell us about the project', required: true, max: 4000 },
    CONSENT,
  ],
};

export interface FieldError { field: string | null; code: string; message: string }

export type SubmissionState =
  | { kind: 'idle' }
  | { kind: 'success' }
  /** Field-level problems the visitor can fix. */
  | { kind: 'invalid'; errors: FieldError[]; values: Record<string, string> }
  /** Anything else — retryable, and deliberately not detailed. */
  | { kind: 'failed'; message: string; values: Record<string, string> };

/** Everything typed, minus the honeypot and the consent box, so a re-rendered
    form does not lose what someone wrote. Consent is deliberately NOT
    re-ticked: an affirmative must be given again if the form comes back. */
export function retainedValues(form: FormData, fields: FieldSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of fields) {
    if (spec.kind === 'consent') continue;
    const value = form.get(spec.name);
    if (typeof value === 'string' && value !== '') out[spec.name] = value;
  }
  return out;
}

/** Builds the JSON body for the API from submitted form data. Only fields
    this form declares are read — anything else a client appended is dropped
    here and would be rejected by the API anyway. */
export function submissionBody(form: FormData, fields: FieldSpec[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const spec of fields) {
    const value = form.get(spec.name);
    if (typeof value === 'string' && value !== '') body[spec.name] = value;
  }
  const honeypot = form.get(HONEYPOT_FIELD);
  if (typeof honeypot === 'string' && honeypot !== '') body[HONEYPOT_FIELD] = honeypot;
  return body;
}

/** Groups field errors by field name for rendering beside each control. */
export function errorsByField(errors: FieldError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const error of errors) {
    if (typeof error.field === 'string' && error.field && !(error.field in out)) {
      out[error.field] = error.message;
    }
  }
  return out;
}

/** Errors that name no field, or name one this form does not render — they
    would otherwise be invisible. */
export function generalErrors(errors: FieldError[], fields: FieldSpec[]): string[] {
  const known = new Set(fields.map((f) => f.name));
  return errors.filter((e) => !e.field || !known.has(e.field)).map((e) => e.message);
}
