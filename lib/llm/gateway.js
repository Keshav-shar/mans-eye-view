'use strict';
const path = require('path');
const fs = require('fs');
const { completeJson } = require('./client');
const { validate } = require('./validate');
const { TASKS } = require('./prompts');
const { readJson, writeJson, sha } = require('../fsutil');

// Every gated LLM call in the research pipeline goes through here. It owns:
// - budgets that count ATTEMPTS and TOKENS (not just successes), so retries are never free;
// - a per-model gate fed by Groq's x-ratelimit-* headers and retry-after;
// - a content-addressed disk cache (same task + model + input → no new call);
// - schema validation of every answer (off-schema → null, never a throw into the pipeline);
// - a model fallback: if the fast/guard model is unusable on this key, the call moves to smart.
// It never throws: failures return null and are counted, so a session degrades to rules-only.

function parseDuration(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str) * 1000;
  let ms = 0;
  for (const [, n, unit] of str.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const v = Number(n);
    ms += unit === 'h' ? v * 3600000 : unit === 'm' ? v * 60000 : unit === 's' ? v * 1000 : v;
  }
  return ms;
}

// Per-model pacing. Groq's free tier allows e.g. 8,000 tokens per minute per model, refilled
// continuously, so a burst of page reads drains it in seconds. Instead of skipping calls, each call
// estimates its tokens and waits (one at a time, up to maxWait) until the bucket has enough.
class RateGate {
  constructor(minGapMs = 150) { this.nextAt = 0; this.minGap = minGapMs; this.tok = null; this.chain = Promise.resolve(); this.waited = 0; this.dailyOut = false; }

  _have(now) {
    if (!this.tok) return Infinity;
    const rate = this.tok.limit / 60000; // tokens per ms
    return Math.min(this.tok.limit, this.tok.remaining + rate * (now - this.tok.at));
  }

  take(need = 0, maxWaitMs = 60000) {
    const run = async () => {
      if (this.dailyOut) return false;
      const now = Date.now();
      let wait = this.nextAt - now;
      if (this.tok && need) {
        const have = this._have(now);
        if (have < need) wait = Math.max(wait, (need - Math.max(0, have)) / (this.tok.limit / 60000));
      }
      if (wait > maxWaitMs) return false;
      if (wait > 0) { this.waited += wait; await new Promise((r) => setTimeout(r, wait)); }
      const t = Date.now();
      if (this.tok && need) { this.tok.remaining = Math.max(0, this._have(t) - need); this.tok.at = t; } // reserve
      this.nextAt = Math.max(t, this.nextAt) + this.minGap;
      return true;
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }

  update(headers = {}) {
    const reqLeft = Number(headers['x-ratelimit-remaining-requests']);
    const tokLeft = Number(headers['x-ratelimit-remaining-tokens']);
    const tokLimit = Number(headers['x-ratelimit-limit-tokens']);
    if (Number.isFinite(tokLimit) && tokLimit > 0 && Number.isFinite(tokLeft)) this.tok = { limit: tokLimit, remaining: tokLeft, at: Date.now() };
    let until = 0;
    if (Number.isFinite(reqLeft) && reqLeft <= 0) {
      const reset = parseDuration(headers['x-ratelimit-reset-requests']);
      if (reset > 10 * 60000) this.dailyOut = true; // the daily request allowance is used up
      until = Math.max(until, reset);
    }
    if (!this.tok && Number.isFinite(tokLeft) && tokLeft < 1500) until = Math.max(until, parseDuration(headers['x-ratelimit-reset-tokens']));
    if (headers['retry-after']) until = Math.max(until, parseDuration(headers['retry-after']));
    if (until > 0) this.nextAt = Math.max(this.nextAt, Date.now() + Math.min(until, 60000));
  }
}

class Gateway {
  constructor({ cfg, router, cacheDir = null, maxCalls = 60, maxTokens = 150000, complete = completeJson, cacheTtlMs = 7 * 864e5 }) {
    this.cfg = cfg;
    this.router = router;
    this.cacheDir = cacheDir;
    this.maxCalls = maxCalls;
    this.maxTokens = maxTokens;
    this.complete = complete;
    this.cacheTtl = cacheTtlMs;
    this.gates = new Map();
    this.mem = new Map();
    this.stats = { calls: 0, tokens: 0, cacheHits: 0, failures: 0, invalid: 0, byTask: {}, units: 0, failReasons: {} };
    this.lastError = null;
    if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  }

  gate(model) {
    if (!this.gates.has(model)) this.gates.set(model, new RateGate());
    return this.gates.get(model);
  }

  enabled() { return Boolean(this.cfg && this.cfg.groqKey && this.router && this.router.get('smart')); }

  budgetOk(extraTokens = 0) {
    return this.enabled() && this.stats.calls < this.maxCalls && this.stats.tokens + extraTokens < this.maxTokens;
  }

  // Work units processed (pages, mentions). Kept for the AI-call ratio metric.
  addUnits(n = 1) { this.stats.units += n; }

  usage() {
    const s = this.stats;
    const waitedMs = [...this.gates.values()].reduce((a, g) => a + g.waited, 0);
    return { ...s, ratio: s.units ? +(s.calls / s.units).toFixed(3) : 0, maxCalls: this.maxCalls, maxTokens: this.maxTokens, lastError: this.lastError, waitedMs: Math.round(waitedMs) };
  }

  _cacheGet(key) {
    if (this.mem.has(key)) return this.mem.get(key);
    if (!this.cacheDir) return undefined;
    const hit = readJson(path.join(this.cacheDir, `${key}.json`), null);
    if (hit && Date.now() - hit.at < this.cacheTtl) { this.mem.set(key, hit.value); return hit.value; }
    return undefined;
  }

  _cacheSet(key, value) {
    this.mem.set(key, value);
    if (this.mem.size > 500) this.mem.delete(this.mem.keys().next().value);
    if (this.cacheDir) { try { writeJson(path.join(this.cacheDir, `${key}.json`), { at: Date.now(), value }); } catch { /* cache is best-effort */ } }
  }

  // Why calls fail, per task and reason ("extract_page: invalid-json"), so a session can say so.
  fail(taskName, reason, err = null) {
    this.stats.failures++;
    const k = `${taskName}: ${reason}`;
    this.stats.failReasons[k] = (this.stats.failReasons[k] || 0) + 1;
    if (err) this.lastError = `${taskName}: ${String(err).slice(0, 200)}`;
  }

  // run('extract_relations', input) → validated object or null.
  async run(taskName, input, { maxTokens = 1500, role = null } = {}) {
    const task = TASKS[taskName];
    if (!task) throw new Error(`Unknown task ${taskName}`);
    let model = this.router.get(role || task.role);
    if (!model) return null;
    const user = task.user(input);
    const key = sha(JSON.stringify([taskName, model, task.system, user]));
    const hit = this._cacheGet(key);
    if (hit !== undefined) { this.stats.cacheHits++; return validate(task.schema, hit); }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.budgetOk(maxTokens / 4)) return null;
      // Estimated tokens for this call: prompt (~4 chars per token) plus about half the answer allowance.
      const need = Math.ceil((task.system.length + user.length) / 4) + Math.ceil(maxTokens / 2);
      const okToGo = await this.gate(model).take(need);
      if (!okToGo) { this.lastError = this.gate(model).dailyOut ? 'Groq daily request limit reached' : 'Rate limited; skipped'; this.stats.skipped = (this.stats.skipped || 0) + 1; return null; }
      this.stats.calls++;
      this.stats.byTask[taskName] = (this.stats.byTask[taskName] || 0) + 1;
      try {
        const raw = await this.complete(this.cfg, [{ role: 'system', content: task.system }, { role: 'user', content: user }], {
          model, schema: task.schema, schemaName: taskName, maxTokens, temperature: 0, effort: 'low', timeoutMs: 45000,
          onResponse: (r) => {
            this.gate(model).update(r.headers || {});
            const used = r.data && r.data.usage && Number(r.data.usage.total_tokens);
            this.stats.tokens += Number.isFinite(used) ? used : Math.ceil((task.system.length + user.length) / 4);
          },
        });
        const value = validate(task.schema, task.prepare ? task.prepare(raw) : raw);
        if (value == null) { this.stats.invalid++; this.fail(taskName, 'schema', 'the answer did not match the expected shape'); return null; }
        this._cacheSet(key, value);
        // After a model fallback, later calls compute their key with the new model: cache under it too.
        const finalKey = sha(JSON.stringify([taskName, model, task.system, user]));
        if (finalKey !== key) this._cacheSet(finalKey, value);
        return value;
      } catch (e) {
        this.lastError = `${taskName}: ${e.message}`;
        if (e.kind === 'rate') { this.gate(model).update({ 'retry-after': String(e.retryAfter || 5) }); continue; }
        if (e.kind === 'model' && model !== this.router.get('smart')) {
          this.router.markUnavailable(model);
          model = this.router.get('smart');
          continue;
        }
        this.fail(taskName, /valid JSON/.test(e.message) ? 'invalid-json' : /too long/.test(e.message) ? 'timeout' : e.kind || 'error', e.message);
        return null;
      }
    }
    this.fail(taskName, 'rate', 'rate limited twice');
    return null;
  }
}

module.exports = { Gateway, RateGate, parseDuration };
