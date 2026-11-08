import { h, icon, tc, detectKind, hrefFor, fid, isoDate, addDays, relDay, fmtDate, autogrow, toast, PERSONISH } from './dom.js';
import {
  state, on, emit, edit, queueSave, select, createNode, deleteNode, kidsOf, pathTo, backlinksOf, findByTitle, store,
} from './state.js';
import { chipsEditor, bulletList, nodePicker } from './ui.js';
import { renderMd } from './md.js';
import { api } from './api.js';

const KIND_ICON = { phone: 'phone', email: 'mail', url: 'globe', address: 'pin', date: 'calendar', number: 'hash', text: 'lines' };
const PRESETS = [['Phone', 'phone'], ['Email', 'email'], ['Address', 'address'], ['Link', 'url'], ['Date', 'date'], ['Other', 'text']];
const PRESET_KEY = { Phone: 'Phone', Email: 'Email', Address: 'Address', Link: 'Website', Date: 'Date', Other: '' };

const LEVELS = {
  skill: { label: 'Proficiency', words: ['Not started', 'Beginner', 'Basic', 'Working', 'Strong', 'Expert'] },
  person: { label: 'Relationship', words: ['Unknown', 'Heard of', 'Met once', 'Talked', 'Friendly', 'Close'] },
  other: { label: 'Rating', words: ['0 of 5', '1 of 5', '2 of 5', '3 of 5', '4 of 5', '5 of 5'] },
};
const levelInfo = (type) => (type === 'skill' || type === 'path' ? LEVELS.skill : PERSONISH.has(type) ? LEVELS.person : LEVELS.other);

const STATUS_SUGGESTIONS = ['to reach out', 'reached out', 'in conversation', 'waiting', 'warm', 'referred', 'gone cold', 'learning', 'practicing', 'solid', 'rusty', 'active', 'paused', 'done'];
const BASE_TYPES = ['area', 'company', 'person', 'hr', 'recruiter', 'vc', 'mentor', 'skill', 'credential', 'idea', 'path', 'project', 'product', 'tech', 'concept', 'field', 'event', 'resource', 'place', 'session', 'note'];

function section(title, body, actions) {
  return h('section', { class: 'sec' }, h('div', { class: 'sec-h' }, h('h3', {}, title), actions || null), body);
}

// ---- Properties (phone, email, address, anything) ------------------------------------------------------------------------
function propertiesSection(n) {
  const list = h('div', { class: 'props' });

  const rowFor = (f) => {
    const kindBtn = h('button', {
      class: 'kind', type: 'button', title: 'Copy value', 'aria-label': 'Copy value',
      onclick: async () => {
        if (!f.value) return;
        try { await navigator.clipboard.writeText(f.value); toast('Copied'); } catch { toast('Could not copy', { kind: 'error' }); }
      },
    });
    const open = h('a', { class: 'open icon-btn sm', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open', title: 'Open' }, icon('external', 13));
    const sync = () => {
      kindBtn.replaceChildren(icon(KIND_ICON[f.kind] || 'lines', 15));
      kindBtn.dataset.kind = f.kind;
      const href = hrefFor(f);
      if (href) { open.setAttribute('href', href); open.hidden = false; } else { open.removeAttribute('href'); open.hidden = true; }
    };
    const save = () => queueSave(n.id, ['fields']);
    const key = h('input', {
      class: 'k', value: f.key, placeholder: 'Name', maxlength: 40, 'aria-label': 'Property name', list: 'keys-list',
      oninput: (e) => { f.key = e.target.value; f.kind = detectKind(f.key, f.value); sync(); save(); },
    });
    const val = h('input', {
      class: 'v', value: f.value, placeholder: 'Value', maxlength: 600, 'aria-label': 'Property value',
      oninput: (e) => { f.value = e.target.value; f.kind = detectKind(f.key, f.value); sync(); save(); },
    });
    sync();
    return h('div', { class: 'prop', 'data-id': f.id }, kindBtn, key, val, open,
      h('button', {
        class: 'icon-btn sm rm', type: 'button', 'aria-label': 'Remove property',
        onclick: () => { n.fields = n.fields.filter((x) => x.id !== f.id); save(); draw(); },
      }, icon('x', 13)));
  };

  const draw = () => {
    list.replaceChildren(...n.fields.map(rowFor));
    if (!n.fields.length) list.append(h('p', { class: 'hint' }, 'Phone numbers, emails, addresses, links or anything else worth keeping. The AI fills these in from your notes too.'));
  };
  const add = (label, kind) => {
    const f = { id: fid(), key: PRESET_KEY[label], value: '', kind };
    n.fields.push(f);
    draw();
    const row = list.querySelector(`[data-id="${f.id}"]`);
    (row && row.querySelector(f.key ? '.v' : '.k')).focus();
  };
  draw();
  const presets = h('div', { class: 'presets' }, PRESETS.map(([label, kind]) => h('button', { class: 'btn sm', type: 'button', onclick: () => add(label, kind) }, icon('plus', 12), label)));
  return section('Details', h('div', {}, list, presets));
}

// ---- Level, dates ------------------------------------------------------------------------------------------------------------
function trackingSection(n) {
  const info = levelInfo(n.type);
  const word = h('span', { class: 'level-word' });
  const segs = h('div', { class: 'meter', role: 'radiogroup', 'aria-label': info.label });
  const drawLevel = () => {
    word.textContent = n.level == null ? 'Not rated' : info.words[n.level];
    segs.replaceChildren(...info.words.map((w, i) => h('button', {
      type: 'button', class: `seg${n.level != null && i <= n.level && n.level > 0 ? ' on' : ''}${n.level === i ? ' cur' : ''}`, role: 'radio', 'aria-checked': String(n.level === i),
      'aria-label': `${info.label}: ${w}`, title: w,
      onclick: () => { edit(n, { level: n.level === i ? null : i }); drawLevel(); },
    }, String(i))));
  };
  drawLevel();

  const dateField = (label, key, quick) => {
    const input = h('input', {
      type: 'date', class: 'date', value: n[key] || '', 'aria-label': label,
      onchange: (e) => { edit(n, { [key]: e.target.value || null }); hint(); },
    });
    const note = h('span', { class: 'date-note' });
    const hint = () => {
      note.textContent = n[key] ? relDay(n[key]) : '';
      note.classList.toggle('overdue', key === 'followUp' && n[key] && n[key] < isoDate());
    };
    const set = (v) => { input.value = v || ''; edit(n, { [key]: v || null }); hint(); };
    hint();
    return h('div', { class: 'field' },
      h('label', {}, label),
      h('div', { class: 'date-row' }, input, note),
      h('div', { class: 'quick' }, quick.map(([text, days]) => h('button', { class: 'btn sm', type: 'button', onclick: () => set(days === null ? null : addDays(isoDate(), days)) }, text))));
  };

  return section('Keeping in touch', h('div', { class: 'tracking' },
    h('div', { class: 'field' }, h('label', {}, info.label), h('div', { class: 'level-row' }, segs, word)),
    dateField('Follow up on', 'followUp', [['Tomorrow', 1], ['In a week', 7], ['In 2 weeks', 14], ['In a month', 30], ['Clear', null]]),
    dateField('Last touched', 'lastTouched', [['Today', 0], ['Clear', null]])));
}

// ---- Notes with [[wikilinks]] ------------------------------------------------------------------------------------------------------------
function notesSection(n) {
  const host = h('div', { class: 'notes' });
  let editing = false;

  const preview = () => {
    editing = false;
    host.replaceChildren();
    if (!n.notes.trim()) {
      host.append(h('button', { class: 'notes-empty', type: 'button', onclick: editMode }, 'Write notes in markdown. Link other nodes with [[Name]].'));
      return;
    }
    const body = h('div', { class: 'md', tabindex: 0, title: 'Click to edit', onclick: (e) => { if (!e.target.closest('a,input')) editMode(); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === body) editMode(); } },
      renderMd(n.notes, {
        resolve: findByTitle,
        onWiki: async (title, node) => {
          if (node) return select(node.id, { view: 'note' });
          const created = await createNode(n.id, { title, type: 'note' });
          if (created) toast(`Created "${title}" under ${n.title}`);
        },
        onTask: (lineNo, checked) => {
          const lines = n.notes.split('\n');
          lines[lineNo] = lines[lineNo].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
          edit(n, { notes: lines.join('\n') });
        },
      }));
    host.append(body);
  };
  const editMode = () => {
    editing = true;
    const ta = h('textarea', {
      class: 'notes-input', value: n.notes, rows: 6, maxlength: 20000, 'aria-label': 'Notes', placeholder: 'Markdown works. Link nodes with [[Name]].',
      oninput: (e) => edit(n, { notes: e.target.value }),
      onblur: () => { if (editing) preview(); },
      onkeydown: (e) => { if (e.key === 'Escape') ta.blur(); },
    });
    host.replaceChildren(ta);
    autogrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  preview();
  return section('Notes', host);
}

// ---- Connections ------------------------------------------------------------------------------------------------------------------------------
function connectionsSection(n) {
  const out = h('div', { class: 'links' });
  const incoming = h('div', { class: 'links' });
  const relation = h('input', { class: 'relation', placeholder: 'How are they related? (optional)', maxlength: 48, 'aria-label': 'Relationship', list: 'relations-list' });

  const nodeChip = (node) => h('button', { class: 'node-chip', type: 'button', onclick: () => select(node.id, { view: 'note' }) },
    h('span', { class: 'tdot', style: tc(node.type) }), node.title);

  const draw = () => {
    out.replaceChildren(...n.links.map((l, i) => {
      const target = state.nodes.get(l.to);
      if (!target) return null;
      return h('div', { class: 'link-row' },
        h('input', {
          class: 'rel', value: l.relation, placeholder: 'related to', maxlength: 48, 'aria-label': 'Relationship',
          oninput: (e) => { l.relation = e.target.value; queueSave(n.id, ['links']); },
        }),
        nodeChip(target),
        h('button', { class: 'icon-btn sm rm', type: 'button', 'aria-label': 'Remove link', onclick: () => { n.links.splice(i, 1); queueSave(n.id, ['links']); draw(); } }, icon('x', 13)));
    }));
    const back = backlinksOf(n.id);
    incoming.replaceChildren(...back.map(({ node, relation: r }) => h('div', { class: 'link-row incoming' }, h('span', { class: 'rel static' }, r), nodeChip(node))));
  };
  draw();

  const exclude = new Set([n.id]);
  const picker = nodePicker({
    exclude,
    onPick: (target) => {
      if (n.links.some((l) => l.to === target.id && l.relation.toLowerCase() === relation.value.trim().toLowerCase())) return;
      n.links.push({ to: target.id, relation: relation.value.trim() });
      relation.value = '';
      queueSave(n.id, ['links']);
      draw();
    },
  });
  const body = h('div', {},
    out,
    h('div', { class: 'link-add' }, picker, relation),
    backlinksOf(n.id).length ? h('div', { class: 'sub-h' }, 'Linked from') : null,
    incoming);
  return section('Connections', body);
}

// ---- From the web: identifiers and the pages each fact came from ---------------------------------------------------
const sourceCache = new Map();

function safeHref(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

function webSection(n) {
  const ids = Object.entries(n.identifiers || {});
  const aliases = n.aliases || [];
  const sources = n.sources || [];
  if (!ids.length && !aliases.length && !sources.length) return null;
  const list = h('div', { class: 'src-list' });
  // Fact-level evidence: the sentence each fact came from, the site, and which extractor read it.
  const evidence = h('div', { class: 'src-list prov' });
  if (sources.length) {
    api.get(`/api/web/provenance/${encodeURIComponent(n.id)}`).then((r) => {
      const facts = (r.facts || []).filter((f) => f.snippet).slice(0, 8);
      if (!facts.length) return;
      evidence.replaceChildren(h('div', { class: 'sub-h' }, 'Evidence'), ...facts.map((f) => h('div', { class: 'src' },
        h('span', {}, `“${f.snippet.slice(0, 220)}”`),
        h('span', { class: 'src-meta' }, [f.domain, f.kind === 'edge' ? 'connection' : 'mention', String(f.extractor || '').startsWith('haiku') ? 'read by AI' : 'rules', f.at ? fmtDate(f.at.slice(0, 10)) : null].filter(Boolean).join(' · ')))));
    }).catch(() => {});
  }
  const draw = () => {
    list.replaceChildren(...sources.slice().reverse().map((id) => {
      const s = sourceCache.get(id);
      if (!s) return h('div', { class: 'src muted' }, 'Loading…');
      const href = safeHref(s.url);
      return h('div', { class: 'src' },
        href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('external', 12), s.title || s.domain) : h('span', {}, s.title || s.domain),
        h('span', { class: 'src-meta' }, [s.domain, s.pageType, s.fetchedAt ? fmtDate(s.fetchedAt.slice(0, 10)) : null].filter(Boolean).join(' · ')));
    }));
  };
  const missing = sources.filter((id) => !sourceCache.has(id));
  if (missing.length) {
    api.get(`/api/web/sources?ids=${missing.join(',')}`).then((r) => {
      for (const s of r.sources) sourceCache.set(s.id, s);
      for (const id of missing) if (!sourceCache.has(id)) sourceCache.set(id, { id, title: 'Source no longer stored', domain: '' });
      draw();
    }).catch(() => {});
  }
  draw();
  const title = sources.length ? `From the web (${sources.length} source${sources.length === 1 ? '' : 's'})` : 'From the web';
  return section(title, h('div', {},
    ids.length ? h('div', { class: 'chips ids' }, ids.map(([k, v]) => h('span', { class: 'chip id', title: 'Strong identifier: anything else with the same one is merged into this node' }, h('b', {}, k), ` ${v}`))) : null,
    aliases.length ? h('p', { class: 'hint' }, `Also known as: ${aliases.join(', ')}`) : null,
    list,
    evidence));
}

// ---- Children ---------------------------------------------------------------------------------------------------------------------------------------
function childrenSection(n) {
  const kids = kidsOf(n.id);
  const title = h('input', { class: 'child-title', placeholder: n.type === 'area' ? 'Add to this area' : 'Add a sub-node', maxlength: 120, 'aria-label': 'New sub-node name' });
  const type = h('input', { class: 'child-type', placeholder: 'type', maxlength: 24, value: store.get('lastType', 'note'), list: 'types-list', 'aria-label': 'Type of the new sub-node' });
  const add = async () => {
    const t = title.value.trim();
    if (!t) return title.focus();
    store.set('lastType', type.value.trim() || 'note');
    title.value = '';
    await createNode(n.id, { title: t, type: type.value.trim() || 'note' });
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return section(kids.length ? `Inside this node (${kids.length})` : 'Inside this node', h('div', {},
    kids.length ? h('div', { class: 'kids' }, kids.map((k) => h('button', { class: 'kid', type: 'button', onclick: () => select(k.id, { view: 'note' }) },
      h('span', { class: 'tdot', style: tc(k.type) }), h('span', { class: 'kid-title' }, k.title), h('span', { class: 'kid-sub' }, k.summary || k.type)))) : null,
    h('div', { class: 'child-add' }, title, type, h('button', { class: 'btn', type: 'button', onclick: add }, icon('plus', 14), 'Add'))));
}

// ---- Whole editor ----------------------------------------------------------------------------------------------------------------------------------
export function render() {
  const host = document.getElementById('editor');
  host.replaceChildren();
  const n = state.nodes.get(state.selected);
  refreshDatalists();
  if (!n) {
    host.append(h('div', { class: 'empty-stage' },
      h('h2', {}, 'Start your tree'),
      h('p', {}, 'Add a company, a person, a skill or an idea. Or open the AI panel and paste a note: Nexus will file it for you.'),
      h('button', { class: 'btn primary', onclick: () => createNode(null) }, icon('plus', 14), 'Add a node')));
    return;
  }

  const title = h('input', {
    class: 'doc-title', value: n.title, placeholder: 'Untitled', maxlength: 120, 'aria-label': 'Title',
    oninput: (e) => { edit(n, { title: e.target.value }); emit('titlechange', n.id); },
    onblur: (e) => { if (!e.target.value.trim()) { e.target.value = 'Untitled'; edit(n, { title: 'Untitled' }); emit('titlechange', n.id); } },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
  });

  const typeInput = h('input', {
    class: 'meta-input type', value: n.type, list: 'types-list', maxlength: 24, 'aria-label': 'Type', style: tc(n.type),
    onchange: (e) => {
      const v = e.target.value.trim().toLowerCase() || 'note';
      store.set('lastType', v);
      edit(n, { type: v });
      render();
      emit('titlechange', n.id);
    },
  });
  const statusInput = h('input', {
    class: 'meta-input status', value: n.status, list: 'status-list', maxlength: 32, placeholder: 'Status', 'aria-label': 'Status',
    oninput: (e) => edit(n, { status: e.target.value }),
  });
  const tags = chipsEditor(n.tags, { onChange: () => queueSave(n.id, ['tags']), placeholder: 'Add a tag' });

  const summary = h('textarea', {
    class: 'summary', value: n.summary, rows: 2, maxlength: 600, placeholder: 'A line or two on who or what this is', 'aria-label': 'Brief',
    oninput: (e) => edit(n, { summary: e.target.value }),
  });
  autogrow(summary);

  const pros = bulletList(n.pros, { onChange: () => queueSave(n.id, ['pros']), placeholder: 'Add a strength or reason to like this', tone: 'pro' });
  const cons = bulletList(n.cons, { onChange: () => queueSave(n.id, ['cons']), placeholder: 'Add a risk or downside', tone: 'con' });

  const created = new Date(n.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const updated = new Date(n.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  host.append(h('article', { class: 'doc' },
    title,
    h('div', { class: 'meta' }, typeInput, statusInput, tags),
    summary,
    propertiesSection(n),
    h('div', { class: 'two' },
      section('Pros', pros),
      section('Cons', cons)),
    trackingSection(n),
    notesSection(n),
    connectionsSection(n),
    webSection(n),
    childrenSection(n),
    h('footer', { class: 'doc-foot' },
      h('span', {}, `Created ${created}. Edited ${updated}.`),
      h('span', { class: 'spacer' }),
      (n.sources || []).length ? h('button', { class: 'btn sm', type: 'button', title: 'Also delete the web pages and snippets saved about it', onclick: () => deleteNode(n.id, { forget: true }) }, icon('trash', 13), 'Delete + forget web data') : null,
      h('button', { class: 'btn danger sm', type: 'button', onclick: () => deleteNode(n.id) }, icon('trash', 13), 'Delete'))));

  host.scrollTop = 0;
  if (state.focusTitle === n.id) {
    state.focusTitle = null;
    title.focus();
    title.select();
  }
}

function refreshDatalists() {
  const types = new Set(BASE_TYPES);
  const keys = new Set(['Phone', 'Email', 'Address', 'LinkedIn', 'Website', 'Role', 'Location', 'Team', 'Met at']);
  const rels = new Set(['works at', 'introduced by', 'reports to', 'invested in', 'mentor of', 'knows', 'uses skill', 'part of']);
  for (const n of state.nodes.values()) {
    types.add(n.type);
    n.fields.forEach((f) => keys.add(f.key));
    n.links.forEach((l) => l.relation && rels.add(l.relation));
  }
  const fill = (id, items) => {
    let dl = document.getElementById(id);
    if (!dl) { dl = h('datalist', { id }); document.body.append(dl); }
    dl.replaceChildren(...[...items].slice(0, 80).map((v) => h('option', { value: v })));
  };
  fill('types-list', types);
  fill('keys-list', keys);
  fill('relations-list', rels);
  fill('status-list', STATUS_SUGGESTIONS);
}

export function init() {
  on('tree', render);
  on('select', render);
}
