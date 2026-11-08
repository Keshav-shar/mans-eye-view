'use strict';

// Binary logistic regression on sparse features (Map index → value), trained with SGD + L2, plus Platt
// scaling so its output can be read as a probability. Used for "is this page worth reading?",
// learned from your review decisions; until it has enough labels the heuristic classifier decides.

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

class LogReg {
  constructor({ lr = 0.1, l2 = 1e-4 } = {}) {
    this.w = new Map(); this.b = 0; this.lr = lr; this.l2 = l2;
    this.platt = { a: 1, c: 0 }; this.n = 0;
  }

  raw(x) {
    let z = this.b;
    for (const [i, v] of x) z += (this.w.get(i) || 0) * v;
    return z;
  }

  predict(x) { return sigmoid(this.platt.a * this.raw(x) + this.platt.c); }

  fit(X, y, { epochs = 30, seed = 7 } = {}) {
    const idx = X.map((_, i) => i);
    let s = seed;
    const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let e = 0; e < epochs; e++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const lr = this.lr / (1 + e * 0.1);
      for (const i of idx) {
        const g = sigmoid(this.raw(X[i])) - y[i];
        for (const [k, v] of X[i]) {
          const w = this.w.get(k) || 0;
          this.w.set(k, w - lr * (g * v + this.l2 * w));
        }
        this.b -= lr * g;
      }
    }
    this.n = X.length;
    return this;
  }

  // Platt scaling: fit p = sigmoid(a·z + c) on (score, label) pairs by gradient descent.
  calibrate(X, y, { iters = 300, lr = 0.05 } = {}) {
    const z = X.map((x) => this.raw(x));
    let a = 1; let c = 0;
    for (let t = 0; t < iters; t++) {
      let ga = 0; let gc = 0;
      for (let i = 0; i < z.length; i++) { const g = sigmoid(a * z[i] + c) - y[i]; ga += g * z[i]; gc += g; }
      a -= (lr * ga) / z.length; c -= (lr * gc) / z.length;
    }
    this.platt = { a, c };
    return this;
  }

  toJSON() { return { w: [...this.w], b: this.b, platt: this.platt, n: this.n }; }

  static fromJSON(j) {
    const m = new LogReg();
    if (j && Array.isArray(j.w)) { m.w = new Map(j.w); m.b = j.b || 0; m.platt = j.platt || m.platt; m.n = j.n || 0; }
    return m;
  }
}

module.exports = { LogReg, sigmoid };
