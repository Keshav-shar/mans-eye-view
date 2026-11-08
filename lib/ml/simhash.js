'use strict';
const { tokens } = require('./text');

// 64-bit SimHash over word 3-shingles. Two pages within Hamming distance ≤ 3 are near-duplicates
// (syndicated press releases, mirrors): they count as ONE origin when corroborating a fact.

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function fnv64(s) {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i) & 0xff); h = (h * FNV_PRIME) & MASK; }
  return h;
}

function simhash(text, k = 3) {
  const t = tokens(text, { stop: false });
  if (!t.length) return '0';
  const v = new Int32Array(64);
  const n = Math.max(1, t.length - k + 1);
  for (let i = 0; i < n && i < 20000; i++) {
    const h = fnv64(t.slice(i, i + k).join(' '));
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16);
}

function hamming(a, b) {
  let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  let c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

const nearDuplicate = (a, b, maxDist = 3) => Boolean(a && b && a !== '0' && b !== '0' && hamming(a, b) <= maxDist);

module.exports = { simhash, hamming, nearDuplicate, fnv64 };
