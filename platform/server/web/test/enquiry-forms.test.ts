/* Public enquiry forms — web side (Fast-Track Phase 3).

   Unit rules against the real modules, plus source-level assertions about the
   rendered component and pages. Live-server behaviour is covered in
   http-routes.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENQUIRY_FORMS, FORM_FIELDS, HONEYPOT_FIELD,
  retainedValues, submissionBody, errorsByField, generalErrors,
  type FieldSpec,
} from '../src/lib/enquiry-forms.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const componentSource = read('src', 'components', 'public', 'EnquiryForm.astro');
const pageHandlerSource = read('src', 'lib', 'enquiry-page.ts');
const submitSource = read('src', 'lib', 'enquiry-submit.ts');
const PAGES = {
  contact: read('src', 'pages', 'contact', 'index.astro'),
  'request-b2b-account': read('src', 'pages', 'request-b2b-account', 'index.astro'),
  'private-label-enquiry': read('src', 'pages', 'private-label-enquiry', 'index.astro'),
};

/* The API's own field list, read from source rather than imported: the API is
   ESM JavaScript in a different package, and the point of this test is that
   the two lists agree, not that they share a module. */
const apiFormsSource = fs.readFileSync(
  path.join(root, '..', 'api', 'src', 'public-forms.js'), 'utf8');

const formData = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

// ---------------------------------------------------------------------------
// contract agreement with the API
// ---------------------------------------------------------------------------

test('the three forms match the API exactly', () => {
  assert.deepEqual([...ENQUIRY_FORMS], ['contact', 'request-b2b-account', 'private-label-enquiry']);
  assert.match(apiFormsSource, /FORM_TYPES = Object\.freeze\(\['contact', 'request-b2b-account', 'private-label-enquiry'\]\)/);
});

test('every rendered field exists on the API side, with the same kind', () => {
  for (const formType of ENQUIRY_FORMS) {
    /* The API declares each form as a block of `name: { kind: 'x', ... }`.
       Slicing that block keeps the check honest without importing it. */
    const start = apiFormsSource.indexOf(formType === 'contact' ? '  contact: {' : `  '${formType}': {`);
    assert.ok(start > 0, `${formType} not found in the API definitions`);
    const block = apiFormsSource.slice(start, apiFormsSource.indexOf('\n  },', start));

    for (const field of FORM_FIELDS[formType]) {
      assert.ok(
        new RegExp(`\\b${field.name}:\\s*\\{[^}]*kind: '${field.kind}'`).test(block),
        `${formType}.${field.name} (${field.kind}) does not match the API`
      );
      if (field.required) {
        assert.ok(new RegExp(`\\b${field.name}:\\s*\\{[^}]*required: true`).test(block),
          `${formType}.${field.name} is required here but not on the API`);
      }
    }
  }
});

test('the honeypot field name matches the API', () => {
  assert.equal(HONEYPOT_FIELD, 'website');
  assert.match(apiFormsSource, /HONEYPOT_FIELD = 'website'/);
});

test('every form requires consent and collects a reply address', () => {
  for (const formType of ENQUIRY_FORMS) {
    const fields = FORM_FIELDS[formType];
    const consent = fields.find((f) => f.kind === 'consent');
    assert.ok(consent?.required, `${formType} must require consent`);
    assert.ok(fields.some((f) => f.kind === 'email' && f.required), `${formType} must require an email`);
  }
});

// ---------------------------------------------------------------------------
// body construction
// ---------------------------------------------------------------------------

test('only declared fields are sent; anything else appended is dropped', () => {
  const fd = formData({
    name: 'Ada', email: 'ada@example.test', message: 'Hello', consent: 'on',
    deliveryState: 'sent', submissionId: 'x', evil: 'y',
  });
  const body = submissionBody(fd, FORM_FIELDS.contact);
  assert.deepEqual(Object.keys(body).sort(), ['consent', 'email', 'message', 'name']);
  for (const forbidden of ['deliveryState', 'submissionId', 'evil']) {
    assert.ok(!(forbidden in body), `${forbidden} was forwarded`);
  }
});

test('a filled honeypot is forwarded so the API can decide, not dropped locally', () => {
  const fd = formData({ name: 'A', email: 'a@b.test', message: 'x', consent: 'on', [HONEYPOT_FIELD]: 'spam' });
  assert.equal(submissionBody(fd, FORM_FIELDS.contact)[HONEYPOT_FIELD], 'spam');
});

test('an empty honeypot is not forwarded', () => {
  const fd = formData({ name: 'A', email: 'a@b.test', message: 'x', consent: 'on', [HONEYPOT_FIELD]: '' });
  assert.ok(!(HONEYPOT_FIELD in submissionBody(fd, FORM_FIELDS.contact)));
});

test('a re-rendered form keeps what was typed but never re-ticks consent', () => {
  const fd = formData({ name: 'Ada', email: 'bad', message: 'Hello', consent: 'on' });
  const values = retainedValues(fd, FORM_FIELDS.contact);
  assert.equal(values.name, 'Ada');
  assert.equal(values.message, 'Hello');
  assert.ok(!('consent' in values), 'consent must be given again if the form comes back');
  assert.ok(!(HONEYPOT_FIELD in values));
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

test('field errors are mapped to their control, first error winning', () => {
  const mapped = errorsByField([
    { field: 'email', code: 'INVALID_EMAIL', message: 'Enter a valid email.' },
    { field: 'email', code: 'REQUIRED', message: 'Also required.' },
    { field: null, code: 'X', message: 'General.' },
  ]);
  assert.deepEqual(mapped, { email: 'Enter a valid email.' });
});

test('an error naming no field, or an unrendered field, still surfaces', () => {
  const general = generalErrors([
    { field: null, code: 'X', message: 'Something general.' },
    { field: 'notARenderedField', code: 'UNKNOWN_FIELD', message: 'Unexpected field.' },
    { field: 'email', code: 'REQUIRED', message: 'Email required.' },
  ], FORM_FIELDS.contact);
  assert.deepEqual(general, ['Something general.', 'Unexpected field.']);
});

// ---------------------------------------------------------------------------
// no-JavaScript operation and progressive enhancement
// ---------------------------------------------------------------------------

test('the form is a plain POST to its own path, with no action attribute', () => {
  assert.match(componentSource, /<form class="enquiry" method="post" novalidate>/);
  assert.doesNotMatch(componentSource, /<form[^>]+action=/);
});

test('the only script is a double-submit guard, and it is inline and optional', () => {
  const scripts = componentSource.match(/<script[\s\S]*?<\/script>/g) ?? [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /is:inline/);
  assert.match(scripts[0], /Progressive enhancement ONLY/);
  assert.match(scripts[0], /button\.disabled = true/);
  // No fetch, no XHR — submission is the browser's own form POST.
  assert.doesNotMatch(scripts[0], /fetch\(|XMLHttpRequest|preventDefault/);
});

test('no client framework or hydration directive is introduced', () => {
  assert.doesNotMatch(componentSource, /client:(load|idle|visible|only)/);
  assert.doesNotMatch(componentSource, /react|vue|svelte|preact/i);
});

test('submission runs server-side, so the API origin never reaches the browser', () => {
  for (const [name, source] of Object.entries(PAGES)) {
    assert.match(source, /await handleEnquiryPage\(Astro\.request/, name);
    assert.doesNotMatch(source, /PUBLIC_API_ORIGIN/, name);
  }
  assert.doesNotMatch(componentSource, /PUBLIC_API_ORIGIN|\/forms\//);
  // The origin is read only in the server-only submit module.
  assert.match(submitSource, /PUBLIC_API_ORIGIN/);
});

// ---------------------------------------------------------------------------
// accessibility and content
// ---------------------------------------------------------------------------

test('every control has a real label bound by id', () => {
  assert.match(componentSource, /<label class="enquiry-label" for=\{id\}>/);
  assert.match(componentSource, /<label class="enquiry-consent" for=\{id\}>/);
  assert.match(componentSource, /id=\{id\} name=\{field\.name\}/);
});

test('required fields are marked visibly and for assistive technology', () => {
  assert.match(componentSource, /required=\{field\.required\}/);
  assert.match(componentSource, /visually-hidden"> \(required\)<\/span>/);
  assert.match(componentSource, /\(optional\)/);
});

test('a validation summary links to each failing control, and errors are described', () => {
  assert.match(componentSource, /role="alert"/);
  assert.match(componentSource, /href=\{`#field-\$\{field\.name\}`\}/);
  assert.match(componentSource, /aria-describedby=\{described\}/);
  assert.match(componentSource, /id="enquiry-errors"/);
});

test('the success state is announced and replaces the form', () => {
  assert.match(componentSource, /class="enquiry-success" role="status"/);
  assert.match(componentSource, /state\.kind === 'success' \? \(/);
});

test('the honeypot is hidden from sight, tab order and assistive technology', () => {
  assert.match(componentSource, /class="enquiry-trap" aria-hidden="true"/);
  assert.match(componentSource, /tabindex="-1"/);
  // Off-screen rather than display:none — some bots skip hidden inputs.
  assert.match(componentSource, /\.enquiry-trap \{[\s\S]*?position: absolute/);
  assert.doesNotMatch(componentSource, /\.enquiry-trap \{[\s\S]*?display: none/);
});

test('the interface is square-cornered and mobile-safe', () => {
  assert.match(componentSource, /border-radius: 0/);
  assert.doesNotMatch(componentSource, /border-radius:\s*(?!0)[1-9]/);
  assert.match(componentSource, /font-size: 16px/, 'iOS focus-zoom guard');
  assert.match(componentSource, /@media \(max-width: 480px\)/);
});

test('no pricing, stock or availability field is offered on any form', () => {
  for (const formType of ENQUIRY_FORMS) {
    for (const field of FORM_FIELDS[formType]) {
      assert.doesNotMatch(field.name, /price|stock|availab|qty|cost|discount/i, `${formType}.${field.name}`);
    }
  }
  assert.doesNotMatch(componentSource, /name="(price|stock|quantity|budget)"/i);
});

test('the privacy note points at the policy page and promises nothing', () => {
  assert.match(componentSource, /href="\/privacy-policy\/"/);
  assert.match(componentSource, /only to answer your enquiry/);
  for (const source of [componentSource, ...Object.values(PAGES)]) {
    assert.doesNotMatch(source, /within \d+ (hours|days|working)/i, 'no invented response time');
    assert.doesNotMatch(source, /guarantee|best price|cheapest|fastest/i, 'no invented claim');
  }
});

test('each page keeps its registry metadata, breadcrumbs and one H1', () => {
  for (const [name, source] of Object.entries(PAGES)) {
    assert.match(source, /STATIC_ROUTE_METADATA\[/, name);
    assert.match(source, /staticBreadcrumbs\(/, name);
    // The H1 comes from Page.astro via the metadata registry, not from here.
    assert.doesNotMatch(source, /<h1/, `${name} must not add a second H1`);
  }
});

// ---------------------------------------------------------------------------
// status and failure handling
// ---------------------------------------------------------------------------

test('the page sets its own status, because a nested component cannot', () => {
  for (const [name, source] of Object.entries(PAGES)) {
    assert.match(source, /Astro\.response\.status = status/, name);
  }
  assert.match(pageHandlerSource, /Astro\.response\.status/, 'the reason is documented');
});

test('an invalid submission answers 400, a failure 502, throttling 429, success 200', () => {
  assert.match(pageHandlerSource, /return \{ status: 400, state: \{ kind: 'invalid'/);
  assert.match(pageHandlerSource, /status: result\.kind === 'throttled' \? 429 : 502/);
  assert.match(pageHandlerSource, /return \{ status: 200, state: \{ kind: 'success' \} \}/);
});

test('a GET renders the empty form and calls nothing upstream', () => {
  assert.match(pageHandlerSource, /if \(request\.method !== 'POST'\) \{\s*return \{ status: 200, state: \{ kind: 'idle' \} \};/);
});

test('no internal detail reaches the visitor on failure', () => {
  /* The messages are constants with no interpolation, so an upstream status,
     host or error name cannot reach the page. */
  assert.match(pageHandlerSource, /const RETRY_MESSAGE =\s*\n?\s*'[^']*';/);
  assert.match(pageHandlerSource, /const THROTTLED_MESSAGE =\s*\n?\s*'[^']*';/);
  assert.doesNotMatch(pageHandlerSource, /message: `.*\$\{/, 'no interpolated failure message');
  assert.doesNotMatch(pageHandlerSource, /result\.detail/, 'detail is for logs, never for a page');
});

test('the submit client is narrow: fixed paths, no cookies, bounded response', () => {
  assert.match(submitSource, /if \(!ENQUIRY_FORMS\.includes\(formType\)\)/);
  assert.match(submitSource, /`\/forms\/\$\{formType\}`/);
  assert.match(submitSource, /credentials: 'omit'/);
  assert.match(submitSource, /redirect: 'error'/);
  assert.match(submitSource, /MAX_RESPONSE_BYTES/);
  assert.match(submitSource, /REQUEST_TIMEOUT_MS/);
});

test('a malformed error body is discarded rather than rendered', () => {
  assert.match(submitSource, /function readFieldErrors/);
  assert.match(submitSource, /typeof message !== 'string'/);
  assert.match(submitSource, /message\.slice\(0, 300\)/);
  assert.match(submitSource, /upstream 400 without field errors/);
});

test('the read-only public API client is not widened to allow a POST', () => {
  const publicApi = read('src', 'lib', 'public-api.ts');
  assert.match(publicApi, /refusing non-\/public path/);
  assert.doesNotMatch(publicApi, /method: 'POST'/);
  assert.match(submitSource, /does NOT reuse `requestJson`/);
});
