'use strict';

// One canonical spelling per URL, so the frontier's seen-set and the source ids never split the same
// page in two: lowercase punycode host (WHATWG URL does this), no fragment, no default port, no
// tracking parameters, sorted query, https preferred.

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_hsenc|_hsmi|si|spm|yclid|dclid|trk|trkCampaign)$/i;
const MAX_LEN = 2048;

function canonicalize(raw, base) {
  let u;
  try { u = base ? new URL(String(raw).trim(), base) : new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.protocol === 'http:') u.protocol = 'https:'; // only https is fetched; try the secure origin
  u.hash = '';
  if (u.port === '443' || u.port === '80') u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
  const out = u.toString();
  return out.length > MAX_LEN ? null : out;
}

// Registered domain (eTLD+1) without a public-suffix download: covers the common two-level suffixes.
const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'firm.in', 'gen.in', 'ind.in',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'com.br', 'com.cn', 'com.sg', 'com.hk',
  'com.mx', 'com.tr', 'com.tw', 'co.kr', 'co.nz', 'co.za', 'com.ar', 'com.my', 'com.ph', 'com.pk', 'co.id', 'com.vn', 'co.il',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev', 'web.app', 'substack.com', 'medium.com',
]);

function registeredDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  if (TWO_LEVEL.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const domainOf = (url) => registeredDomain(hostOf(url));

module.exports = { canonicalize, registeredDomain, hostOf, domainOf };
