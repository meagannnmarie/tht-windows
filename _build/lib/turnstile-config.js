'use strict';

// Turnstile site key constants.
// Site keys are public and safe to hardcode — they appear in every HTML response.
// Secret keys are NEVER here; they live in Vercel environment variables only.

const PRODUCTION_SITE_KEY = '0x4AAAAAAF6YmOhhO4SGh-KK';

// Official Cloudflare always-passes visible test key (from developers.cloudflare.com/turnstile).
// Server-side: test-mode secret keys always return hostname:'example.com' in siteverify responses.
// Preview environments must therefore set CLOUDFLARE_TURNSTILE_HOSTNAME_ALLOWLIST to
// 'hometeamroof.com,example.com' so the server accepts test-mode tokens.
const TEST_SITE_KEY = '1x00000000000000000000AA';

// Returns the correct Turnstile site key for the given Vercel deployment environment.
// Called at build time by generate.js; VERCEL_ENV is set automatically by Vercel.
//
// VERCEL_ENV values:
//   'production'  — hometeamroof.com live deploy → real key, strict hostname
//   'preview'     — *.vercel.app branch deploy   → test key
//   'development' — `vercel dev` local server    → test key
//   undefined     — plain `node` local run       → test key
//
// Safety: production builds will error if the resolved key is the test key.
function getSiteKey(vercelEnv) {
  if (vercelEnv === 'production') {
    return PRODUCTION_SITE_KEY;
  }
  return TEST_SITE_KEY;
}

// Hard assertion used at build time to prevent test keys from reaching production.
// Throws immediately so the Vercel build fails visibly rather than deploying silently.
function assertProductionSafe(vercelEnv, siteKey) {
  if (vercelEnv === 'production' && siteKey !== PRODUCTION_SITE_KEY) {
    throw new Error(
      `[THT-BUILD] FATAL: VERCEL_ENV=production but Turnstile site key is a test key. ` +
      `Aborting build to prevent test credentials from reaching hometeamroof.com.`
    );
  }
  if (vercelEnv !== 'production' && siteKey === PRODUCTION_SITE_KEY) {
    throw new Error(
      `[THT-BUILD] FATAL: VERCEL_ENV=${vercelEnv || 'undefined'} but Turnstile site key ` +
      `is the production key. Use test keys outside of production builds.`
    );
  }
}

module.exports = { getSiteKey, assertProductionSafe, PRODUCTION_SITE_KEY, TEST_SITE_KEY };
