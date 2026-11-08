'use strict';
const { post } = require('./client');
const { sha } = require('../fsutil');

// Screens untrusted chunks before they reach any LLM. Uses Llama Prompt Guard 2 on the same Groq
// key when the router found one; otherwise (or on any error) a heuristic. Flagged chunks are kept
// out of LLM context but remain available to the rules-based extractors, which cannot be steered.

const PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?)\b/i,
  /\byou are now\b|\bact as (an?|the)\b[^.\n]{0,30}\b(ai|assistant|model|system)\b/i,
  /\b(system|developer) (prompt|message|instructions?)\b/i,
  /<\/?\s*(system|assistant|developer|untrusted[_a-z]*)\s*>/i,
  /\b(jailbreak|do anything now|dan mode|developer mode)\b/i,
  /\b(reveal|print|output|leak)\b[^.\n]{0,30}\b(prompt|instructions|api key|secret)\b/i,
  /\b(new|updated) instructions?\s*:/i,
  /\bBEGIN (SYSTEM|INSTRUCTIONS|PROMPT)\b/i,
];

function heuristicScore(text) {
  const s = String(text || '');
  let hits = 0;
  for (const p of PATTERNS) if (p.test(s)) hits++;
  return hits === 0 ? 0 : Math.min(1, 0.6 + hits * 0.15);
}

class Guard {
  constructor({ cfg, router, maxCalls = 120, threshold = 0.5 }) {
    this.cfg = cfg;
    this.router = router;
    this.maxCalls = maxCalls;
    this.threshold = threshold;
    this.calls = 0;
    this.cache = new Map();
    this.flagged = 0;
  }

  async modelScore(text) {
    const model = this.router && this.router.get('guard');
    if (!model || !this.cfg || !this.cfg.groqKey || this.calls >= this.maxCalls) return null;
    this.calls++;
    try {
      const r = await post(this.cfg, { model, messages: [{ role: 'user', content: text.slice(0, 1800) }], max_completion_tokens: 8, temperature: 0 }, { timeoutMs: 15000 });
      if (!r.ok) {
        if (r.status === 404 || r.status === 400) this.router.markUnavailable(model);
        return null;
      }
      const content = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
      const n = Number.parseFloat(String(content || '').trim());
      if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
      if (/unsafe|malicious|injection|jailbreak/i.test(String(content))) return 0.9;
      if (/safe|benign/i.test(String(content))) return 0.05;
      return null;
    } catch {
      return null;
    }
  }

  // → [{ text, score, safe, by }]
  async screen(chunks) {
    const out = [];
    for (const text of chunks) {
      const key = sha(text, 'sha1');
      if (this.cache.has(key)) { out.push({ text, ...this.cache.get(key) }); continue; }
      const h = heuristicScore(text);
      const m = h >= this.threshold ? null : await this.modelScore(text);
      const score = Math.max(h, m == null ? 0 : m);
      const res = { score, safe: score < this.threshold, by: m == null ? 'heuristic' : 'model' };
      if (!res.safe) this.flagged++;
      this.cache.set(key, res);
      out.push({ text, ...res });
    }
    return out;
  }
}

module.exports = { Guard, heuristicScore };
