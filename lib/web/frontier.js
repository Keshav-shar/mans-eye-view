'use strict';
const { canonicalize, domainOf } = require('./canonical');

// Crawl frontier: a max-heap on priority. Every entry carries its depth and domain, and the depth and
// per-domain caps are enforced at push time (the pasted design only capped search-result URLs).

// Crawler traps: endless calendars, session-ID paths, faceted search loops.
function isTrap(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return true; }
  if (p.length > 200) return true;
  const segs = p.split('/').filter(Boolean);
  const count = new Map();
  for (const s of segs) { count.set(s, (count.get(s) || 0) + 1); if (count.get(s) > 2) return true; }
  return segs.length > 12;
}

class Frontier {
  constructor({ maxDepthFor = () => 2, capFor = () => 3 } = {}) {
    this.heap = [];
    this.seen = new Set();
    this.perDomain = new Map(); // domain → URLs admitted
    this.maxDepthFor = maxDepthFor;
    this.capFor = capFor;
    this.rejected = { seen: 0, depth: 0, cap: 0, invalid: 0 };
  }

  get size() { return this.heap.length; }

  admitted(domain) { return this.perDomain.get(domain) || 0; }

  // → { ok, reason }
  // Extra fields (branch, rParent, …) travel with the entry untouched.
  push({ url, depth = 0, priority = 0.5, parent = null, via = 'search', tier = 'open', anchor = '', ...extra }) {
    const c = canonicalize(url);
    if (!c) { this.rejected.invalid++; return { ok: false, reason: 'invalid' }; }
    if (this.seen.has(c)) { this.rejected.seen++; return { ok: false, reason: 'seen' }; }
    if (isTrap(c)) { this.rejected.trap = (this.rejected.trap || 0) + 1; return { ok: false, reason: 'trap' }; }
    const domain = domainOf(c);
    if (depth > this.maxDepthFor(tier)) { this.rejected.depth++; return { ok: false, reason: 'depth' }; }
    if (this.admitted(domain) >= this.capFor(tier, domain)) { this.rejected.cap++; return { ok: false, reason: 'domain cap' }; }
    this.seen.add(c);
    this.perDomain.set(domain, this.admitted(domain) + 1);
    this.heap.push({ ...extra, url: c, depth, priority, parent, via, tier, domain, anchor });
    this._up(this.heap.length - 1);
    return { ok: true };
  }

  // Priority of the best entry waiting, or 0 when empty.
  peekPriority() { return this.heap.length ? this.heap[0].priority : 0; }

  markSeen(url) { const c = canonicalize(url); if (c) this.seen.add(c); }

  pop() {
    if (!this.heap.length) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) { this.heap[0] = last; this._down(0); }
    return top;
  }

  popMany(n) {
    const out = [];
    while (out.length < n && this.heap.length) out.push(this.pop());
    return out;
  }

  _up(i) {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].priority >= h[i].priority) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }

  _down(i) {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1; const r = l + 1;
      let m = i;
      if (l < h.length && h[l].priority > h[m].priority) m = l;
      if (r < h.length && h[r].priority > h[m].priority) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }

  toJSON() { return { heap: this.heap, seen: [...this.seen].slice(-5000), perDomain: [...this.perDomain] }; }

  load(j) {
    if (!j) return this;
    this.heap = Array.isArray(j.heap) ? j.heap : [];
    this.seen = new Set(j.seen || []);
    this.perDomain = new Map(j.perDomain || []);
    return this;
  }
}

module.exports = { Frontier, isTrap };
