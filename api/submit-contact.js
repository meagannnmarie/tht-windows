// Vercel serverless function — Contact form handler with Cloudflare Turnstile.
// Handles POST /api/submit-contact only. The estimate form continues to use
// /api/submit-inquiry, which is not modified.
//
// DELIVERY SYNC CONTRACT
// attemptDelivery, sendAlert, SOURCE_MAP, validation rules, phone normalization,
// UUID handling, and HL payload shape below are intentional copies of the
// corresponding sections in api/submit-inquiry.js. If any of those sections
// change in submit-inquiry.js, apply the same change here and confirm both
// test suites still pass before merging.
//
// Intentional differences from submit-inquiry.js:
//   • Cloudflare Turnstile server-side verification (this file only)
//   • source is always 'Contact Page - hometeamroof.com' — body.sourceKey ignored
//   • CLOUDFLARE_TURNSTILE_SECRET_KEY env var is required (this file only)
//   • Log prefix is [THT-CONTACT] not [THT]

'use strict';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// SOURCE_MAP — identical to submit-inquiry.js.
const SOURCE_MAP = {
  'woodlands-roofing-tx': 'The Woodlands Roofing - hometeamroof.com',
  'homepage':             'Homepage - hometeamroof.com',
  'roofing':              'Roofing Page - hometeamroof.com',
  'windows':              'Windows Page - hometeamroof.com',
  'doors':                'Doors Page - hometeamroof.com',
  'estimate':             'Estimate Page - hometeamroof.com',
  'contact':              'Contact Page - hometeamroof.com',
  'financing':            'Financing Page - hometeamroof.com',
};

// Identical to submit-inquiry.js.
async function attemptDelivery(webhookUrl, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message };
  }
}

// Identical to submit-inquiry.js.
async function sendAlert(submissionId, payload, errorDetail) {
  const alertUrl = process.env.ALERT_WEBHOOK_URL;
  if (!alertUrl) return;
  try {
    await fetch(alertUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        alert:        'HL_WEBHOOK_FAILURE',
        submissionId,
        errorDetail,
        receivedAt:   new Date().toISOString(),
        lead:         payload,
      }),
    });
  } catch { /* intentionally swallowed */ }
}

// FAIL-OPEN POLICY
// If Cloudflare's siteverify API cannot be reached or returns an unexpected
// response, the token is treated as valid and the lead is delivered to GoHighLevel.
// Availability takes priority over spam filtering for this contact form.
//
// Fail-open applies to:
//   • Network errors and AbortController timeouts (5 s)        failReason: 'network-error'
//   • Cloudflare HTTP 5xx (temporary service outage)           failReason: 'cf-5xx:<status>'
//   • Cloudflare HTTP 4xx (auth/config error — see note below) failReason: 'cf-4xx:<status>'
//   • Unparseable JSON response body                           failReason: 'cf-parse-error'
//
// 4xx note: A 4xx response most likely indicates a misconfigured secret key.
// It is treated as fail-open (not fail-hard) so a misconfigured key does not
// silently discard leads. A separate CONFIG ALERT is logged at ERROR level to
// prompt immediate operator investigation.
//
// Definitive rejections — Cloudflare reachable, success:false with error codes,
// or absent/mismatched hostname — are NEVER fail-opened. These are hard failures.

const EXPECTED_HOSTNAME = 'hometeamroof.com';

// Returns the set of hostnames that are accepted in Turnstile verification responses.
// Defaults to production hostname only. For preview/test environments using Cloudflare
// test-mode secret keys, extend the allowlist via environment variable — test-mode
// keys always return 'example.com' as the hostname (per official Cloudflare docs).
//
// Production Vercel: leave CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST unset.
// Preview Vercel:    CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST='hometeamroof.com,example.com'
function getAllowedHostnames() {
  const raw = (process.env.CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST || '').trim();
  if (!raw) return new Set([EXPECTED_HOSTNAME]);
  return new Set(raw.split(',').map(h => h.trim()).filter(Boolean));
}

// Verify a Turnstile token server-side against Cloudflare's siteverify API.
//
// Return values:
//   { verified: true }                              — token is valid; proceed
//   { verified: true, failOpen: true, failReason }  — infrastructure failure;
//                                                     fail-open per policy above
//   { verified: false, reason }                     — definitive rejection
async function verifyTurnstile(token, secretKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret: secretKey, response: token }),
      signal:  controller.signal,
    });
    clearTimeout(timer);

    if (res.status >= 400 && res.status < 500) {
      // 4xx: auth/configuration error — likely wrong secret key; not a transient outage.
      // Fail open to preserve leads, but the caller emits a CONFIG ALERT log.
      return { verified: true, failOpen: true, failReason: `cf-4xx:${res.status}` };
    }
    if (!res.ok) {
      // 5xx: temporary Cloudflare service error.
      return { verified: true, failOpen: true, failReason: `cf-5xx:${res.status}` };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      // Unparseable response body — treat as temporary failure.
      return { verified: true, failOpen: true, failReason: 'cf-parse-error' };
    }

    if (!data.success) {
      return { verified: false, reason: (data['error-codes'] || []).join(',') || 'invalid' };
    }

    // Hostname check: Cloudflare always includes hostname for both real and test-mode
    // secret keys (test keys return 'example.com' per official documentation).
    // A missing hostname is unexpected and is treated as a hard failure, not a pass.
    // To allow preview testing with test-mode keys, add 'example.com' to the
    // CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST env var in the Vercel preview scope.
    if (!data.hostname) {
      return { verified: false, reason: 'hostname-absent' };
    }
    if (!getAllowedHostnames().has(data.hostname)) {
      return { verified: false, reason: 'hostname-mismatch' };
    }
    return { verified: true };
  } catch (err) {
    clearTimeout(timer);
    return { verified: true, failOpen: true, failReason: 'network-error' };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookUrl  = process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  const tsSecretKey = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;

  if (!webhookUrl) {
    console.error('[THT-CONTACT] HIGHLEVEL_INQUIRY_WEBHOOK_URL is not configured');
    return res
      .status(500)
      .json({ error: 'Server configuration error. Please call us at (832) 422-3039.' });
  }
  if (!tsSecretKey) {
    console.error('[THT-CONTACT] CLOUDFLARE_TURNSTILE_SECRET_KEY is not configured');
    return res
      .status(500)
      .json({ error: 'Server configuration error. Please call us at (832) 422-3039.' });
  }

  // Parse body — identical to submit-inquiry.js
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot — identical to submit-inquiry.js
  if (body._hp) {
    return res.status(200).json({ ok: true });
  }

  // Turnstile verification — reject if token is absent
  const cfToken = (body.cfToken || '').trim();
  if (!cfToken) {
    return res.status(400).json({ error: 'Please complete the security check and try again.' });
  }

  const tsResult = await verifyTurnstile(cfToken, tsSecretKey);
  if (!tsResult.verified) {
    return res
      .status(400)
      .json({ error: 'Security check failed. Please refresh the page and try again.' });
  }
  // CONFIG ALERT: a 4xx response from Cloudflare indicates a likely secret key
  // misconfiguration. The submission is still delivered (fail-open) but this
  // should be investigated before the next deploy.
  if (tsResult.failOpen && (tsResult.failReason || '').startsWith('cf-4xx')) {
    console.error(`[THT-CONTACT] CONFIG ALERT: Cloudflare siteverify returned ${tsResult.failReason} — verify CLOUDFLARE_TURNSTILE_SECRET_KEY is correct`);
  }

  // Source is always 'contact' — body.sourceKey is intentionally ignored.
  // Routing is determined by which URL path was called, not by a client-supplied
  // value that any caller could forge.
  const source = SOURCE_MAP['contact'];

  // Submission ID — identical to submit-inquiry.js
  const clientId = (body.submissionId || '').trim();
  const submissionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(clientId)
    ? clientId
    : crypto.randomUUID();

  // Field extraction — identical to submit-inquiry.js
  const firstName       = (body.firstName       || '').trim();
  const lastName        = (body.lastName        || '').trim();
  const email           = (body.email           || '').trim().toLowerCase();
  const rawPhone        = (body.phone           || '').trim();
  const city            = (body.city            || '').trim();
  const numberOfWindows = (body.numberOfWindows || '').trim();
  const message         = (body.message         || '').trim();
  const pageUrl         = (body.pageUrl         || '').trim();

  // Validation — identical rules to submit-inquiry.js
  const errors = [];
  if (!firstName && !lastName) {
    errors.push('Please provide your name.');
  }
  if (!email && !rawPhone) {
    errors.push('Please provide an email address or phone number.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Please enter a valid email address.');
  }
  const phoneDigits = rawPhone.replace(/\D/g, '');
  if (rawPhone && phoneDigits.length < 7) {
    errors.push('Please provide a valid phone number.');
  }
  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') });
  }

  // Phone normalization — identical to submit-inquiry.js
  let phone = rawPhone;
  if (phoneDigits.length === 10) {
    phone = `+1${phoneDigits}`;
  } else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
    phone = `+${phoneDigits}`;
  }

  // HL payload — identical shape to submit-inquiry.js.
  // cfToken is excluded: it must not be stored in the CRM.
  // Contact form has no address/serviceType/preferredContactMethod/projectTimeline
  // fields; empty strings maintain a consistent HL payload shape across endpoints.
  const payload = {
    submissionId,
    firstName,
    lastName,
    fullName:               [firstName, lastName].filter(Boolean).join(' '),
    email,
    phone,
    address:                '',
    city,
    zipCode:                '',
    serviceType:            '',
    preferredContactMethod: '',
    numberOfWindows,
    projectTimeline:        '',
    message,
    source,
    pageUrl,
    submittedAt:            new Date().toISOString(),
  };

  const tsStatus = tsResult.failOpen
    ? `fail-open(${tsResult.failReason || 'unknown'})`
    : 'pass';
  const logCtx = `[THT-CONTACT] id=${submissionId} turnstile=${tsStatus}`;

  // HL delivery + retry — identical logic to submit-inquiry.js
  let result = await attemptDelivery(webhookUrl, payload);
  if (!result.ok) {
    await new Promise(r => setTimeout(r, 1000));
    result = await attemptDelivery(webhookUrl, payload);
  }

  if (result.ok) {
    console.log(`${logCtx} status=delivered`);
    return res.status(200).json({ ok: true, submissionId });
  }

  // Permanent failure — identical response behavior to submit-inquiry.js
  const errorDetail = result.error || `HL HTTP ${result.status}`;
  console.error(`${logCtx} status=FAILED detail=${errorDetail}`);
  await sendAlert(submissionId, payload, errorDetail);

  return res.status(502).json({
    error:        'Unable to submit your request. Please try again or call us at (832) 422-3039.',
    submissionId,
  });
};
