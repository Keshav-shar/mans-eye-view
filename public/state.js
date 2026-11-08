import { api } from './api.js';
import { toast } from './dom.js';

// ---- Tiny event bus -----------------------------------------------------------------------------------------------
const listeners = new Map();
export const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); };
export const emit = (ev, ...args) => { for (const fn of listeners.get(ev) || []) fn(...args); };

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`nexus.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`nexus.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

export const state = {
  nodes: new Map(),
  kids: new Map(),
  rev: 0,
  selected: null,
  view: 'note',
  expanded: new Set(store.get('expanded', [])),
  filter: '',
  status: { ai: { configured: false }, undo: null },
  saving: 'saved',
  focusTitle: null,
};

// ---- Tree index and queries -------------------------------------------------------------------------------------------
function indexTree(list) {
  state.nodes = new Map(list.map((n) => [n.id, n]));
  state.kids = new Map();
  for (const n of list) {
    const k = n.parentId || '';
    if (!state.kids.has(k)) state.kids.set(k, []);
    state.kids.get(k).push(n);
  }
  for (const a of state.kids.values()) a.sort((x, y) => x.order - y.order || x.title.localeCompare(y.title));
}

export const kidsOf = (id) => state.kids.get(id || '') || [];

export function pathTo(id) {
  const out = [];
  let cur = state.nodes.get(id);
  for (let g = 0; cur && g < 40; g++) { out.unshift(cur); cur = cur.parentId ? state.nodes.get(cur.parentId) : null; }
  return out;
}

export function descendantCount(id) {
  let n = 0;
  const walk = (x) => { for (const c of kidsOf(x)) { n++; walk(c.id); } };
  walk(id);
  return n;
}

export function findByTitle(title) {
  const t = title.trim().toLowerCase();
  let best = null;
  for (const n of state.nodes.values()) {
    if (n.title.toLowerCase() === t && (!best || pathTo(n.id).length < pathTo(best.id).length)) best = n;
  }
  return best;
}

export function backlinksOf(id) {
  const target = state.nodes.get(id);
  if (!target) return [];
  const title = target.title.toLowerCase();
  const out = [];
  for (const n of state.nodes.values()) {
    if (n.id === id) continue;
    const link = n.links.find((l) => l.to === id);
    if (link) out.push({ node: n, relation: link.relation || 'related to' });
    else if (title && n.notes && n.notes.toLowerCase().includes(`[[${title}`)) out.push({ node: n, relation: 'mentions this' });
  }
  return out;
}

export function searchNodes(query, { limit = 8, exclude = new Set() } = {}) {
  const q = query.trim().toLowerCase();
  const scored = [];
  for (const n of state.nodes.values()) {
    if (exclude.has(n.id)) continue;
    const title = n.title.toLowerCase();
    let s = 0;
    if (!q) s = 1;
    else if (title === q) s = 6;
    else if (title.startsWith(q)) s = 5;
    else if (title.includes(q)) s = 4;
    else if (n.tags.some((t) => t.includes(q)) || n.type.includes(q)) s = 3;
    else if (n.fields.some((f) => f.value.toLowerCase().includes(q)) || n.summary.toLowerCase().includes(q)) s = 2;
    else {
      let j = 0;
      for (const ch of title) if (ch === q[j]) j++;
      if (j === q.length) s = 1;
    }
    if (s) scored.push([s, n]);
  }
  scored.sort((a, b) => b[0] - a[0] || (b[1].updatedAt > a[1].updatedAt ? 1 : -1));
  return scored.slice(0, limit).map((x) => x[1]);
}

// ---- Loading and selection ------------------------------------------------------------------------------------------------
export async function refresh() {
  await flushSaves();
  const [tree, status] = await Promise.all([api.get('/api/tree'), api.get('/api/status')]);
  state.rev = tree.rev;
  state.status = status;
  indexTree(tree.nodes);
  if (!state.selected || !state.nodes.has(state.selected)) {
    const last = store.get('selected');
    state.selected = state.nodes.has(last) ? last : (kidsOf(null)[0] && kidsOf(null)[0].id) || null;
  }
  emit('tree');
}

export function select(id, { view } = {}) {
  if (id && !state.nodes.has(id)) return;
  state.selected = id;
  if (view) state.view = view;
  let p = id && state.nodes.get(id).parentId;
  while (p) { state.expanded.add(p); const n = state.nodes.get(p); p = n && n.parentId; }
  store.set('expanded', [...state.expanded]);
  store.set('selected', id);
  emit('select');
}

export function toggleExpanded(id, force) {
  const open = force === undefined ? !state.expanded.has(id) : force;
  if (open) state.expanded.add(id); else state.expanded.delete(id);
  store.set('expanded', [...state.expanded]);
}

// ---- Saving -----------------------------------------------------------------------------------------------------------------------
const pending = new Map();
let timer = null;

function setSaving(s) { state.saving = s; emit('saving'); }

export function queueSave(id, keys) {
  const set = pending.get(id) || new Set();
  keys.forEach((k) => set.add(k));
  pending.set(id, set);
  setSaving('dirty');
  clearTimeout(timer);
  timer = setTimeout(flushSaves, 500);
}

export function edit(node, patch) {
  Object.assign(node, patch);
  queueSave(node.id, Object.keys(patch));
}

let flushing = Promise.resolve();
export function flushSaves() {
  clearTimeout(timer);
  flushing = flushing.then(async () => {
    const jobs = [...pending];
    pending.clear();
    if (!jobs.length) return;
    setSaving('saving');
    try {
      for (const [id, keys] of jobs) {
        const n = state.nodes.get(id);
        if (!n) continue;
        const patch = {};
        keys.forEach((k) => { patch[k] = n[k]; });
        await api.patch(`/api/nodes/${id}`, patch);
        state.status.undo = state.status.undo || 'Last change';
      }
      setSaving(pending.size ? 'dirty' : 'saved');
    } catch (e) {
      for (const [id, keys] of jobs) { const s = pending.get(id) || new Set(); keys.forEach((k) => s.add(k)); pending.set(id, s); }
      setSaving('error');
      toast(`Not saved yet: ${e.message}`, { kind: 'error' });
    }
  });
  return flushing;
}

window.addEventListener('beforeunload', () => {
  if (!pending.size) return;
  for (const [id, keys] of pending) {
    const n = state.nodes.get(id);
    if (!n) continue;
    const patch = {};
    keys.forEach((k) => { patch[k] = n[k]; });
    fetch(`/api/nodes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: true }).catch(() => {});
  }
});

// ---- Structural actions ---------------------------------------------------------------------------------------------------------------
export async function createNode(parentId, { title = 'Untitled', type } = {}) {
  try {
    const n = await api.post('/api/nodes', { parentId, title, type: type || store.get('lastType', 'note') });
    if (parentId) { state.expanded.add(parentId); store.set('expanded', [...state.expanded]); }
    await refresh();
    state.focusTitle = n.id;
    select(n.id, { view: 'note' });
    return n;
  } catch (e) { toast(e.message, { kind: 'error' }); return null; }
}

export async function deleteNode(id, { forget = false } = {}) {
  const n = state.nodes.get(id);
  if (!n) return;
  const count = descendantCount(id);
  let msg = count ? `Delete "${n.title}" and its ${count} sub-node${count === 1 ? '' : 's'}? You can undo this.` : `Delete "${n.title}"? You can undo this.`;
  if (forget) msg += ' The web pages and snippets saved about it are also deleted, and that part cannot be undone.';
  if (!window.confirm(msg)) return;
  try {
    await flushSaves();
    await api.del(`/api/nodes/${id}${forget ? '?forget=1' : ''}`);
    const fallback = n.parentId || null;
    state.selected = fallback;
    await refresh();
    toast(`Deleted "${n.title}"`, { action: { label: 'Undo', fn: undo } });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

export async function moveNode(id, parentId, index) {
  try {
    await flushSaves();
    await api.post(`/api/nodes/${id}/move`, { parentId, index });
    if (parentId) state.expanded.add(parentId);
    await refresh();
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

export async function undo() {
  try {
    await flushSaves();
    const r = await api.post('/api/undo');
    toast(`Undid: ${r.label}`);
    await refresh();
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
