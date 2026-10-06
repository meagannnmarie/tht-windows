#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT  = path.resolve(__dirname, '../..');
const BUILD = path.resolve(__dirname, '..');
const DIST  = path.resolve(ROOT, 'dist');

// ── Filesystem helpers ────────────────────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Template engine ───────────────────────────────────────────────────────────

function injectPartials(html) {
  return html.replace(/\{\{PARTIAL:([^}]+)\}\}/g, (_, name) => {
    const f = path.join(BUILD, 'partials', `${name}.html`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  });
}

function substituteTokens(html, tokens) {
  return html.replace(/\{\{([^}]+)\}\}/g, (match, key) =>
    key in tokens ? tokens[key] : match
  );
}

// ── Token map ─────────────────────────────────────────────────────────────────

function buildTokens(site, loc) {
  const faq = loc.faq.items;
  const sf  = loc.schema.faq_schema;
  return {
    // Global
    businessName:        site.businessName,
    PHONE_TEL:           site.phoneTel,
    PHONE_DISPLAY:       site.phoneDisplay,
    CURRENT_YEAR:        String(new Date().getFullYear()),
    // Meta
    META_TITLE:          loc.meta.title,
    META_DESCRIPTION:    loc.meta.description,
    META_OG_DESCRIPTION: loc.meta.description,
    CANONICAL_URL:       loc.meta.canonical,
    OG_IMAGE:            loc.meta.og_image,
    // Location
    CITY:                loc.location.city,
    STATE:               loc.location.state,
    COUNTY:              loc.location.county,
    CITY_STATE:          `${loc.location.city}, ${loc.location.state}`,
    // Hero
    HERO_IMAGE:          loc.hero.image,
    HERO_IMAGE_ALT:      loc.hero.image_alt,
    HERO_IMAGE_POSITION: loc.hero.image_position,
    HERO_EYEBROW:        loc.hero.eyebrow,
    HERO_H1_LINE1:       loc.hero.h1_line1,
    HERO_H1_LINE2:       loc.hero.h1_line2,
    HERO_TAGLINE:        loc.hero.tagline,
    HERO_MOB_TAGLINE:    loc.hero.mob_tagline,
    // Intro
    INTRO_HEADING:       loc.intro.heading,
    INTRO_P1:            loc.intro.body_p1,
    INTRO_P2:            loc.intro.body_p2,
    INTRO_CALLOUT_LABEL: loc.intro.callout_label,
    INTRO_CALLOUT_TEXT:  loc.intro.callout_text,
    INTRO_IMAGE:         loc.intro.image,
    INTRO_IMAGE_ALT:     loc.intro.image_alt,
    // Services
    SERVICES_HEADING:    loc.services_heading,
    SERVICES_SUB:        loc.services_sub,
    // Financing
    FIN_HEADING:         loc.financing.heading,
    FIN_SUB:             loc.financing.sub,
    // Process
    PROCESS_HEADING:     loc.process.heading,
    PROCESS_SUB:         loc.process.sub,
    PROCESS_STEP1_P:     loc.process.step1_p,
    PROCESS_STEP2_P:     loc.process.step2_p,
    PROCESS_STEP3_P:     loc.process.step3_p,
    // FAQ
    FAQ_HEADING:  loc.faq.heading,
    FAQ_1_Q: faq[0].q, FAQ_1_A: faq[0].a,
    FAQ_2_Q: faq[1].q, FAQ_2_A: faq[1].a,
    FAQ_3_Q: faq[2].q, FAQ_3_A: faq[2].a,
    FAQ_4_Q: faq[3].q, FAQ_4_A: faq[3].a,
    FAQ_5_Q: faq[4].q, FAQ_5_A: faq[4].a,
    FAQ_6_Q: faq[5].q, FAQ_6_A: faq[5].a,
    // Final CTA
    FINAL_CTA_EYEBROW:   loc.final_cta.eyebrow,
    FINAL_CTA_HEADING:   loc.final_cta.heading,
    FINAL_CTA_SUB:       loc.final_cta.sub,
    // Schema
    SCHEMA_SERVICE_NAME: loc.schema.service_name,
    SCHEMA_SERVICE_DESC: loc.schema.service_description,
    SCHEMA_FAQ_1_Q: sf[0].q, SCHEMA_FAQ_1_A: sf[0].a,
    SCHEMA_FAQ_2_Q: sf[1].q, SCHEMA_FAQ_2_A: sf[1].a,
    SCHEMA_FAQ_3_Q: sf[2].q, SCHEMA_FAQ_3_A: sf[2].a,
    SCHEMA_FAQ_4_Q: sf[3].q, SCHEMA_FAQ_4_A: sf[3].a,
    SCHEMA_FAQ_5_Q: sf[4].q, SCHEMA_FAQ_5_A: sf[4].a,
    SCHEMA_FAQ_6_Q: sf[5].q, SCHEMA_FAQ_6_A: sf[5].a,
  };
}

// ── Image copy (with Stage 1 exclusion rules) ─────────────────────────────────

// Paired PNGs kept in dist: referenced as .png in HTML, or permanent OG asset
const KEEP_PAIRED_PNG = new Set(['websitepic.png', 'doortool.png', 'roofing.png']);

function copyImages() {
  const srcDir  = path.join(ROOT, 'images');
  const destDir = path.join(DIST, 'images');
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  // Collect WebP basenames for paired-PNG detection
  const webpBases = new Set(
    entries
      .filter(e => e.isFile() && e.name.endsWith('.webp'))
      .map(e => path.basename(e.name, '.webp'))
  );

  let copied = 0, skipped = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const src  = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDir(src, dest);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext  = path.extname(entry.name).toLowerCase();
    const base = path.basename(entry.name, path.extname(entry.name));

    if (ext === '.png' && webpBases.has(base) && !KEEP_PAIRED_PNG.has(entry.name)) {
      skipped++;
      continue; // excluded — 308 redirect present in vercel.json
    }

    copyFile(src, dest);
    copied++;
  }

  console.log(`  images/: ${copied} copied, ${skipped} excluded (redirected)`);
}

// ── HTML source page collection ───────────────────────────────────────────────

// Pages produced by the template generator — skip source prototypes
const GENERATED_PAGES = new Set([
  path.join(ROOT, 'roofing', 'the-woodlands-tx.html'),
]);

const SKIP_HTML_DIRS = new Set([
  '_build', 'dist', 'node_modules', '.git', '.next', '.vercel', '.cache',
  'api', 'images', 'videos', 'public',
]);

function collectSourceHtml(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_HTML_DIRS.has(entry.name)) collectSourceHtml(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.html') && !GENERATED_PAGES.has(full)) {
      results.push(full);
    }
  }
  return results;
}

// ── Sitemap generation ────────────────────────────────────────────────────────

const BASE_URL = 'https://hometeamroof.com';

function hasNoindex(content) {
  return (
    /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(content) ||
    /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]+name=["']robots["']/i.test(content)
  );
}

function getCanonical(content) {
  const m =
    content.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    content.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  return m ? m[1] : null;
}

function urlMeta(urlPath) {
  switch (urlPath) {
    case '/':
      return { changefreq: 'monthly', priority: '1.0' };
    case '/roofing':
    case '/windows':
    case '/doors':
    case '/estimate':
      return { changefreq: 'monthly', priority: '0.9' };
    case '/reviews':
      return { changefreq: 'weekly',  priority: '0.8' };
    case '/gallery':
    case '/contact':
      return { changefreq: 'monthly', priority: '0.8' };
    case '/financing':
    case '/replacement-window-options':
    case '/service-areas':
      return { changefreq: 'monthly', priority: '0.7' };
    case '/meet-the-team':
      return { changefreq: 'monthly', priority: '0.6' };
  }
  const [, service] = urlPath.split('/');
  if (['roofing', 'windows', 'doors'].includes(service))
    return { changefreq: 'monthly', priority: '0.8' };
  if (service === 'service-areas')
    return { changefreq: 'monthly', priority: '0.7' };
  return { changefreq: 'monthly', priority: '0.7' };
}

function collectDistHtml(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectDistHtml(full, results);
    else if (entry.isFile() && entry.name.endsWith('.html')) results.push(full);
  }
  return results;
}

function generateSitemap() {
  const seen = new Set();
  const urls = collectDistHtml(DIST)
    .reduce((acc, file) => {
      const content = fs.readFileSync(file, 'utf8');
      if (hasNoindex(content)) return acc;
      const canonical = getCanonical(content);
      if (!canonical || !canonical.startsWith(BASE_URL)) return acc;
      const urlPath = canonical.slice(BASE_URL.length) || '/';
      if (seen.has(canonical)) return acc;
      seen.add(canonical);
      const { changefreq, priority } = urlMeta(urlPath);
      acc.push({ loc: canonical, urlPath, changefreq, priority });
      return acc;
    }, [])
    .sort((a, b) => {
      if (a.urlPath === '/') return -1;
      if (b.urlPath === '/') return 1;
      const diff = parseFloat(b.priority) - parseFloat(a.priority);
      return diff !== 0 ? diff : a.urlPath.localeCompare(b.urlPath);
    });

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(u =>
        `  <url>\n    <loc>${u.loc}</loc>` +
        `\n    <changefreq>${u.changefreq}</changefreq>` +
        `\n    <priority>${u.priority}</priority>\n  </url>`
      )
      .join('\n') +
    '\n</urlset>\n';

  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), xml);
  console.log(`  sitemap.xml: ${urls.length} URLs`);
  urls.forEach(u => console.log(`    ${u.loc}`));
}

// ── Template page generator ───────────────────────────────────────────────────

function generatePage(templateName, dataFile, outputPath) {
  const templatePath = path.join(BUILD, 'templates', `${templateName}.html`);
  const sitePath     = path.join(BUILD, 'data', 'site.json');
  const dataPath     = path.join(BUILD, 'data', `${dataFile}.json`);

  const template = fs.readFileSync(templatePath, 'utf8');
  const site     = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
  const loc      = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const tokens   = buildTokens(site, loc);

  // Pass 1: inject partials; Pass 2: substitute all tokens (including those in partials)
  let html = injectPartials(template);
  html = substituteTokens(html, tokens);

  const dest = path.join(DIST, outputPath);
  mkdirp(path.dirname(dest));
  fs.writeFileSync(dest, html, 'utf8');
  console.log(`  Generated: dist/${outputPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== Building dist/ ===\n');

  // 1. Clean and recreate dist/
  if (fs.existsSync(DIST)) execSync(`rm -rf "${DIST}"`);
  mkdirp(DIST);

  // 2. Images (with copy/exclusion rules)
  console.log('images/');
  copyImages();

  // 3. Optimised web videos + poster images
  console.log('videos/');
  const webVidSrc     = path.join(ROOT, 'videos', 'home-team', 'web');
  const postersSrc    = path.join(ROOT, 'videos', 'home-team', 'posters');
  if (fs.existsSync(webVidSrc)) {
    copyDir(webVidSrc, path.join(DIST, 'videos', 'home-team', 'web'));
    console.log('  videos/home-team/web/ copied');
  }
  if (fs.existsSync(postersSrc)) {
    copyDir(postersSrc, path.join(DIST, 'videos', 'home-team', 'posters'));
    console.log('  videos/home-team/posters/ copied');
  }

  // 4. public/ (videos + images referenced from HTML)
  console.log('public/');
  const publicSrc = path.join(ROOT, 'public');
  if (fs.existsSync(publicSrc)) {
    copyDir(publicSrc, path.join(DIST, 'public'));
    console.log('  public/ copied');
  }

  // 5. Root static files
  for (const f of ['robots.txt']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(DIST, f));
      console.log(`  ${f} copied`);
    }
  }

  // 6. CSS → assets/css/
  console.log('assets/css/');
  copyDir(path.join(BUILD, 'css'), path.join(DIST, 'assets', 'css'));
  console.log('  shared.css + local-page.css copied');

  // 7. Existing HTML pages
  console.log('HTML pages/');
  const srcPages = collectSourceHtml(ROOT);
  for (const src of srcPages) {
    const rel = path.relative(ROOT, src);
    copyFile(src, path.join(DIST, rel));
  }
  console.log(`  ${srcPages.length} source pages copied`);

  // 8. Template-generated pages
  console.log('Template pages/');
  generatePage('local-roofing', 'roofing-the-woodlands-tx', 'roofing/the-woodlands-tx.html');

  // 9. Sitemap
  console.log('sitemap/');
  generateSitemap();

  // 10. Size summary
  console.log('\n=== Build complete ===');
  try {
    const size = execSync(`du -sh "${DIST}"`).toString().split('\t')[0];
    console.log(`dist/ size: ${size}`);
  } catch { /* non-fatal */ }
}

main();
