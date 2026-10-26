// Vercel serverless function — server-side only, never exposed to the browser.
// Reads HIGHLEVEL_INQUIRY_WEBHOOK_URL from environment; forwards a validated,
// idempotency-keyed JSON payload to HighLevel with one automatic retry and an
// optional alert webhook on permanent failure.
//
// ALERT_WEBHOOK_URL (optional env var): receives the full lead payload on HL
// delivery failure so no inquiry is permanently lost. Configure to a Zapier /
// Make.com / Slack incoming webhook that notifies the team by email or SMS.
//
// Logs contain only submissionId + outcome — no customer PII in log output.

'use strict';

// Maps sanitized source keys (sent from the browser) to human-readable labels
// stored in HighLevel. Add an entry here whenever a new landing page is created.
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

// Single attempt to POST payload to HL with an 8-second hard timeout.
// Returns { ok, status } on HTTP response; { ok: false, error } on network failure.
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

// POST a recovery alert to ALERT_WEBHOOK_URL on permanent HL failure.
// Contains the full submission payload so the operator can create the HL
// contact manually. A failure here must not mask the original HL error.
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookUrl = process.env.HIGHLEVEL_INQUIRY_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[THT] HIGHLEVEL_INQUIRY_WEBHOOK_URL is not configured');
    return res
      .status(500)
      .json({ error: 'Server configuration error. Please call us at (832) 422-3039.' });
  }

  // Parse body — Vercel auto-parses JSON but guard against edge cases
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // ── Honeypot — silently accept bots without forwarding ──────────────────────
  if (body._hp) {
    return res.status(200).json({ ok: true });
  }

  // ── Submission ID — accept valid client UUID or generate server-side ─────────
  // Used for reconciliation (Vercel logs ↔ HL contact) and future idempotency.
  // Note: the server does not currently deduplicate on this ID; a second POST
  // with the same submissionId will be forwarded to HL. True idempotency would
  // require persistent storage (e.g. Vercel KV) and is a future enhancement.
  const clientId = (body.submissionId || '').trim();
  const submissionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(clientId)
    ? clientId
    : crypto.randomUUID();

  // ── Extract & trim ───────────────────────────────────────────────────────────
  const firstName              = (body.firstName              || '').trim();
  const lastName               = (body.lastName               || '').trim();
  const email                  = (body.email                  || '').trim().toLowerCase();
  const rawPhone               = (body.phone                  || '').trim();
  const address                = (body.address                || '').trim();
  const city                   = (body.city                   || '').trim();
  const zipCode                = (body.zipCode                || '').trim();
  const serviceType            = (body.serviceType            || '').trim();
  const preferredContactMethod = (body.preferredContactMethod || '').trim();
  const numberOfWindows        = (body.numberOfWindows        || '').trim();
  const projectTimeline        = (body.projectTimeline        || '').trim();
  const message                = (body.message                || '').trim();
  const pageUrl                = (body.pageUrl                || '').trim();

  // ── Resolve source label ─────────────────────────────────────────────────────
  const rawSourceKey = (body.sourceKey || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const source = SOURCE_MAP[rawSourceKey] || 'Home Team - hometeamroof.com';

  // ── Validation ───────────────────────────────────────────────────────────────
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

  // ── Normalize phone ──────────────────────────────────────────────────────────
  let phone = rawPhone;
  if (phoneDigits.length === 10) {
    phone = `+1${phoneDigits}`;
  } else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
    phone = `+${phoneDigits}`;
  }

  // ── Build HighLevel payload ──────────────────────────────────────────────────
  const payload = {
    submissionId,
    firstName,
    lastName,
    fullName:              [firstName, lastName].filter(Boolean).join(' '),
    email,
    phone,
    address,
    city,
    zipCode,
    serviceType,
    preferredContactMethod,
    numberOfWindows,
    projectTimeline,
    message,
    source,
    pageUrl,
    submittedAt:           new Date().toISOString(),
  };

  // Log context — submissionId + metadata only, no PII
  const logCtx = `[THT] id=${submissionId} src=${rawSourceKey || 'direct'} svc=${serviceType || 'unset'}`;

  // ── Attempt 1 ────────────────────────────────────────────────────────────────
  let result = await attemptDelivery(webhookUrl, payload);

  // ── Retry once after 1 s on any failure ─────────────────────────────────────
  if (!result.ok) {
    await new Promise(r => setTimeout(r, 1000));
    result = await attemptDelivery(webhookUrl, payload);
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (result.ok) {
    console.log(`${logCtx} status=delivered`);
    return res.status(200).json({ ok: true, submissionId });
  }

  // ── Permanent failure — alert and surface error to browser ───────────────────
  const errorDetail = result.error || `HL HTTP ${result.status}`;
  console.error(`${logCtx} status=FAILED detail=${errorDetail}`);
  await sendAlert(submissionId, payload, errorDetail);

  return res.status(502).json({
    error:        'Unable to submit your request. Please try again or call us at (832) 422-3039.',
    submissionId,
  });
};
