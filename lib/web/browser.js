'use strict';

// Optional headless rendering for pages that only show content after JavaScript runs.
// Off unless NEXUS_BROWSER=on in .env, and only if Playwright is installed:
//   npm install playwright && npx playwright install chromium
//
// A rendered page runs the site's own scripts, so every request it makes is checked here:
//   - only https, only allowed hosts (deny list applies), and the host must resolve to public addresses;
//   - images, fonts and media are never downloaded;
//   - no cookies are kept (a fresh context per page), no extra headers, no downloads;
//   - 20 s per page, one page at a time.
// It is used ONLY for pages judged "JavaScript-only". Blocked pages and bot walls are never rendered.

const BLOCK_TYPES = new Set(['image', 'media', 'font', 'websocket', 'eventsource', 'manifest', 'other']);

// Decide one request from a rendered page. Exported for tests.
async function decideRequest(url, resourceType, guard) {
  if (BLOCK_TYPES.has(resourceType)) return { allow: false, reason: 'asset' };
  if (/^(data|blob|about):/i.test(url)) return { allow: true };
  const shape = guard.check(url);
  if (!shape.ok) return { allow: false, reason: shape.reason };
  const addr = await guard.resolve(shape.host);
  if (!addr.ok) return { allow: false, reason: addr.reason };
  return { allow: true };
}

class Renderer {
  constructor({ guard, userAgent, loader = () => require('playwright') }) {
    this.guard = guard;
    this.ua = userAgent;
    this.loader = loader;
    this.browser = null;
    this.error = null;
    this.queue = Promise.resolve();
    this.stats = { pages: 0, blockedRequests: 0 };
  }

  available() {
    if (this.error) return false;
    try { this.loader(); return true; } catch (e) { this.error = 'Playwright is not installed (npm install playwright && npx playwright install chromium)'; return false; }
  }

  async _browser() {
    if (this.browser) return this.browser;
    const { chromium } = this.loader();
    this.browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    return this.browser;
  }

  // → { status, html, url } or throws
  render(url, { timeoutMs = 20000 } = {}) {
    const run = async () => {
      const browser = await this._browser();
      const context = await browser.newContext({ userAgent: this.ua, javaScriptEnabled: true, acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false });
      try {
        await context.route('**/*', async (route) => {
          const req = route.request();
          const d = await decideRequest(req.url(), req.resourceType(), this.guard).catch(() => ({ allow: false }));
          if (d.allow) return route.continue();
          this.stats.blockedRequests++;
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        const resp = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: Math.min(6000, timeoutMs / 2) }).catch(() => {});
        const html = await page.content();
        this.stats.pages++;
        return { status: resp ? resp.status() : 200, html: html.slice(0, 6 * 1024 * 1024), url: page.url() };
      } finally {
        await context.close().catch(() => {});
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  async close() { if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; } }
}

module.exports = { Renderer, decideRequest, BLOCK_TYPES };
