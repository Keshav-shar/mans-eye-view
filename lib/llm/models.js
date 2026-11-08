'use strict';
const { readJson, writeJson } = require('../fsutil');

// Maps roles to models on the one Groq key. `GET /models` tells us what the key can use; any role
// whose model is missing falls back to GROQ_MODEL (smart). The guard role may be empty, in which
// case lib/llm/guard.js uses its heuristic only.

const ROLE_CANDIDATES = {
  fast: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'qwen/qwen3.8-27b'],
  guard: ['meta-llama/llama-prompt-guard-2-86m', 'meta-llama/llama-prompt-guard-2-22m'],
};
const TTL = 24 * 60 * 60 * 1000;

class ModelRouter {
  constructor(cfg, { cacheFile = null } = {}) {
    this.cfg = cfg;
    this.cacheFile = cacheFile;
    this.available = null; // Set of model ids, or null when unknown
    this.unavailable = new Set();
    this.checkedAt = 0;
    this.error = null;
    const cached = cacheFile && readJson(cacheFile, null);
    if (cached && Array.isArray(cached.ids) && Date.now() - cached.at < TTL) {
      this.available = new Set(cached.ids);
      this.checkedAt = cached.at;
    }
  }

  async refresh({ force = false } = {}) {
    if (!this.cfg.groqKey) return this;
    if (!force && this.available && Date.now() - this.checkedAt < TTL) return this;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`${this.cfg.groqBase}/models`, { headers: { Authorization: `Bearer ${this.cfg.groqKey}` }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ids = (Array.isArray(data.data) ? data.data : []).filter((m) => m && m.active !== false).map((m) => m.id).filter((x) => typeof x === 'string');
      this.available = new Set(ids);
      this.checkedAt = Date.now();
      this.error = null;
      if (this.cacheFile) writeJson(this.cacheFile, { at: this.checkedAt, ids });
    } catch (e) {
      this.error = e.message;
    } finally {
      clearTimeout(timer);
    }
    return this;
  }

  has(id) {
    if (!id || this.unavailable.has(id)) return false;
    return this.available ? this.available.has(id) : true; // unknown → optimistic, the gateway falls back on 404
  }

  get(role) {
    const smart = this.cfg.modelSmart || this.cfg.groqModel || null;
    if (role === 'smart') return smart;
    const override = role === 'fast' ? this.cfg.modelFast : role === 'guard' ? this.cfg.modelGuard : null;
    if (override && this.has(override)) return override;
    for (const id of ROLE_CANDIDATES[role] || []) {
      if (this.available ? this.has(id) : (role === 'fast' && id === ROLE_CANDIDATES.fast[0] && !this.unavailable.has(id))) return id;
    }
    return role === 'guard' ? null : smart;
  }

  markUnavailable(id) { if (id) this.unavailable.add(id); }

  roles() {
    return {
      fast: this.get('fast'), smart: this.get('smart'), guard: this.get('guard'),
      discovered: this.available ? this.available.size : null, error: this.error,
    };
  }
}

module.exports = { ModelRouter, ROLE_CANDIDATES };
