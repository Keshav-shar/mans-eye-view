'use strict';

// Politeness: at most `concurrency` requests in flight overall, at most one at a time per domain,
// and at least `minDelayMs` (or the site's Crawl-delay, or its Retry-After) between hits to a domain.

class DomainLimiter {
  constructor({ minDelayMs = 1000, concurrency = 4, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.minDelay = minDelayMs;
    this.max = concurrency;
    this.now = now;
    this.sleep = sleep;
    this.active = 0;
    this.waiters = [];
    this.next = new Map(); // domain → earliest next start (ms)
    this.busy = new Set();
  }

  async _slot() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise((r) => this.waiters.push(r));
    this.active++;
  }

  _free() {
    this.active--;
    const w = this.waiters.shift();
    if (w) w();
  }

  // Waits for a slot, then returns release(). delayMs = the site's crawl-delay, if any.
  async acquire(domain, delayMs = 0) {
    for (;;) {
      if (!this.busy.has(domain)) {
        const wait = (this.next.get(domain) || 0) - this.now();
        if (wait <= 0) break;
        await this.sleep(Math.min(wait, 60000));
      } else {
        await this.sleep(100);
      }
    }
    this.busy.add(domain);
    await this._slot();
    const gap = Math.max(this.minDelay, delayMs);
    this.next.set(domain, this.now() + gap);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(domain);
      this.next.set(domain, Math.max(this.next.get(domain) || 0, this.now() + gap));
      this._free();
    };
  }

  // A 429/503 Retry-After pushes the domain's next start back.
  penalize(domain, ms) {
    this.next.set(domain, Math.max(this.next.get(domain) || 0, this.now() + Math.min(ms, 3600000)));
  }
}

module.exports = { DomainLimiter };
