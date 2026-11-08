'use strict';
const { urlType, TYPE_VALUE } = require('./classify');
const { tokens } = require('../ml/text');
const { domainOf } = require('../web/canonical');

// Which links on a valuable page are worth following. priority = relevance × novelty × trust / (1+depth),
// where relevance blends the URL's predicted page type with the anchor's overlap with the research seed.

const SKIP = /\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|logout|wp-admin|wp-login|feed|rss|cdn-cgi|share|print|subscribe|unsubscribe)(\/|$|\?)|\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|ico|woff2?|dmg|exe|apk)(\?|$)|[?&](sessionid|sid|replytocom|share|print)=|\/page\/\d{2,}|\/(tag|author)\//i;

function scoreLinks(links, { pageUrl, depth, seedTerms = [], trust = 0.6, seenDomainPages = () => 0, sameDomainOnly = true, max = 30 }) {
  const base = domainOf(pageUrl);
  const seed = new Set(seedTerms);
  const out = [];
  for (const l of links) {
    if (l.nofollow || SKIP.test(l.url)) continue;
    const d = domainOf(l.url);
    const internal = d === base;
    if (sameDomainOnly && !internal) continue;
    const t = urlType(l.url);
    const typeVal = t ? TYPE_VALUE[t] : 0.35;
    if (t === 'legal' || t === 'listing') continue;
    const at = tokens(`${l.anchor} ${l.url.replace(/[/._?=&-]+/g, ' ')}`);
    const overlap = seed.size ? at.filter((x) => seed.has(x)).length / Math.max(1, Math.min(seed.size, 4)) : 0;
    const relevance = Math.min(1, 0.65 * typeVal + 0.35 * Math.min(1, overlap) + (internal ? 0.05 : 0));
    const novelty = 1 / (1 + 0.2 * seenDomainPages(d));
    const priority = (relevance * novelty * trust) / (1 + depth);
    out.push({ ...l, priority: Math.round(priority * 1000) / 1000, predicted: t || 'other', domain: d });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, max);
}

module.exports = { scoreLinks, SKIP };
