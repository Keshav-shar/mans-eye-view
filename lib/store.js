'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./schema');

const AREAS = [
  ['Companies', 'Places you want to work, partner with or learn from.'],
  ['People', 'Recruiters, mentors, peers and anyone worth staying in touch with.'],
  ['Investors', 'Funds, angels and the people behind them.'],
  ['Skills', 'What you can do today and what you are building towards.'],
  ['Ideas', 'Anything half-formed that you do not want to lose.'],
  ['Paths', 'Routes you are considering: roles, courses, roadmaps.'],
];

// Node groups added by the research build (migration "areas-v2"). Existing groups are never moved or
// renamed; anything you delete later is not re-added, because the migration is recorded on the tree.
const NEW_AREAS = [
  ['Products & Tech', 'Products, tools, frameworks and technologies: what companies build and use.'],
  ['Concepts', 'Ideas, fields and techniques worth understanding.'],
  ['Research', 'One node per web research session: what was searched, read and added.'],
];

// Groups added with categorical extraction (migration "areas-v3"): where entities are, where people
// studied, and dated events such as funding rounds, acquisitions and launches.
const V3_AREAS = [
  ['Places', 'Cities and countries where companies, investors and people are based.'],
  ['Education', 'Universities, colleges and schools people studied at.'],
  ['Events', 'Funding rounds, acquisitions, launches and other dated events.'],
];

// Skill groups seeded under Skills. They mirror what Nexus's research engine itself uses, so the tree
// doubles as a learning map for ML fundamentals, vector databases and agentic architecture.
const SKILL_GROUPS = [
  ['ML Fundamentals', 'Classical ML that powers page classification, entity matching and ranking.', [
    ['TF-IDF & BM25', 'Sparse text representations and probabilistic ranking.'],
    ['Logistic regression & calibration', 'Linear classifiers, regularisation, Platt scaling.'],
    ['Precision, recall & F1', 'Evaluating extractors and merge decisions on gold sets.'],
    ['Record linkage (Fellegi-Sunter, EM)', 'Probabilistic entity resolution with m/u weights.'],
    ['Bandits (UCB1)', 'Exploration vs exploitation when choosing what to search next.'],
  ]],
  ['Vector Databases', 'Embeddings and retrieval: how Nexus finds similar nodes and evidence.', [
    ['Embeddings & cosine similarity', 'Sentence encoders such as all-MiniLM-L6-v2.'],
    ['Flat vs ANN indexes (HNSW, IVF)', 'Exact search versus approximate nearest neighbours.'],
    ['Hybrid retrieval & RRF', 'Fusing sparse and dense rankings with reciprocal rank fusion.'],
    ['Chunking strategies', 'Splitting documents for retrieval without losing context.'],
    ['Near-duplicate detection (SimHash)', 'Spotting syndicated copies before counting evidence.'],
  ]],
  ['Agentic Architecture', 'LLM agents that plan, use tools and stay inside guardrails.', [
    ['Tool use & structured outputs', 'Function calling and JSON-schema constrained answers.'],
    ['Planner/executor loops', 'Workflow-first orchestration with bounded agent steps.'],
    ['Gated fallbacks & budgets', 'Rules first, AI only when weak, valuable and affordable.'],
    ['Prompt-injection defence', 'Treating fetched content as data, never instructions.'],
    ['Evaluation harnesses', 'Regression suites that compare strategies on gold data.'],
  ]],
];

function migrateTree(tree) {
  tree.migrations = Array.isArray(tree.migrations) ? tree.migrations : [];
  let changed = false;
  const lcV3 = (x) => String(x || '').toLowerCase();
  if (!tree.migrations.includes('areas-v3')) {
    const roots = Object.values(tree.nodes).filter((n) => !n.parentId);
    let order = roots.reduce((m, n) => Math.max(m, n.order), -10) + 10;
    for (const [title, summary] of V3_AREAS) {
      if (roots.some((n) => lcV3(n.title) === lcV3(title))) continue;
      const n = S.blankNode({ parentId: null, type: 'area', title, order });
      order += 10;
      n.summary = summary;
      tree.nodes[n.id] = n;
    }
    tree.migrations.push('areas-v3');
    changed = true;
  }
  if (tree.migrations.includes('areas-v2')) return changed;
  const all = () => Object.values(tree.nodes);
  const lc = (x) => String(x || '').toLowerCase();
  const top = (title) => all().find((n) => !n.parentId && lc(n.title) === lc(title));
  const nextOrder = (pid) => all().filter((n) => (n.parentId || null) === pid).reduce((m, n) => Math.max(m, n.order), -10) + 10;
  const add = (pid, type, title, summary) => {
    const n = S.blankNode({ parentId: pid, type, title, order: nextOrder(pid) });
    n.summary = summary;
    tree.nodes[n.id] = n;
    return n;
  };
  for (const [title, summary] of NEW_AREAS) if (!top(title)) add(null, 'area', title, summary);
  const skills = top('Skills') || add(null, 'area', 'Skills', 'What you can do today and what you are building towards.');
  for (const [title, summary, kids] of SKILL_GROUPS) {
    const kidsOf = (pid) => all().filter((n) => n.parentId === pid);
    let g = kidsOf(skills.id).find((n) => lc(n.title) === lc(title));
    if (!g) g = add(skills.id, 'skill', title, summary);
    for (const [k, ks] of kids) if (!kidsOf(g.id).some((n) => lc(n.title) === lc(k))) add(g.id, 'skill', k, ks);
  }
  tree.migrations.push('areas-v2');
  return true;
}

function seedTree() {
  const tree = { version: 1, rev: 1, createdAt: S.nowIso(), updatedAt: S.nowIso(), nodes: {} };
  AREAS.forEach(([title, summary], i) => {
    const n = S.blankNode({ type: 'area', title, order: i * 10 });
    n.summary = summary;
    tree.nodes[n.id] = n;
  });
  return tree;
}

class Store {
  constructor(dir, { maxHistory = 60 } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'tree.json');
    this.histDir = path.join(dir, 'history');
    this.maxHistory = maxHistory;
    this.queue = Promise.resolve();
    this.lastSnap = null;
    this.tree = null;
  }

  init() {
    fs.mkdirSync(this.histDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.tree = seedTree();
      this._write(this.tree);
      return this;
    }
    try {
      this.tree = this._read(this.file);
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corrupt = path.join(this.dir, `tree.corrupt-${stamp}.json`);
      fs.renameSync(this.file, corrupt);
      console.error(`Could not read tree.json (${err.message}). Moved it to ${path.basename(corrupt)}.`);
      const newest = this._history().pop();
      this.tree = newest ? this._read(path.join(this.histDir, newest), true) : seedTree();
      this._write(this.tree);
    }
    return this;
  }

  get() { return this.tree; }

  _read(file, snapshot = false) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tree = snapshot ? raw.tree : raw;
    S.validateTree(tree);
    if (!Number.isInteger(tree.rev)) tree.rev = 1;
    return tree;
  }

  // Write to a temp file, flush it to disk, then rename: a crash can never leave half a file.
  _write(tree) {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(tree, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  _history() {
    return fs.readdirSync(this.histDir).filter((f) => f.endsWith('.json')).sort();
  }

  // `window` (ms) lets a long-running writer such as a research session share one undo snapshot.
  _snapshot(label, coalesce, window = 30000) {
    const now = Date.now();
    if (coalesce && this.lastSnap && this.lastSnap.key === coalesce && now - this.lastSnap.at < window) {
      this.lastSnap.at = now;
      return;
    }
    const name = `${String(now).padStart(13, '0')}-${String(this.tree.rev).padStart(6, '0')}.json`;
    fs.writeFileSync(path.join(this.histDir, name), JSON.stringify({ label, savedAt: S.nowIso(), tree: this.tree }));
    this.lastSnap = coalesce ? { key: coalesce, at: now } : null;
    const all = this._history();
    for (const old of all.slice(0, Math.max(0, all.length - this.maxHistory))) fs.unlinkSync(path.join(this.histDir, old));
  }

  // Run `fn` on a private copy. The copy is validated, snapshotted and saved atomically; if anything
  // throws, nothing is written and the live tree is untouched. Calls are serialised.
  // Adds the research node groups once. Called by server start (not by bare init) so existing callers
  // keep the original six-area seed.
  migrate() {
    const draft = structuredClone(this.tree);
    if (!migrateTree(draft)) return this;
    S.validateTree(draft);
    draft.rev = (this.tree.rev || 0) + 1;
    draft.updatedAt = S.nowIso();
    this._write(draft);
    this.tree = draft;
    return this;
  }

  mutate(label, fn, { coalesce, window } = {}) {
    const run = async () => {
      const draft = structuredClone(this.tree);
      const result = await fn(draft);
      S.validateTree(draft);
      draft.rev = (this.tree.rev || 0) + 1;
      draft.updatedAt = S.nowIso();
      this._snapshot(label, coalesce, window);
      this._write(draft);
      this.tree = draft;
      return result;
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  peekUndo() {
    const newest = this._history().pop();
    if (!newest) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.histDir, newest), 'utf8')).label || 'Last change';
    } catch { return 'Last change'; }
  }

  undo() {
    const run = async () => {
      const newest = this._history().pop();
      if (!newest) return null;
      const file = path.join(this.histDir, newest);
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      S.validateTree(snap.tree);
      const restored = snap.tree;
      if (Array.isArray(this.tree.migrations)) restored.migrations = this.tree.migrations; // never re-run a migration on undo
      restored.rev = (this.tree.rev || 0) + 1;
      restored.updatedAt = S.nowIso();
      this._write(restored);
      this.tree = restored;
      this.lastSnap = null;
      fs.unlinkSync(file);
      return snap.label || 'Last change';
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { Store, seedTree, migrateTree, NEW_AREAS, V3_AREAS, SKILL_GROUPS };
