#!/usr/bin/env node
'use strict';
// ── Home Team Roofing — Lead Submission System Tests ──────────────────────────
// Tests api/submit-inquiry.js handler behavior using mock req/res objects.
// No real network calls are made; global fetch is replaced per test.
// No real customer PII is used anywhere in this file.
//
// Tests run sequentially via _queue so fetch mocks don't race across the
// handler's 1-second retry delay.

const handler = require('../../api/submit-inquiry');

// ── Test infrastructure ───────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
const _queue = [];

// Queue a test for sequential execution.
function test(name, fn) {
  _queue.push({ name, fn });
}

// Queue a section header (printed at run time, not registration time).
function group(name) {
  _queue.push({ header: name });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(body, method = 'POST') {
  return { method, body };
}

function mockRes() {
  const r = { _status: null, _body: null };
  r.status = function(s) { r._status = s; return r; };
  r.json   = function(b) { r._body = b; return r; };
  return r;
}

// ── URL-routing fetch mock ────────────────────────────────────────────────────
// Routes ALERT_WEBHOOK_URL calls independently so alert calls never consume a
// slot in the HL responses array.  alertOk=true simulates a 200 from the alert
// endpoint; alertOk=false simulates failure (handler must swallow it silently).
const originalFetch = global.fetch;
function mockFetch(hlResponses, alertOk = true) {
  let hlCall = 0;
  global.fetch = async function(url, _opts) {
    if (process.env.ALERT_WEBHOOK_URL && url === process.env.ALERT_WEBHOOK_URL) {
      return { ok: alertOk, status: alertOk ? 200 : 500 };
    }
    const resp = hlResponses[hlCall] || hlResponses[hlResponses.length - 1];
    hlCall++;
    if (resp.throw) throw new Error(resp.throw);
    return { ok: resp.ok, status: resp.status || (resp.ok ? 200 : 500) };
  };
}
function restoreFetch() { global.fetch = originalFetch; }

const TEST_WEBHOOK = 'https://example.com/test-webhook';

// Set up env for all tests
process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL = TEST_WEBHOOK;

// ── Valid baseline payload ────────────────────────────────────────────────────
const validBody = {
  submissionId:  'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  firstName:     'Test',
  lastName:      'Customer',
  email:         'test@example.com',
  phone:         '7135550100',
  city:          'Houston',
  serviceType:   'Roofing',
  message:       'Test inquiry — safe to delete.',
  sourceKey:     'estimate',
  pageUrl:       'https://hometeamroof.com/estimate?source=api-test',
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

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: HONEYPOT
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 2: Honeypot');

test('silently accepts bot (filled _hp) with 200 — no HL call', async () => {
  let hlCalled = false;
  global.fetch = async () => { hlCalled = true; return { ok: true, status: 200 }; };
  const res = mockRes();
  await handler(mockReq({ ...validBody, _hp: 'bot-value' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(!hlCalled, 'HL should NOT be called when honeypot is filled');
});

test('processes real user (empty _hp) normally', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, _hp: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 3: Server-side validation');

test('rejects when both firstName and lastName are empty', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: '', lastName: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/name/i.test(res._body.error), 'error should mention name');
});

test('accepts when only firstName is provided (lastName empty)', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, lastName: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('accepts when only lastName is provided (firstName empty)', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('rejects when both email and phone are empty', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: '', phone: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('accepts phone-only submission (no email)', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('accepts email-only submission (no phone)', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

test('rejects malformed email when phone is also absent', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, email: 'notanemail', phone: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
  assert(/email/i.test(res._body.error), 'error should mention email');
});

test('rejects phone string with fewer than 7 digits ("abc")', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: 'abc', email: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('rejects phone string with fewer than 7 digits ("123")', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '123', email: '' }), res);
  assert(res._status === 400, `expected 400, got ${res._status}`);
});

test('accepts phone string with 7 or more digits', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '832-422-3039' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: PHONE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 4: Phone normalization');

test('normalizes 10-digit phone to E.164', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
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
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, phone: '17135550100' }), res);
  restoreFetch();
  assert(capturedPayload.phone === '+17135550100',
    `expected +17135550100, got ${capturedPayload.phone}`);
});

test('leaves non-standard phone unchanged (international)', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
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
// GROUP 5: SUBMISSION ID
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 5: Submission ID');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('valid client UUID is preserved in HL payload', async () => {
  const clientId = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: clientId }), res);
  restoreFetch();
  assert(capturedPayload.submissionId === clientId,
    `client ID not preserved: ${capturedPayload.submissionId}`);
});

test('valid client UUID is returned in 200 response', async () => {
  mockFetch([{ ok: true }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res);
  restoreFetch();
  assert(res._body.submissionId === 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
    'submissionId not echoed in response');
});

test('invalid client UUID is replaced with server-generated UUID', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'not-a-valid-uuid' }), res);
  restoreFetch();
  assert(UUID_RE.test(capturedPayload.submissionId),
    `expected valid UUID, got ${capturedPayload.submissionId}`);
  assert(capturedPayload.submissionId !== 'not-a-valid-uuid', 'invalid ID was not replaced');
});

test('missing submissionId generates server-side UUID', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  const body = { ...validBody };
  delete body.submissionId;
  await handler(mockReq(body), res);
  restoreFetch();
  assert(UUID_RE.test(capturedPayload.submissionId),
    `expected valid UUID, got ${capturedPayload.submissionId}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: SOURCE ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 6: Source attribution');

const sourceTests = [
  ['estimate',            'Estimate Page - hometeamroof.com'],
  ['contact',             'Contact Page - hometeamroof.com'],
  ['woodlands-roofing-tx','The Woodlands Roofing - hometeamroof.com'],
  ['roofing',             'Roofing Page - hometeamroof.com'],
  ['unknown-key',         'Home Team - hometeamroof.com'],
  ['',                    'Home Team - hometeamroof.com'],
];

sourceTests.forEach(function([key, expectedLabel]) {
  test(`sourceKey "${key}" → "${expectedLabel}"`, async () => {
    let capturedPayload;
    global.fetch = async (url, opts) => {
      capturedPayload = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    };
    const res = mockRes();
    await handler(mockReq({ ...validBody, sourceKey: key }), res);
    restoreFetch();
    assert(capturedPayload.source === expectedLabel,
      `expected "${expectedLabel}", got "${capturedPayload.source}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7: HL DELIVERY — SUCCESS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 7: HL delivery — success');

test('returns 200 and ok:true on HL 200', async () => {
  mockFetch([{ ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true');
});

test('HL payload includes all expected fields', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  const required = ['submissionId','firstName','lastName','fullName','email',
    'phone','serviceType','source','pageUrl','submittedAt'];
  required.forEach(f => {
    assert(f in capturedPayload, `missing field "${f}" in HL payload`);
  });
});

test('fullName is computed from firstName + lastName', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, firstName: 'Jane', lastName: 'Smith' }), res);
  restoreFetch();
  assert(capturedPayload.fullName === 'Jane Smith',
    `expected "Jane Smith", got "${capturedPayload.fullName}"`);
});

test('multiple service types forwarded as comma-separated string', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, serviceType: 'Roofing, Windows, Doors' }), res);
  restoreFetch();
  assert(capturedPayload.serviceType === 'Roofing, Windows, Doors',
    `serviceType not preserved: "${capturedPayload.serviceType}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8: HL DELIVERY — RETRY
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 8: Retry behavior');

test('succeeds on retry after first HL 500', async () => {
  mockFetch([{ ok: false, status: 500 }, { ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after retry, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true after retry');
});

test('succeeds on retry after first network failure', async () => {
  mockFetch([{ throw: 'Network error' }, { ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after retry, got ${res._status}`);
});

test('returns 502 when both attempts fail (HTTP 500)', async () => {
  mockFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502, got ${res._status}`);
  assert(/try again|call us/i.test(res._body.error), 'error message should suggest retry or phone');
});

test('returns 502 when both attempts throw (network failure)', async () => {
  mockFetch([{ throw: 'timeout' }, { throw: 'timeout' }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502, got ${res._status}`);
});

test('returns submissionId in 502 response for manual recovery', async () => {
  mockFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._body.submissionId, 'submissionId should be in 502 response for recovery');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9: ALERT WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 9: Alert webhook on permanent failure');

test('fires alert webhook on permanent HL failure', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertCalled = false;
  let hlCallCount = 0;
  global.fetch = async (url, opts) => {
    if (url.includes('alert')) {
      alertCalled = true;
      return { ok: true, status: 200 };
    }
    hlCallCount++;
    return { ok: false, status: 500 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(alertCalled, 'alert webhook should be called on permanent failure');
  assert(hlCallCount === 2, `expected 2 HL attempts, got ${hlCallCount}`);
});

test('alert webhook receives submissionId and lead data', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertBody;
  global.fetch = async (url, opts) => {
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
  assert(alertBody.lead, 'alert should contain lead data for recovery');
  assert(alertBody.alert === 'HL_WEBHOOK_FAILURE', 'alert type should be set');
});

test('alert webhook failure does not change the 502 response', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  global.fetch = async (url, opts) => {
    return { ok: false, status: 500 }; // both HL and alert fail
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(res._status === 502, `expected 502, got ${res._status}`);
});

test('does NOT fire alert webhook on success', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  let alertCalled = false;
  global.fetch = async (url, opts) => {
    if (url.includes('alert')) { alertCalled = true; }
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(!alertCalled, 'alert webhook should NOT fire on successful delivery');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10: CONTACT FORM FIELDS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 10: Contact form field mapping');

test('contact form sourceKey maps to correct label', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({
    ...validBody,
    sourceKey:       'contact',
    numberOfWindows: '4-7',
    message:         'Test project notes.',
  }), res);
  restoreFetch();
  assert(capturedPayload.source === 'Contact Page - hometeamroof.com',
    `expected contact source label, got "${capturedPayload.source}"`);
  assert(capturedPayload.numberOfWindows === '4-7',
    `numberOfWindows not preserved: ${capturedPayload.numberOfWindows}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11: REPEAT CUSTOMER HANDLING
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 11: Repeat customer (multiple inquiries)');

test('second submission from same customer is forwarded without deduplication', async () => {
  let hlCallCount = 0;
  global.fetch = async () => { hlCallCount++; return { ok: true, status: 200 }; };
  const res1 = mockRes();
  const res2 = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res1);
  await handler(mockReq({ ...validBody, submissionId: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6', message: 'Second inquiry' }), res2);
  restoreFetch();
  assert(hlCallCount === 2, `expected 2 HL calls, got ${hlCallCount}`);
  assert(res1._status === 200, 'first submission should succeed');
  assert(res2._status === 200, 'second submission should succeed');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12: MISSING WEBHOOK URL CONFIG
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 12: Missing environment configuration');

test('returns 500 when HIGHLEVEL_INQUIRY_WEBHOOK_URL is not set', async () => {
  const saved = process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  delete process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  const res = mockRes();
  await handler(mockReq(validBody), res);
  process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL = saved;
  assert(res._status === 500, `expected 500, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13: API TIMEOUT
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 13: API timeout simulation');

test('returns 502 when HL call times out (AbortError both attempts)', async () => {
  // Simulates the AbortController 8-second timeout firing on both attempts.
  mockFetch([{ throw: 'AbortError: The operation was aborted' }, { throw: 'AbortError: The operation was aborted' }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 502, `expected 502 on timeout, got ${res._status}`);
  assert(/try again|call us/i.test(res._body.error), 'error message should instruct customer');
});

test('recovers if second attempt succeeds after timeout on first', async () => {
  // First attempt times out, retry succeeds — common when HL is briefly busy.
  mockFetch([{ throw: 'AbortError: The operation was aborted' }, { ok: true, status: 200 }]);
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after timeout+retry, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true after recovery');
});

test('submissionId included in 502 response when timeout is permanent', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://example.com/alert';
  mockFetch([{ throw: 'AbortError' }, { throw: 'AbortError' }]);
  const res = mockRes();
  await handler(mockReq({ ...validBody, submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' }), res);
  restoreFetch();
  delete process.env.ALERT_WEBHOOK_URL;
  assert(res._body.submissionId === 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
    'submissionId must be in 502 body so operator can reconcile with Vercel logs');
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER — execute all queued tests sequentially
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
