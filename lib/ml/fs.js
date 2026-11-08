'use strict';
const { normalize, jaroWinkler, tokenSetRatio, jaccard, cosine } = require('./text');

// Fellegi-Sunter record linkage for "is this web mention the same entity as that node?".
//
// The pasted design scored name_jw, name_tok and embedding as separate agree/disagree features. Those
// are strongly correlated, so summing their log-likelihood ratios over-counts the same evidence and
// pushes p_same towards 1 for any similar name. Here the name is ONE comparison with ordered levels
// (exact > jaro-winkler ≥ .92 > token-set ≥ .90 > none), and the other comparisons are chosen to be
// roughly independent of it: context embedding, neighbour overlap, and shared web domain.
// m = P(level | same entity), u = P(level | different). Priors are hand-set; fitEM() re-estimates them
// from unlabelled candidate pairs and fitLabelled() from your review decisions.

const PRIORS = {
  prior: 0.1,
  m: {
    name: { exact: 0.8, jw: 0.12, tok: 0.05, none: 0.03 },
    emb: { high: 0.7, mid: 0.2, low: 0.1 },
    nbr: { yes: 0.4, no: 0.6 },
    domain: { yes: 0.5, no: 0.5 },
  },
  u: {
    name: { exact: 0.002, jw: 0.01, tok: 0.02, none: 0.968 },
    emb: { high: 0.03, mid: 0.12, low: 0.85 },
    nbr: { yes: 0.02, no: 0.98 },
    domain: { yes: 0.05, no: 0.95 },
  },
};

// Exclusive identifiers: one entity has one of each. Different values ⇒ different entities (veto).
const EXCLUSIVE = ['domain', 'github', 'linkedin', 'crunchbase', 'wikidata'];

function nameLevel(a, b, aliases = []) {
  const na = normalize(a);
  const names = [b, ...aliases];
  if (names.some((x) => normalize(x) === na)) return 'exact';
  if (names.some((x) => jaroWinkler(a, x) >= 0.92)) return 'jw';
  if (names.some((x) => tokenSetRatio(a, x) >= 0.9)) return 'tok';
  return 'none';
}

const embLevel = (c) => (c == null ? null : c >= 0.85 ? 'high' : c >= 0.7 ? 'mid' : 'low');

// features: { name, emb, nbr, domain } (levels; null = not observed, contributes nothing)
function compare(mention, node, ctx = {}) {
  const ids = mention.ids || {};
  const nid = node.identifiers || {};
  const conflict = EXCLUSIVE.find((ns) => ids[ns] && nid[ns] && ids[ns] !== nid[ns]);
  // Timeline veto: an organisation founded in a different year (more than a year apart) is not the same one.
  const founded = (v) => { const m = /\b(1[89]\d\d|20\d\d)\b/.exec(String(v || '')); return m ? Number(m[1]) : null; };
  const mYear = founded(mention.attrs && mention.attrs.founded);
  const nf = (node.fields || []).find((f) => /^founded$/i.test(f.key));
  const nYear = nf ? founded(nf.value) : null;
  const timeline = mYear && nYear && Math.abs(mYear - nYear) > 1 ? `Founded ${mYear} vs ${nYear}` : null;
  const levels = {
    name: nameLevel(mention.text, node.title, node.aliases || []),
    emb: embLevel(ctx.embCos),
    nbr: ctx.pageNeighbours && ctx.nodeNeighbours && ctx.nodeNeighbours.size
      ? (jaccard(ctx.pageNeighbours, ctx.nodeNeighbours) >= 0.2 ? 'yes' : 'no') : null,
    domain: ctx.domainMatch == null ? null : (ctx.domainMatch ? 'yes' : 'no'),
  };
  return { levels, veto: conflict ? `Different ${conflict}` : timeline };
}

class FellegiSunter {
  constructor(params = PRIORS) { this.p = structuredClone(params); }

  logOdds(levels) {
    let s = Math.log(this.p.prior / (1 - this.p.prior));
    for (const [k, lv] of Object.entries(levels)) {
      if (lv == null || !this.p.m[k]) continue;
      s += Math.log(Math.max(1e-6, this.p.m[k][lv]) / Math.max(1e-6, this.p.u[k][lv]));
    }
    return s;
  }

  score(mention, node, ctx = {}) {
    const { levels, veto } = compare(mention, node, ctx);
    const p = veto ? 0 : 1 / (1 + Math.exp(-this.logOdds(levels)));
    return { nodeId: node.id, p, levels, veto };
  }

  // Unsupervised EM over candidate pairs (arrays of level objects). Keeps priors as pseudo-counts so a
  // small or skewed sample cannot drive a probability to 0 or 1.
  fitEM(pairs, { iters = 40, pseudo = 5 } = {}) {
    if (pairs.length < 10) return this;
    for (let it = 0; it < iters; it++) {
      const g = pairs.map((lv) => 1 / (1 + Math.exp(-this.logOdds(lv))));
      const sumG = g.reduce((a, b) => a + b, 0);
      const next = { prior: Math.min(0.9, Math.max(0.01, sumG / pairs.length)), m: {}, u: {} };
      for (const k of Object.keys(this.p.m)) {
        next.m[k] = {}; next.u[k] = {};
        const lvls = Object.keys(this.p.m[k]);
        const mc = {}; const uc = {};
        for (const l of lvls) { mc[l] = pseudo * PRIORS.m[k][l]; uc[l] = pseudo * PRIORS.u[k][l]; }
        pairs.forEach((lv, i) => { if (lv[k] != null) { mc[lv[k]] += g[i]; uc[lv[k]] += 1 - g[i]; } });
        const ms = lvls.reduce((s, l) => s + mc[l], 0); const us = lvls.reduce((s, l) => s + uc[l], 0);
        for (const l of lvls) { next.m[k][l] = mc[l] / ms; next.u[k][l] = uc[l] / us; }
      }
      this.p = next;
    }
    return this;
  }

  // Supervised re-estimate from review decisions: [{ levels, match: true|false }].
  fitLabelled(labels, { pseudo = 10 } = {}) {
    const pos = labels.filter((x) => x.match); const neg = labels.filter((x) => !x.match);
    if (pos.length < 5 || neg.length < 5) return this;
    const est = (rows, base) => {
      const out = {};
      for (const k of Object.keys(base)) {
        const lvls = Object.keys(base[k]);
        const c = Object.fromEntries(lvls.map((l) => [l, pseudo * base[k][l]]));
        for (const r of rows) if (r.levels[k] != null && r.levels[k] in c) c[r.levels[k]] += 1;
        const s = lvls.reduce((a, l) => a + c[l], 0);
        out[k] = Object.fromEntries(lvls.map((l) => [l, c[l] / s]));
      }
      return out;
    };
    this.p = { prior: this.p.prior, m: est(pos, PRIORS.m), u: est(neg, PRIORS.u) };
    return this;
  }

  toJSON() { return this.p; }
}

module.exports = { FellegiSunter, PRIORS, compare, nameLevel, embLevel, EXCLUSIVE, cosine };
