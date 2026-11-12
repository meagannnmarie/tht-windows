// Backward-compatibility shim — both the Contact form and the Start Your
// Project form now route through /api/submit-inquiry. This file keeps the
// /api/submit-contact path alive (no 404 for any cached or external references)
// while eliminating duplicate delivery code.
//
// All Turnstile verification, field validation, GoHighLevel delivery, retry
// logic, alert webhook, and submission ID handling live in submit-inquiry.js.
// Source attribution is determined by body.sourceKey; the contact form sends
// sourceKey: 'contact' which maps to 'Contact Page - hometeamroof.com'.
//
// No unprotected bypass: every request to /api/submit-contact passes through
// the same Cloudflare Turnstile gate as /api/submit-inquiry.

'use strict';

module.exports = require('./submit-inquiry');
