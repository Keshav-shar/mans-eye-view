'use strict';
const { BM25 } = require('./ml/bm25');

function index(tree) {
  const m = new Map();
  for (const n of Object.values(tree.nodes)) {
    const k = n.parentId || null;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(n);
  }
  for (const list of m.values()) list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return m;
}

function pathOf(tree, id) {
  const out = [];
  let cur = tree.nodes[id];
  for (let guard = 0; cur && guard < 64; guard++) {
    out.unshift(cur.title);
    cur = cur.parentId ? tree.nodes[cur.parentId] : null;
  }
  return out;
}

function depthOf(tree, id) {
  let d = 0;
  let cur = tree.nodes[id];
  while (cur && cur.parentId && d < 64) { d++; cur = tree.nodes[cur.parentId]; }
  return d;
}

// True when `id` is `rootId` or sits somewhere below it.
function inSubtree(tree, rootId, id) {
  let cur = tree.nodes[id];
  for (let guard = 0; cur && guard < 64; guard++) {
    if (cur.id === rootId) return true;
    cur = cur.parentId ? tree.nodes[cur.parentId] : null;
  }
  return false;
}

function subtreeIds(tree, id) {
  const idx = index(tree);
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const c of idx.get(cur) || []) stack.push(c.id);
  }
  return out;
}

function height(tree, id, idx = index(tree)) {
  let h = 0;
  for (const c of idx.get(id) || []) h = Math.max(h, 1 + height(tree, c.id, idx));
  return h;
}

function nextOrder(tree, parentId) {
  let max = -10;
  for (const n of Object.values(tree.nodes)) if ((n.parentId || null) === (parentId || null)) max = Math.max(max, n.order);
  return max + 10;
}

function haystack(n) {
  // Title twice: a hit in the name matters more than one in a property value.
  return [n.title, n.title, ...(n.aliases || []), n.type, n.summary, n.status, n.tags.join(' '), n.fields.map((f) => f.value).join(' ')].join(' ');
}

// BM25 over the nodes (replaces substring counting), optionally fused with hybrid scores the caller
// computed with embeddings (lib/vector/retrieval.js). Output is normalised to 0..50.
function relevance(nodes, query, extra = null) {
  const bm = new BM25();
  for (const n of nodes) bm.add(n.id, haystack(n));
  const hits = bm.search(query, nodes.length);
  const scores = new Map();
  const top = hits.length ? hits[0].score : 0;
  for (const h of hits) scores.set(h.id, top ? (h.score / top) * 50 : 0);
  if (extra && extra.size) {
    const max = Math.max(...extra.values()) || 1;
    for (const [id, v] of extra) scores.set(id, Math.max(scores.get(id) || 0, (v / max) * 50));
  }
  return scores;
}

// Choose which nodes to show the model: top-level structure first, then whatever matches the query.
function selectNodes(tree, query, budgetChars, lineFor, extra = null) {
  const nodes = Object.values(tree.nodes);
  const scores = relevance(nodes, query, extra);
  const ranked = nodes
    .map((n) => ({ n, rank: (depthOf(tree, n.id) <= 1 ? 100 : 0) + (scores.get(n.id) || 0) }))
    .sort((a, b) => b.rank - a.rank || (b.n.updatedAt > a.n.updatedAt ? 1 : -1));
  const chosen = new Set();
  let used = 0;
  for (const { n } of ranked) {
    if (chosen.has(n.id)) continue;
    // Include ancestors so every parent id the model sees is also described.
    const chain = [];
    let cur = n;
    while (cur && !chosen.has(cur.id)) { chain.push(cur); cur = cur.parentId ? tree.nodes[cur.parentId] : null; }
    const cost = chain.reduce((sum, c) => sum + lineFor(c).length + 1, 0);
    if (used + cost > budgetChars) continue;
    chain.forEach((c) => chosen.add(c.id));
    used += cost;
  }
  // Emit in tree order so the outline reads naturally.
  const idx = index(tree);
  const lines = [];
  const walk = (pid) => {
    for (const c of idx.get(pid) || []) {
      if (chosen.has(c.id)) { lines.push({ n: c, line: lineFor(c) }); }
      walk(c.id);
    }
  };
  walk(null);
  return { lines, truncated: chosen.size < nodes.length };
}

const outlineLine = (n) => `${n.id} | ${n.type} | ${n.title} | ${n.parentId || '-'}`;

function outline(tree, query, budgetChars = 12000, { scores = null } = {}) {
  const { lines, truncated } = selectNodes(tree, query, budgetChars, outlineLine, scores);
  return { text: lines.map((l) => l.line).join('\n'), truncated, count: lines.length };
}

function detailLine(tree) {
  return (n) => {
    const o = {
      id: n.id, type: n.type, title: n.title, path: pathOf(tree, n.id).slice(0, -1).join(' > ') || undefined,
      summary: n.summary || undefined,
      fields: n.fields.length ? n.fields.map((f) => `${f.key}: ${f.value}`) : undefined,
      tags: n.tags.length ? n.tags : undefined,
      pros: n.pros.length ? n.pros : undefined,
      cons: n.cons.length ? n.cons : undefined,
      status: n.status || undefined,
      level: n.level ?? undefined,
      followUp: n.followUp || undefined,
      lastTouched: n.lastTouched || undefined,
      links: n.links.length ? n.links.map((l) => `${l.relation || 'related to'} -> ${l.to}`) : undefined,
      notes: n.notes ? n.notes.slice(0, 240) : undefined,
    };
    return JSON.stringify(o);
  };
}

function detailed(tree, query, budgetChars = 20000, { scores = null } = {}) {
  const { lines, truncated } = selectNodes(tree, query, budgetChars, detailLine(tree), scores);
  return { text: lines.map((l) => l.line).join('\n'), truncated, count: lines.length };
}

module.exports = { index, pathOf, depthOf, inSubtree, subtreeIds, height, nextOrder, outline, detailed };
