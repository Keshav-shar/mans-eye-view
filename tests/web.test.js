'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { canonicalize, registeredDomain } = require('../lib/web/canonical');
const { UrlGuard, isBlockedAddress } = require('../lib/web/urlGuard');
const { safeFetch } = require('../lib/web/safeFetch');
const { Robots } = require('../lib/web/robots');
const { DomainLimiter } = require('../lib/web/rateLimit');
const { classify } = require('../lib/web/blockDetector');
const { extract } = require('../lib/web/scrape');
const { Fetcher } = require('../lib/web/fetcher');
const { Evidence } = require('../lib/web/evidence');
const { Frontier } = require('../lib/web/frontier');
const { DEFAULTS } = require('../lib/defaults');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-web-'));
const publicLookup = (addr = '93.184.215.14') => (host, opts, cb) => cb(null, [{ address: addr, family: 4 }]);
const guardWith = (lookup = publicLookup(), lists = {}) => new UrlGuard({ deny: DEFAULTS.domains.deny, ...lists, lookup });
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('canonicalize: https, no tracking, sorted query, no fragment', () => {
  assert.equal(canonicalize('http://Example.com:80/a//b?utm_source=x&b=2&a=1#top'), 'https://example.com/a/b?a=1&b=2');
  assert.equal(canonicalize('javascript:alert(1)'), null);
  assert.equal(canonicalize('/team', 'https://zeta.io/about'), 'https://zeta.io/team');
  assert.equal(registeredDomain('blog.zeta.co.in'), 'zeta.co.in');
  assert.equal(registeredDomain('www.qdrant.tech'), 'qdrant.tech');
});

test('URL guard refuses internal targets by shape', () => {
  const g = guardWith();
  for (const u of [
    'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://2130706433/', 'https://0x7f.1/',
    'https://intranet/', 'https://printer.local/', 'https://a.internal/x', 'https://user:pw@zeta.io/', 'https://zeta.io:8443/',
    'https://www.linkedin.com/in/someone', 'ftp://zeta.io/',
  ]) assert.equal(g.check(canonicalize(u) || u).ok, false, u);
  assert.equal(g.check('http://zeta.io/').ok, false); // plain http is never fetched…
  assert.equal(canonicalize('http://zeta.io/'), 'https://zeta.io/'); // …links to it are tried over https instead
  assert.equal(g.check('https://zeta.io/team').ok, true);
  assert.equal(g.check('https://zeta.io/team').tier, 'open');
  assert.equal(new UrlGuard({ trusted: ['zeta.io'] }).check('https://blog.zeta.io/').tier, 'trusted');
});

test('URL guard refuses every non-public address family', () => {
  for (const ip of ['10.1.2.3', '100.64.0.1', '127.0.0.53', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12::3', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::1', '2001:db8::1', '2002::1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.215.14', '2606:4700::1111', '2a00:1450:4001::200e']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('DNS: any private answer blocks, and the vetted address is pinned for the connection', async () => {
  const mixed = guardWith((h, o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }]));
  const r = await mixed.resolve('rebind.example');
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-public/);

  const seen = [];
  const g = guardWith(publicLookup('93.184.215.14'));
  const res = await safeFetch('https://zeta.io/', { guard: g, fetchImpl: async (url, init) => { seen.push(init.pinned.address); return html('<p>hi</p>'); } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['93.184.215.14']);
});

test('redirects are re-checked on every hop', async () => {
  // A public page that redirects to cloud metadata (by IP) and to a name that resolves privately.
  const lookup = (host, o, cb) => cb(null, [{ address: host === 'evil-rebind.example' ? '169.254.169.254' : '93.184.215.14', family: 4 }]);
  const g = guardWith(lookup);
  const hop = (to) => async () => new Response(null, { status: 302, headers: { location: to } });
  await assert.rejects(safeFetch('https://zeta.io/a', { guard: g, fetchImpl: hop('http://169.254.169.254/latest/meta-data/') }), /IP addresses are refused/);
  await assert.rejects(safeFetch('https://zeta.io/a', { guard: g, fetchImpl: hop('https://evil-rebind.example/x') }), /non-public address/);
  let n = 0;
  await assert.rejects(safeFetch('https://zeta.io/loop', { guard: g, maxRedirects: 3, fetchImpl: async () => new Response(null, { status: 301, headers: { location: `/loop${n++}` } }) }), /Too many redirects/);
});

test('bodies are capped while streaming and only text types are read', async () => {
  const g = guardWith();
  const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(256 * 1024)); } }); // endless
  await assert.rejects(safeFetch('https://zeta.io/huge', { guard: g, maxBytes: 1024 * 1024, fetchImpl: async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }) }), /larger than/);
  await assert.rejects(safeFetch('https://zeta.io/x.png', { guard: g, fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }) }), /Skipped a image\/png/);
});

test('robots.txt: rules, crawl-delay, and conservative failure modes', async () => {
  const files = { 'https://a.io': [200, 'User-agent: *\nDisallow: /private\nCrawl-delay: 2\nSitemap: https://a.io/sm.xml'], 'https://b.io': [403, ''], 'https://c.io': [404, ''], 'https://d.io': [503, ''] };
  const rb = new Robots({ userAgent: 'NexusBot/1.0', fetchText: async (u) => { const [s, t] = files[new URL(u).origin]; return { status: s, text: t }; } });
  assert.equal((await rb.check('https://a.io/private/x')).ok, false);
  const ok = await rb.check('https://a.io/team');
  assert.equal(ok.ok, true);
  assert.equal(ok.delayMs, 2000);
  assert.deepEqual(await rb.sitemaps('https://a.io'), ['https://a.io/sm.xml']);
  assert.equal((await rb.check('https://b.io/')).ok, false); // 403 robots → stay out
  assert.equal((await rb.check('https://c.io/')).ok, true); // no robots → allowed
  assert.equal((await rb.check('https://d.io/')).ok, false); // server error → stay out for now
});

test('rate limiter spaces requests to one domain', async () => {
  const lim = new DomainLimiter({ minDelayMs: 60, concurrency: 4 });
  const t0 = Date.now();
  const r1 = await lim.acquire('a.io'); r1();
  const r2 = await lim.acquire('a.io'); r2();
  assert.ok(Date.now() - t0 >= 55);
  const t1 = Date.now();
  const r3 = await lim.acquire('b.io'); r3(); // other domain: no wait
  assert.ok(Date.now() - t1 < 40);
});

test('block detector: rate limits and bot walls are blocks; never "solved"', () => {
  assert.equal(classify({ status: 429, text: '' }).verdict, 'blocked');
  assert.equal(classify({ status: 403, text: '' }).verdict, 'blocked');
  assert.equal(classify({ status: 200, text: '<div class="cf-turnstile"></div> Verify you are human', visibleChars: 40 }).verdict, 'blocked');
  assert.equal(classify({ status: 404, text: '' }).verdict, 'gone');
  assert.equal(classify({ status: 200, text: '<script></script><script></script><script></script>', visibleChars: 10 }).verdict, 'js_required');
  assert.equal(classify({ status: 200, text: 'x', visibleChars: 5000, title: 'About' }).verdict, 'ok');
  assert.equal(classify({ status: 204, text: '' }).verdict, 'empty');
});

test('extract: markdown, JSON-LD, links, robots meta', () => {
  const page = extract(`<html><head><title>Zeta</title><meta name="robots" content="noindex, nofollow">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Zeta"}]}</script></head>
    <body><nav>menu</nav><article><h1>About Zeta</h1><p>${'Zeta builds payment rails for banks. '.repeat(20)}</p><a href="/team?utm_source=x">Team</a></article></body></html>`, 'https://zeta.io/about');
  assert.match(page.markdown, /About Zeta/);
  assert.equal(page.jsonld[0].name, 'Zeta');
  assert.ok(page.links.some((l) => l.url === 'https://zeta.io/team'));
  assert.equal(page.noindex, true);
  assert.equal(page.nofollow, true);
  assert.ok(page.contentHash && page.simhash !== '0');
});

test('fetcher: robots → page; two blocks in a row trip the circuit breaker and later pages are deferred without a request', async () => {
  const ev = new Evidence(tmp());
  let hits = 0;
  const fetchImpl = async (url) => {
    hits++;
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.includes('/wall')) return html('<p>Access denied</p>', 429, { 'retry-after': '120' });
    return html(`<html><head><title>Team</title></head><body><main><p>${'Meet the team at Zeta. '.repeat(30)}</p></main></body></html>`);
  };
  const settings = { ...DEFAULTS, fetch: { ...DEFAULTS.fetch, minDelayMs: 0 } };
  const f = new Fetcher({ guard: guardWith(), evidence: ev, settings, fetchImpl });
  const ok = await f.fetch('https://zeta.io/team');
  assert.equal(ok.ok, true);
  assert.equal(ok.page.title, 'Team');
  const blocked = await f.fetch('https://zeta.io/wall');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(ev.isBlocked('zeta.io'), false); // one block only skips the page
  assert.equal((await f.fetch('https://zeta.io/wall2')).blocked, true);
  assert.equal(ev.isBlocked('zeta.io'), true); // two in a row pause the site
  const before = hits;
  const after = await f.fetch('https://zeta.io/other');
  assert.equal(after.deferred, true);
  assert.equal(hits, before); // no request was sent while the breaker is open
  assert.equal((await f.fetch('https://www.linkedin.com/in/x')).policy, true);
});

test('frontier enforces depth and per-domain caps at push time', () => {
  const fr = new Frontier({ maxDepthFor: () => 1, capFor: () => 2 });
  assert.equal(fr.push({ url: 'https://a.io/1', depth: 0, priority: 0.2 }).ok, true);
  assert.equal(fr.push({ url: 'https://a.io/1?utm_source=x', depth: 0 }).reason, 'seen');
  assert.equal(fr.push({ url: 'https://a.io/2', depth: 2 }).reason, 'depth');
  assert.equal(fr.push({ url: 'https://a.io/3', depth: 1, priority: 0.9 }).ok, true);
  assert.equal(fr.push({ url: 'https://a.io/4', depth: 1 }).reason, 'domain cap');
  assert.equal(fr.pop().url, 'https://a.io/3'); // highest priority first
});

test('search provider: inferred from the key, never a Firecrawl key sent to Brave', () => {
  const { load } = require('../lib/config');
  const env = { ...process.env };
  const run = (vars) => {
    for (const k of ['SEARCH_PROVIDER', 'SEARCH_API_KEY', 'FIRECRAWL_API_KEY', 'BRAVE_API_KEY', 'SEARXNG_URL']) delete process.env[k];
    Object.assign(process.env, vars);
    const c = load();
    return [c.searchProvider, c.searchKey];
  };
  try {
    assert.deepEqual(run({ FIRECRAWL_API_KEY: 'fc-abc' }), ['firecrawl', 'fc-abc']);
    assert.deepEqual(run({ SEARCH_API_KEY: 'fc-abc' }), ['firecrawl', 'fc-abc']);
    assert.deepEqual(run({ SEARCH_API_KEY: 'BSAxyz' }), ['brave', 'BSAxyz']);
    assert.deepEqual(run({ SEARCH_PROVIDER: 'Firecrawl', SEARCH_API_KEY: 'k' }), ['firecrawl', 'k']);
    assert.deepEqual(run({ SEARXNG_URL: 'http://127.0.0.1:8888/' }).slice(0, 1), ['searxng']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
});

test('search adapter: Firecrawl v2 request shape, results, and readable errors', async () => {
  const { createSearch } = require('../lib/web/search');
  let sent = null;
  const ok = createSearch({ searchProvider: 'firecrawl', searchKey: 'fc-test' }, {
    fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ success: true, data: { web: [{ url: 'https://qdrant.tech/', title: 'Qdrant', description: 'Vector DB' }, { url: 'ftp://x' }] } }), { status: 200 }); },
  });
  const rows = await ok.search('qdrant vector database', { count: 5 });
  assert.equal(sent.url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(sent.init.headers.Authorization, 'Bearer fc-test');
  assert.deepEqual(JSON.parse(sent.init.body), { query: 'qdrant vector database', limit: 5, sources: ['web'], ignoreInvalidURLs: true });
  assert.deepEqual(rows, [{ url: 'https://qdrant.tech/', title: 'Qdrant', snippet: 'Vector DB' }]);
  assert.equal(ok.warning, null);

  const fail = (provider, status, body) => createSearch({ searchProvider: provider, searchKey: 'k' }, { fetchImpl: async () => new Response(JSON.stringify(body), { status }) }).search('x');
  await assert.rejects(fail('firecrawl', 401, { success: false, error: 'Unauthorized: Invalid token' }), (e) => /Firecrawl rejected the API key: Unauthorized: Invalid token/.test(e.message) && e.fatal);
  await assert.rejects(fail('brave', 422, { error: { detail: 'The provided subscription token is invalid.' } }), (e) => /SEARCH_PROVIDER=firecrawl/.test(e.message) && /subscription token is invalid/.test(e.message) && e.fatal);
  await assert.rejects(fail('firecrawl', 402, { error: 'Insufficient credits' }), /out of credits/);
  assert.match(createSearch({ searchProvider: 'firecrawl', searchKey: '7234-abcd' }).warning, /start with "fc-"/);
});

test('block detector ignores challenge words inside inline script code; author pages are not "JavaScript-only"', () => {
  const gh = `<html><head><title>yashi-04 · GitHub</title><script>window.flags={"octocaptcha_origin_optimization":true,"captchaless":1}</script></head><body><main><p>${'Repositories and contributions. '.repeat(40)}</p></main></body></html>`;
  assert.equal(classify({ status: 200, text: gh, visibleChars: 1200 }).verdict, 'ok');
  assert.equal(classify({ status: 200, text: '<div class="g-recaptcha"></div>', visibleChars: 20 }).verdict, 'blocked');
  const author = `<html><head><title>Yashi Sharma, Author</title><script type="application/ld+json">{"@type":"Person","name":"Yashi Sharma","jobTitle":"Content Writer"}</script>${'<script src="/a.js"></script>'.repeat(30)}</head>
    <body><nav>Home News</nav><main><div><h2>Yashi Sharma</h2></div><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/p${i}">Story ${i} about students and research projects on campus this term</a></li>`).join('')}</ul></main></body></html>`;
  const e = extract(author, 'https://blog.example.edu/blog/author/yashi/');
  assert.ok(e.bodyChars >= 500, `body ${e.bodyChars}`);
  assert.match(e.text, /Yashi Sharma, Content Writer\./); // JSON-LD folded into the text
  assert.equal(classify({ status: 200, text: author, visibleChars: e.visibleChars, scriptCount: e.scriptCount, bodyChars: e.bodyChars, structured: true }).verdict, 'ok');
});

test('fetcher: transient errors are retried with backoff; blocks are not', async () => {
  const { backoff } = require('../lib/web/fetcher');
  assert.equal(backoff(0, { base: 500, rand: () => 0.5 }), 500);
  assert.equal(backoff(3, { base: 500, rand: () => 0.5 }), 4000);
  assert.equal(backoff(9, { base: 500, cap: 8000, rand: () => 0.5 }), 8000);
  let n = 0;
  const flaky = async (url) => {
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } });
    n++;
    if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (n === 2) return new Response('busy', { status: 502, headers: { 'content-type': 'text/html' } });
    return html(`<html><head><title>OK</title></head><body><main><p>${'Fine now. '.repeat(40)}</p></main></body></html>`);
  };
  const settings = { ...DEFAULTS, fetch: { ...DEFAULTS.fetch, minDelayMs: 0 } };
  const f = new Fetcher({ guard: guardWith(), evidence: new Evidence(tmp()), settings, fetchImpl: flaky, backoffBase: 5 });
  const r = await f.fetch('https://zeta.io/page');
  assert.equal(r.ok, true);
  assert.equal(n, 3);
  let m = 0;
  const wall = async (url) => (url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : (m++, html('denied', 429)));
  const g = new Fetcher({ guard: guardWith(), evidence: new Evidence(tmp()), settings, fetchImpl: wall, backoffBase: 5 });
  assert.equal((await g.fetch('https://zeta.io/x')).blocked, true);
  assert.equal(m, 1); // a 429 is never retried
});

test('crawler traps, rel=canonical and PDFs', async () => {
  const { isTrap } = require('../lib/web/frontier');
  assert.equal(isTrap('https://a.io/cal/2026/01/cal/2026/cal/2026/x'), true);
  assert.equal(isTrap(`https://a.io/${'x'.repeat(210)}`), true);
  assert.equal(isTrap('https://a.io/blog/2026/11/post'), false);
  const settings = { ...DEFAULTS, fetch: { ...DEFAULTS.fetch, minDelayMs: 0 } };
  const { makePdf } = require('./helpers/pdf');
  const pdf = makePdf(['Zeta Labs Annual Report 2026', 'Zeta Labs was founded by Asha Rao in Bengaluru and builds payment rails for banks across India and Southeast Asia. ']);
  const site = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (u.pathname === '/report.pdf') return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
    const canon = u.pathname === '/p?ref=1' ? '' : '<link rel="canonical" href="/team">';
    const off = u.pathname === '/off' ? '<link rel="canonical" href="https://elsewhere.io/team">' : canon;
    return html(`<html><head><title>T</title>${off}</head><body><main><p>${'Team page text. '.repeat(40)}</p></main></body></html>`);
  };
  const f = new Fetcher({ guard: guardWith(), evidence: new Evidence(tmp()), settings, fetchImpl: site });
  const a = await f.fetch('https://zeta.io/team-old');
  assert.equal(a.canonical, 'https://zeta.io/team');
  assert.equal(a.page.url, 'https://zeta.io/team');
  const b = await f.fetch('https://zeta.io/off');
  assert.equal(b.canonical, null); // a canonical on another site is ignored
  const p = await f.fetch('https://zeta.io/report.pdf');
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.page.isPdf, true);
  assert.match(p.page.text, /founded by Asha Rao/);
});

test('rendered pages: every request is guarded, assets are never fetched', async () => {
  const { decideRequest } = require('../lib/web/browser');
  const lookup = (host, o, cb) => cb(null, [{ address: host === 'internal.example' ? '10.0.0.7' : '93.184.215.14', family: 4 }]);
  const g = guardWith(lookup);
  assert.equal((await decideRequest('https://zeta.io/api/team.json', 'xhr', g)).allow, true);
  assert.equal((await decideRequest('https://internal.example/admin', 'fetch', g)).allow, false);
  assert.equal((await decideRequest('https://169.254.169.254/latest', 'fetch', g)).allow, false);
  assert.equal((await decideRequest('http://zeta.io/x.js', 'script', g)).allow, false);
  assert.equal((await decideRequest('https://zeta.io/logo.png', 'image', g)).allow, false);
  assert.equal((await decideRequest('https://www.linkedin.com/embed', 'sub_frame', g)).allow, false);
});
