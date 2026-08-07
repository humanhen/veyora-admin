/* Shared POST handling for the three enquiry routes (Fast-Track Phase 3).

   A plain function rather than an Astro component, for the same reason
   catalogue-page.ts is one: a page that must answer 400 has to set its status
   in the PAGE frontmatter, because `Astro.response.status` set inside a
   nested component has no effect.

   Keeping it here means each page's frontmatter is four lines and all three
   forms behave identically — including the parts that matter and are easy to
   get subtly different between copies, like which status an invalid
   submission returns and what a visitor is told when the API is down. */

import { FORM_FIELDS, retainedValues, submissionBody, type EnquiryForm, type SubmissionState } from './enquiry-forms.ts';
import { submitEnquiry } from './enquiry-submit.ts';
import { throttleVisitor } from './enquiry-throttle.ts';

export interface EnquiryPageState {
  /** The status the page must set on Astro.response. */
  status: number;
  state: SubmissionState;
}

/** Wording for a failure a visitor can do something about (try again), kept
    free of any internal detail — no status code, no host, no upstream name. */
const RETRY_MESSAGE =
  'We could not send your enquiry just now. Please try again in a moment — nothing was recorded.';
const THROTTLED_MESSAGE =
  'That is several enquiries in a short time. Please wait a few minutes and try again — nothing was lost.';

export async function handleEnquiryPage(
  request: Request,
  formType: EnquiryForm,
  { sourcePath }: { sourcePath: string }
): Promise<EnquiryPageState> {
  if (request.method !== 'POST') {
    return { status: 200, state: { kind: 'idle' } };
  }

  const fields = FORM_FIELDS[formType];

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    /* An unreadable body is a malformed request, not a validation failure —
       there is nothing to show against a field. */
    return { status: 400, state: { kind: 'failed', message: RETRY_MESSAGE, values: {} } };
  }

  const values = retainedValues(form, fields);

  /* PER-VISITOR THROTTLE, before the submission is forwarded.
     The API's own limiter is keyed on the address IT sees, which for this path
     is the Astro container — so every visitor shared one budget of 8 per ten
     minutes. This is the only point in the chain that can tell one visitor
     from another. The API's limiter is unchanged and still guards the direct
     `/api/forms/...` route. See visitor-identity.ts. */
  if (throttleVisitor(request).throttled) {
    return { status: 429, state: { kind: 'failed', message: THROTTLED_MESSAGE, values } };
  }

  const result = await submitEnquiry(formType, submissionBody(form, fields), { sourcePath });

  if (result.ok) {
    /* 200 rather than a redirect. A POST-redirect-GET would need a session or
       a query flag to carry the success state, and a query flag on a public
       page is both indexable and forgeable. Re-rendering keeps the success
       state server-side and unguessable; a refresh re-posts, which the API
       treats as a second enquiry rather than as corruption. */
    return { status: 200, state: { kind: 'success' } };
  }

  if (result.kind === 'invalid') {
    return { status: 400, state: { kind: 'invalid', errors: result.errors, values } };
  }

  /* Throttling and upstream failure are distinguished for the visitor,
     because "wait a moment" and "try again" call for different behaviour —
     but neither carries an internal detail. */
  const message = result.kind === 'throttled' ? THROTTLED_MESSAGE : RETRY_MESSAGE;
  return { status: result.kind === 'throttled' ? 429 : 502, state: { kind: 'failed', message, values } };
}
