// Vercel serverless function — server-side only, never exposed to the browser.
// Reads HIGHLEVEL_INQUIRY_WEBHOOK_URL from environment; forwards a flat JSON
// payload to HighLevel on each valid form submission.

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

  // ── Extract & trim ───────────────────────────────────────────────────────────
  const firstName       = (body.firstName       || '').trim();
  const lastName        = (body.lastName        || '').trim();
  const email           = (body.email           || '').trim().toLowerCase();
  const rawPhone        = (body.phone           || '').trim();
  const city            = (body.city            || '').trim();
  const zipCode         = (body.zipCode         || '').trim();
  const serviceType     = (body.serviceType     || '').trim();
  const numberOfWindows = (body.numberOfWindows || '').trim();
  const projectTimeline = (body.projectTimeline || '').trim();
  const message         = (body.message         || '').trim();
  const pageUrl         = (body.pageUrl         || '').trim();

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

  if (errors.length) {
    return res.status(400).json({ error: errors.join(' ') });
  }

  // ── Normalize phone ──────────────────────────────────────────────────────────
  const digits = rawPhone.replace(/\D/g, '');
  let phone = rawPhone;
  if (digits.length === 10) {
    phone = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    phone = `+${digits}`;
  }

  // ── Build flat HighLevel payload ─────────────────────────────────────────────
  const payload = {
    firstName,
    lastName,
    fullName:        [firstName, lastName].filter(Boolean).join(' '),
    email,
    phone,
    city,
    zipCode,
    serviceType,
    numberOfWindows,
    projectTimeline,
    message,
    source:          'Home Team Windows Website',
    pageUrl,
    submittedAt:     new Date().toISOString(),
  };

  // ── Forward to HighLevel ─────────────────────────────────────────────────────
  try {
    const hlRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!hlRes.ok) {
      console.error('[THT] HighLevel returned HTTP', hlRes.status);
      return res.status(502).json({
        error: 'Unable to process your request right now. Please try again or call us at (832) 422-3039.',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[THT] Webhook fetch failed:', err.message);
    return res.status(502).json({
      error: 'Unable to submit your request. Please try again or call us at (832) 422-3039.',
    });
  }
};
