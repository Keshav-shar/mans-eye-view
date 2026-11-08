import { h, tc } from './dom.js';
import { searchNodes, select, pathTo } from './state.js';

let overlay = null;

export function close() {
  if (overlay) { overlay.remove(); overlay = null; }
}

export function open(commands) {
  close();
  let items = [];
  let active = 0;
  const input = h('input', { class: 'pal-input', placeholder: 'Jump to a node or run a command', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });

  const compute = () => {
    const q = input.value.trim().toLowerCase();
    const cmds = commands.filter((c) => !q || c.label.toLowerCase().includes(q)).slice(0, q ? 4 : 8)
      .map((c) => ({ kind: 'cmd', label: c.label, hint: c.hint, run: c.run }));
    const nodes = searchNodes(q, { limit: q ? 10 : 6 }).map((n) => ({
      kind: 'node', node: n, label: n.title, hint: pathTo(n.id).slice(0, -1).map((x) => x.title).join(' / '),
      run: () => select(n.id, { view: 'note' }),
    }));
    items = q ? [...nodes, ...cmds] : [...cmds, ...nodes];
    active = Math.min(active, Math.max(0, items.length - 1));
  };
  const draw = () => {
    list.replaceChildren(...(items.length ? items.map((it, i) => h('button', {
      type: 'button', class: `pal-item${i === active ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === active),
      onmousemove: () => { if (active !== i) { active = i; draw(); } },
      onclick: () => run(it),
    },
    it.kind === 'node' ? h('span', { class: 'tdot', style: tc(it.node.type) }) : h('span', { class: 'cmd-mark' }, '>'),
    h('span', { class: 'pal-label' }, it.label),
    it.hint ? h('span', { class: 'pal-hint' }, it.hint) : null)) : [h('p', { class: 'pal-empty' }, 'No matches')]));
    const a = list.querySelector('.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  };
  const run = (it) => { close(); it.run(); };

  input.addEventListener('input', () => { active = 0; compute(); draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); run(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  overlay = h('div', { class: 'pal-back', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list));
  document.body.append(overlay);
  compute(); draw();
  input.focus();
}
