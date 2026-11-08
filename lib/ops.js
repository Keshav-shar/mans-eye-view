'use strict';
const S = require('./schema');
const T = require('./tree');

// Turns the model's JSON into tree changes. The model never touches the tree directly: every operation
// is normalised, resolved against real ids, deduplicated, and applied only by this file.

const MAX_OPS = 40;
const MAX_CREATE = 30;
const GLOBAL_DEDUPE = new Set(['company', 'vc', 'skill', 'product', 'tech', 'concept', 'field', 'credential', 'place', 'school']); // names unique enough to merge across parents
const ORG_TYPES = new Set(['company', 'vc']);
const typeCompatible = (a, b) => a === b || (ORG_TYPES.has(a) && ORG_TYPES.has(b));

// A shared strong identifier (same domain, GitHub org, LinkedIn page…) means the same entity.
function sharesIdentifier(node, ids) {
  const mine = node.identifiers || {};
  return Object.entries(ids || {}).some(([ns, v]) => v && mine[ns] === v);
}
const CORP_WORDS = /\b(pvt|private|ltd|limited|inc|llc|corp|corporation|co|technologies|technology|labs)\b/g;

const lc = (s) => String(s || '').toLowerCase();

function titleKey(title, type) {
  let k = lc(title).replace(/[^\p{L}\p{N}]+/gu, ' ');
  if (type === 'company' || type === 'vc') k = k.replace(CORP_WORDS, ' ');
  return k.replace(/\s+/g, ' ').trim();
}

function sameValue(a, b, kind) {
  if (kind === 'phone') {
    const da = a.replace(/\D/g, '').slice(-10);
    const db = b.replace(/\D/g, '').slice(-10);
    return da.length >= 7 && da === db;
  }
  return lc(a).trim() === lc(b).trim();
}

function runOps(tree, rawOps, { accepted = null, inPlace = false, maxOps = MAX_OPS, maxCreate = MAX_CREATE } = {}) {
  const t = inPlace ? tree : structuredClone(tree);
  const ops = Array.isArray(rawOps) ? rawOps.slice(0, maxOps) : [];
  const refs = new Map();       // model's temp ref -> real node id
  const refOwner = new Map();   // temp ref -> index of the operation that defines it
  const blockedRefs = new Set();
  const report = [];
  const stats = { created: 0, merged: 0, updated: 0, linked: 0, skipped: 0, changed: 0 };
  const createdIds = [];

  const all = () => Object.values(t.nodes);
  const siblings = (pid) => all().filter((n) => (n.parentId || null) === (pid || null));

  function resolve(val, entry, what) {
    if (val == null || val === '' || val === '-' || val === 'root' || val === 'null') return null;
    if (typeof val !== 'string') throw new Error(`Invalid ${what}`);
    const v = val.trim();
    if (blockedRefs.has(v)) throw new Error('Depends on a change that is not included');
    if (refs.has(v)) {
      const owner = refOwner.get(v);
      if (owner !== undefined && !entry.dependsOn.includes(owner)) entry.dependsOn.push(owner);
      return refs.get(v);
    }
    if (t.nodes[v]) return v;
    const hits = all().filter((n) => titleKey(n.title, n.type) === titleKey(v, n.type));
    if (hits.length === 1) {
      entry.warnings.push(`"${v}" was matched to an existing node by name`);
      return hits[0].id;
    }
    throw new Error(hits.length > 1 ? `"${v}" matches several nodes` : `Unknown node "${v}"`);
  }

  const pick = (raw, ...names) => { for (const n of names) if (raw[n] != null) return raw[n]; return undefined; };

  // Normalised "what to add" description shared by create, merge and update.
  function deltaFrom(raw, entry) {
    const src = raw.set && typeof raw.set === 'object' ? { ...raw, ...raw.set } : raw;
    const links = [];
    for (const l of Array.isArray(pick(raw, 'links', 'addLinks')) ? pick(raw, 'links', 'addLinks') : []) {
      if (!l || typeof l !== 'object') continue;
      try {
        const to = resolve(l.to, entry, 'link target');
        if (to) links.push({ ...S.normLinks([{ to, relation: '', conf: l.conf, status: l.status, n: l.n }])[0], to, relation: S.text(l.relation, S.LIMITS.relation) });
      } catch (e) {
        entry.warnings.push(`Skipped a link: ${e.message}`);
      }
    }
    return {
      summary: S.text(src.summary ?? src.brief, S.LIMITS.summary, { multiline: true }),
      status: S.normStatus(src.status),
      level: S.normLevel(src.level),
      followUp: S.normDate(src.followUp),
      lastTouched: S.normDate(src.lastTouched ?? src.lastContacted),
      fields: S.normFields(pick(raw, 'fields', 'addFields')),
      tags: S.normTags(pick(raw, 'tags', 'addTags')),
      pros: S.normBullets(pick(raw, 'pros', 'addPros'), S.LIMITS.pros),
      cons: S.normBullets(pick(raw, 'cons', 'addCons'), S.LIMITS.cons),
      notes: S.text(pick(raw, 'notes', 'appendNotes'), S.LIMITS.notes, { multiline: true }),
      aliases: S.normAliases(pick(raw, 'aliases', 'addAliases')),
      identifiers: S.normIdentifiers(pick(raw, 'identifiers', 'ids')),
      sources: S.normSources(pick(raw, 'sources')),
      links,
    };
  }

  // Additive merge. Existing data is never deleted, and a different value for an existing property
  // is stored alongside the old one instead of replacing it.
  function applyDelta(node, d, entry) {
    const ch = entry.changes;
    let notes = d.notes;

    if (d.summary) {
      if (!node.summary) { node.summary = d.summary; ch.push({ kind: 'summary', value: d.summary }); }
      else if (lc(node.summary) !== lc(d.summary)) notes = notes ? `${notes}\n\nUpdate: ${d.summary}` : `Update: ${d.summary}`;
    }
    for (const k of ['status', 'level', 'followUp', 'lastTouched']) {
      const v = d[k];
      if (v == null || v === '') continue;
      if (node[k] !== v) { ch.push({ kind: k, value: String(v), from: node[k] == null || node[k] === '' ? null : String(node[k]) }); node[k] = v; }
    }
    for (const f of d.fields) {
      if (node.fields.some((x) => lc(x.key) === lc(f.key) && sameValue(x.value, f.value, f.kind))) continue;
      if (node.fields.length >= S.LIMITS.fields) { entry.warnings.push('Property limit reached; some details were not added'); break; }
      const clash = node.fields.find((x) => lc(x.key) === lc(f.key));
      node.fields.push({ ...f, id: S.newId('f') });
      ch.push({ kind: 'field', label: f.key, value: f.value, note: clash ? `Differs from the existing "${clash.value}", which was kept` : undefined });
    }
    for (const [list, max, kind] of [['tags', S.LIMITS.tags, 'tag'], ['pros', S.LIMITS.pros, 'pro'], ['cons', S.LIMITS.cons, 'con']]) {
      for (const item of d[list]) {
        if (node[list].some((x) => lc(x) === lc(item))) continue;
        if (node[list].length >= max) break;
        node[list].push(item);
        ch.push({ kind, value: item });
      }
    }
    if (notes && !node.notes.includes(notes)) {
      const next = node.notes ? `${node.notes}\n\n${notes}` : notes;
      node.notes = next.slice(0, S.LIMITS.notes);
      ch.push({ kind: 'notes', value: notes.length > 140 ? `${notes.slice(0, 140)}…` : notes });
    }
    for (const a of d.aliases || []) {
      if (lc(a) === lc(node.title) || node.aliases.some((x) => lc(x) === lc(a))) continue;
      if (node.aliases.length >= S.LIMITS.aliases) break;
      node.aliases.push(a);
      ch.push({ kind: 'alias', value: a });
    }
    for (const [ns, v] of Object.entries(d.identifiers || {})) {
      if (node.identifiers[ns] === v) continue;
      if (node.identifiers[ns]) { entry.warnings.push(`Kept the existing ${ns} "${node.identifiers[ns]}" instead of "${v}"`); continue; }
      node.identifiers[ns] = v;
      ch.push({ kind: 'identifier', label: ns, value: v });
    }
    const newSources = (d.sources || []).filter((x) => !node.sources.includes(x));
    if (newSources.length) {
      node.sources = [...node.sources, ...newSources].slice(-S.LIMITS.sources);
      ch.push({ kind: 'source', value: `${newSources.length} web source${newSources.length === 1 ? '' : 's'}` });
    }
    for (const l of d.links) {
      if (l.to === node.id) continue;
      const same = node.links.find((x) => x.to === l.to && lc(x.relation) === lc(l.relation));
      if (same) {
        // Evidence only ever strengthens a link: higher confidence, more origins, inferred → confirmed.
        let up = false;
        if (l.conf != null && (same.conf == null || l.conf > same.conf)) { same.conf = l.conf; up = true; }
        if (l.n != null && (same.n == null || l.n > same.n)) { same.n = l.n; up = true; }
        const RANK = { inferred: 0, single: 1, confirmed: 2 };
        if (l.status && (RANK[l.status] ?? 0) > (RANK[same.status] ?? 2)) { same.status = l.status; up = true; } // only ever upgrades
        if (up) ch.push({ kind: 'evidence', label: l.relation || 'related to', value: t.nodes[l.to].title });
        continue;
      }
      if (node.links.length >= S.LIMITS.links) break;
      node.links.push(l);
      ch.push({ kind: 'link', value: t.nodes[l.to].title, label: l.relation || 'related to' });
    }
    if (ch.length) node.updatedAt = S.nowIso();
  }

  function registerRef(ref, id, idx) {
    if (typeof ref !== 'string' || !ref.trim()) return;
    const r = ref.trim().slice(0, 40);
    if (t.nodes[r]) return; // a ref may never shadow a real id
    refs.set(r, id);
    refOwner.set(r, idx);
  }

  function doCreate(raw, entry, idx) {
    const base = S.normNodeInput(raw);
    if (!base.title) throw new Error('Missing title');
    entry.title = base.title;
    entry.type = base.type;
    const parentId = resolve(pick(raw, 'parent', 'parentId'), entry, 'parent');
    if (parentId && T.depthOf(t, parentId) >= S.LIMITS.depth - 1) throw new Error('Too deeply nested');
    const key = titleKey(base.title, base.type);
    const delta = deltaFrom(raw, entry);

    let existing = Object.keys(delta.identifiers).length
      ? all().find((n) => typeCompatible(n.type, base.type) && sharesIdentifier(n, delta.identifiers))
      : null;
    if (existing) entry.warnings.push(`Matched the existing ${existing.type} by ${Object.keys(delta.identifiers).find((ns) => existing.identifiers[ns] === delta.identifiers[ns])}`);
    if (!existing) existing = siblings(parentId).find((n) => n.type === base.type && titleKey(n.title, n.type) === key);
    if (!existing && GLOBAL_DEDUPE.has(base.type)) {
      existing = all().find((n) => n.type === base.type && titleKey(n.title, n.type) === key);
      if (existing) entry.warnings.push(`Matched the existing ${existing.type} under ${T.pathOf(t, existing.parentId).join(' › ') || 'the top level'}`);
    }
    if (existing) {
      entry.status = 'merge';
      entry.nodeId = existing.id;
      entry.title = existing.title;
      entry.parentPath = T.pathOf(t, existing.parentId);
      applyDelta(existing, delta, entry);
      registerRef(raw.ref, existing.id, idx);
      if (!entry.changes.length) entry.status = 'noop';
      return;
    }
    const twin = all().find((n) => n.type === base.type && titleKey(n.title, n.type) === key);
    if (twin) entry.warnings.push(`A ${twin.type} with this name already exists under ${T.pathOf(t, twin.parentId).join(' › ') || 'the top level'}. If it is the same one, merge them by hand.`);
    if (stats.created >= maxCreate) throw new Error('Too many new nodes in one request');

    const node = S.blankNode({ parentId, order: T.nextOrder(t, parentId), type: base.type, title: base.title });
    applyDelta(node, delta, { changes: [], warnings: entry.warnings });
    t.nodes[node.id] = node;
    entry.status = 'new';
    entry.nodeId = node.id;
    entry.parentPath = T.pathOf(t, parentId);
    // Re-describe the new node's contents as additions for the preview.
    const probe = { changes: [], warnings: [] };
    applyDelta(S.blankNode({ type: node.type, title: node.title }), delta, probe);
    entry.changes = probe.changes;
    registerRef(raw.ref, node.id, idx);
    createdIds.push(node.id);
    stats.created++;
  }

  function doUpdate(raw, entry) {
    const id = resolve(pick(raw, 'id', 'target', 'node'), entry, 'node');
    if (!id) throw new Error('Missing node id');
    const node = t.nodes[id];
    entry.title = node.title;
    entry.type = node.type;
    entry.nodeId = id;
    entry.parentPath = T.pathOf(t, node.parentId);
    applyDelta(node, deltaFrom(raw, entry), entry);
    entry.status = entry.changes.length ? 'update' : 'noop';
  }

  function doLink(raw, entry) {
    const from = resolve(raw.from, entry, 'source');
    const to = resolve(raw.to, entry, 'target');
    if (!from || !to) throw new Error('A link needs both ends');
    if (from === to) throw new Error('A node cannot link to itself');
    const node = t.nodes[from];
    const relation = S.text(raw.relation, S.LIMITS.relation);
    entry.title = node.title;
    entry.type = node.type;
    entry.nodeId = from;
    entry.parentPath = T.pathOf(t, node.parentId);
    if (node.links.some((x) => x.to === to && lc(x.relation) === lc(relation))) { entry.status = 'noop'; return; }
    if (node.links.length >= S.LIMITS.links) throw new Error('Link limit reached');
    node.links.push({ to, relation });
    node.updatedAt = S.nowIso();
    entry.status = 'link';
    entry.changes.push({ kind: 'link', label: relation || 'related to', value: t.nodes[to].title });
  }

  ops.forEach((raw, idx) => {
    const entry = { idx, op: 'invalid', status: 'skipped', title: '', type: '', nodeId: null, parentPath: [], changes: [], warnings: [], dependsOn: [] };
    report.push(entry);
    try {
      if (!raw || typeof raw !== 'object') throw new Error('Not an operation');
      const kind = lc(raw.op);
      entry.op = ['create', 'update', 'link'].includes(kind) ? kind : 'invalid';
      if (entry.op === 'invalid') throw new Error(`"${S.text(raw.op, 20) || 'unknown'}" is not an allowed operation`);
      if (accepted && !accepted.has(idx)) {
        if (typeof raw.ref === 'string') blockedRefs.add(raw.ref.trim());
        entry.skipped = 'Not selected';
        return;
      }
      if (entry.op === 'create') doCreate(raw, entry, idx);
      else if (entry.op === 'update') doUpdate(raw, entry);
      else doLink(raw, entry);
    } catch (e) {
      entry.status = 'skipped';
      entry.skipped = e.message;
      if (raw && typeof raw.ref === 'string') blockedRefs.add(raw.ref.trim());
    }
  });

  for (const e of report) {
    if (e.status === 'skipped' || e.status === 'noop') { stats.skipped++; continue; }
    if (e.status === 'merge') stats.merged++;
    if (e.status === 'update') stats.updated++;
    if (e.status === 'link') stats.linked++;
  }
  stats.changed = stats.created + stats.merged + stats.updated + stats.linked;
  S.validateTree(t);
  return { tree: t, report, stats, createdIds, refs: Object.fromEntries(refs) };
}

module.exports = { runOps, titleKey, sharesIdentifier, typeCompatible, GLOBAL_DEDUPE, MAX_OPS };
