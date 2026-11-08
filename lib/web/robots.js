'use strict';
const robotsParser = require('robots-parser');

// robots.txt per origin, cached for a day. Semantics follow RFC 9309 with a conservative twist:
// - 2xx: obey the file;   - 404/410 and other 4xx: no rules (allowed);
// - 401/403: treated as "disallow everything" (the site is telling bots to stay out);
// - 5xx / network failure: disallow everything until the next check.

const TTL = 24 * 60 * 60 * 1000;
const FAIL_TTL = 30 * 60 * 1000;

class Robots {
  constructor({ fetchText, userAgent = 'NexusBot', now = () => Date.now() }) {
    this.fetchText = fetchText; // async (url) → { status, text }
    this.ua = userAgent.split('/')[0];
    this.now = now;
    this.cache = new Map();
  }

  async _get(origin) {
    const hit = this.cache.get(origin);
    if (hit && this.now() < hit.until) return hit;
    let entry;
    try {
      const res = await this.fetchText(`${origin}/robots.txt`);
      if (res.status >= 200 && res.status < 300) entry = { mode: 'rules', parser: robotsParser(`${origin}/robots.txt`, String(res.text || '').slice(0, 512 * 1024)), until: this.now() + TTL };
      else if (res.status === 401 || res.status === 403) entry = { mode: 'deny', until: this.now() + TTL };
      else if (res.status >= 400 && res.status < 500) entry = { mode: 'allow', until: this.now() + TTL };
      else entry = { mode: 'deny', until: this.now() + FAIL_TTL };
    } catch (e) {
      entry = { mode: e && e.code === 'not_found' ? 'allow' : 'deny', until: this.now() + FAIL_TTL };
    }
    this.cache.set(origin, entry);
    return entry;
  }

  // → { ok, delayMs, reason }
  async check(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return { ok: false, delayMs: 0, reason: 'Bad URL' }; }
    const e = await this._get(origin);
    if (e.mode === 'deny') return { ok: false, delayMs: 0, reason: 'robots.txt (or an unreachable robots.txt) disallows crawling' };
    if (e.mode === 'allow') return { ok: true, delayMs: 0 };
    const allowed = e.parser.isAllowed(url, this.ua);
    const delay = Number(e.parser.getCrawlDelay(this.ua)) || 0;
    return allowed === false
      ? { ok: false, delayMs: 0, reason: 'robots.txt disallows this page' }
      : { ok: true, delayMs: Math.min(60, delay) * 1000 };
  }

  async sitemaps(origin) {
    const e = await this._get(origin);
    return e.mode === 'rules' ? e.parser.getSitemaps().slice(0, 20) : [];
  }
}

module.exports = { Robots };
