'use strict';
const { safeFetch, FetchError } = require('./safeFetch');
const { Robots } = require('./robots');
const { DomainLimiter } = require('./rateLimit');
const { classify, CHALLENGE } = require('./blockDetector');
const { extract } = require('./scrape');
const { extractPdf } = require('./pdf');
const { canonicalize, domainOf } = require('./canonical');
const { parseDuration } = require('../llm/gateway');

// The fetch ladder for one URL:
//   canonicalise → guard shape/tier → circuit breaker → robots.txt → per-domain rate limit
//   → pinned safeFetch (conditional GET when we have an ETag), retried with backoff on transient errors
//   → block verdict → HTML or PDF extraction → rel=canonical → (optional) render JavaScript-only pages
// Outcomes: { ok: true, page } or { ok: false, deferred, reason, kind } — never a throw.

const RETRY_CODES = new Set(['network', 'timeout']);
const RETRY_STATUS = new Set([500, 502, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with jitter: min(cap, base·2ⁿ) · rand(0.5, 1.5).
function backoff(n, { base = 500, cap = 8000, rand = Math.random } = {}) {
  return Math.round(Math.min(cap, base * 2 ** n) * (0.5 + rand()));
}

class Fetcher {
  // renderer: optional lib/web/browser.js Renderer (NEXUS_BROWSER=on), used only for JavaScript-only pages.
  constructor({ guard, evidence, settings, fetchImpl = null, renderer = null, retries = 2, backoffBase = 500 }) {
    this.guard = guard;
    this.evidence = evidence;
    this.cfg = settings.fetch;
    this.fetchImpl = fetchImpl;
    this.renderer = renderer;
    this.retries = retries;
    this.backoffBase = backoffBase;
    this.limiter = new DomainLimiter({ minDelayMs: this.cfg.minDelayMs, concurrency: this.cfg.concurrency });
    this.robots = new Robots({
      userAgent: this.cfg.userAgent,
      fetchText: async (url) => {
        try {
          return await this.raw(url, { accept: 'text/plain,*/*;q=0.1', maxBytes: 512 * 1024 });
        } catch (e) {
          if (e instanceof FetchError && e.code === 'bad_type') return { status: 404, text: '' }; // HTML 404 pages
          throw e;
        }
      },
    });
  }

  raw(url, opts = {}) {
    return safeFetch(url, {
      guard: this.guard, timeoutMs: this.cfg.timeoutMs, maxBytes: this.cfg.maxBytes, maxRedirects: this.cfg.maxRedirects,
      userAgent: this.cfg.userAgent, fetchImpl: this.fetchImpl, ...opts,
    });
  }

  // Transient failures (timeouts, resets, 500/502/504, a 503 that is not a challenge) are retried up to
  // `retries` times with jittered backoff, honouring Retry-After up to 10 s. Blocks are never retried.
  async rawWithRetry(url, opts) {
    for (let n = 0; ; n++) {
      try {
        const res = await this.raw(url, opts);
        const transient = RETRY_STATUS.has(res.status) || (res.status === 503 && !CHALLENGE.test(String(res.text || '').slice(0, 20000)));
        if (!transient || n >= this.retries) return res;
        const ra = res.retryAfter ? parseDuration(res.retryAfter) : 0;
        await sleep(ra > 0 && ra <= 10000 ? ra : backoff(n, { base: this.backoffBase }));
      } catch (e) {
        if (!(e instanceof FetchError) || !RETRY_CODES.has(e.code) || n >= this.retries) throw e;
        await sleep(backoff(n, { base: this.backoffBase }));
      }
    }
  }

  // Used by map.js: a polite fetch with robots + rate limit, but no extraction.
  async page(url, opts = {}) {
    const c = canonicalize(url);
    if (!c) return null;
    const domain = domainOf(c);
    const rb = await this.robots.check(c);
    if (!rb.ok) return null;
    const release = await this.limiter.acquire(domain, rb.delayMs);
    try { return await this.raw(c, opts); } finally { release(); }
  }

  async fetch(url, { revisit = true } = {}) {
    const c = canonicalize(url);
    if (!c) return { ok: false, reason: 'Not a valid web address', url };
    const shape = this.guard.check(c);
    if (!shape.ok) return { ok: false, reason: shape.reason, url: c, policy: true, kind: shape.tier === 'deny' ? 'denied' : 'policy' };
    const domain = shape.domain;
    if (this.evidence.isBlocked(domain)) return { ok: false, deferred: true, kind: 'blocked', reason: 'This site blocked us recently; waiting before trying again', url: c };
    const rb = await this.robots.check(c);
    if (!rb.ok) return { ok: false, reason: rb.reason, url: c, policy: true, kind: 'robots' };
    const prev = revisit ? this.evidence.sourceByUrl(c) : null;
    const release = await this.limiter.acquire(domain, rb.delayMs);
    let res;
    try {
      res = await this.rawWithRetry(c, { etag: prev && prev.etag, lastModified: prev && prev.lastModified, allowPdf: true });
    } catch (e) {
      const policy = ['blocked_url', 'blocked_address', 'bad_redirect'].includes(e.code);
      return { ok: false, reason: e.message, url: c, code: e.code, policy, kind: policy ? 'policy' : 'error' };
    } finally {
      release();
    }
    this.evidence.notePage(domain, res.status);
    if (res.notModified) return { ok: true, notModified: true, url: res.url, source: prev };

    // A redirect may land on another site: re-check the final URL's tier and robots.
    const finalUrl = res.url || c;
    if (finalUrl !== c) {
      const fin = this.guard.check(finalUrl);
      if (!fin.ok) return { ok: false, reason: fin.reason, url: finalUrl, policy: true, kind: fin.tier === 'deny' ? 'denied' : 'policy' };
      const rb2 = await this.robots.check(finalUrl);
      if (!rb2.ok) return { ok: false, reason: rb2.reason, url: finalUrl, policy: true, kind: 'robots' };
    }

    if (res.isPdf) {
      try {
        const page = await extractPdf(res.buffer, finalUrl);
        if (page.visibleChars < 120) return { ok: false, kind: 'empty', reason: 'The PDF has no readable text (scanned image?)', url: finalUrl };
        this.evidence.noteOk(domain);
        return { ok: true, url: finalUrl, page, res: { status: res.status, etag: res.etag, lastModified: res.lastModified, address: res.address, hops: res.hops } };
      } catch (e) {
        return { ok: false, kind: 'error', reason: `Could not read the PDF (${e.message})`, url: finalUrl };
      }
    }

    const isHtml = /html|xml/i.test(res.contentType || '') || !res.contentType;
    let ext = isHtml && res.status < 400 ? extract(res.text, finalUrl) : null;
    let v = classify({
      status: res.status, text: res.text, visibleChars: ext ? ext.visibleChars : null, title: ext ? ext.title : '', scriptCount: ext ? ext.scriptCount : null,
      bodyChars: ext ? ext.bodyChars : null, structured: ext ? ext.jsonld.length > 0 || Boolean(ext.description) : false,
    });
    if (v.verdict === 'blocked') {
      const wait = res.retryAfter ? parseDuration(res.retryAfter) : 0;
      if (wait) this.limiter.penalize(domain, wait);
      // The circuit breaker opens after 2 consecutive blocks; a single one only defers this page.
      const n = this.evidence.noteBlock(domain, v.reason);
      if (n >= 2) {
        const until = this.evidence.trip(domain, v.reason);
        return { ok: false, deferred: true, blocked: true, kind: 'blocked', reason: `${v.reason}. Paused this site until ${new Date(until).toLocaleTimeString()}; open it yourself if you need it.`, url: finalUrl };
      }
      return { ok: false, deferred: true, blocked: true, kind: 'blocked', reason: `${v.reason}. Skipped this page; one more block pauses the site.`, url: finalUrl };
    }
    // JavaScript-only page and rendering is enabled: render it once, with every request guarded.
    if (v.verdict === 'js_required' && this.renderer && this.renderer.available()) {
      try {
        const out = await this.renderer.render(finalUrl);
        const fin = canonicalize(out.url) || finalUrl;
        if (fin !== finalUrl && !this.guard.check(fin).ok) return { ok: false, kind: 'policy', reason: 'The rendered page moved to a site that is not allowed', url: fin };
        ext = extract(out.html, fin);
        v = classify({ status: out.status, text: out.html, visibleChars: ext.visibleChars, title: ext.title, scriptCount: 0, bodyChars: ext.bodyChars, structured: ext.jsonld.length > 0 });
        if (v.verdict === 'ok') ext.rendered = true;
      } catch (e) {
        return { ok: false, deferred: true, kind: 'js', reason: `Needs JavaScript; rendering failed (${String(e.message).slice(0, 80)})`, url: finalUrl };
      }
    }
    if (v.verdict !== 'ok') return { ok: false, deferred: v.verdict === 'js_required', kind: v.verdict === 'js_required' ? 'js' : v.verdict, reason: v.reason, url: finalUrl, verdict: v.verdict };
    this.evidence.noteOk(domain);
    if (!ext) {
      const text = String(res.text || '');
      return { ok: true, url: finalUrl, page: { url: finalUrl, title: '', markdown: text.slice(0, 200000), text, links: [], jsonld: [], mailtos: [], visibleChars: text.length, contentHash: null, simhash: '0' }, res };
    }
    // rel=canonical: the page's own preferred address, if it is on the same site and allowed.
    let canonical = null;
    if (ext.canonical && ext.canonical !== finalUrl && domainOf(ext.canonical) === domainOf(finalUrl) && this.guard.check(ext.canonical).ok) {
      canonical = ext.canonical;
      ext.url = canonical;
    }
    return { ok: true, url: canonical || finalUrl, canonical, page: ext, res: { status: res.status, etag: res.etag, lastModified: res.lastModified, address: res.address, hops: res.hops } };
  }
}

module.exports = { Fetcher, backoff };
