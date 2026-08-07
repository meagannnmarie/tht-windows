// Vercel serverless function — GET /api/google-reviews
//
// Calls the Google Places API (New) to fetch live business data and reviews.
// The API key is read from an environment variable and is NEVER returned to
// the browser in the JSON response.
//
// Required Vercel environment variables:
//   GOOGLE_PLACES_API_KEY  — your Google Cloud API key (Places API enabled)
//   GOOGLE_PLACE_ID        — the Place ID for The Home Team Roofing & A/C LLC
//                            e.g. "ChIJ..." or the full "places/ChIJ..." form
//
// TESTING LOCALLY:
//   Run `npx vercel dev` from the project root. The serverless function will be
//   available at http://localhost:3000/api/google-reviews. Opening reviews.html
//   via file:// will NOT work because the fetch to /api/google-reviews requires
//   an HTTP server context. Use `vercel dev` or `npx serve .` + Vercel CLI.

const PLACES_API_BASE = 'https://places.googleapis.com/v1/places';

// Fields requested from the Places API (New).
// Only request what is actually displayed — billing is per-field.
const FIELD_MASK = [
  'displayName',
  'rating',
  'userRatingCount',
  'googleMapsUri',
  'reviews',
].join(',');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    console.error('[google-reviews] Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID env vars');
    return res.status(503).json({ error: 'Reviews endpoint not configured.' });
  }

  // The Places API (New) accepts "ChIJ..." or "places/ChIJ..." — normalise to
  // the full resource path for the URL, and strip the prefix for the write-
  // review URL which uses the bare place ID.
  const resourcePath = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
  const barePlaceId  = placeId.replace(/^places\//, '');

  let googleRes;
  try {
    googleRes = await fetch(`${PLACES_API_BASE}/${resourcePath}`, {
      headers: {
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
    });
  } catch (networkErr) {
    console.error('[google-reviews] Network error reaching Google:', networkErr.message);
    return res.status(502).json({ error: 'Unable to reach Google Places API.' });
  }

  if (!googleRes.ok) {
    const body = await googleRes.text().catch(() => '');
    console.error('[google-reviews] Google API returned HTTP', googleRes.status, body);
    return res.status(502).json({ error: 'Google Places API returned an error.' });
  }

  let data;
  try {
    data = await googleRes.json();
  } catch (parseErr) {
    console.error('[google-reviews] Failed to parse Google response:', parseErr.message);
    return res.status(502).json({ error: 'Unexpected response from Google.' });
  }

  // Shape reviews to only expose what we display.
  // Google attribution requirements are honoured by preserving authorAttribution
  // fields (displayName, uri, photoUri) so the frontend can link reviewer names
  // and display photos as required by the Places API terms of service.
  const reviews = (data.reviews || []).map(function (r) {
    return {
      rating:                       r.rating,
      relativePublishTimeDescription: r.relativePublishTimeDescription || '',
      publishTime:                  r.publishTime || '',
      text:                         (r.text && r.text.text) ? r.text.text : '',
      // review-level googleMapsUri is available in the new API when present
      googleMapsUri:                r.googleMapsUri || null,
      author: {
        displayName: (r.authorAttribution && r.authorAttribution.displayName) || 'Google Reviewer',
        uri:         (r.authorAttribution && r.authorAttribution.uri)         || null,
        photoUri:    (r.authorAttribution && r.authorAttribution.photoUri)    || null,
      },
    };
  });

  // Cache at the Vercel edge for 5 minutes so repeated page loads don't each
  // hit the Google API. stale-while-revalidate lets the edge serve a cached
  // copy while refreshing in the background.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  return res.status(200).json({
    businessName:   (data.displayName && data.displayName.text) || 'Home Team Home Solutions',
    rating:         data.rating          ?? null,
    totalReviews:   data.userRatingCount ?? null,
    googleMapsUri:  data.googleMapsUri   || null,
    // Constructed server-side so the plain place ID is never exposed to the
    // browser. Replace with a direct review-writing short link if one is
    // obtained from Google Business Profile.
    writeReviewUri: `https://search.google.com/local/writereview?placeid=${barePlaceId}`,
    reviews,
  });
};
