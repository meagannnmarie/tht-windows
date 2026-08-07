// Vercel serverless function — GET /api/google-business/auth
//
// Initiates the Google OAuth 2.0 authorization code flow for the
// Google Business Profile API. Redirects the browser to Google's
// consent screen. After the user approves, Google redirects to
// /api/google-business/callback with an authorization code.
//
// Required Vercel environment variables:
//   GOOGLE_BUSINESS_CLIENT_ID      — OAuth 2.0 client ID
//   GOOGLE_BUSINESS_CLIENT_SECRET  — OAuth 2.0 client secret (used here
//                                    only to sign the CSRF state token)
//   GOOGLE_BUSINESS_REDIRECT_URI   — must match the URI registered in
//                                    Google Cloud Console exactly
//                                    e.g. https://your-preview.vercel.app/api/google-business/callback
//
// USAGE:
//   Navigate to /api/google-business/auth in a browser while logged into
//   the Google account that owns the Business Profile. Approve the consent
//   screen, then check the callback page for your refresh token.
//
// This endpoint is for one-time developer/admin use to obtain a refresh
// token. It is NOT part of the public-facing website.

const crypto = require('crypto');

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const BUSINESS_SCOPE   = 'https://www.googleapis.com/auth/business.manage';
const STATE_TTL_SECONDS = 600; // state token valid for 10 minutes

// Signs a state payload with HMAC-SHA256 so the callback can verify it
// without a shared session store (stateless CSRF protection).
function makeState(clientSecret) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const mac = crypto
    .createHmac('sha256', clientSecret)
    .update(ts)
    .digest('hex');
  return Buffer.from(`${ts}:${mac}`).toString('base64url');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId      = process.env.GOOGLE_BUSINESS_CLIENT_ID;
  const clientSecret  = process.env.GOOGLE_BUSINESS_CLIENT_SECRET;
  const redirectUri   = process.env.GOOGLE_BUSINESS_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[google-business/auth] Missing required environment variables');
    return res.status(503).json({
      error: 'OAuth not configured.',
      missing: [
        !clientId     && 'GOOGLE_BUSINESS_CLIENT_ID',
        !clientSecret && 'GOOGLE_BUSINESS_CLIENT_SECRET',
        !redirectUri  && 'GOOGLE_BUSINESS_REDIRECT_URI',
      ].filter(Boolean),
    });
  }

  const state = makeState(clientSecret);

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         BUSINESS_SCOPE,
    access_type:   'offline',   // request a refresh token
    prompt:        'consent',   // always show consent so refresh token is returned
    state,
  });

  return res.redirect(302, `${GOOGLE_AUTH_URL}?${params.toString()}`);
};
