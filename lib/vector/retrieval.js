'use strict';
const path = require('path');
const { VectorIndex } = require('./index');
const { BM25 } = require('../ml/bm25');
const { rrf } = require('../ml/rank');
const { sha } = require('../fsutil');

// Hybrid retrieval over the tree's nodes and over evidence chunks from fetched pages:
// sparse (BM25) + dense (embeddings) fused with reciprocal rank fusion. Used by Ask/Capture context
// selection, entity blocking in the Graph Builder, duplicate warnings and query de-duplication.

const nodeText = (n) => [n.title, ...(n.aliases || []), n.type, n.summary, (n.tags || []).join(' ')].filter(Boolean).join(' . ');

class Retrieval {
  constructor({ dir, embedder, maxChunks = 20000 }) {
    this.embedder = embedder;
    this.nodesIdx = new VectorIndex(path.join(dir, 'nodes'), { dim: embedder.dim }).load();
    this.chunksIdx = new VectorIndex(path.join(dir, 'chunks'), { dim: embedder.dim, cap: maxChunks }).load();
    this.nodeBm = new BM25();
    this.chunkBm = null; // built lazily from chunk metadata
    this.rev = -1;
    this.syncing = null;
  }

  ready() { return this.embedder.isReady(); }

  // Bring node vectors up to date with the tree; only nodes whose text changed are re-embedded.
  async syncNodes(tree) {
    if (this.syncing) await this.syncing;
    if (tree.rev === this.rev && this.nodesIdx.version === this.embedder.version) return;
    this.syncing = (async () => {
      this.nodesIdx.ensureVersion(this.embedder.version);
      const nodes = Object.values(tree.nodes);
      const live = new Set(nodes.map((n) => n.id));
      for (const id of [...this.nodesIdx.ids]) if (!live.has(id)) this.nodesIdx.remove(id);
      this.nodeBm = new BM25();
      const todo = [];
      for (const n of nodes) {
        const text = nodeText(n);
        this.nodeBm.add(n.id, text);
        const h = sha(text, 'sha1').slice(0, 16);
        const m = this.nodesIdx.getMeta(n.id);
        if (!m || m.h !== h || m.type !== n.type) todo.push({ n, text, h });
      }
      for (let i = 0; i < todo.length; i += 64) {
        const part = todo.slice(i, i + 64);
        const vecs = await this.embedder.embed(part.map((x) => x.text));
        part.forEach((x, j) => this.nodesIdx.upsert(x.n.id, vecs[j], { h: x.h, type: x.n.type }));
      }
      this.nodesIdx.save();
      this.rev = tree.rev;
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  }

  // Sparse-only scores, synchronous; what lib/tree.js falls back to.
  bm25Nodes(query, k = 200) { return this.nodeBm.search(query, k); }

  // → Map(id → fused score), for lib/tree.js selectNodes. Dense part only when the embedder is ready.
  async rankNodes(tree, query, { k = 200 } = {}) {
    if (this.ready()) await this.syncNodes(tree);
    else if (tree.rev !== this.rev) { this.nodeBm = new BM25(); for (const n of Object.values(tree.nodes)) this.nodeBm.add(n.id, nodeText(n)); }
    const sparse = this.nodeBm.search(query, k);
    const lists = [sparse];
    if (this.ready() && this.nodesIdx.size) lists.push(this.nodesIdx.search(await this.embedder.embedOne(query), k).filter((r) => r.score > 0.2));
    const fused = rrf(lists);
    return new Map(fused.map((r) => [r.id, r.score]));
  }

  // Candidate nodes for entity resolution: exact/alias handled by the caller; this is dense + sparse.
  async candidates(tree, text, types, { k = 20, vec = null } = {}) {
    await this.syncNodes(tree);
    const ok = (id) => tree.nodes[id] && (!types || types.includes(tree.nodes[id].type));
    const sparse = this.nodeBm.search(text, k * 2, ok).slice(0, k);
    const q = vec || await this.embedder.embedOne(text);
    const dense = this.nodesIdx.search(q, k, (m, id) => ok(id));
    const cos = new Map(dense.map((r) => [r.id, r.score]));
    return { ids: rrf([sparse, dense]).slice(0, k).map((r) => r.id), cos, vec: q };
  }

  nodeVector(id) { return this.nodesIdx.vector(id); }

  async similarNodes(tree, text, type, { k = 3, min = 0.9 } = {}) {
    if (!this.ready()) return [];
    await this.syncNodes(tree);
    const q = await this.embedder.embedOne(text);
    return this.nodesIdx.search(q, k, (m) => !type || m.type === type).filter((r) => r.score >= min && tree.nodes[r.id]);
  }

  // ---- evidence chunks -------------------------------------------------------------------------
  _chunkBm() {
    if (!this.chunkBm) {
      this.chunkBm = new BM25();
      this.chunksIdx.ids.forEach((id, i) => this.chunkBm.add(id, this.chunksIdx.meta[i].text || ''));
    }
    return this.chunkBm;
  }

  // The embedder changed (e.g. the model finished downloading): re-embed stored chunk text instead of
  // throwing the evidence away.
  async migrateChunks() {
    if (this.chunksIdx.version === this.embedder.version) return;
    if (this.chunksIdx.version == null || !this.chunksIdx.size) { this.chunksIdx.ensureVersion(this.embedder.version); return; }
    const old = this.chunksIdx.ids.map((id, i) => [id, this.chunksIdx.meta[i]]);
    this.chunksIdx.ensureVersion(this.embedder.version);
    for (let i = 0; i < old.length; i += 64) {
      const part = old.slice(i, i + 64);
      const vecs = await this.embedder.embed(part.map(([, m]) => m.text || ''));
      part.forEach(([id, m], j) => this.chunksIdx.upsert(id, vecs[j], m));
    }
    this.chunkBm = null;
    this.chunksIdx.save();
  }

  async addChunks(sourceId, chunks, meta = {}) {
    await this.migrateChunks();
    const list = chunks.slice(0, 40).filter((c) => c && c.length >= 40);
    if (!list.length) return 0;
    const vecs = await this.embedder.embed(list);
    list.forEach((text, i) => {
      const id = `${sourceId}:${i}`;
      this.chunksIdx.upsert(id, vecs[i], { sourceId, text: text.slice(0, 1500), url: meta.url || '', title: meta.title || '', at: Date.now() });
      if (this.chunkBm) this.chunkBm.add(id, text);
    });
    return list.length;
  }

  async searchChunks(query, { k = 5, exclude = null } = {}) {
    if (!this.chunksIdx.size) return [];
    if (this.ready()) await this.migrateChunks();
    const okFn = (m) => !exclude || !exclude.has(m.sourceId);
    const sparse = this._chunkBm().search(query, k * 3, (id) => { const m = this.chunksIdx.getMeta(id); return m && okFn(m); });
    const lists = [sparse];
    if (this.ready()) lists.push(this.chunksIdx.search(await this.embedder.embedOne(query), k * 3, okFn));
    return rrf(lists).slice(0, k).map((r) => ({ id: r.id, score: r.score, ...this.chunksIdx.getMeta(r.id) })).filter((r) => r.text);
  }

  removeSource(sourceId) {
    const ids = this.chunksIdx.ids.filter((id) => id.startsWith(`${sourceId}:`));
    for (const id of ids) { this.chunksIdx.remove(id); if (this.chunkBm) this.chunkBm.remove(id); }
    return ids.length;
  }

  save() { this.nodesIdx.save(); this.chunksIdx.save(); }
}

module.exports = { Retrieval, nodeText };
