'use strict';
const fs = require('fs');
const { writeAtomic, writeJson, readJson } = require('../fsutil');

// A flat vector index: one Float32Array, exact cosine by dot product (vectors are unit length).
// For a personal graph (≤5000 nodes, ≤20000 chunks) brute force is a few milliseconds, exact, and needs
// no index build, which is why there is no HNSW here. Persisted as <name>.bin + <name>.json.

class VectorIndex {
  constructor(file, { dim = 384, version = null, cap = Infinity } = {}) {
    this.file = file;
    this.dim = dim;
    this.cap = cap;
    this.version = version;
    this.ids = [];
    this.meta = [];
    this.pos = new Map();
    this.data = new Float32Array(dim * 64);
    this.dirty = false;
  }

  get size() { return this.ids.length; }

  load() {
    const head = readJson(`${this.file}.json`, null);
    if (!head || head.dim !== this.dim || !Array.isArray(head.ids)) return this;
    let buf;
    try { buf = fs.readFileSync(`${this.file}.bin`); } catch { return this; }
    if (buf.length !== head.ids.length * this.dim * 4) return this;
    this.version = head.version;
    this.ids = head.ids;
    this.meta = head.meta || head.ids.map(() => ({}));
    this.data = new Float32Array(Math.max(this.dim * 64, buf.length / 4));
    this.data.set(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    this.ids.forEach((id, i) => this.pos.set(id, i));
    return this;
  }

  save() {
    if (!this.dirty) return;
    const n = this.ids.length * this.dim;
    writeAtomic(`${this.file}.bin`, Buffer.from(this.data.buffer, this.data.byteOffset, n * 4));
    writeJson(`${this.file}.json`, { dim: this.dim, version: this.version, ids: this.ids, meta: this.meta });
    this.dirty = false;
  }

  // Drop everything if the embedder changed: vectors from different models are not comparable.
  ensureVersion(v) {
    if (this.version === v) return false;
    this.version = v; this.ids = []; this.meta = []; this.pos = new Map(); this.dirty = true;
    return true;
  }

  has(id) { return this.pos.has(id); }
  getMeta(id) { const i = this.pos.get(id); return i == null ? null : this.meta[i]; }

  vector(id) {
    const i = this.pos.get(id);
    return i == null ? null : this.data.subarray(i * this.dim, (i + 1) * this.dim);
  }

  upsert(id, vec, meta = {}) {
    if (vec.length !== this.dim) throw new Error('Vector dimension mismatch');
    let i = this.pos.get(id);
    if (i == null) {
      if (this.ids.length >= this.cap) this.remove(this.ids[0]); // oldest first
      i = this.ids.length;
      if ((i + 1) * this.dim > this.data.length) {
        const next = new Float32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
      this.ids.push(id); this.meta.push(meta); this.pos.set(id, i);
    } else {
      this.meta[i] = meta;
    }
    this.data.set(vec, i * this.dim);
    this.dirty = true;
  }

  remove(id) {
    const i = this.pos.get(id);
    if (i == null) return;
    const last = this.ids.length - 1;
    if (i !== last) {
      this.data.copyWithin(i * this.dim, last * this.dim, (last + 1) * this.dim);
      this.ids[i] = this.ids[last]; this.meta[i] = this.meta[last]; this.pos.set(this.ids[i], i);
    }
    this.ids.pop(); this.meta.pop(); this.pos.delete(id);
    this.dirty = true;
  }

  // → [{ id, score, meta }] best first
  search(q, k = 10, filter = null) {
    const n = this.ids.length; const d = this.dim;
    const top = [];
    for (let i = 0; i < n; i++) {
      if (filter && !filter(this.meta[i], this.ids[i])) continue;
      let s = 0;
      const o = i * d;
      for (let j = 0; j < d; j++) s += this.data[o + j] * q[j];
      if (top.length < k) { top.push([s, i]); if (top.length === k) top.sort((a, b) => a[0] - b[0]); } else if (s > top[0][0]) {
        top[0] = [s, i];
        top.sort((a, b) => a[0] - b[0]);
      }
    }
    return top.sort((a, b) => b[0] - a[0]).map(([score, i]) => ({ id: this.ids[i], score, meta: this.meta[i] }));
  }
}

module.exports = { VectorIndex };
