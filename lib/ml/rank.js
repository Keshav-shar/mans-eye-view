'use strict';
const { cosine } = require('./text');

// Ranking helpers: reciprocal rank fusion, maximal marginal relevance, and a UCB1 bandit.

// RRF: fuse several ranked lists of ids. score(id) = Σ 1 / (k + rank).
function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) {
    list.forEach((item, i) => {
      const id = typeof item === 'string' ? item : item.id;
      score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
    });
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

// MMR: pick k items relevant to `target` but not redundant with each other. → indices in pick order.
function mmr(vectors, target, k = 3, lambda = 0.7) {
  const chosen = [];
  const rel = vectors.map((v) => cosine(v, target));
  while (chosen.length < Math.min(k, vectors.length)) {
    let best = -1; let bestScore = -Infinity;
    for (let i = 0; i < vectors.length; i++) {
      if (chosen.includes(i)) continue;
      const red = chosen.length ? Math.max(...chosen.map((j) => cosine(vectors[i], vectors[j]))) : 0;
      const s = lambda * rel[i] - (1 - lambda) * red;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen;
}

function centroid(vectors) {
  if (!vectors.length) return new Float32Array(0);
  const c = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < c.length; i++) c[i] += v[i] / vectors.length;
  return c;
}

// UCB1 over named arms (e.g. "company:investors"). Rewards should be in [0, 1].
class UCB1 {
  constructor({ c = 1.2, state = null } = {}) {
    this.c = c;
    this.arms = new Map(state ? Object.entries(state) : []);
  }

  score(arm) {
    const a = this.arms.get(arm);
    if (!a || !a.n) return Infinity;
    const N = [...this.arms.values()].reduce((s, x) => s + x.n, 0);
    return a.sum / a.n + this.c * Math.sqrt(Math.log(Math.max(N, 1)) / a.n);
  }

  update(arm, reward) {
    const a = this.arms.get(arm) || { n: 0, sum: 0 };
    a.n += 1; a.sum += Math.max(0, Math.min(1, reward));
    this.arms.set(arm, a);
  }

  toJSON() { return Object.fromEntries(this.arms); }
}

module.exports = { rrf, mmr, centroid, UCB1 };
