'use strict';
const { cosine } = require('../ml/text');

// Backlinker (D10): suggests links between nodes that are close in the graph but not connected.
// A personal tree is far too sparse to train LightGBM or a GNN, so this uses the classic neighbourhood
// scores plus embedding similarity:
//   Adamic-Adar  Σ 1/log(deg z)   over common neighbours z
//   Resource allocation  Σ 1/deg z
//   cosine of the two nodes' embeddings
// Area nodes and research-session nodes are ignored as neighbours (they connect everything).
// Output goes to the review queue as suggestions; nothing is written automatically.

const HUB_TYPES = new Set(['area', 'session']);

function adjacency(tree) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const n of Object.values(tree.nodes)) {
    if (HUB_TYPES.has(n.type)) continue;
    const p = n.parentId && tree.nodes[n.parentId];
    if (p && !HUB_TYPES.has(p.type)) add(n.id, p.id);
    for (const l of n.links || []) { const t = tree.nodes[l.to]; if (t && !HUB_TYPES.has(t.type)) add(n.id, t.id); }
  }
  return adj;
}

function suggest(tree, touched, { vectorOf = () => null, min = 0.35, max = 10 } = {}) {
  const adj = adjacency(tree);
  const deg = (id) => (adj.get(id) || new Set()).size;
  const seen = new Set();
  const out = [];
  for (const a of touched) {
    if (!tree.nodes[a] || HUB_TYPES.has(tree.nodes[a].type)) continue;
    const na = adj.get(a) || new Set();
    const two = new Set();
    for (const z of na) for (const b of adj.get(z) || []) if (b !== a && !na.has(b)) two.add(b);
    for (const b of two) {
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const nb = adj.get(b) || new Set();
      const common = [...na].filter((z) => nb.has(z));
      if (!common.length) continue;
      const aa = common.reduce((s, z) => s + (deg(z) > 1 ? 1 / Math.log(deg(z)) : 0), 0);
      const ra = common.reduce((s, z) => s + 1 / Math.max(1, deg(z)), 0);
      const va = vectorOf(a); const vb = vectorOf(b);
      const cos = va && vb ? Math.max(0, cosine(va, vb)) : 0;
      const score = 0.45 * Math.min(1, aa / 2) + 0.25 * Math.min(1, ra) + 0.3 * cos;
      if (score >= min) out.push({ a, b, score: Math.round(score * 100) / 100, common: common.slice(0, 5), aa: +aa.toFixed(3), ra: +ra.toFixed(3), cos: +cos.toFixed(3) });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, max);
}

module.exports = { suggest, adjacency, HUB_TYPES };
