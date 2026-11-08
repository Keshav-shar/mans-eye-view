'use strict';
const { tokens } = require('./text');
const { fnv64 } = require('./simhash');

// Feature hashing ("hashing trick"): text → fixed-size vector without storing a vocabulary.
// - hashVector: dense, signed, L2-normalised; the pure-JS embedding fallback (unigrams + bigrams +
//   char trigrams of each word, so "vectordb" and "vector db" still land near each other).
// - hashFeatures: sparse Map for the logistic-regression page classifier.

function bucket(s, dim) {
  const h = fnv64(s);
  return { i: Number(h % BigInt(dim)), sign: (h >> 63n) & 1n ? -1 : 1 };
}

function hashVector(text, dim = 384) {
  const v = new Float32Array(dim);
  const ts = tokens(text, { stop: true, min: 1 });
  const feats = [];
  for (let i = 0; i < ts.length; i++) {
    feats.push([`w:${ts[i]}`, 1]);
    if (i + 1 < ts.length) feats.push([`b:${ts[i]} ${ts[i + 1]}`, 0.7]);
    const w = `#${ts[i]}#`;
    for (let j = 0; j + 3 <= w.length && j < 12; j++) feats.push([`c:${w.slice(j, j + 3)}`, 0.25]);
  }
  const tf = new Map();
  for (const [f, wgt] of feats) tf.set(f, (tf.get(f) || 0) + wgt);
  for (const [f, c] of tf) {
    const { i, sign } = bucket(f, dim);
    v[i] += sign * (1 + Math.log(c));
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function hashFeatures(text, dim = 1 << 15, prefix = '') {
  const m = new Map();
  for (const t of tokens(text)) {
    const { i } = bucket(`${prefix}${t}`, dim);
    m.set(i, (m.get(i) || 0) + 1);
  }
  for (const [i, c] of m) m.set(i, 1 + Math.log(c));
  return m;
}

module.exports = { hashVector, hashFeatures };
