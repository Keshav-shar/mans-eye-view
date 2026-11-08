import { h, icon, tc } from './dom.js';
import { searchNodes, pathTo } from './state.js';

// Tags: small chips with an inline input.
export function chipsEditor(list, { onChange, placeholder = 'Add a tag' }) {
  const input = h('input', { class: 'chip-input', placeholder, 'aria-label': placeholder, autocomplete: 'off' });
  const box = h('div', { class: 'chips' });
  const draw = () => {
    box.replaceChildren(
      ...list.map((t, i) => h('span', { class: 'chip' }, `#${t}`,
        h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${t}`, onclick: () => { list.splice(i, 1); draw(); onChange(); } }, icon('x', 12)))),
      input,
    );
  };
  const commit = () => {
    const parts = input.value.split(/[,\n]/).map((s) => s.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
    let added = false;
    for (const p of parts) if (!list.includes(p) && list.length < 24) { list.push(p); added = true; }
    input.value = '';
    if (added) { draw(); onChange(); input.focus(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !input.value && list.length) { list.pop(); draw(); onChange(); input.focus(); }
  });
  input.addEventListener('blur', commit);
  draw();
  return box;
}

// Pros and cons: editable one-line items.
export function bulletList(list, { onChange, placeholder, tone }) {
  const wrap = h('div', { class: `bullets ${tone}` });
  const add = h('input', { class: 'bullet-add', placeholder, 'aria-label': placeholder, autocomplete: 'off', maxlength: 240 });
  const draw = () => {
    wrap.replaceChildren(
      ...list.map((text, i) => h('div', { class: 'bullet' },
        h('input', {
          class: 'bullet-text', value: text, maxlength: 240, 'aria-label': 'Edit item',
          oninput: (e) => { list[i] = e.target.value; onChange(); },
          onblur: (e) => { if (!e.target.value.trim()) { list.splice(i, 1); draw(); onChange(); } },
        }),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Remove item', onclick: () => { list.splice(i, 1); draw(); onChange(); } }, icon('x', 13)))),
      add,
    );
  };
  add.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = add.value.trim();
    if (!v || list.length >= 30) return;
    list.push(v);
    draw();
    onChange();
    wrap.querySelector('.bullet-add').focus();
  });
  draw();
  return wrap;
}

// Search-as-you-type picker for choosing an existing node.
export function nodePicker({ onPick, exclude = new Set(), placeholder = 'Find a node to link' }) {
  const input = h('input', { class: 'picker-input', placeholder, 'aria-label': placeholder, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false' });
  const list = h('div', { class: 'picker-list', role: 'listbox', hidden: true });
  let items = [];
  let active = 0;
  const draw = () => {
    list.replaceChildren(...items.map((n, i) => h('button', {
      type: 'button', class: `picker-item${i === active ? ' active' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); pick(n); },
    },
    h('span', { class: 'tdot', style: tc(n.type) }),
    h('span', { class: 'pi-title' }, n.title),
    h('span', { class: 'pi-path' }, pathTo(n.id).slice(0, -1).map((x) => x.title).join(' / ')))));
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(items.length > 0));
  };
  const pick = (n) => { input.value = ''; items = []; draw(); onPick(n); };
  input.addEventListener('input', () => { const q = input.value.trim(); items = q ? searchNodes(q, { limit: 7, exclude }) : []; active = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') { items = []; draw(); }
  });
  input.addEventListener('blur', () => { items = []; draw(); });
  return h('div', { class: 'picker' }, input, list);
}
