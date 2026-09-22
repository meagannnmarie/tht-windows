#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://ththomesolutions.com';

// Directories never scanned — assets, build artifacts, dev tooling, server code
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.vercel', '.cache',
  'api', 'images', 'videos', 'public',
  'dist', 'build', 'coverage', 'test', 'tests', '__tests__',
]);

// Filenames excluded by name regardless of canonical
const SKIP_FILES = new Set([
  '404.html', '500.html', 'error.html', 'offline.html',
]);

// Returns the set of redirect source paths from vercel.json.
// Only exact path strings are matched; wildcard/regex patterns are not evaluated.
function loadRedirectSources(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    return new Set((config.redirects || []).map(r => r.source).filter(Boolean));
  } catch {
    return new Set();
  }
}

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

function collectHtmlFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        results.push(...collectHtmlFiles(path.join(dir, entry.name)));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.html') &&
      !SKIP_FILES.has(entry.name)
    ) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// Metadata only — never affects inclusion or exclusion decisions
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
  if (['roofing', 'windows', 'doors'].includes(service)) {
    return { changefreq: 'monthly', priority: '0.8' };
  }
  if (service === 'service-areas') {
    return { changefreq: 'monthly', priority: '0.7' };
  }
  return { changefreq: 'monthly', priority: '0.7' };
}

const root = __dirname;
const redirectSources = loadRedirectSources(root);
const seenLocs = new Set();

const urls = collectHtmlFiles(root)
  .reduce((acc, file) => {
    const content = fs.readFileSync(file, 'utf8');

    // Exclusion checks — these are the only reasons a page is skipped
    if (hasNoindex(content)) return acc;
    const canonical = getCanonical(content);
    if (!canonical || !canonical.startsWith(BASE_URL)) return acc;
    const urlPath = canonical.slice(BASE_URL.length) || '/';
    if (redirectSources.has(urlPath)) return acc;
    if (seenLocs.has(canonical)) return acc;
    seenLocs.add(canonical);

    // Metadata only — assigned after all exclusion checks pass
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
      `\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join('\n') +
  '\n</urlset>\n';

fs.writeFileSync(path.join(root, 'sitemap.xml'), xml);
console.log(`Generated sitemap.xml with ${urls.length} URLs:`);
urls.forEach(u => console.log(`  ${u.loc}`));
