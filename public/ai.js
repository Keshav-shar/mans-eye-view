import { h, icon, tc, toast } from './dom.js';
import { api } from './api.js';
import { state, on, refresh, select, undo, flushSaves, findByTitle, pathTo, toggleExpanded } from './state.js';
import { renderMd } from './md.js';
import * as research from './research.js';

const cap = { text: '', url: '', useContext: true, busy: false, proposal: null, picked: new Set(), result: null, error: '' };
const ask = { q: '', busy: false, items: [], error: '' };
let tab = 'capture';
let host = null;
let ctxLabel = null;

const BADGE = { new: 'New', merge: 'Merged', update: 'Updated', link: 'Linked', noop: 'No change', skipped: 'Skipped' };
const selectable = (e) => ['new', 'merge', 'update', 'link'].includes(e.status);

function describe(c) {
  switch (c.kind) {
    case 'summary': return ['Brief', c.value];
    case 'field': return [c.label, c.value, c.note];
    case 'tag': return ['Tag', `#${c.value}`];
    case 'pro': return ['Pro', c.value];
    case 'con': return ['Con', c.value];
    case 'notes': return ['Note', c.value];
    case 'link': return [c.label, `→ ${c.value}`];
    case 'status': return ['Status', c.value, c.from ? `Was "${c.from}"` : null];
    case 'level': return ['Level', `${c.value} of 5`, c.from ? `Was ${c.from}` : null];
    case 'followUp': return ['Follow up', c.value, c.from ? `Was ${c.from}` : null];
    case 'lastTouched': return ['Last touched', c.value];
    case 'alias': return ['Also known as', c.value];
    case 'identifier': return [c.label, c.value, 'Strong identifier'];
    case 'source': return ['Source', c.value];
    case 'evidence': return [c.label, `→ ${c.value}`, 'More evidence for an existing link'];
    default: return [c.kind, c.value];
  }
}

function toggle(idx, on) {
  const rep = cap.proposal.report;
  if (on) {
    cap.picked.add(idx);
    for (const d of rep[idx].dependsOn) if (rep[d] && selectable(rep[d])) toggle(d, true);
  } else {
    cap.picked.delete(idx);
    for (const e of rep) if (e.dependsOn.includes(idx) && cap.picked.has(e.idx)) toggle(e.idx, false);
  }
}

async function organize() {
  const text = cap.text.trim();
  if (!text || cap.busy) return;
  cap.busy = true; cap.error = ''; cap.result = null; cap.proposal = null;
  render();
  try {
    await flushSaves();
    const p = await api.post('/api/ai/propose', { text, contextNodeId: cap.useContext ? state.selected : null });
    cap.proposal = p;
    cap.picked = new Set(p.report.filter(selectable).map((e) => e.idx));
  } catch (e) { cap.error = e.message; }
  cap.busy = false;
  render();
}

// Firecrawl-style: read one page, extract entities and relations, show the same preview as a note.
async function readPage() {
  const url = cap.url.trim();
  if (!url || cap.busy) return;
  cap.busy = true; cap.error = ''; cap.result = null; cap.proposal = null;
  render();
  try {
    await flushSaves();
    const p = await api.post('/api/web/scrape', { url });
    cap.proposal = p;
    cap.picked = new Set(p.report.filter(selectable).map((e) => e.idx));
  } catch (e) { cap.error = e.message; }
  cap.busy = false;
  render();
}

async function apply() {
  if (cap.busy || !cap.proposal || !cap.picked.size) return;
  cap.busy = true; cap.error = '';
  render();
  try {
    const r = await api.post('/api/ai/apply', { proposalId: cap.proposal.proposalId, accepted: [...cap.picked] });
    cap.result = r.stats; cap.proposal = null; cap.text = '';
    await refresh();
    const made = (r.createdIds || []).filter((id) => state.nodes.has(id));
    // Open every folder on the way to each new node so nothing that was just filed is hidden.
    for (const id of made) for (const a of pathTo(id)) toggleExpanded(a.id, true);
    if (made[0]) select(made[0], { view: 'note' });
    const bits = [];
    if (r.stats.created) bits.push(`${r.stats.created} new`);
    if (r.stats.merged + r.stats.updated) bits.push(`${r.stats.merged + r.stats.updated} updated`);
    if (r.stats.linked) bits.push(`${r.stats.linked} linked`);
    toast(`Added to your tree: ${bits.join(', ') || 'nothing new'}`, { action: { label: 'Undo', fn: undo } });
  } catch (e) { cap.error = e.message; }
  cap.busy = false;
  render();
}

async function sendQuestion(q) {
  const question = (q ?? ask.q).trim();
  if (!question || ask.busy) return;
  ask.busy = true; ask.error = ''; ask.q = '';
  const item = { q: question, a: null, nodes: [] };
  ask.items.push(item);
  render();
  try {
    await flushSaves();
    const r = await api.post('/api/ai/ask', { question, contextNodeId: cap.useContext ? state.selected : null });
    item.a = r.answer; item.nodes = r.nodes;
  } catch (e) { ask.items.pop(); ask.q = question; ask.error = e.message; }
  ask.busy = false;
  render();
}

function banner() {
  const ai = state.status.ai || {};
  if (ai.configured) return null;
  return h('div', { class: 'banner warn', role: 'status' },
    h('strong', {}, ai.hasKey ? 'Model name missing' : 'Groq key missing'),
    h('p', {}, `Add ${ai.hasKey ? 'GROQ_MODEL' : 'GROQ_API_KEY'} to the .env file next to server.js, then restart Nexus. Everything else works without it.`));
}

function contextRow() {
  const n = state.nodes.get(state.selected);
  ctxLabel = h('span', { class: 'ctx-name' }, n ? n.title : 'Nothing selected');
  return h('label', { class: 'toggle ctx' },
    h('input', { type: 'checkbox', checked: cap.useContext, onchange: (e) => { cap.useContext = e.target.checked; } }),
    'Use the open node as context: ', ctxLabel);
}

function proposalView() {
  const p = cap.proposal;
  const rep = p.report;
  const items = rep.map((e) => {
    const ok = selectable(e);
    const checked = cap.picked.has(e.idx);
    const changes = e.changes.map((c) => {
      const [label, value, note] = describe(c);
      return h('li', {}, h('span', { class: 'chg-k' }, label), h('span', { class: 'chg-v' }, value), note ? h('span', { class: 'chg-note' }, note) : null);
    });
    return h('li', { class: `prop-item ${e.status}${checked ? ' on' : ''}` },
      h('label', { class: 'pi-head' },
        h('input', { type: 'checkbox', checked, disabled: !ok, 'aria-label': `Include ${e.title || 'this change'}`, onchange: (ev) => { toggle(e.idx, ev.target.checked); render(); } }),
        h('span', { class: `badge ${e.status}` }, BADGE[e.status] || e.status),
        e.title ? h('span', { class: 'pi-name' }, h('span', { class: 'tdot', style: tc(e.type) }), e.title, h('span', { class: 'pi-type' }, e.type)) : h('span', { class: 'pi-name muted' }, 'Unreadable change')),
      e.parentPath && e.parentPath.length ? h('div', { class: 'pi-where' }, `in ${e.parentPath.join(' / ')}`) : (e.status === 'new' ? h('div', { class: 'pi-where' }, 'at the top level') : null),
      changes.length ? h('ul', { class: 'chg' }, changes) : null,
      e.skipped && e.skipped !== 'Not selected' ? h('div', { class: 'pi-skip' }, e.skipped) : null,
      e.status === 'noop' ? h('div', { class: 'pi-skip' }, 'Already in your tree.') : null,
      ...e.warnings.map((w) => h('div', { class: 'pi-warn' }, w)));
  });
  const n = cap.picked.size;
  const pg = p.page;
  return h('div', { class: 'proposal' },
    p.reply ? h('p', { class: 'ai-reply' }, p.reply) : null,
    pg ? h('div', { class: 'page-card' },
      h('div', {}, h('b', {}, pg.title || pg.url)),
      h('div', { class: 'hint' }, [`${pg.chars.toLocaleString()} characters`, `${pg.links} links`, `${pg.mentions} entities`, `${pg.facts} relations`,
        pg.jsonld.length ? `structured data: ${pg.jsonld.join(', ')}` : null, pg.ai.calls ? `${pg.ai.calls} AI calls` : 'no AI calls needed',
        pg.flagged ? `${pg.flagged} suspicious passage${pg.flagged === 1 ? '' : 's'} kept away from the AI` : null].filter(Boolean).join(' · ')),
      h('details', {}, h('summary', {}, 'Page text'), h('pre', { class: 'page-md' }, pg.markdown))) : null,
    h('p', { class: 'hint' }, 'Nothing has been saved yet. Untick anything you do not want.'),
    h('ul', { class: 'prop-list' }, items),
    h('div', { class: 'prop-actions' },
      h('button', { class: 'btn primary', type: 'button', disabled: !n || cap.busy, onclick: apply }, icon('check', 14), n ? `Add ${n} change${n === 1 ? '' : 's'} to tree` : 'Nothing selected'),
      h('button', { class: 'btn', type: 'button', onclick: () => { cap.proposal = null; render(); } }, 'Discard')));
}

function captureTab() {
  const ta = h('textarea', {
    class: 'ai-input', rows: 6, value: cap.text, maxlength: 12000, 'aria-label': 'Note to organise', disabled: cap.busy,
    placeholder: 'Paste or type anything.\n\n"Met Priya Shah, HR lead at Zeta Payments (Mumbai, BKC). +91 98111 22233, priya@zeta.in. Hiring SDE interns, follow up next Friday. Pro: replies fast. Con: only remote roles."',
    oninput: (e) => { cap.text = e.target.value; go.disabled = !cap.text.trim() || cap.busy; },
    onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); organize(); } },
  });
  const go = h('button', { class: 'btn primary', type: 'button', disabled: !cap.text.trim() || cap.busy, onclick: organize },
    icon('sparkle', 14), cap.busy && !cap.proposal ? 'Organising…' : 'Organise');
  const urlIn = h('input', {
    class: 'ai-ask', value: cap.url, maxlength: 2048, placeholder: 'Or read a web page: https://company.com/about', 'aria-label': 'Web page to read', disabled: cap.busy,
    oninput: (e) => { cap.url = e.target.value; read.disabled = !cap.url.trim() || cap.busy; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); readPage(); } },
  });
  const read = h('button', { class: 'btn', type: 'button', disabled: !cap.url.trim() || cap.busy, onclick: readPage }, icon('globe', 14), 'Read page');
  return h('div', { class: 'ai-body' },
    contextRow(),
    ta,
    h('div', { class: 'ai-row' }, go, h('span', { class: 'hint' }, 'Ctrl+Enter')),
    h('div', { class: 'ai-row' }, urlIn, read),
    cap.error ? h('div', { class: 'banner error', role: 'alert' }, cap.error) : null,
    cap.busy && !cap.proposal ? h('p', { class: 'hint' }, 'Reading your note and matching it to your tree…') : null,
    cap.proposal ? proposalView() : null,
    cap.result && !cap.proposal ? h('div', { class: 'banner ok', role: 'status' }, `Saved: ${cap.result.created} new, ${cap.result.merged + cap.result.updated} updated, ${cap.result.linked} linked.`) : null);
}

const SUGGESTIONS = ['Who should I follow up with this week?', 'Which skills have I not practised lately?', 'Summarise everything I know about my investor contacts.', 'Which companies have no contact person yet?'];

function askTab() {
  const input = h('input', {
    class: 'ai-ask', value: ask.q, placeholder: 'Ask about your network or skills', maxlength: 1000, 'aria-label': 'Question', disabled: ask.busy,
    oninput: (e) => { ask.q = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); sendQuestion(); } },
  });
  return h('div', { class: 'ai-body' },
    h('div', { class: 'ai-row' }, input, h('button', { class: 'btn primary', type: 'button', disabled: ask.busy, onclick: () => sendQuestion() }, ask.busy ? 'Thinking…' : 'Ask')),
    ask.error ? h('div', { class: 'banner error', role: 'alert' }, ask.error) : null,
    !ask.items.length ? h('div', { class: 'suggest' }, SUGGESTIONS.map((s) => h('button', { class: 'btn sm', type: 'button', onclick: () => sendQuestion(s) }, s))) : null,
    h('div', { class: 'qa' }, ask.items.map((it) => h('div', { class: 'qa-item' },
      h('p', { class: 'q' }, it.q),
      it.a == null ? h('p', { class: 'hint' }, 'Thinking…') : h('div', { class: 'a md' }, renderMd(it.a, { resolve: findByTitle, onWiki: (t, n) => { if (n) select(n.id, { view: 'note' }); } })),
      it.nodes && it.nodes.length ? h('div', { class: 'a-nodes' }, it.nodes.map((id) => {
        const n = state.nodes.get(id);
        return n ? h('button', { class: 'node-chip', type: 'button', title: pathTo(id).map((x) => x.title).join(' / '), onclick: () => select(id, { view: 'note' }) }, h('span', { class: 'tdot', style: tc(n.type) }), n.title) : null;
      })) : null))));
}

export function render() {
  if (!host) return;
  const keep = host.querySelector('.ai-scroll');
  const top = keep ? keep.scrollTop : 0;
  host.replaceChildren(
    h('div', { class: 'ai-head' },
      h('div', { class: 'tabs', role: 'tablist' }, [['capture', 'Capture'], ['ask', 'Ask'], ['research', 'Research']].map(([id, label]) => h('button', {
        class: `tab${tab === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(tab === id), type: 'button',
        onclick: () => { tab = id; render(); },
      }, label))),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close panel', title: 'Close', onclick: () => document.dispatchEvent(new CustomEvent('nexus:ai', { detail: false })) }, icon('x', 15))),
    h('div', { class: 'ai-scroll' }, tab === 'research' ? null : banner(), tab === 'capture' ? captureTab() : tab === 'ask' ? askTab() : research.view()));
  const scroller = host.querySelector('.ai-scroll');
  scroller.scrollTop = top;
}

export function focus() {
  const el = host && host.querySelector(tab === 'capture' ? '.ai-input' : '.ai-ask');
  if (el) el.focus();
}

export function setTab(t) { tab = t; render(); }

export function init(el) {
  host = el;
  on('select', () => {
    const n = state.nodes.get(state.selected);
    if (ctxLabel && n) ctxLabel.textContent = n.title;
  });
  // The Research tab repaints itself; re-rendering the panel on every tree change would steal focus.
  on('tree', () => { if (!cap.busy && !ask.busy && tab !== 'research') render(); });
  render();
}
