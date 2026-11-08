'use strict';
const { hashVector } = require('../ml/tfidf');

// Sentence embeddings, locally. Groq serves no embedding models, so:
//   primary  — all-MiniLM-L6-v2 (384-d, mean pooled, L2-normalised) via @huggingface/transformers,
//              downloaded once (~23 MB quantised) into data/web/models and then used offline;
//   fallback — a 384-d signed feature-hashing vector (lib/ml/tfidf.js), pure JS, no download.
// `version` is stored with every vector; indexes never mix versions and re-embed when it changes.

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

class Embedder {
  constructor({ prefer = 'transformers', cacheDir = null, loader = () => import('@huggingface/transformers') } = {}) {
    this.prefer = prefer;
    this.cacheDir = cacheDir;
    this.loader = loader;
    this.pipe = null;
    this.version = 'hash384-v1';
    this.state = prefer === 'transformers' ? 'idle' : 'ready';
    this.error = null;
    this.ready = prefer === 'transformers' ? null : Promise.resolve(this);
    this.dim = DIM;
  }

  // Starts loading in the background; safe to call many times.
  init() {
    if (this.ready) return this.ready;
    this.state = 'loading';
    this.ready = (async () => {
      try {
        const T = await this.loader();
        if (this.cacheDir) T.env.cacheDir = this.cacheDir;
        T.env.allowLocalModels = true;
        this.pipe = await T.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        await this.pipe(['warm up'], { pooling: 'mean', normalize: true });
        this.version = 'minilm-l6-v2';
        this.state = 'ready';
      } catch (e) {
        this.pipe = null;
        this.version = 'hash384-v1';
        this.state = 'fallback';
        this.error = String(e && e.message ? e.message : e).slice(0, 300);
      }
      return this;
    })();
    return this.ready;
  }

  isReady() { return this.state === 'ready' || this.state === 'fallback'; }

  status() { return { prefer: this.prefer, state: this.state, version: this.version, model: this.pipe ? MODEL : 'feature hashing', error: this.error }; }

  // → Float32Array[] (unit length)
  async embed(texts) {
    const list = texts.map((t) => String(t || '').slice(0, 2000));
    if (!list.length) return [];
    if (this.pipe) {
      const out = [];
      for (let i = 0; i < list.length; i += 32) {
        const t = await this.pipe(list.slice(i, i + 32), { pooling: 'mean', normalize: true });
        const data = t.data;
        const n = t.dims[0];
        for (let j = 0; j < n; j++) out.push(Float32Array.from(data.subarray(j * DIM, (j + 1) * DIM)));
      }
      return out;
    }
    return list.map((t) => hashVector(t, DIM));
  }

  async embedOne(text) { return (await this.embed([text]))[0]; }
}

module.exports = { Embedder, DIM, MODEL };
