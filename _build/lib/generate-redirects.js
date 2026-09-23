#!/usr/bin/env node
'use strict';

// Reads images/ directory, finds matched PNG/WebP pairs, and appends
// verified redirect entries to vercel.json["redirects"].
// Existing redirects are NEVER modified or removed.
// Only candidates whose source path is not already present are added.
// Run locally after adding new image pairs:
//   node _build/lib/generate-redirects.js
// Review the vercel.json diff, then commit.

const fs   = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '../..');
const IMAGES_DIR  = path.join(ROOT, 'images');
const VERCEL_JSON = path.join(ROOT, 'vercel.json');

// PNGs that live in dist as-is — must NOT receive a redirect (Stage 1)
const NO_REDIRECT = new Set(['websitepic.png', 'doortool.png', 'roofing.png']);

// ── 1. Load current vercel.json and preserve existing redirects exactly ──
const config   = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
const existing = Array.isArray(config.redirects) ? config.redirects : [];

console.log(`Existing redirects in vercel.json: ${existing.length}`);

// Build a Set of source paths already present — used to detect collisions
const existingSources = new Set(existing.map(r => r.source));

// ── 2. Build fresh PNG→WebP candidate list from disk ──
const entries = fs.readdirSync(IMAGES_DIR, { withFileTypes: true });

const webpBases = new Set(
  entries
    .filter(e => e.isFile() && e.name.endsWith('.webp'))
    .map(e => path.basename(e.name, '.webp'))
);

const candidates = entries
  .filter(e => e.isFile() && path.extname(e.name).toLowerCase() === '.png')
  .filter(e => !NO_REDIRECT.has(e.name))
  .filter(e => webpBases.has(path.basename(e.name, path.extname(e.name))))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(e => ({
    source:      `/images/${e.name}`,
    destination: `/images/${path.basename(e.name, path.extname(e.name))}.webp`,
    permanent:   true,
  }));

// ── 3. Filter candidates — skip any whose source already exists ──
const newRedirectsOnly = [];
const collisions       = [];

for (const candidate of candidates) {
  if (existingSources.has(candidate.source)) {
    collisions.push(candidate.source);
  } else {
    newRedirectsOnly.push(candidate);
  }
}

if (collisions.length > 0) {
  console.log(`Skipped ${collisions.length} already-present source(s):`);
  collisions.forEach(s => console.log(`  (skipped) ${s}`));
}

// ── 4. Write — existing array is untouched, new entries appended ──
config.redirects = [...existing, ...newRedirectsOnly];

fs.writeFileSync(VERCEL_JSON, JSON.stringify(config, null, 2) + '\n');
console.log(`Added ${newRedirectsOnly.length} new PNG→WebP redirect(s) to vercel.json`);
newRedirectsOnly.forEach(r => console.log(`  ${r.source} → ${r.destination}`));
