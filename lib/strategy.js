'use strict';

// Strategy registry: every judgement point has a rules/ML default and an AI alternative with the same
// contract `run(input, ctx) → result`. Config picks one; a `fallback` wraps them in GatedFallback so
// the AI only runs when the default is weak on a valuable input and the gateway has budget.

const REG = new Map();

function register(kind, name, factory) {
  if (!REG.has(kind)) REG.set(kind, new Map());
  REG.get(kind).set(name, factory);
}

function names(kind) { return [...(REG.get(kind) || new Map()).keys()]; }

// How "confident" a result is (0..1, low → fire the fallback) and how to combine two results.
const KINDS = {
  page_classifier: {
    signal: (r) => (r ? r.conf : 0),
    combine: (a, b) => (b ? { ...a, pageType: b.pageType, value: (a.value + b.value) / 2, conf: Math.max(a.conf, 0.7), source: 'llm' } : a),
  },
  entity_tagger: {
    // Coverage: how much of the page's capitalised vocabulary the rules explained. Few mentions on a
    // long page → low signal.
    signal: (r, input) => {
      const words = (String(input.text || '').match(/\b[A-Z][a-zA-Z]{2,}/g) || []).length;
      return words ? Math.min(1, (r.length * 4) / Math.max(8, words)) : 1;
    },
    combine: (a, b) => {
      const seen = new Set(a.map((m) => `${m.type}|${m.key}`));
      return [...a, ...(b || []).filter((m) => !seen.has(`${m.type}|${m.key}`))];
    },
  },
  relation_extractor: {
    // Coverage: share of mentions that take part in at least one relation. (Not min(conf): one weak
    // fact must not trigger an LLM call for the whole page, and zero facts on a thin page is fine.)
    signal: (r, input) => {
      const ms = (input.mentions || []).filter((m) => m.conf >= 0.6);
      if (ms.length < 2) return 1;
      const used = new Set();
      for (const f of r) { used.add(f.subj); used.add(f.obj); }
      return ms.filter((m) => used.has(m.mid)).length / ms.length;
    },
    combine: (a, b) => {
      const seen = new Set(a.map((f) => `${f.subj}|${f.rel}|${f.obj}`));
      return [...a, ...(b || []).filter((f) => !seen.has(`${f.subj}|${f.rel}|${f.obj}`))];
    },
  },
  query_generator: {
    signal: (r) => Math.min(1, r.length / 4),
    combine: (a, b) => [...new Set([...a, ...(b || [])])],
  },
};

class GatedFallback {
  constructor(kind, primary, secondary, gate, gateway) {
    this.kind = kind; this.p = primary; this.s = secondary; this.gate = gate || {}; this.gw = gateway;
    this.fired = 0;
  }

  shouldFire(signal, value) {
    return signal < (this.gate.below ?? 0) && value >= (this.gate.valueAbove ?? 0) && Boolean(this.gw && this.gw.budgetOk());
  }

  async run(input, ctx = {}) {
    const res = await this.p.run(input, ctx);
    const k = KINDS[this.kind];
    if (!k) return res;
    const signal = k.signal(res, input);
    if (!this.shouldFire(signal, ctx.value ?? 0)) return res;
    this.fired++;
    let extra = null;
    try { extra = await this.s.run(input, ctx); } catch { extra = null; }
    return k.combine(res, extra);
  }
}

function build(kind, settings, deps = {}) {
  const spec = (settings.strategies || {})[kind] || {};
  const make = (name) => {
    const f = REG.get(kind) && REG.get(kind).get(name);
    if (!f) throw new Error(`No ${kind} strategy named "${name}". Known: ${names(kind).join(', ')}`);
    return f(deps, spec.params || {});
  };
  if (!spec.use || spec.use === 'none') return null;
  const primary = make(spec.use);
  if (spec.fallback && spec.fallback.use && spec.fallback.use !== 'none' && spec.fallback.use !== spec.use) {
    return new GatedFallback(kind, primary, make(spec.fallback.use), spec.fallback.gate, deps.gateway);
  }
  return primary;
}

module.exports = { register, build, names, GatedFallback, KINDS };
