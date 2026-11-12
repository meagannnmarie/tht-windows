// Shared Cloudflare Turnstile server-side verification module.
// Used by both /api/submit-contact and /api/submit-inquiry.
//
// FAIL-OPEN POLICY
// If Cloudflare's siteverify API cannot be reached or returns an unexpected
// response, the token is treated as valid and the lead is delivered to GoHighLevel.
// Availability takes priority over spam filtering for all contact forms.
//
// Fail-open applies to:
//   • Network errors and AbortController timeouts (5 s)        failReason: 'network-error'
//   • Cloudflare HTTP 5xx (temporary service outage)           failReason: 'cf-5xx:<status>'
//   • Cloudflare HTTP 4xx (auth/config error — see note below) failReason: 'cf-4xx:<status>'
//   • Unparseable JSON response body                           failReason: 'cf-parse-error'
//
// 4xx note: A 4xx response most likely indicates a misconfigured secret key.
// It is treated as fail-open (not fail-hard) so a misconfigured key does not
// silently discard leads. Callers must emit a CONFIG ALERT log at ERROR level.
//
// Definitive rejections — Cloudflare reachable, success:false with error codes,
// or absent/mismatched hostname — are NEVER fail-opened. These are hard failures.

'use strict';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EXPECTED_HOSTNAME    = 'hometeamroof.com';

// Returns the set of hostnames accepted in Turnstile verification responses.
// Defaults to production hostname only. For preview/test environments using
// Cloudflare test-mode secret keys, extend the allowlist via environment
// variable — test-mode keys always return 'example.com' as the hostname.
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
      return { verified: true, failOpen: true, failReason: `cf-4xx:${res.status}` };
    }
    if (!res.ok) {
      return { verified: true, failOpen: true, failReason: `cf-5xx:${res.status}` };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { verified: true, failOpen: true, failReason: 'cf-parse-error' };
    }

    if (!data.success) {
      return { verified: false, reason: (data['error-codes'] || []).join(',') || 'invalid' };
    }

    // Hostname check: Cloudflare always includes hostname for both real and test-mode
    // secret keys (test keys return 'example.com' per official documentation).
    // A missing hostname is unexpected and is treated as a hard failure, not a pass.
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

module.exports = { verifyTurnstile, getAllowedHostnames, EXPECTED_HOSTNAME, TURNSTILE_VERIFY_URL };
