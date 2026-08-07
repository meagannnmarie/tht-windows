// Vercel serverless function — GET /api/google-business/callback
//
// Handles the OAuth 2.0 redirect from Google after the user approves
// the consent screen. Exchanges the authorization code for access and
// refresh tokens, then displays the refresh token to the developer.
//
// Required Vercel environment variables (same as /api/google-business/auth):
//   GOOGLE_BUSINESS_CLIENT_ID
//   GOOGLE_BUSINESS_CLIENT_SECRET
//   GOOGLE_BUSINESS_REDIRECT_URI
//
// After completing the flow, copy the refresh token from this page and
// store it as a Vercel environment variable (e.g. GOOGLE_BUSINESS_REFRESH_TOKEN)
// for use by other serverless functions. Do NOT store it in source code.

const crypto = require('crypto');

const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const STATE_TTL_SECONDS = 600;

// Verifies the HMAC-signed state created by /api/google-business/auth.
function verifyState(state, clientSecret) {
  let ts, mac;
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    [ts, mac] = decoded.split(':');
  } catch {
    return false;
  }

  const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
  if (!ts || !mac || isNaN(age) || age < 0 || age > STATE_TTL_SECONDS) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(ts)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

// Minimal HTML page shown to the developer after a successful token exchange.
function successPage(refreshToken, accessToken, expiresIn) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAuth Complete — Home Team</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#111}
  h1{font-size:22px;margin-bottom:8px}
  .ok{color:#16a34a;font-weight:700}
  .card{background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:20px 24px;margin:20px 0}
  label{display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
  code{display:block;word-break:break-all;font-size:13px;background:#fff;border:1px solid #dee2e6;border-radius:4px;padding:12px;user-select:all}
  .warn{font-size:13px;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;margin-top:16px}
  .step{font-size:14px;line-height:1.7;margin-top:20px}
</style>
</head>
<body>
<h1><span class="ok">&#10003;</span> Authorization Complete</h1>
<p>Google has granted access to the Business Profile. Save the refresh token below as a Vercel environment variable — it does not expire unless access is revoked.</p>

<div class="card">
  <label>Refresh Token — save as GOOGLE_BUSINESS_REFRESH_TOKEN</label>
  <code id="rt">${refreshToken}</code>
</div>

<div class="card">
  <label>Access Token (short-lived, expires in ${expiresIn}s)</label>
  <code>${accessToken}</code>
</div>

<div class="warn">
  <strong>Never commit these tokens to source control.</strong>
  Store the refresh token in Vercel &rarr; Settings &rarr; Environment Variables only.
</div>

<div class="step">
  <strong>Next steps:</strong><br>
  1. Copy the Refresh Token above.<br>
  2. Go to Vercel &rarr; your project &rarr; Settings &rarr; Environment Variables.<br>
  3. Add <code style="display:inline;padding:2px 6px">GOOGLE_BUSINESS_REFRESH_TOKEN</code> with the copied value.<br>
  4. Redeploy for the variable to take effect.
</div>
</body>
</html>`;
}

function errorPage(title, detail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OAuth Error — Home Team</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#111}.err{color:#dc2626}</style>
</head>
<body>
<h1><span class="err">&#10007;</span> ${title}</h1>
<p>${detail}</p>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientId      = process.env.GOOGLE_BUSINESS_CLIENT_ID;
  const clientSecret  = process.env.GOOGLE_BUSINESS_CLIENT_SECRET;
  const redirectUri   = process.env.GOOGLE_BUSINESS_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[google-business/callback] Missing required environment variables');
    return res.status(503).send(errorPage(
      'OAuth not configured',
      'One or more required environment variables are missing. Check Vercel project settings.'
    ));
  }

  const { code, state, error: oauthError, error_description } = req.query;

  // Google returned an error instead of a code.
  if (oauthError) {
    console.error('[google-business/callback] Google returned error:', oauthError, error_description);
    return res.status(400).send(errorPage(
      'Google denied authorization',
      `Error: <strong>${oauthError}</strong>${error_description ? ' — ' + error_description : ''}`
    ));
  }

  if (!code || !state) {
    return res.status(400).send(errorPage(
      'Invalid callback',
      'Missing authorization code or state parameter.'
    ));
  }

  // CSRF check — verify the state was issued by /api/google-business/auth.
  if (!verifyState(state, clientSecret)) {
    console.error('[google-business/callback] State verification failed');
    return res.status(400).send(errorPage(
      'Invalid state parameter',
      'The state token is missing, expired (10-minute window), or was tampered with. Start the flow again from /api/google-business/auth.'
    ));
  }

  // Exchange the authorization code for tokens.
  let tokenRes;
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
  } catch (networkErr) {
    console.error('[google-business/callback] Network error reaching Google token endpoint:', networkErr.message);
    return res.status(502).send(errorPage(
      'Network error',
      'Could not reach Google token endpoint. Try again.'
    ));
  }

  let tokens;
  try {
    tokens = await tokenRes.json();
  } catch {
    return res.status(502).send(errorPage(
      'Unexpected response',
      'Google returned a non-JSON response from the token endpoint.'
    ));
  }

  if (!tokenRes.ok || tokens.error) {
    console.error('[google-business/callback] Token exchange failed:', tokens);
    return res.status(502).send(errorPage(
      'Token exchange failed',
      `Google returned: <strong>${tokens.error || tokenRes.status}</strong>${tokens.error_description ? ' — ' + tokens.error_description : ''}`
    ));
  }

  if (!tokens.refresh_token) {
    // This happens when the account already granted access and prompt=consent
    // was not honoured, or the token was previously issued.
    console.warn('[google-business/callback] No refresh_token in response. The account may already have an active grant. Re-run /api/google-business/auth to force a new consent screen.');
  }

  // Log server-side only (tokens never reach a third party).
  console.log('[google-business/callback] Token exchange successful. refresh_token present:', !!tokens.refresh_token);

  // No-cache so the token page is never stored in browser or CDN cache.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(
    successPage(
      tokens.refresh_token || '(not returned — re-run /api/google-business/auth)',
      tokens.access_token  || '(missing)',
      tokens.expires_in    || '?',
    )
  );
};
