'use strict';
const { tokens } = require('./text');

// Okapi BM25 over an in-memory inverted index. Small enough to rebuild for the whole tree (≤5000
// nodes) in milliseconds; also used for evidence chunks.

class BM25 {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.postings = new Map(); // term → Map(id → tf)
    this.len = new Map();
    this.total = 0;
  }

  get size() { return this.len.size; }

  add(id, text) {
    if (this.len.has(id)) this.remove(id);
    const ts = tokens(text);
    const tf = new Map();
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      if (!this.postings.has(t)) this.postings.set(t, new Map());
      this.postings.get(t).set(id, c);
    }
    this.len.set(id, ts.length);
    this.total += ts.length;
  }

  remove(id) {
    const l = this.len.get(id);
    if (l == null) return;
    for (const [t, m] of this.postings) { if (m.delete(id) && !m.size) this.postings.delete(t); }
    this.len.delete(id);
    this.total -= l;
  }

  // → [{ id, score }] best first. `filter(id)` restricts the candidates.
  search(query, k = 20, filter = null) {
    const N = this.len.size;
    if (!N) return [];
    const avg = this.total / N || 1;
    const scores = new Map();
    for (const t of new Set(tokens(query))) {
      const m = this.postings.get(t);
      if (!m) continue;
      const idf = Math.log(1 + (N - m.size + 0.5) / (m.size + 0.5));
      for (const [id, tf] of m) {
        if (filter && !filter(id)) continue;
        const dl = this.len.get(id) || 0;
        const s = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (dl / avg))));
        scores.set(id, (scores.get(id) || 0) + s);
      }
    }
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
  }
}

module.exports = { BM25 };
