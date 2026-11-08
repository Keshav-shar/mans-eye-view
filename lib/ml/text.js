'use strict';

// Text primitives shared by the parser, matcher and retrievers.

const STOP = new Set(('a an and are as at be been but by for from has have he her his i if in into is it its of on or our '
  + 'she so than that the their them they this to was we were what when where which who will with you your about after all also '
  + 'can more most new not one only other over such there these through up us very via how why do does did any each than then').split(' '));

function normalize(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/[^\p{L}\p{N}'+#.]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s, { stop = true, min = 2 } = {}) {
  const out = [];
  for (const raw of normalize(s).split(' ')) {
    const t = raw.replace(/^[.'#+]+|[.']+$/g, '');
    if (t.length < min) continue;
    if (stop && STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

// Whitespace/quote-insensitive normal form for grounding checks ("is this snippet really in the page?").
const flat = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a, b) => (!a.length && !b.length ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length; const lb = b.length;
  if (!la || !lb) return 0;
  const win = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false); const mb = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - win); j < Math.min(lb, i + win + 1); j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = true; mb[j] = true; m++; break;
    }
  }
  if (!m) return 0;
  let t = 0; let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (m / la + m / lb + (m - t / 2) / m) / 3;
}

function jaroWinkler(a, b, p = 0.1) {
  const x = normalize(a); const y = normalize(b);
  const j = jaro(x, y);
  let l = 0;
  while (l < 4 && l < x.length && l < y.length && x[l] === y[l]) l++;
  return j + l * p * (1 - j);
}

// fuzzywuzzy-style token_set_ratio: robust to word order and extra words.
function tokenSetRatio(a, b) {
  const A = new Set(tokens(a, { stop: false, min: 1 })); const B = new Set(tokens(b, { stop: false, min: 1 }));
  if (!A.size && !B.size) return 1;
  const inter = [...A].filter((x) => B.has(x)).sort();
  const da = [...A].filter((x) => !B.has(x)).sort();
  const db = [...B].filter((x) => !A.has(x)).sort();
  const t0 = inter.join(' ');
  const t1 = [t0, ...da].join(' ').trim();
  const t2 = [t0, ...db].join(' ').trim();
  return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2));
}

function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a); const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

function sentences(text, max = 2000) {
  const out = [];
  for (const block of String(text || '').split(/\n{2,}|\n(?=[-*#>]|\d+\.)/)) {
    const clean = block.replace(/[#>*_`]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    for (const s of clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const t = s.trim();
      if (t.length >= 3) out.push(t.slice(0, 1000));
      if (out.length >= max) return out;
    }
  }
  return out;
}

// Paragraph-aware chunks with overlap, for retrieval and for picking what the LLM sees.
function chunk(text, { size = 1100, overlap = 150, max = 200 } = {}) {
  const paras = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      out.push(cur);
      cur = cur.slice(Math.max(0, cur.length - overlap));
    }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size - overlap) out.push((cur + p.slice(i, i + size)).slice(0, size + overlap));
      cur = '';
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (out.length >= max) break;
  }
  if (cur && out.length < max) out.push(cur);
  return out;
}

// Split markdown into sections by heading, each with its heading path ("Team › Leadership"), then pack
// consecutive sections into groups of at most `size` characters. Long sections are cut at paragraphs.
function chunkByHeadings(markdown, { size = 6000, maxGroups = 3 } = {}) {
  const lines = String(markdown || '').split('\n');
  const sections = [];
  const path = [];
  let cur = { path: '', text: [] };
  const flush = () => { const t = cur.text.join('\n').trim(); if (t) sections.push({ path: cur.path, text: t }); };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = m[2].replace(/[*_`[\]]/g, '').slice(0, 60);
      cur = { path: path.filter(Boolean).join(' › '), text: [] };
    } else cur.text.push(line);
  }
  flush();
  const groups = [];
  let g = '';
  const push = (s) => { if (g && g.length + s.length + 2 > size) { groups.push(g); g = ''; } g = g ? `${g}\n\n${s}` : s; };
  for (const s of sections) {
    const head = s.path ? `[${s.path}]\n` : '';
    if (head.length + s.text.length <= size) { push(head + s.text); continue; }
    for (const part of chunk(s.text, { size: size - head.length - 50, overlap: 0 })) push(head + part);
  }
  if (g) groups.push(g);
  return groups.slice(0, maxGroups);
}

const cosine = (a, b) => {
  let d = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

module.exports = { STOP, normalize, tokens, flat, levenshtein, ratio, jaro, jaroWinkler, tokenSetRatio, jaccard, sentences, chunk, chunkByHeadings, cosine };
