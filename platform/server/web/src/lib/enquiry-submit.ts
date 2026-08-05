/* Server-side submission of a public enquiry (Fast-Track Phase 3).

   Runs in the Astro server only. The browser never sees the API origin, never
   makes a cross-origin request, and needs no JavaScript: the form posts to its
   own path and this module forwards it.

   It deliberately does NOT reuse `requestJson` from public-api.ts. That helper
   is GET-only and refuses any path outside `/public/` — correctly, because it
   guards a read-only boundary. Widening it to permit a POST to a different
   namespace would weaken exactly the guard it exists to provide, so this is a
   separate, similarly narrow path with its own fixed allowlist. */

import { ENQUIRY_FORMS, type EnquiryForm, type FieldError } from './enquiry-forms.ts';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type SubmitResult =
  | { ok: true }
  | { ok: false; kind: 'invalid'; errors: FieldError[] }
  /** Retryable. `detail` is for server logs, never for a visitor. */
  | { ok: false; kind: 'throttled' | 'unavailable'; detail: string };

function apiOrigin(): string {
  /* Read at call time rather than module load so tests can point it at a
     local mock, matching public-api.ts's own approach. */
  const origin = import.meta.env.PUBLIC_API_ORIGIN ?? process.env.PUBLIC_API_ORIGIN ?? '';
  if (!origin) throw new Error('enquiry-submit: PUBLIC_API_ORIGIN is not configured');
  return origin;
}

/** Fixed path per form. The form type is checked against the allowlist, so a
    caller cannot construct an arbitrary path. */
function submitUrl(formType: EnquiryForm): URL {
  if (!ENQUIRY_FORMS.includes(formType)) {
    throw new Error(`enquiry-submit: unknown form "${formType}"`);
  }
  return new URL(`/forms/${formType}`, apiOrigin());
}

export async function submitEnquiry(
  formType: EnquiryForm,
  body: Record<string, string>,
  { sourcePath }: { sourcePath?: string } = {}
): Promise<SubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(submitUrl(formType), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      /* No cookies. This API is unauthenticated and forwarding a visitor's
         session to it would be both useless and a privacy leak. */
      credentials: 'omit',
      redirect: 'error',
      body: JSON.stringify(sourcePath ? { ...body, sourceUrl: sourcePath } : body),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.name : 'fetch failed';
    return { ok: false, kind: 'unavailable', detail };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { ok: false, kind: 'throttled', detail: 'upstream 429' };
  }

  let parsed: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (/^application\/json\b/i.test(contentType)) {
    try {
      const text = await response.text();
      if (text.length <= MAX_RESPONSE_BYTES) parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.status === 400) {
    const errors = readFieldErrors(parsed);
    /* A 400 with no readable field errors is not something a visitor can act
       on, so it is reported as a failure rather than as an empty error list
       that would render as "something is wrong, but not with anything". */
    return errors.length
      ? { ok: false, kind: 'invalid', errors }
      : { ok: false, kind: 'unavailable', detail: 'upstream 400 without field errors' };
  }

  if (!response.ok) return { ok: false, kind: 'unavailable', detail: `upstream ${response.status}` };
  if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true) return { ok: true };
  return { ok: false, kind: 'unavailable', detail: 'unexpected success body' };
}

/** Reads only the shape the API documents. Anything else is discarded rather
    than rendered — a malformed error body must not become page content. */
function readFieldErrors(parsed: unknown): FieldError[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { fieldErrors?: unknown }).fieldErrors;
  if (!Array.isArray(list)) return [];
  const out: FieldError[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { field, code, message } = item as Record<string, unknown>;
    if (typeof message !== 'string' || message === '') continue;
    out.push({
      field: typeof field === 'string' ? field : null,
      code: typeof code === 'string' ? code : 'INVALID',
      message: message.slice(0, 300),
    });
  }
  return out;
}
