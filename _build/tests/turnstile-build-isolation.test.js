#!/usr/bin/env node
'use strict';
// ── Home Team Roofing — Turnstile Preview / Production Isolation Tests ─────────
// Verifies that build-time key selection and server-side hostname validation
// are correctly isolated between Production and Preview/local environments.
//
// Does NOT run the full build. Tests the config module and server handler directly.

const fs      = require('fs');
const path    = require('path');
const handler = require('../../api/submit-contact');
const {
  getSiteKey,
  assertProductionSafe,
  PRODUCTION_SITE_KEY,
  TEST_SITE_KEY,
} = require('../lib/turnstile-config');

// ── Test infrastructure ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
const _queue   = [];

function test(name, fn) { _queue.push({ name, fn }); }
function group(name)    { _queue.push({ header: name }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 18: BUILD-TIME KEY SELECTION — ENVIRONMENT ISOLATION
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 18: Build-time key selection — environment isolation');

test('VERCEL_ENV=production → production site key', () => {
  assert(getSiteKey('production') === PRODUCTION_SITE_KEY,
    'production env must resolve to the real production site key');
});

test('VERCEL_ENV=preview → test site key', () => {
  assert(getSiteKey('preview') === TEST_SITE_KEY,
    'preview env must resolve to the Cloudflare test key');
});

test('VERCEL_ENV=development → test site key', () => {
  assert(getSiteKey('development') === TEST_SITE_KEY,
    'development env must resolve to the Cloudflare test key');
});

test('VERCEL_ENV=undefined (plain node) → test site key', () => {
  assert(getSiteKey(undefined) === TEST_SITE_KEY,
    'local/unset env must resolve to the Cloudflare test key');
});

test('production key and test key are distinct values', () => {
  assert(PRODUCTION_SITE_KEY !== TEST_SITE_KEY,
    'production and test keys must be different — a match would indicate a copy-paste error');
});

test('production key is not a Cloudflare test-mode key (prefix check)', () => {
  // All official Cloudflare test-mode site keys begin with 1x, 2x, or 3x.
  const testPrefixes = ['1x', '2x', '3x'];
  const isTestKey = testPrefixes.some(p => PRODUCTION_SITE_KEY.startsWith(p));
  assert(!isTestKey,
    `production key starts with a test-mode prefix — it is not a real site key`);
});

test('test site key is an official Cloudflare test-mode key (prefix check)', () => {
  assert(TEST_SITE_KEY.startsWith('1x') || TEST_SITE_KEY.startsWith('2x') || TEST_SITE_KEY.startsWith('3x'),
    'test key must be an official Cloudflare test-mode key (1x/2x/3x prefix)');
});

test('assertProductionSafe does not throw for matched production env', () => {
  let threw = false;
  try { assertProductionSafe('production', PRODUCTION_SITE_KEY); }
  catch { threw = true; }
  assert(!threw, 'assertProductionSafe must not throw when production key is used in production');
});

test('assertProductionSafe does not throw for matched preview env', () => {
  let threw = false;
  try { assertProductionSafe('preview', TEST_SITE_KEY); }
  catch { threw = true; }
  assert(!threw, 'assertProductionSafe must not throw when test key is used in preview');
});

test('assertProductionSafe throws if test key would reach production', () => {
  let threw = false;
  try { assertProductionSafe('production', TEST_SITE_KEY); }
  catch { threw = true; }
  assert(threw, 'build must FAIL if production env receives a test-mode site key');
});

test('assertProductionSafe throws if production key is used outside production', () => {
  let threw = false;
  try { assertProductionSafe('preview', PRODUCTION_SITE_KEY); }
  catch { threw = true; }
  assert(threw, 'build must FAIL if production key is used in a preview build');
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 19: SOURCE FILE INTEGRITY — TOKEN PRESENT, HARDCODED KEYS ABSENT
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 19: Source file integrity — token present, hardcoded keys absent');

const contactHtmlPath = path.resolve(__dirname, '../../contact.html');
let contactHtml = '';
try { contactHtml = fs.readFileSync(contactHtmlPath, 'utf8'); }
catch { /* handled per-test */ }

test('contact.html contains the {{TURNSTILE_SITE_KEY}} build token', () => {
  assert(contactHtml.includes('data-sitekey="{{TURNSTILE_SITE_KEY}}"'),
    'contact.html must use {{TURNSTILE_SITE_KEY}} token — not a hardcoded key');
});

test('contact.html does NOT contain the hardcoded production site key', () => {
  assert(!contactHtml.includes(PRODUCTION_SITE_KEY),
    `contact.html must not contain the hardcoded production site key — ` +
    `it must come from the build token to prevent accidental test-environment use`);
});

test('contact.html does NOT contain any hardcoded Cloudflare test-mode site key', () => {
  // All official CF test keys hardcoded in HTML would bypass the build-time guard.
  const knownTestSiteKeys = [
    '1x00000000000000000000AA', // always passes, visible
    '2x00000000000000000000AB', // always fails, visible
    '1x00000000000000000000BB', // always passes, invisible
    '3x00000000000000000000FF', // forces interaction
  ];
  for (const key of knownTestSiteKeys) {
    assert(!contactHtml.includes(key),
      `contact.html must not contain hardcoded test key ${key} — use {{TURNSTILE_SITE_KEY}} token`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 20: SERVER-SIDE HOSTNAME ISOLATION — PRODUCTION CANNOT ACCEPT TEST TOKENS
// ─────────────────────────────────────────────────────────────────────────────
group('GROUP 20: Server-side hostname isolation — production cannot accept test tokens');

const TEST_WEBHOOK  = 'https://example.com/test-webhook';
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

function mockReq(body, method = 'POST') { return { method, body }; }
function mockRes() {
  const r = { _status: null, _body: null };
  r.status = function(s) { r._status = s; return r; };
  r.json   = function(b) { r._body   = b; return r; };
  return r;
}

process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL   = TEST_WEBHOOK;
process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY = 'test-secret-key';

const validBody = {
  submissionId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
  firstName: 'Test', lastName: 'Customer',
  email: 'test@example.com', phone: '7135550100',
  cfToken: 'valid-test-token',
};

test('production: example.com token rejected when allowlist is unset', async () => {
  // Simulates production: no CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST set.
  // A test-mode secret key returns example.com; production must reject it.
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
  assert(/security check failed/i.test(res._body.error),
    'error message must reference security check failure');
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

test('preview: hometeamroof.com token still accepted when allowlist is set', async () => {
  process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST = 'hometeamroof.com,example.com';
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'hometeamroof.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  assert(res._status === 200,
    `preview must still accept hometeamroof.com tokens; got ${res._status}`);
});

test('neither env: third-party hostname always rejected regardless of allowlist', async () => {
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
    `evil.com must be rejected even when allowlist is set; got ${res._status}`);
});

test('production allowlist env var set by mistake: example.com still rejected if not in allowlist', async () => {
  // If an operator accidentally sets the allowlist in Production but only to 'hometeamroof.com',
  // example.com tokens (from test-mode keys) are still rejected.
  process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST = 'hometeamroof.com';
  global.fetch = async (url) => {
    if (url === TURNSTILE_URL)
      return { ok: true, json: async () => ({ success: true, hostname: 'example.com' }) };
    return { ok: true, status: 200 };
  };
  const res = mockRes();
  await handler(mockReq(validBody), res);
  restoreFetch();
  delete process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST;
  assert(res._status === 400,
    `example.com must be rejected when allowlist is 'hometeamroof.com' only; got ${res._status}`);
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
