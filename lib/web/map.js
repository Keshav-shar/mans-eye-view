'use strict';
const { canonicalize, domainOf } = require('./canonical');

// Firecrawl's /map: list a site's URLs without crawling it. Sources: robots.txt Sitemap: lines,
// /sitemap.xml (and nested sitemap indexes, two levels, ten files), then the homepage's own links.
// Everything is filtered to the same registered domain and canonicalised.

function locs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

async function mapSite(startUrl, { fetchPage, robots, extract, limit = 2000 }) {
  const start = canonicalize(startUrl);
  if (!start) throw new Error('Not a valid web address');
  const origin = new URL(start).origin;
  const domain = domainOf(start);
  const out = new Set();
  const add = (u) => {
    const c = canonicalize(u, start);
    if (c && domainOf(c) === domain && out.size < limit) out.add(c);
  };

  // Homepage navigation first: it is small and points at the pages that matter (about, team, careers),
  // which a 10k-entry blog sitemap would otherwise crowd out.
  try {
    const res = await fetchPage(start);
    if (res && res.status === 200) {
      add(start);
      for (const l of extract(res.text, res.url || start).links) add(l.url);
    }
  } catch { /* homepage unreachable */ }

  const queue = [...(await robots.sitemaps(origin)), `${origin}/sitemap.xml`];
  const seenMaps = new Set();
  let files = 0;
  while (queue.length && files < 10 && out.size < limit) {
    const sm = canonicalize(queue.shift());
    if (!sm || seenMaps.has(sm) || domainOf(sm) !== domain) continue;
    seenMaps.add(sm);
    files++;
    try {
      const res = await fetchPage(sm, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' });
      if (!res || res.status !== 200) continue;
      const found = locs(res.text);
      if (/<sitemapindex/i.test(res.text)) { for (const l of found.slice(0, 20)) queue.push(l); } else { for (const l of found) add(l); }
    } catch { /* skip unreadable sitemap */ }
  }
  return [...out];
}

module.exports = { mapSite, locs };
