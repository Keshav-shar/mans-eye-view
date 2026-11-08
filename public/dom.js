// Small DOM helpers. Nothing here ever uses innerHTML with user data: text is always inserted as text nodes.

const NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'draggable') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  caret: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  graph: '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="8" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.7 8.6l3 7.4M16.6 9.9l-3.5 6.3M8.2 7.2l7.6.6"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17v4M17 19h4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  lines: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  hash: '<path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  command: '<path d="M9 9h6v6H9zM9 9V7a2 2 0 1 0-2 2h2zM15 9V7a2 2 0 1 1 2 2h-2zM9 15v2a2 2 0 1 1-2-2h2zM15 15v2a2 2 0 1 0 2-2h-2z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  svg.innerHTML = ICONS[name] || ''; // static, trusted markup only
  return svg;
}

// ---- Type colours: one hue per node type, shared by the tree, chips and graph ------------------------
const HUES = { company: 212, person: 168, hr: 146, recruiter: 128, vc: 38, mentor: 268, skill: 338, idea: 52, path: 22, project: 192, event: 302, resource: 96, place: 244, product: 200, tech: 182, concept: 284, field: 296, credential: 322 };
const NEUTRAL = new Set(['area', 'note', 'session']);

export function typeHue(type) {
  if (HUES[type] != null) return HUES[type];
  if (NEUTRAL.has(type)) return 220;
  let x = 0;
  for (const c of String(type)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}
export const typeSat = (type) => (NEUTRAL.has(type) ? 0.14 : 1);
export const tc = (type) => ({ '--th': typeHue(type), '--ts': typeSat(type) });
export const PERSONISH = new Set(['person', 'hr', 'recruiter', 'mentor', 'vc']);

// ---- Dates (local time, ISO strings) -----------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}
export function diffDays(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000);
}
export function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const opts = { day: 'numeric', month: 'short' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}
export function relDay(iso) {
  const d = diffDays(iso, isoDate());
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 0) return d < 14 ? `in ${d} days` : fmtDate(iso);
  return d > -14 ? `${-d} days ago` : fmtDate(iso);
}

// ---- Property kinds (mirrors the server so icons update while typing) ---------------------------------------
export function detectKind(key, value) {
  const k = String(key).toLowerCase();
  const v = String(value).trim();
  if (!v) return 'text';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
  if (/^(https?:\/\/|www\.)\S+$/i.test(v) || (/\b(linkedin|github|twitter|x)\.com\b/i.test(v) && !/\s/.test(v))) return 'url';
  const digits = v.replace(/\D/g, '');
  if (/^[+()\d\s.\-x]{7,25}$/i.test(v) && digits.length >= 7 && digits.length <= 15) return 'phone';
  if (/address|location|office|\bhq\b|headquarter|city/.test(k)) return 'address';
  if (/^-?\d+([.,]\d+)?$/.test(v)) return 'number';
  return 'text';
}

export function hrefFor(f) {
  const v = String(f.value || '').trim();
  if (!v) return null;
  if (f.kind === 'phone') return `tel:${v.replace(/[^\d+]/g, '')}`;
  if (f.kind === 'email') return `mailto:${v}`;
  if (f.kind === 'address') return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
  if (f.kind === 'url') {
    const u = /^https?:\/\//i.test(v) ? v : /^[\w.-]+\.[a-z]{2,}/i.test(v) ? `https://${v}` : null;
    if (!u) return null;
    try {
      const p = new URL(u);
      return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
    } catch { return null; }
  }
  return null;
}

export const fid = () => `f_${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function autogrow(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 420)}px`; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

export function toast(msg, { kind = 'info', action = null, ms = 4500 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', {}, msg),
    action && h('button', { class: 'btn sm', onclick: () => { el.remove(); action.fn(); } }, action.label));
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 8000) : ms);
}

export function contextMenu(x, y, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map((it) => h('button', {
    class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem',
    onclick: () => { close(); it.onClick(); },
  }, it.label)));
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  const away = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc, true); });
  menu.querySelector('button')?.focus();
}
