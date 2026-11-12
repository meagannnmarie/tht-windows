#!/usr/bin/env node
'use strict';
// ── Home Team Roofing — Estimate Form Spam Protection Tests ──────────────────
// Verifies that Cloudflare Turnstile is correctly enforced on api/submit-inquiry.js
// (the "Start Your Project" estimate form handler) and that existing delivery
// behavior is fully preserved after the security gate.
//
// Groups 21-24 continue the numbering from turnstile-build-isolation.test.js
// (Groups 18-20) so the full test suite has non-overlapping group identifiers.
//
// No real network calls are made; global fetch is replaced per test.
// No real customer PII is used anywhere in this file.

const handler = require('../../api/submit-inquiry');

// ── Test infrastructure ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
const _queue   = [];

function test(name, fn) { _queue.push({ name, fn }); }
function group(name)    { _queue.push({ header: name }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function mockReq(body, method = 'POST') { return { method, body }; }
function mockRes() {
  const r = { _status: null, _body: null };
  r.status = function(s) { r._status = s; return r; };
  r.json   = function(b) { r._body   = b; return r; };
  return r;
}

// ── URL constants ─────────────────────────────────────────────────────────────

const TEST_WEBHOOK    = 'https://example.com/test-webhook';
const TURNSTILE_URL   = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ── Default env setup ─────────────────────────────────────────────────────────

process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL   = TEST_WEBHOOK;
process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'test-secret-key';

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

// Mock that succeeds Turnstile and allows routing HL responses individually.
function mockOk(hlResponses = [{ ok: true, status: 200 }]) {
  let hlCall = 0;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    const resp = hlResponses[hlCall] || hlResponses[hlResponses.length - 1];
    hlCall++;
    if (resp.throw) throw new Error(resp.throw);
    return { ok: resp.ok, status: resp.status || (resp.ok ? 200 : 500) };
  };
}

// ── Valid baseline payload (estimate form) ────────────────────────────────────

const validBody = {
  submissionId:          'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  firstName:             'Test',
  lastName:              'Customer',
  email:                 'test@example.com',
  phone:                 '7135550100',
  address:               '123 Main St',
  city:                  'Houston',
  zipCode:               '77001',
  serviceType:           'Roofing',
  preferredContactMethod: 'Call',
  message:               'Test estimate — safe to delete.',
  sourceKey:             'estimate',
  pageUrl:               'https://hometeamroof.com/estimate?source=api-test',
  cfToken:               'valid-test-token',
};

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 21: SECURITY GATE — TOKEN REQUIRED
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 21: Security gate — Turnstile token required');

test('returns 400 when cfToken is absent from body', async () => {
  const body = { ...validBody };
  delete body.cfToken;
  const res = mockRes();
  await handler(mockReq(body), res);
  assert(res._status === 400, `expected 400 on absent token, got ${res._status}`);
  assert(/security check/i.test(res._body.error),
    'error should mention security check');
});

test('returns 400 when cfToken is an empty string', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, cfToken: '' }), res);
  assert(res._status === 400, `expected 400 on empty token, got ${res._status}`);
});

test('returns 400 when cfToken is whitespace only', async () => {
  const res = mockRes();
  await handler(mockReq({ ...validBody, cfToken: '   ' }), res);
  assert(res._status === 400, `expected 400 on whitespace token, got ${res._status}`);
});

test('returns 400 when Turnstile reports success:false (invalid token)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on invalid token, got ${res._status}`);
  assert(/security check failed/i.test(res._body.error),
    'error should mention security check failed');
});

test('returns 400 when Turnstile reports success:false (timeout-or-duplicate)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on duplicate token, got ${res._status}`);
});

test('returns 400 when Turnstile hostname is absent (success:true, no hostname)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400,
    `expected 400 when hostname absent, got ${res._status}`);
});

test('returns 400 when Turnstile hostname mismatches (not hometeamroof.com)', async () => {
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'example.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400,
    `expected 400 for example.com hostname in production, got ${res._status}`);
});

test('returns 500 when CLOUDFLARE_TURNSTILE_SECRET_KEY is not set', async () => {
  const saved = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  delete process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  const res = mockRes();
  await handler(mockReq(validBody), res);
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = saved;
  assert(res._status === 500, `expected 500 on missing secret key, got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 22: FAIL-OPEN — INFRASTRUCTURE FAILURES PRESERVE LEAD DELIVERY
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 22: Fail-open — infrastructure failures preserve lead delivery');

test('delivers lead when Cloudflare siteverify is unreachable (network error)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) throw new Error('network-error');
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `network error must fail-open (200), got ${res._status}`);
});

test('delivers lead when Cloudflare siteverify times out (AbortError)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) {
      const err = new Error('AbortError: The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `timeout must fail-open (200), got ${res._status}`);
});

test('delivers lead when Cloudflare returns HTTP 503', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) return { ok: false, status: 503 };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `Cloudflare 503 must fail-open (200), got ${res._status}`);
});

test('delivers lead when Cloudflare returns HTTP 429', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) return { ok: false, status: 429 };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `Cloudflare 429 must fail-open (200), got ${res._status}`);
});

test('delivers lead when Cloudflare returns HTTP 401 (config error — fail open)', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) return { ok: false, status: 401 };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `Cloudflare 401 must fail-open (200), got ${res._status}`);
});

test('delivers lead when Cloudflare returns unparseable JSON', async () => {
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `unparseable JSON must fail-open (200), got ${res._status}`);
});

test('honeypot hit returns 200 without calling Turnstile or HL', async () => {
  let turnstileCalled = false;
  let hlCalled = false;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) { turnstileCalled = true; return { ok: true, json: async () => ({}) }; }
    hlCalled = true;
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, _hp: 'bot-fill' }), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 for honeypot hit, got ${res._status}`);
  assert(!turnstileCalled, 'Turnstile must NOT be called when honeypot is filled');
  assert(!hlCalled, 'HL must NOT be called when honeypot is filled');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 23: HOSTNAME ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 23: Hostname isolation');

test('production: example.com token rejected when allowlist is unset', async () => {
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'example.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400,
    `production must reject example.com tokens; got ${res._status}`);
});

test('production: hometeamroof.com token accepted when allowlist is unset', async () => {
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `production must accept hometeamroof.com tokens; got ${res._status}`);
});

test('preview: example.com token accepted when allowlist includes example.com', async () => {
  process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST = 'hometeamroof.com,example.com';
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'example.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  assert(res._status === 200,
    `preview must accept example.com tokens with allowlist; got ${res._status}`);
});

test('third-party hostname rejected regardless of allowlist', async () => {
  process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST = 'hometeamroof.com,example.com';
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'evil.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  assert(res._status === 400,
    `evil.com must be rejected even with allowlist set; got ${res._status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 24: DELIVERY AFTER SECURITY PASS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 24: Delivery after security pass — integration');

test('valid token + valid fields → 200 delivered to HL', async () => {
  mockOk();
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200, got ${res._status}`);
  assert(res._body.ok === true, 'body.ok should be true');
});

test('cfToken is NOT forwarded in HL payload', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(!('cfToken' in capturedPayload),
    'cfToken must NOT appear in HL payload — it must not be stored in the CRM');
});

test('all required HL fields present after security pass', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  const required = ['submissionId', 'firstName', 'lastName', 'fullName', 'email',
    'phone', 'serviceType', 'source', 'pageUrl', 'submittedAt'];
  required.forEach(f => {
    assert(f in capturedPayload, `missing field "${f}" in HL payload`);
  });
});

test('source label is resolved from sourceKey (not from cfToken)', async () => {
  let capturedPayload;
  global.fetch = async (url, opts) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    capturedPayload = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq({ ...validBody, sourceKey: 'roofing' }), res);
  restoreFetch();
  assert(capturedPayload.source === 'Roofing Page - hometeamroof.com',
    `expected roofing label, got "${capturedPayload.source}"`);
});

test('succeeds on retry after first HL 500, with valid Turnstile', async () => {
  let hlCall = 0;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    hlCall++;
    return { ok: hlCall > 1, status: hlCall > 1 ? 200 : 500 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200, `expected 200 after retry, got ${res._status}`);
  assert(hlCall === 2, `expected 2 HL attempts, got ${hlCall}`);
});

test('fail-open delivery still delivers lead and returns 200', async () => {
  // Turnstile fails (network error) → fail-open → HL delivery proceeds
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL) throw new Error('network-error');
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 200,
    `fail-open must still deliver lead (200), got ${res._status}`);
  assert(res._body.ok === true, 'body.ok must be true on fail-open delivery');
});

test('cfToken absent → 400 before any HL call', async () => {
  let hlCalled = false;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    hlCalled = true;
    return { ok: true, status: 200 };
  };
  const body = { ...validBody };
  delete body.cfToken;
  const res = mockRes();
  await handler(mockReq(body), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on absent token, got ${res._status}`);
  assert(!hlCalled, 'HL must NOT be called when cfToken is absent');
});

test('Turnstile rejection → 400 before any HL call', async () => {
  let hlCalled = false;
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) };
    hlCalled = true;
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  assert(res._status === 400, `expected 400 on rejected token, got ${res._status}`);
  assert(!hlCalled, 'HL must NOT be called when Turnstile rejects');
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
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
