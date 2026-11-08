import { h, icon, typeHue, typeSat } from './dom.js';
import { state, kidsOf, select } from './state.js';

// A force-directed map of the whole tree. Solid lines are parent/child, dashed lines are connections.
// The layout is kept between redraws so the map does not jump when you edit something.

const pos = new Map();
let wrap = null; let canvas = null; let ctx = null; let legend = null; let focusBox = null;
let W = 0; let H = 0; let dpr = 1;
let view = { x: 0, y: 0, k: 1 };
let nodes = []; let edges = []; let adj = new Map(); let radius = new Map();
let alpha = 0; let raf = 0; let visible = false; let needsFit = true;
let hover = null; let dragging = null; let panning = null; let moved = false;
let focusMode = false;
let ro = null;

const isDark = () => document.documentElement.dataset.theme !== 'light';
const colorFor = (type, a = 1) => `hsla(${typeHue(type)}, ${Math.round(typeSat(type) * 62)}%, ${isDark() ? 64 : 44}%, ${a})`;
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function build() {
  const all = [...state.nodes.values()];
  const nb = new Map();
  const link = (a, b) => { if (!nb.has(a)) nb.set(a, new Set()); nb.get(a).add(b); };
  const raw = [];
  const seen = new Set();
  for (const n of all) {
    if (n.parentId && state.nodes.has(n.parentId)) { raw.push({ a: n.parentId, b: n.id, kind: 'tree', rel: '' }); link(n.parentId, n.id); link(n.id, n.parentId); }
    for (const l of n.links) {
      if (!state.nodes.has(l.to)) continue;
      const key = `${[n.id, l.to].sort().join('|')}|${l.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push({ a: n.id, b: l.to, kind: 'link', rel: l.relation, status: l.status || 'confirmed', conf: typeof l.conf === 'number' ? l.conf : null });
      link(n.id, l.to); link(l.to, n.id);
    }
  }
  let keep = null;
  if (focusMode && state.selected && state.nodes.has(state.selected)) {
    keep = new Set([state.selected]);
    let frontier = [state.selected];
    for (let d = 0; d < 2; d++) {
      const next = [];
      for (const id of frontier) for (const x of nb.get(id) || []) if (!keep.has(x)) { keep.add(x); next.push(x); }
      frontier = next;
    }
  }
  nodes = all.filter((n) => !keep || keep.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  edges = raw.filter((e) => ids.has(e.a) && ids.has(e.b));
  adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a).add(e.b); adj.get(e.b).add(e.a);
  }
  radius = new Map(nodes.map((n) => [n.id, (n.type === 'area' ? 8 : 4.5) + Math.min(10, Math.sqrt(kidsOf(n.id).length) * 1.7)]));
  for (const id of [...pos.keys()]) if (!state.nodes.has(id)) pos.delete(id);
  let i = 0;
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const p = n.parentId && pos.get(n.parentId);
    const ang = (i++ * 2.399) % (Math.PI * 2);
    pos.set(n.id, p
      ? { x: p.x + Math.cos(ang) * 50, y: p.y + Math.sin(ang) * 50, vx: 0, vy: 0 }
      : { x: Math.cos(ang) * 180, y: Math.sin(ang) * 180, vx: 0, vy: 0 });
  }
  const types = [...new Set(nodes.map((n) => n.type))].sort();
  legend.replaceChildren(...types.map((t) => h('span', { class: 'lg' }, h('i', { style: { background: colorFor(t) } }), t)));
}

function tick() {
  const a = alpha;
  const cell = 140;
  const grid = new Map();
  for (const n of nodes) {
    const p = pos.get(n.id);
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(n.id); else grid.set(key, [n.id]);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const cx = Math.floor(p.x / cell); const cy = Math.floor(p.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(`${gx},${gy}`);
        if (!bucket) continue;
        for (const oid of bucket) {
          if (oid === n.id) continue;
          const q = pos.get(oid);
          let dx = p.x - q.x; let dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          if (d2 > cell * cell * 4) continue;
          const f = (900 * a) / d2;
          p.vx += dx * f; p.vy += dy * f;
        }
      }
    }
    p.vx -= p.x * 0.01 * a; p.vy -= p.y * 0.01 * a;
  }
  for (const e of edges) {
    const p = pos.get(e.a); const q = pos.get(e.b);
    const dx = q.x - p.x; const dy = q.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = ((d - (e.kind === 'tree' ? 60 : 110)) * 0.045 * a) / d;
    p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (dragging && dragging.id === n.id) { p.vx = 0; p.vy = 0; continue; }
    p.vx *= 0.6; p.vy *= 0.6;
    p.x += p.vx; p.y += p.vy;
  }
  alpha *= 0.985;
}

function resize() {
  if (!wrap || !visible) return;
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = r.width; H = r.height;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  if (needsFit) fit(); else schedule();
}

export function fit() {
  if (!nodes.length || !W) return;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of nodes) { const p = pos.get(n.id); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const k = Math.max(0.15, Math.min(1.5, Math.min(W / (x1 - x0 + 140), H / (y1 - y0 + 140))));
  view = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
  needsFit = false;
  schedule();
}

function schedule() {
  if (raf || !visible) return;
  raf = requestAnimationFrame(frame);
}

function frame() {
  raf = 0;
  if (!visible) return;
  if (alpha > 0.03 || dragging) { tick(); if (dragging && alpha < 0.12) alpha = 0.12; }
  draw();
  if (alpha > 0.03 || dragging) schedule();
}

function reheat(v = 0.7) { alpha = Math.max(alpha, v); schedule(); }

function draw() {
  if (!ctx || !W) return;
  const bg = css('--bg', '#14171f');
  const edgeCol = css('--line-strong', '#3a4356');
  const text = css('--text', '#e5e9f2');
  const dim = css('--text-dim', '#8b95a8');
  const accent = css('--accent', '#7c9cff');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const k = view.k;
  const focusId = hover || state.selected;
  const near = focusId && adj.get(focusId) ? adj.get(focusId) : new Set();
  const dimOthers = Boolean(hover);
  const sx = (x) => x * k + view.x; const sy = (y) => y * k + view.y;

  ctx.lineWidth = 1;
  for (const e of edges) {
    const p = pos.get(e.a); const q = pos.get(e.b);
    const hot = focusId && (e.a === focusId || e.b === focusId);
    // Web evidence: weaker links are fainter; inferred (backlinker) links are dotted.
    const strength = e.conf == null ? 1 : 0.35 + 0.65 * e.conf;
    ctx.globalAlpha = (dimOthers && !hot ? 0.12 : hot ? 0.95 : 0.55) * (hot ? 1 : strength);
    ctx.strokeStyle = hot ? accent : edgeCol;
    ctx.setLineDash(e.kind === 'link' ? (e.status === 'inferred' ? [1.5, 4] : [4, 4]) : []);
    ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke();
  }
  ctx.setLineDash([]);

  const labelFont = `500 ${Math.max(10, Math.min(13, 11.5 * Math.sqrt(k) + 1))}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.font = labelFont; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const labels = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    const x = sx(p.x); const y = sy(p.y);
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const r = (radius.get(n.id) || 5) * Math.max(0.7, Math.min(1.6, k));
    const lit = n.id === focusId || near.has(n.id);
    ctx.globalAlpha = dimOthers && !lit ? 0.22 : 1;
    ctx.fillStyle = colorFor(n.type);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (n.id === state.selected) {
      ctx.globalAlpha = 1; ctx.strokeStyle = accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
    if (k > 0.55 || lit || (adj.get(n.id) || { size: 0 }).size >= 4) labels.push({ n, x, y: y + r + 4, lit });
  }
  for (const l of labels) {
    ctx.globalAlpha = dimOthers && !l.lit ? 0.3 : 1;
    const t = l.n.title.length > 26 ? `${l.n.title.slice(0, 25)}…` : l.n.title;
    ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(t, l.x, l.y);
    ctx.fillStyle = l.n.id === state.selected || l.lit ? text : dim; ctx.fillText(t, l.x, l.y);
  }
  ctx.globalAlpha = 1;

  if (hover && edges.length) {
    // Show the relationship name on the connections of the hovered node.
    ctx.font = `500 11px ${getComputedStyle(document.body).fontFamily}`; ctx.textBaseline = 'middle';
    for (const e of edges) {
      if (!e.rel || (e.a !== hover && e.b !== hover)) continue;
      const p = pos.get(e.a); const q = pos.get(e.b);
      const mx = sx((p.x + q.x) / 2); const my = sy((p.y + q.y) / 2);
      ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(e.rel, mx, my);
      ctx.fillStyle = accent; ctx.fillText(e.rel, mx, my);
    }
  }
}

function hit(px, py) {
  const wx = (px - view.x) / view.k; const wy = (py - view.y) / view.k;
  let best = null; let bd = Infinity;
  for (const n of nodes) {
    const p = pos.get(n.id);
    const d = Math.hypot(p.x - wx, p.y - wy);
    const lim = (radius.get(n.id) || 5) + 5 / view.k;
    if (d <= lim && d < bd) { best = n.id; bd = d; }
  }
  return best;
}

function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

function bind() {
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = local(e);
    const id = hit(px, py);
    moved = false;
    if (id) dragging = { id };
    else panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    if (dragging) {
      moved = true;
      const p = pos.get(dragging.id);
      p.x = (px - view.x) / view.k; p.y = (py - view.y) / view.k;
      reheat(0.35);
    } else if (panning) {
      moved = true;
      view.x = panning.vx + (e.clientX - panning.x); view.y = panning.vy + (e.clientY - panning.y);
      schedule();
    } else {
      const id = hit(px, py);
      if (id !== hover) { hover = id; canvas.style.cursor = id ? 'pointer' : 'grab'; schedule(); }
    }
  });
  const up = (e) => {
    if (dragging && !moved) select(dragging.id, { view: 'graph' });
    dragging = null; panning = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    schedule();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; schedule(); } });
  canvas.addEventListener('dblclick', (e) => { const id = hit(...local(e)); if (id) select(id, { view: 'note' }); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = local(e);
    const next = Math.max(0.12, Math.min(3.5, view.k * Math.exp(-e.deltaY * 0.0015)));
    const wx = (px - view.x) / view.k; const wy = (py - view.y) / view.k;
    view = { k: next, x: px - wx * next, y: py - wy * next };
    schedule();
  }, { passive: false });
}

export function mount(container) {
  canvas = h('canvas', { class: 'graph-canvas', role: 'img', 'aria-label': 'Map of your tree. Click a node to select it, double-click to open it.' });
  ctx = canvas.getContext('2d');
  legend = h('div', { class: 'legend' });
  focusBox = h('input', { type: 'checkbox', onchange: (e) => { focusMode = e.target.checked; needsFit = true; refresh(); } });
  wrap = h('div', { class: 'graph-wrap' }, canvas,
    h('div', { class: 'graph-tools' },
      h('label', { class: 'toggle' }, focusBox, 'Only what is near the selected node'),
      h('button', { class: 'btn sm', type: 'button', onclick: fit }, icon('fit', 13), 'Fit')),
    legend,
    h('p', { class: 'graph-hint' }, 'Solid lines are nesting, dashed lines are connections, dotted lines are inferred. Fainter lines have less web evidence. Drag to move, scroll to zoom, double-click to open.'));
  container.replaceChildren(wrap);
  bind();
  ro = new ResizeObserver(resize);
  ro.observe(wrap);
}

export function show() {
  visible = true;
  if (!nodes.length || true) build();
  needsFit = true;
  resize();
  // Warm up the layout so the first frame is already readable.
  alpha = 1;
  if (nodes.length < 800) for (let i = 0; i < 160; i++) tick();
  alpha = 0.25;
  fit();
}

export function hide() { visible = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

export function refresh() {
  if (!wrap) return;
  build();
  if (visible) { reheat(0.5); }
}

export function redraw() { schedule(); }
