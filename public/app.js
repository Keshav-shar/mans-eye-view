import { h, icon, toast, typeHue, typeSat } from './dom.js';
import { api } from './api.js';
import { state, on, emit, store, refresh, select, createNode, undo, flushSaves, pathTo } from './state.js';
import * as sidebar from './sidebar.js';
import * as editor from './editor.js';
import * as graph from './graph.js';
import * as agenda from './agenda.js';
import * as ai from './ai.js';
import * as palette from './palette.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const narrow = () => window.matchMedia('(max-width: 900px)').matches;

// ---- Theme ----------------------------------------------------------------------------------------------------------------------
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  const b = $('btn-theme');
  b.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon', 16));
  b.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  b.setAttribute('aria-label', b.title);
  graph.redraw();
}
setTheme(store.get('theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// ---- Panels ----------------------------------------------------------------------------------------------------------------------
function setSide(open) { app.dataset.side = open ? 'open' : 'closed'; store.set('side', open); }
function setAi(open, { focus = false } = {}) {
  app.dataset.ai = open ? 'open' : 'closed';
  store.set('ai', open);
  $('btn-ai').setAttribute('aria-pressed', String(open));
  if (open && narrow()) setSide(false);
  if (open && focus) setTimeout(() => ai.focus(), 50);
}
setSide(narrow() ? false : store.get('side', true));
setAi(narrow() ? false : store.get('ai', true));
$('btn-side').addEventListener('click', () => { const open = app.dataset.side !== 'open'; setSide(open); if (open && narrow()) setAi(false); });
$('btn-ai').addEventListener('click', () => setAi(app.dataset.ai !== 'open', { focus: true }));
$('scrim').addEventListener('click', () => { setSide(false); setAi(false); });
document.addEventListener('nexus:ai', (e) => setAi(Boolean(e.detail)));

// ---- Views ----------------------------------------------------------------------------------------------------------------------
const VIEWS = ['note', 'graph', 'agenda'];
function applyView() {
  const v = VIEWS.includes(state.view) ? state.view : 'note';
  $('editor').hidden = v !== 'note';
  $('graph').hidden = v !== 'graph';
  $('agenda').hidden = v !== 'agenda';
  document.querySelectorAll('.views .view-tab').forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (v === 'graph') graph.show(); else graph.hide();
  if (v === 'agenda') agenda.render();
  if (narrow() && v !== 'note') setSide(false);
}
function setView(v) { state.view = v; store.set('view', v); applyView(); }
document.querySelectorAll('.views .view-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---- Accent follows the selected node's type ----------------------------------------------------------------------
function paintAccent() {
  const n = state.nodes.get(state.selected);
  const root = document.documentElement.style;
  root.setProperty('--ah', n ? typeHue(n.type) : 220);
  root.setProperty('--as', n ? Math.max(0.5, typeSat(n.type)) : 0.5);
}

function crumbs() {
  const box = $('crumbs');
  const path = pathTo(state.selected);
  box.replaceChildren(...path.flatMap((n, i) => [
    i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '/') : null,
    h('button', { class: `crumb${i === path.length - 1 ? ' last' : ''}`, type: 'button', onclick: () => select(n.id, { view: 'note' }) }, n.title || 'Untitled'),
  ]).filter(Boolean));
}

function savingState() {
  const el = $('saving');
  const map = { saved: ['Saved', 'ok'], saving: ['Saving…', 'busy'], dirty: ['Editing…', 'busy'], error: ['Not saved', 'bad'] };
  const [label, tone] = map[state.saving] || map.saved;
  el.textContent = label;
  el.dataset.tone = tone;
  const u = $('btn-undo');
  u.disabled = !state.status.undo;
  u.title = state.status.undo ? `Undo: ${state.status.undo} (Ctrl+Z)` : 'Nothing to undo';
}

on('select', () => { paintAccent(); crumbs(); applyView(); if (narrow()) setSide(false); });
on('titlechange', crumbs);
on('tree', () => {
  paintAccent(); crumbs(); savingState();
  if (state.view === 'graph') graph.refresh();
  if (state.view === 'agenda') agenda.render();
});
on('saving', savingState);

// ---- Data in and out ----------------------------------------------------------------------------------------------------
async function exportTree() {
  await flushSaves();
  const a = h('a', { href: '/api/export', download: '' });
  document.body.append(a); a.click(); a.remove();
}
async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is larger than 5 MB.');
    const tree = JSON.parse(await file.text());
    const count = Array.isArray(tree.nodes) ? tree.nodes.length : Object.keys(tree.nodes || {}).length;
    if (!count) throw new Error('That file has no nodes.');
    if (!window.confirm(`Replace your whole tree with the ${count} nodes in this file? You can undo this.`)) return;
    await flushSaves();
    await api.post('/api/import', { tree });
    await refresh();
    toast(`Imported ${count} nodes`, { action: { label: 'Undo', fn: undo } });
  } catch (e) {
    toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message, { kind: 'error' });
  } finally { $('import-file').value = ''; }
}
$('btn-export').addEventListener('click', exportTree);
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => importFile(e.target.files[0]));
$('btn-undo').addEventListener('click', undo);
$('btn-new-root').addEventListener('click', () => createNode(null));

// ---- Command palette and shortcuts ---------------------------------------------------------------------------------------
const commands = () => [
  { label: 'New top-level node', run: () => createNode(null) },
  { label: 'New node inside the open one', run: () => state.selected && createNode(state.selected) },
  { label: 'Capture with AI', hint: 'Paste notes', run: () => { ai.setTab('capture'); setAi(true, { focus: true }); } },
  { label: 'Ask AI about my tree', run: () => { ai.setTab('ask'); setAi(true, { focus: true }); } },
  { label: 'Research the web', hint: 'Search or crawl a site', run: () => { ai.setTab('research'); setAi(true); } },
  { label: 'Show note', run: () => setView('note') },
  { label: 'Show graph', run: () => setView('graph') },
  { label: 'Show what needs attention', run: () => setView('agenda') },
  { label: 'Undo last change', run: undo },
  { label: 'Export tree as JSON', run: exportTree },
  { label: 'Toggle theme', run: () => $('btn-theme').click() },
];
$('btn-palette').addEventListener('click', () => palette.open(commands()));

const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open(commands()); }
  else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing(e.target)) { e.preventDefault(); undo(); }
  else if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); createNode(e.shiftKey ? null : state.selected); }
  else if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setAi(app.dataset.ai !== 'open', { focus: true }); }
  else if (e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); setView(state.view === 'graph' ? 'note' : 'graph'); }
  else if (e.key === 'Escape' && narrow()) { setSide(false); setAi(false); }
});
window.addEventListener('resize', () => { if (state.view === 'graph') graph.redraw(); });

// ---- Boot ---------------------------------------------------------------------------------------------------------------------------------
async function boot() {
  sidebar.init();
  editor.init();
  graph.mount($('graph'));
  ai.init($('ai-panel'));
  try {
    await refresh();
  } catch (e) {
    $('editor').replaceChildren(h('div', { class: 'empty-stage' }, h('h2', {}, 'Cannot load your tree'), h('p', {}, e.message),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again')));
    return;
  }
  const saved = store.get('view', 'note');
  state.view = VIEWS.includes(saved) ? saved : 'note';
  paintAccent(); crumbs(); savingState(); applyView();
  emit('select');
}
boot();
