#!/usr/bin/env node
'use strict';
// ── Home Team Roofing — Contact Spam Protection Tests ─────────────────────────
// Tests api/submit-contact.js handler behavior using mock req/res objects.
// No real network calls are made; global fetch is replaced per test.
// No real customer PII is used anywhere in this file.
//
// Delivery behavior groups (honeypot, validation, phone normalization, UUID,
// retry, alert, timeout) mirror the equivalent groups in submission-system.test.js
// to enforce the DELIVERY SYNC CONTRACT declared in api/submit-contact.js.
// A failure here that passes in submission-system.test.js (or vice versa) signals
// the two handlers have drifted — investigate before merging.

const handler = require('../../api/submit-contact');

// ── Test infrastructure (identical pattern to submission-system.test.js) ───────

let passed = 0, failed = 0;
const failures = [];
const _queue = [];

function test(name, fn)   { _queue.push({ name, fn }); }
function group(name)      { _queue.push({ header: name }); }
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function mockReq(body, method = 'POST') { return { method, body }; }
function mockRes() {
  const r = { _status: null, _body: null };
  r.status = function(s) { r._status = s; return r; };
  r.json   = function(b) { r._body   = b; return r; };
  return r;
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

const TEST_WEBHOOK    = 'https://example.com/test-webhook';
const TURNSTILE_URL   = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Three-way fetch router: Turnstile | alert webhook | HL webhook
//
// tsResponse shapes:
//   { success, errorCodes?, hostname? }  — normal Cloudflare siteverify response
//   { httpFail: true }                   — HTTP 500 from Cloudflare (5xx outage)
//   { httpStatus: <n> }                  — explicit HTTP status from Cloudflare (e.g. 401)
//   { throw: 'msg' }                     — network error / AbortError
//   { noSuccessKey: true }               — parseable JSON but missing 'success' field
//   { jsonParseError: true }             — HTTP 200 but response body is unparseable JSON
//
// hlResponses: array of { ok, status? } | { throw: 'msg' }
// alertOk:     boolean
function mockFetch(tsResponse, hlResponses, alertOk = true) {
  let hlCall = 0;
  global.fetch = async function(url, _opts) {
    if (url === TURNSTILE_URL) {
      if (tsResponse.throw)         throw new Error(tsResponse.throw);
      if (tsResponse.httpStatus)    return { ok: false, status: tsResponse.httpStatus };
      if (tsResponse.httpFail)      return { ok: false, status: 500 };
      if (tsResponse.noSuccessKey)  return { ok: true, json: async () => ({}) };
      if (tsResponse.jsonParseError) {
        return { ok: true, status: 200, json: async () => { throw new Error('JSON parse error'); } };
      }
      const tsBody = {
        success:       tsResponse.success,
        'error-codes': tsResponse.errorCodes || [],
      };
      if ('hostname' in tsResponse) tsBody.hostname = tsResponse.hostname;
      return { ok: true, json: async () => tsBody };
    }
    if (process.env.ALERT_WEBHOOK_URL && url === process.env.ALERT_WEBHOOK_URL) {
      return { ok: alertOk, status: alertOk ? 200 : 500 };
    }
    // HL webhook
    const resp = hlResponses[hlCall] || hlResponses[hlResponses.length - 1];
    hlCall++;
    if (resp.throw) throw new Error(resp.throw);
    return { ok: resp.ok, status: resp.status || (resp.ok ? 200 : 500) };
  };
}

// Shorthand: valid Turnstile pass + single HL success
function mockOk() { mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]); }

// Environment
process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL   = TEST_WEBHOOK;
process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'test-secret-key'; // mocked — value irrelevant

// ── Valid baseline payload (contact form) ─────────────────────────────────────
const validBody = {
  submissionId:  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  firstName:     'Test',
  lastName:      'Customer',
  email:         'test@example.com',
  phone:         '7135550100',
  city:          'Houston',
  numberOfWindows: '4-7',
  message:       'Test contact inquiry — safe to delete.',
  cfToken:       'valid-test-token',
  sourceKey:     'contact',
  pageUrl:       'https://hometeamroof.com/contact',
};

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: HTTP METHOD
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 1: HTTP method');

test('rejects GET with 405', async () => {
  const res = mockRes();
  await handler(mockReq({}, 'GET'), res);
  assert(res._status === 405, `expected 405, got ${res._status}`);
});

test('rejects PUT with 405', async () => {
  const res = mockRes();
  await handler(mockReq({}, 'PUT'), res);
  assert(res._status === 405, `expected 405, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: MISSING ENVIRONMENT CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 2: Missing environment configuration');

test('returns 500 when HIGHLEVEL_INQUIRY_WEBHOOK_URL is not set', async () => {
  const saved = process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  delete process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  const res = mockRes();
  await handler(mockReq(validBody), res);
  process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL = saved;
  assert(res._status === 500, `expected 500, got ${res._status}`);
});

test('returns 500 when CLOUDFLARE_TURNSTILE_SECRET_KEY is not set', async () => {
  const saved = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  const res = mockRes();
  await handler(mockReq(validBody), res);
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = saved;
  assert(res._status === 500, `expected 500, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: HONEYPOT
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 3: Honeypot');

test('silently accepts bot (_hp filled) with 200 — no Turnstile call, no HL call', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  const res = mockRes();
  await handler(mockReq({ ...validBody, _hp: 'bot-value' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(!fetchCalled, 'fetch should NOT be called when honeypot is filled');
});

test('processes real user (empty _hp) past honeypot to Turnstile', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, _hp: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: TURNSTILE TOKEN VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 4: Turnstile token verification');

test('rejects missing cfToken with 400', async () => {
  const res = mockRes();
  const body = { ...validBody };
  delete body.cfToken;
  await handler(mockReq(body), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/security check/i.test(res._body.error), 'error should mention security check');
});

test('rejects empty cfToken with 400', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, cfToken: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('rejects whitespace-only cfToken with 400', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, cfToken: '   ' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('rejects invalid token (Cloudflare success:false) with 400', async () => {
  mockFetch({ success: false, errorCodes: ['invalid-input-response'] }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/security check failed/i.test(res._body.error), 'error should mention security check failed');
});

test('rejects replayed token (Cloudflare returns timeout-or-duplicate) with 400', async () => {
  mockFetch({ success: false, errorCodes: ['timeout-or-duplicate'] }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('accepts valid token (Cloudflare success:true) and delivers to HL', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true');
});

test('Cloudflare response missing success key → treated as failure → 400', async () => {
  mockFetch({ noSuccessKey: true }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on missing success key, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: TURNSTILE FAILURE MODES — FAIL OPEN
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 5: Turnstile failure modes — fail open');

test('Cloudflare network error → fail open → HL delivery → 200', async () => {
  mockFetch({ throw: 'Network error' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on fail-open, got ${res._status}`);
  assert(res._body.ok === true, 'lead must be delivered when Cloudflare is unreachable');
});

test('Cloudflare AbortController timeout → fail open → HL delivery → 200', async () => {
  mockFetch({ throw: 'AbortError: The operation was aborted' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on timeout fail-open, got ${res._status}`);
});

test('Cloudflare HTTP 500 → fail open → HL delivery → 200', async () => {
  mockFetch({ httpFail: true }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on Cloudflare 5xx fail-open, got ${res._status}`);
});

test('fail-open submissions still deliver to HL with correct source', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) throw new Error('Network error');
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(capturedPayload.source === 'Contact Page - hometeamroof.com',
    `expected contact source label, got "${capturedPayload.source}"`);
});

test('Cloudflare HTTP 4xx (auth/config error) → fail open → HL delivery → 200', async () => {
  // 4xx is NOT treated as a definitive rejection — it fails open to protect leads.
  // A separate CONFIG ALERT is emitted in the logs.
  mockFetch({ httpStatus: 401 }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on CF 4xx fail-open, got ${res._status}`);
  assert(res._body.ok === true, 'lead must be delivered when Cloudflare returns 4xx');
});

test('Cloudflare HTTP 403 (forbidden) → fail open → HL delivery → 200', async () => {
  mockFetch({ httpStatus: 403 }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on CF 403 fail-open, got ${res._status}`);
});

test('Cloudflare unparseable JSON response → fail open → HL delivery → 200', async () => {
  mockFetch({ jsonParseError: true }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 on JSON parse error fail-open, got ${res._status}`);
  assert(res._body.ok === true, 'lead must be delivered when response body is unreadable');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: SOURCE ATTRIBUTION — SECURITY BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 6: Source attribution — server-side enforcement');

test('source is always "Contact Page" regardless of body.sourceKey', async () => {
  let capturedPayload;
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{
    ok: true,
    // intercept to capture
  }]);
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, sourceKey: 'estimate' }), res);
  restoreFetch();
  assert(capturedPayload.source === 'Contact Page - hometeamroof.com',
    `sourceKey spoofing must not change source; got "${capturedPayload.source}"`);
});

test('source is always "Contact Page" when sourceKey is omitted', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const body = { ...validBody };
  delete body.sourceKey;
  const res = mockRes();
  await handler(mockReq(body), res);
  restoreFetch();
  assert(capturedPayload.source === 'Contact Page - hometeamroof.com',
    `expected contact source, got "${capturedPayload.source}"`);
});

test('cfToken is NOT forwarded to GoHighLevel', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(!('cfToken' in capturedPayload),
    'cfToken must be stripped from the HL payload — not stored in CRM');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7: SERVER-SIDE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 7: Server-side validation');

test('rejects when both firstName and lastName are empty', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: '', lastName: '' }), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/name/i.test(res._body.error), 'error should mention name');
});

test('accepts when only firstName is provided', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, lastName: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('accepts when only lastName is provided', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('rejects when both email and phone are empty', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: '', phone: '' }), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('accepts phone-only (no email)', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('accepts email-only (no phone)', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('rejects malformed email when phone is also absent', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: 'notanemail', phone: '' }), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/email/i.test(res._body.error), 'error should mention email');
});

test('rejects phone with fewer than 7 digits', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '123', email: '' }), res);
  restoreFetch();
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8: PHONE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 8: Phone normalization');

test('normalizes 10-digit phone to E.164', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '7135550100' }), res);
  restoreFetch();
  assert(capturedPayload.phone === '+17135550100',
    `expected +17135550100, got ${capturedPayload.phone}`);
});

test('normalizes 11-digit phone starting with 1 to E.164', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '17135550100' }), res);
  restoreFetch();
  assert(capturedPayload.phone === '+17135550100',
    `expected +17135550100, got ${capturedPayload.phone}`);
});

test('leaves non-standard phone unchanged', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '+447911123456' }), res);
  restoreFetch();
  assert(capturedPayload.phone === '+447911123456',
    `expected unchanged, got ${capturedPayload.phone}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9: SUBMISSION ID
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 9: Submission ID');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('valid client UUID is preserved in HL payload', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res);
  restoreFetch();
  assert(capturedPayload.submissionId === 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
    `client UUID not preserved: ${capturedPayload.submissionId}`);
});

test('invalid client UUID is replaced with server-generated UUID', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'not-a-uuid' }), res);
  restoreFetch();
  assert(UUID_RE.test(capturedPayload.submissionId),
    `expected valid UUID, got ${capturedPayload.submissionId}`);
  assert(capturedPayload.submissionId !== 'not-a-uuid', 'invalid ID should be replaced');
});

test('missing submissionId generates server-side UUID', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const body = { ...validBody };
  delete body.submissionId;
  const res = mockRes();
  await handler(mockReq(body), res);
  restoreFetch();
  assert(UUID_RE.test(capturedPayload.submissionId),
    `expected valid UUID, got ${capturedPayload.submissionId}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10: HL DELIVERY — SUCCESS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 10: HL delivery — success');

test('returns 200 and ok:true on HL 200', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true');
});

test('HL payload includes all required fields', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  const required = ['submissionId','firstName','lastName','fullName','email',
    'phone','source','pageUrl','submittedAt'];
  required.forEach(f => {
    assert(f in capturedPayload, `missing field "${f}" in HL payload`);
  });
});

test('fullName is computed from firstName + lastName', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: 'Jane', lastName: 'Smith' }), res);
  restoreFetch();
  assert(capturedPayload.fullName === 'Jane Smith',
    `expected "Jane Smith", got "${capturedPayload.fullName}"`);
});

test('contact form fields forwarded correctly; unused fields are empty strings', async () => {
  let capturedPayload;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, numberOfWindows: '8-12', city: 'Tomball', message: 'Test message.' }), res);
  restoreFetch();
  assert(capturedPayload.numberOfWindows === '8-12',
    `numberOfWindows not preserved: ${capturedPayload.numberOfWindows}`);
  assert(capturedPayload.city === 'Tomball',
    `city not preserved: ${capturedPayload.city}`);
  assert(capturedPayload.message === 'Test message.',
    `message not preserved: ${capturedPayload.message}`);
  // These fields have no inputs on the contact form
  assert(capturedPayload.address === '',            'address should be empty string');
  assert(capturedPayload.serviceType === '',        'serviceType should be empty string');
  assert(capturedPayload.preferredContactMethod === '', 'preferredContactMethod should be empty string');
  assert(capturedPayload.zipCode === '',            'zipCode should be empty string');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11: RETRY BEHAVIOR
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 11: Retry behavior');

test('succeeds on retry after first HL 500', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: false, status: 500 }, { ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after retry, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true after retry');
});

test('succeeds on retry after first HL network failure', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ throw: 'Network error' }, { ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after retry, got ${res._status}`);
});

test('returns 502 when both HL attempts fail (HTTP 500)', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: false, status: 500 }, { ok: false, status: 500 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502, got ${res._status}`);
  assert(/try again|call us/i.test(res._body.error), 'error should suggest retry or phone');
});

test('returns 502 when both HL attempts throw (network failure)', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ throw: 'timeout' }, { throw: 'timeout' }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502, got ${res._status}`);
});

test('returns submissionId in 502 response for manual recovery', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: false, status: 500 }, { ok: false, status: 500 }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res);
  restoreFetch();
  assert(res._body.submissionId === 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
    'submissionId must be in 502 body for operator recovery');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12: ALERT WEBHOOK ON PERMANENT FAILURE
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 12: Alert webhook on permanent failure');

test('fires alert webhook on permanent HL failure', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertCalled = false;
  global.fetch = async function(url) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    if (url.includes('alert')) { alertCalled = true; return { ok: true, status: 200 }; }
    return { ok: false, status: 500 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(alertCalled, 'alert webhook should fire on permanent HL failure');
  assert(res._status === 502, `expected 502, got ${res._status}`);
});

test('alert webhook receives submissionId and lead payload', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertBody;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    if (url.includes('alert')) {
      alertBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 500 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(alertBody, 'alert body should be captured');
  assert(alertBody.submissionId === 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
    'alert should contain submissionId');
  assert(alertBody.lead, 'alert should contain lead payload for recovery');
  assert(alertBody.alert === 'HL_WEBHOOK_FAILURE', 'alert type should be set');
});

test('alert webhook failure does not change the 502 response', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  global.fetch = async function(url) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    return { ok: false, status: 500 }; // both HL and alert fail
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(res._status === 502, `expected 502, got ${res._status}`);
});

test('does NOT fire alert webhook on successful delivery', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertCalled = false;
  global.fetch = async function(url, opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    if (url.includes('alert')) { alertCalled = true; }
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(!alertCalled, 'alert webhook must NOT fire on successful delivery');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13: API TIMEOUT SIMULATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 13: HL API timeout simulation');

test('returns 502 when both HL calls time out (AbortError)', async () => {
  mockFetch(
    { success: true, hostname: 'hometeamroof.com' },
    [{ throw: 'AbortError: The operation was aborted' },
     { throw: 'AbortError: The operation was aborted' }]
  );
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502 on timeout, got ${res._status}`);
  assert(/try again|call us/i.test(res._body.error), 'error should instruct customer');
});

test('recovers if second HL attempt succeeds after first timeout', async () => {
  mockFetch(
    { success: true, hostname: 'hometeamroof.com' },
    [{ throw: 'AbortError: The operation was aborted' }, { ok: true, status: 200 }]
  );
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after timeout+retry, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true after recovery');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 14: HOSTNAME VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 14: Hostname validation');

test('rejects token issued to a different hostname', async () => {
  mockFetch({ success: true, hostname: 'evil.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on hostname mismatch, got ${res._status}`);
  assert(/security check failed/i.test(res._body.error),
    'error should reference security check');
});

test('accepts token with correct hostname', async () => {
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 for correct hostname, got ${res._status}`);
});

test('absent hostname → rejected with 400 (hostname-absent) in all environments', async () => {
  // Per official Cloudflare documentation, siteverify responses always include a
  // hostname — real keys return the actual domain; test-mode keys return 'example.com'.
  // A missing hostname is therefore unexpected and is never silently passed.
  const absentHostnameResponse = { success: true }; // intentionally no 'hostname' field
  mockFetch(absentHostnameResponse, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400,
    `expected 400 for absent hostname, got ${res._status}`);
  assert(/security check failed/i.test(res._body.error),
    'error should reference security check');
});

test('test-mode key hostname "example.com" + allowlist → accepted and delivered', async () => {
  // Cloudflare test-mode secret keys return hostname:'example.com' (official docs).
  // Preview environments must set CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST to include
  // 'example.com' so the form can be tested end-to-end without the production domain.
  process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST = 'hometeamroof.com,example.com';
  mockFetch({ success: true, hostname: 'example.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  assert(res._status === 200,
    `expected 200 with example.com in allowlist, got ${res._status}`);
});

test('test-mode key hostname "example.com" WITHOUT allowlist → rejected (not in production list)', async () => {
  // Without the preview allowlist configured, test-mode tokens must NOT reach production.
  // CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST defaults to 'hometeamroof.com' only.
  mockFetch({ success: true, hostname: 'example.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400,
    `expected 400: example.com must not pass in production, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 15: EMAIL VALIDATION — WITH AND WITHOUT PHONE
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 15: Email validation with and without phone');

test('rejects malformed email even when valid phone is provided', async () => {
  // Documents that email format is validated unconditionally when non-empty,
  // regardless of whether phone satisfies the contact requirement.
  mockFetch({ success: true, hostname: 'hometeamroof.com' }, [{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: 'notanemail', phone: '7135550100' }), res);
  restoreFetch();
  assert(res._status === 400,
    `expected 400 for malformed email + valid phone, got ${res._status}`);
  assert(/email/i.test(res._body.error), 'error should mention email');
});

test('accepts valid email with valid phone', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: 'test@example.com', phone: '7135550100' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 16: EMPTY AND MALFORMED REQUEST BODIES
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 16: Empty and malformed request bodies');

test('empty body object → 400 validation error (missing name + contact)', async () => {
  const res = mockRes();
  await handler(mockReq({}), res);
  assert(res._status === 400, `expected 400 on empty body, got ${res._status}`);
});

test('null body → 400 validation error (treated as empty object)', async () => {
  const res = mockRes();
  await handler(mockReq(null), res);
  assert(res._status === 400, `expected 400 on null body, got ${res._status}`);
});

test('unparseable JSON string body → 400 validation error', async () => {
  // Vercel can deliver raw string bodies before middleware parses them.
  // The handler parses these defensively and falls back to {}.
  const res = mockRes();
  await handler(mockReq('not-json-at-all'), res);
  assert(res._status === 400, `expected 400 on unparseable body, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 17: DUPLICATE SUBMISSION IDS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 17: Duplicate submission IDs');

test('two requests with identical UUIDs are both delivered — deduplication is HL responsibility', async () => {
  // The endpoint is intentionally stateless and does not block duplicate IDs.
  // GoHighLevel handles idempotency using the submissionId field.
  const dupeId = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
  let hlCallCount = 0;
  global.fetch = async function(url, _opts) {
    if (url === TURNSTILE_URL) return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    hlCallCount++;
    return { ok: true, status: 200 };
  };
  const res1 = mockRes();
  await handler(mockReq({ ...validBody, submissionId: dupeId }), res1);
  const res2 = mockRes();
  await handler(mockReq({ ...validBody, submissionId: dupeId }), res2);
  restoreFetch();
  assert(res1._status === 200, `first request should succeed: got ${res1._status}`);
  assert(res2._status === 200, `second request should succeed: got ${res2._status}`);
  assert(hlCallCount === 2, `both requests must reach HL; got ${hlCallCount} calls`);
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER — identical pattern to submission-system.test.js
// ─────────────────────────────────────────────────────────────────────────────
(async function runAll() {
  for (const item of _queue) {
    if ('header' in item) {
      process.stdout.write(`\n${item.header}\n`);
      continue;
    }
    try {
      await item.fn();
      passed++;
      process.stdout.write(`  PASS  ${item.name}\n`);
    } catch (err) {
      failed++;
      failures.push({ name: item.name, reason: err.message });
      process.stdout.write(`  FAIL  ${item.name}\n         ${err.message}\n`);
    }
  }

  process.stdout.write(`\n${passed + failed} tests: ${passed} passed`);
  if (failed > 0) {
    process.stdout.write(`, ${failed} FAILED\n`);
    failures.forEach(f => process.stdout.write(`  ✗ ${f.name}: ${f.reason}\n`));
    process.exit(1);
  } else {
    process.stdout.write(`, 0 failed\n`);
  }
})();
