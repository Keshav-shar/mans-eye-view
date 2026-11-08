import { h, icon, tc, contextMenu } from './dom.js';
import { state, on, kidsOf, select, toggleExpanded, createNode, deleteNode, moveNode, pathTo } from './state.js';

let dragId = null;

function matches(n, q) {
  return n.title.toLowerCase().includes(q) || n.type.includes(q) || n.tags.some((t) => t.includes(q))
    || n.summary.toLowerCase().includes(q) || n.fields.some((f) => f.value.toLowerCase().includes(q));
}

function inSubtree(rootId, id) {
  let cur = state.nodes.get(id);
  for (let g = 0; cur && g < 40; g++) { if (cur.id === rootId) return true; cur = cur.parentId ? state.nodes.get(cur.parentId) : null; }
  return false;
}

function zoneOf(e, row) {
  const r = row.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'in';
}

function clearDrop() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-in').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-in'));
}

function rowFor(n, depth, visibleOpen) {
  const kids = kidsOf(n.id);
  const open = visibleOpen || state.expanded.has(n.id);
  const row = h('div', {
    class: `row${state.selected === n.id ? ' selected' : ''}`, role: 'treeitem', 'aria-level': depth + 1,
    'aria-selected': String(state.selected === n.id), 'aria-expanded': kids.length ? String(open) : undefined,
    draggable: true, tabindex: 0, 'data-id': n.id, style: { '--d': depth },
    onclick: () => select(n.id, { view: state.view === 'graph' ? 'graph' : 'note' }),
    onkeydown: (e) => {
      if (e.key === 'Enter') select(n.id, { view: 'note' });
      else if (e.key === 'ArrowRight' && kids.length && !open) { toggleExpanded(n.id, true); render(); }
      else if (e.key === 'ArrowLeft' && kids.length && open) { toggleExpanded(n.id, false); render(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); const nx = row.nextElementSibling; if (nx) nx.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const pv = row.previousElementSibling; if (pv) pv.focus(); }
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Add child', onClick: () => createNode(n.id) },
        { label: 'Add sibling', onClick: () => createNode(n.parentId || null) },
        { label: 'Delete', danger: true, onClick: () => deleteNode(n.id) },
      ]);
    },
    ondragstart: (e) => { dragId = n.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); row.classList.add('dragging'); },
    ondragend: () => { dragId = null; row.classList.remove('dragging'); clearDrop(); },
    ondragover: (e) => {
      if (!dragId || inSubtree(dragId, n.id)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDrop();
      row.classList.add(`drop-${zoneOf(e, row)}`);
    },
    ondrop: (e) => {
      if (!dragId || inSubtree(dragId, n.id)) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = zoneOf(e, row);
      const id = dragId;
      clearDrop();
      dragId = null;
      if (zone === 'in') return moveNode(id, n.id, null);
      const sibs = kidsOf(n.parentId || null).filter((x) => x.id !== id);
      const at = sibs.findIndex((x) => x.id === n.id) + (zone === 'after' ? 1 : 0);
      return moveNode(id, n.parentId || null, at);
    },
  },
  h('button', {
    class: `caret${kids.length ? '' : ' leaf'}${open ? ' open' : ''}`, tabindex: -1, 'aria-label': open ? 'Collapse' : 'Expand',
    onclick: (e) => { e.stopPropagation(); toggleExpanded(n.id); render(); },
  }, icon('caret', 12)),
  h('span', { class: 'tdot', style: tc(n.type), title: n.type }),
  h('span', { class: 'row-title' }, n.title || 'Untitled'),
  kids.length ? h('span', { class: 'row-count' }, String(kids.length)) : null,
  h('button', {
    class: 'row-add icon-btn sm', tabindex: -1, 'aria-label': `Add child to ${n.title}`, title: 'Add child',
    onclick: (e) => { e.stopPropagation(); createNode(n.id); },
  }, icon('plus', 13)));
  return row;
}

export function render() {
  const host = document.getElementById('tree');
  const q = state.filter.trim().toLowerCase();
  let visible = null;
  if (q) {
    visible = new Set();
    for (const n of state.nodes.values()) {
      if (!matches(n, q)) continue;
      for (const a of pathTo(n.id)) visible.add(a.id);
    }
  }
  const frag = document.createDocumentFragment();
  const build = (pid, depth) => {
    for (const n of kidsOf(pid)) {
      if (visible && !visible.has(n.id)) continue;
      frag.append(rowFor(n, depth, Boolean(visible)));
      if ((visible || state.expanded.has(n.id)) && kidsOf(n.id).length) build(n.id, depth + 1);
    }
  };
  build(null, 0);
  if (!frag.childNodes.length) {
    frag.append(h('div', { class: 'tree-empty' },
      q ? h('p', {}, `Nothing matches "${state.filter}".`) : h('p', {}, 'Your tree is empty.'),
      q ? null : h('button', { class: 'btn', onclick: () => createNode(null) }, 'Add the first node')));
  }
  const scroll = host.scrollTop;
  host.replaceChildren(frag);
  host.scrollTop = scroll;
  const count = state.nodes.size;
  document.getElementById('tree-count').textContent = `${count} node${count === 1 ? '' : 's'}`;
}

export function init() {
  const host = document.getElementById('tree');
  // Dropping on empty space moves the node to the end of the top level.
  host.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); clearDrop(); } });
  host.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    clearDrop();
    moveNode(id, null, null);
  });
  const filter = document.getElementById('filter');
  filter.addEventListener('input', () => { state.filter = filter.value; render(); });
  filter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filter.value = ''; state.filter = ''; render(); } });
  on('tree', render);
  on('select', render);
  on('titlechange', render);
}
