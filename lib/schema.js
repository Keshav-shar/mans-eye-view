'use strict';
const crypto = require('crypto');

// Everything that enters the tree (manual edits, imports, LLM output) passes through this file.

const LIMITS = {
  title: 120, summary: 600, notes: 20000, key: 40, value: 600, tag: 32, bullet: 240,
  relation: 48, status: 32, type: 24,
  fields: 60, tags: 24, pros: 30, cons: 30, links: 60,
  nodes: 5000, depth: 16,
  aliases: 20, identifiers: 10, sources: 30, idValue: 200,
};

const KINDS = ['text', 'phone', 'email', 'url', 'address', 'date', 'number'];

// Control characters, zero-width and bidi-override characters.
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;

const newId = (prefix = 'n') => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const nowIso = () => new Date().toISOString();

function text(value, max, { multiline = false } = {}) {
  if (value == null || typeof value === 'object') return '';
  let s = String(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(CTRL, '');
  s = multiline
    ? s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
    : s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trim();
  return s;
}

function normDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const TYPE_ALIASES = {
  companies: 'company', organization: 'company', organisation: 'company', org: 'company', startup: 'company',
  firm: 'company', employer: 'company',
  people: 'person', contact: 'person', professional: 'person', human: 'person',
  'hr-manager': 'hr', 'hr-person': 'hr', 'human-resources': 'hr', talent: 'hr',
  investor: 'vc', 'venture-capital': 'vc', 'vc-firm': 'vc', 'venture-capitalist': 'vc', angel: 'vc',
  skills: 'skill', ideas: 'idea', paths: 'path', roadmap: 'path', projects: 'project', events: 'event',
  resources: 'resource', places: 'place', notes: 'note', areas: 'area',
};

function normType(value) {
  let t = text(value, LIMITS.type).toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/[\s_]+/g, '-');
  t = t.replace(/^-+|-+$/g, '');
  if (!t) return 'note';
  return TYPE_ALIASES[t] || t;
}

function detectKind(key, value) {
  const k = String(key).toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && normDate(value)) return 'date';
  if (/^(https?:\/\/|www\.)\S+$/i.test(value) || (/\b(linkedin|github|twitter|x)\.com\b/i.test(value) && !/\s/.test(value))) return 'url';
  const digits = value.replace(/\D/g, '');
  if (/^[+()\d\s.\-x]{7,25}$/i.test(value) && digits.length >= 7 && digits.length <= 15) return 'phone';
  if (/address|location|office|\bhq\b|headquarter|city/.test(k)) return 'address';
  if (/date|deadline|due|birthday/.test(k) && normDate(value)) return 'date';
  if (/^-?\d+([.,]\d+)?$/.test(value)) return 'number';
  return 'text';
}

function normField(raw, { keepId = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const key = text(raw.key ?? raw.label ?? raw.name, LIMITS.key);
  let value = text(raw.value, LIMITS.value);
  if (!key || !value) return null;
  let kind = KINDS.includes(raw.kind) ? raw.kind : detectKind(key, value);
  if (kind === 'date') {
    const d = normDate(value);
    if (d) value = d; else kind = 'text';
  }
  const fid = keepId && typeof raw.id === 'string' && /^f_[a-z0-9]{6,16}$/.test(raw.id) ? raw.id : newId('f');
  return { id: fid, key, value, kind };
}

// Accepts [{key,value}], {Phone: "..."}, or junk (returns []).
function normFields(input, opts) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (input && typeof input === 'object') list = Object.entries(input).map(([key, value]) => ({ key, value }));
  const out = [];
  for (const raw of list) {
    const f = normField(raw, opts);
    if (f) out.push(f);
    if (out.length >= LIMITS.fields) break;
  }
  return out;
}

function uniqueStrings(input, maxCount, maxLen, transform = (s) => s) {
  let list = input;
  if (typeof list === 'string') list = list.split(/[,\n]/);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = transform(text(item, maxLen));
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= maxCount) break;
  }
  return out;
}

const normTags = (v) => uniqueStrings(v, LIMITS.tags, LIMITS.tag, (s) => s.replace(/^#+/, '').replace(/[^\p{L}\p{N}_/ -]/gu, '').trim().replace(/\s+/g, '-').toLowerCase()).filter(Boolean);
const normBullets = (v, max) => uniqueStrings(v, max, LIMITS.bullet);

function normLevel(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(5, n));
}

const normStatus = (v) => text(v, LIMITS.status).toLowerCase();

// Optional evidence on a link: conf (0..1), status (confirmed | single | inferred), n (distinct origins).
function linkMeta(l) {
  const out = {};
  const c = Number(l.conf);
  if (l.conf != null && Number.isFinite(c)) out.conf = Math.round(Math.max(0, Math.min(1, c)) * 100) / 100;
  // confirmed: ≥ 2 independent sites or one trusted site · single: one source so far · inferred: predicted
  if (l.status === 'confirmed' || l.status === 'single' || l.status === 'inferred') out.status = l.status;
  const n = Number(l.n);
  if (l.n != null && Number.isInteger(n) && n > 0) out.n = Math.min(n, 999);
  return out;
}

function normLinks(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const l of input) {
    if (!l || typeof l.to !== 'string') continue;
    const relation = text(l.relation, LIMITS.relation);
    const k = `${l.to}|${relation.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ to: l.to.slice(0, 40), relation, ...linkMeta(l) });
    if (out.length >= LIMITS.links) break;
  }
  return out;
}

const normAliases = (v) => uniqueStrings(v, LIMITS.aliases, LIMITS.title);

// Strong identifiers used for deterministic merges. Values are normalised so that
// "https://www.Zeta.in/about" and "zeta.in" are the same domain.
const ID_NAMESPACES = ['domain', 'github', 'linkedin', 'crunchbase', 'twitter', 'wikidata', 'website'];

function normIdValue(ns, raw) {
  let v = text(raw, LIMITS.idValue).toLowerCase();
  if (!v) return '';
  if (ns === 'domain' || ns === 'website') {
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : '';
  }
  if (ns === 'github' || ns === 'twitter') {
    v = v.replace(/^https?:\/\/(www\.)?(github\.com|twitter\.com|x\.com)\//, '').replace(/^@/, '').split(/[/?#]/)[0];
    return /^[a-z0-9_-]{1,64}$/.test(v) ? v : '';
  }
  if (ns === 'linkedin') {
    const m = /(in|company|school)\/([a-z0-9_%-]{2,100})/.exec(v);
    return m ? `${m[1]}/${m[2]}` : '';
  }
  if (ns === 'crunchbase') {
    const m = /(organization|person)\/([a-z0-9-]{2,100})/.exec(v);
    return m ? `${m[1]}/${m[2]}` : (/^[a-z0-9-]{2,100}$/.test(v) ? v : '');
  }
  return /^[a-z0-9_./:-]{1,200}$/.test(v) ? v : '';
}

function normIdentifiers(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, raw] of Object.entries(input)) {
    const ns = String(k).toLowerCase();
    if (!ID_NAMESPACES.includes(ns)) continue;
    const v = normIdValue(ns, raw);
    if (v) out[ns === 'website' ? 'domain' : ns] = v;
    if (Object.keys(out).length >= LIMITS.identifiers) break;
  }
  return out;
}

function normSources(input) {
  if (!Array.isArray(input)) return [];
  const out = [...new Set(input.filter((x) => typeof x === 'string' && /^s_[a-f0-9]{6,32}$/.test(x)))];
  return out.slice(-LIMITS.sources);
}

function blankNode({ id = newId('n'), parentId = null, order = 0, type = 'note', title = 'Untitled' } = {}) {
  const t = nowIso();
  return {
    id, parentId, order,
    type: normType(type), title: text(title, LIMITS.title) || 'Untitled',
    summary: '', notes: '', fields: [], tags: [], pros: [], cons: [], links: [],
    aliases: [], identifiers: {}, sources: [],
    status: '', level: null, followUp: null, lastTouched: null,
    createdAt: t, updatedAt: t,
  };
}

// Apply a user-supplied patch to a node. Only known keys are read; every value is normalised.
function applyPatch(node, patch) {
  if (!patch || typeof patch !== 'object') return node;
  if ('title' in patch) { const v = text(patch.title, LIMITS.title); if (v) node.title = v; }
  if ('type' in patch) node.type = normType(patch.type);
  if ('summary' in patch) node.summary = text(patch.summary, LIMITS.summary, { multiline: true });
  if ('notes' in patch) node.notes = text(patch.notes, LIMITS.notes, { multiline: true });
  if ('fields' in patch) node.fields = normFields(patch.fields, { keepId: true });
  if ('tags' in patch) node.tags = normTags(patch.tags);
  if ('pros' in patch) node.pros = normBullets(patch.pros, LIMITS.pros);
  if ('cons' in patch) node.cons = normBullets(patch.cons, LIMITS.cons);
  if ('links' in patch) node.links = normLinks(patch.links);
  if ('aliases' in patch) node.aliases = normAliases(patch.aliases);
  if ('identifiers' in patch) node.identifiers = normIdentifiers(patch.identifiers);
  if ('sources' in patch) node.sources = normSources(patch.sources);
  if ('status' in patch) node.status = normStatus(patch.status);
  if ('level' in patch) node.level = normLevel(patch.level);
  if ('followUp' in patch) node.followUp = normDate(patch.followUp);
  if ('lastTouched' in patch) node.lastTouched = normDate(patch.lastTouched);
  return node;
}

// Shape used for LLM "create" operations and for reading deltas.
function normNodeInput(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    title: text(r.title ?? r.name, LIMITS.title),
    type: normType(r.type),
  };
}

function validateTree(tree) {
  if (!tree || typeof tree !== 'object' || !tree.nodes || typeof tree.nodes !== 'object') throw new Error('Invalid tree');
  const ids = Object.keys(tree.nodes);
  if (ids.length > LIMITS.nodes) throw new Error(`Tree is limited to ${LIMITS.nodes} nodes`);
  for (const id of ids) {
    const n = tree.nodes[id];
    if (!n || n.id !== id) throw new Error('Node id mismatch');
    if (n.parentId != null && !tree.nodes[n.parentId]) throw new Error(`Node "${n.title}" has a missing parent`);
    if (n.parentId === id) throw new Error('A node cannot be its own parent');
    if (!Array.isArray(n.links)) n.links = [];
    if (!Array.isArray(n.aliases)) n.aliases = [];
    if (!n.identifiers || typeof n.identifiers !== 'object' || Array.isArray(n.identifiers)) n.identifiers = {};
    if (!Array.isArray(n.sources)) n.sources = [];
    n.links = n.links.filter((l) => l && tree.nodes[l.to] && l.to !== id);
  }
  // Cycle and depth check: walk to the root from every node, memoising results.
  const depth = new Map();
  for (const id of ids) {
    const chain = [];
    let cur = id;
    while (cur != null && !depth.has(cur)) {
      if (chain.includes(cur)) throw new Error('The tree contains a cycle');
      chain.push(cur);
      cur = tree.nodes[cur].parentId;
      if (chain.length > LIMITS.depth + 2) throw new Error(`Nesting is limited to ${LIMITS.depth} levels`);
    }
    let base = cur == null ? -1 : depth.get(cur);
    for (let i = chain.length - 1; i >= 0; i--) { base += 1; depth.set(chain[i], base); }
  }
  for (const d of depth.values()) if (d > LIMITS.depth) throw new Error(`Nesting is limited to ${LIMITS.depth} levels`);
  return tree;
}

// Rebuild an untrusted tree (import) node by node so nothing unexpected survives.
function sanitizeTree(raw) {
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') throw new Error('File is not a Nexus export');
  const list = Array.isArray(raw.nodes) ? raw.nodes : Object.values(raw.nodes);
  if (list.length > LIMITS.nodes) throw new Error(`Import is limited to ${LIMITS.nodes} nodes`);
  const nodes = {};
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : newId('n');
    if (nodes[id]) continue;
    const n = blankNode({ id, parentId: typeof r.parentId === 'string' ? r.parentId : null, order: Number.isFinite(r.order) ? r.order : 0 });
    applyPatch(n, r);
    if (!r.title) n.title = 'Untitled';
    const created = new Date(r.createdAt);
    if (!Number.isNaN(created.getTime())) n.createdAt = created.toISOString();
    const updated = new Date(r.updatedAt);
    if (!Number.isNaN(updated.getTime())) n.updatedAt = updated.toISOString();
    nodes[id] = n;
  }
  for (const n of Object.values(nodes)) {
    if (n.parentId && !nodes[n.parentId]) n.parentId = null;
  }
  // Detach any node that sits in a parent cycle.
  for (const n of Object.values(nodes)) {
    const seen = new Set();
    let cur = n;
    while (cur && cur.parentId) {
      if (seen.has(cur.id)) { cur.parentId = null; break; }
      seen.add(cur.id);
      cur = nodes[cur.parentId];
    }
  }
  const tree = { version: 1, rev: 0, nodes };
  return validateTree(tree);
}

module.exports = {
  LIMITS, KINDS, newId, nowIso, text, normDate, normType, detectKind, normField, normFields, normTags,
  normBullets, normLevel, normStatus, normLinks, normAliases, normIdentifiers, normIdValue, normSources, ID_NAMESPACES, blankNode, applyPatch, normNodeInput, validateTree, sanitizeTree,
};
