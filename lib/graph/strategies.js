'use strict';
const { register } = require('../strategy');
const { mmr, centroid } = require('../ml/rank');
const { flat, tokens } = require('../ml/text');
const { domainOf } = require('../web/canonical');

// Graph-side judgement points (D3 adjudicator, D4 describer, D8 edge verifier). Each has a rules/ML
// default and an LLM alternative behind the same contract.

// ---- D4: descriptions -------------------------------------------------------------------------------
// Extractive MMR: the k sentences most central to what the page says about the entity, minus
// redundancy. Verbatim and short, so nothing is invented.
register('describer', 'mmr', ({ embedder }) => ({
  async run({ sentences, k = 2, maxLen = 600 }) {
    const list = [...new Set(sentences.map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 400))].slice(0, 30);
    if (!list.length) return '';
    if (list.length <= k) return list.join(' ').slice(0, maxLen);
    const vecs = await embedder.embed(list);
    const pick = mmr(vecs, centroid(vecs), k, 0.7).sort((a, b) => a - b);
    return pick.map((i) => list[i]).join(' ').slice(0, maxLen);
  },
}));

register('describer', 'llm', ({ gateway, embedder }) => {
  const fallback = { run: null };
  return {
    async run(input) {
      const out = input.sentences.length ? await gateway.run('describe', { name: input.name, type: input.type, facts: input.sentences.slice(0, 12) }, { maxTokens: 300 }) : null;
      if (out && out.text) {
        // Grounding: each output sentence must share most of its words with the facts it was given.
        const facts = new Set(tokens(input.sentences.join(' ')));
        const ok = out.text.split(/(?<=[.!?])\s+/).every((s) => { const t = tokens(s); return !t.length || t.filter((x) => facts.has(x)).length / t.length >= 0.6; });
        if (ok) return out.text.slice(0, 600);
      }
      if (!fallback.run) fallback.run = require('../strategy').build('describer', { strategies: { describer: { use: 'mmr' } } }, { embedder }).run;
      return fallback.run(input);
    },
  };
});

// ---- D3: adjudicate merges inside the ambiguous band --------------------------------------------------
register('adjudicator', 'llm', ({ gateway }) => ({
  async run({ mention, candidates }) {
    const out = await gateway.run('adjudicate', { mention, candidates: candidates.map((c) => c.card) }, { maxTokens: 300 });
    if (!out) return null;
    if (out.choice >= 0 && out.choice < candidates.length) return { action: 'merge', nodeId: candidates[out.choice].nodeId, reason: out.reason || '' };
    return { action: 'create', reason: out.reason || '' };
  },
}));

// ---- D8: does independent evidence support this edge? ---------------------------------------------------
// Co-occurrence across DISTINCT origins, excluding the pages that produced the claim (the pasted design's
// verifier counted its own source, which is circular).
register('edge_verifier', 'cooccurrence', ({ retrieval }) => ({
  async run({ a, b, exclude = new Set() }) {
    const hits = await retrieval.searchChunks(`${a} ${b}`, { k: 12, exclude });
    const fa = flat(a); const fb = flat(b);
    const both = hits.filter((h) => { const t = flat(h.text); return t.includes(fa) && t.includes(fb); });
    const domains = new Set(both.map((h) => domainOf(h.url)));
    const supported = both.length >= 2 && domains.size >= 2;
    return { supported, confidence: Math.min(0.95, 0.4 + 0.15 * both.length + 0.1 * domains.size), evidence: both.slice(0, 3).map((h) => ({ url: h.url, text: h.text.slice(0, 300) })) };
  },
}));

register('edge_verifier', 'llm', ({ gateway, retrieval }) => ({
  async run({ a, b, rel, exclude = new Set() }) {
    const hits = await retrieval.searchChunks(`${a} ${b}`, { k: 5, exclude });
    if (!hits.length) return { supported: false, confidence: 0, evidence: [] };
    const out = await gateway.run('verify_edge', { claim: `${a} ${rel} ${b}`, evidence: hits.map((h) => h.text.slice(0, 600)) }, { maxTokens: 200 });
    return out ? { supported: out.supported, confidence: out.confidence, evidence: hits.slice(0, 3).map((h) => ({ url: h.url, text: h.text.slice(0, 300) })) } : { supported: false, confidence: 0, evidence: [] };
  },
}));

module.exports = {};
