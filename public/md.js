import { h } from './dom.js';

// A small, safe markdown renderer. It builds DOM nodes directly, so note text can never become markup.
// Supports: headings, lists, task lists, quotes, code, bold, italic, links and [[wikilinks]].

const INLINE = /(`[^`\n]+`)|(\[\[[^\]\n]{1,120}\]\])|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>)\]]+)/g;

function inline(text, opts) {
  const out = [];
  let last = 0;
  let m;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(h('code', {}, tok.slice(1, -1)));
    else if (m[2]) {
      const [target, alias] = tok.slice(2, -2).split('|');
      const title = target.trim();
      const node = opts.resolve ? opts.resolve(title) : null;
      out.push(h('a', {
        class: `wiki${node ? '' : ' missing'}`, href: '#', 'data-title': title,
        title: node ? 'Open this node' : 'No node with this name yet. Click to create it.',
        onclick: (e) => { e.preventDefault(); if (opts.onWiki) opts.onWiki(title, node); },
      }, (alias || title).trim()));
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok);
      out.push(h('a', { href: mm[2], target: '_blank', rel: 'noopener noreferrer' }, mm[1]));
    } else if (m[4]) out.push(h('strong', {}, tok.slice(2, -2)));
    else if (m[5]) out.push(h('em', {}, tok.slice(1, -1)));
    else if (m[6]) out.push(h('a', { href: tok, target: '_blank', rel: 'noopener noreferrer' }, tok));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMd(source, opts = {}) {
  const lines = String(source || '').split('\n');
  const root = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = /^```/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.append(h('pre', {}, h('code', {}, buf.join('\n'))));
      continue;
    }
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) { root.append(h(`h${head[1].length + 1}`, {}, inline(head[2], opts))); i++; continue; }
    if (/^---+\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, inline(buf.join(' '), opts)));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const lineNo = i;
        const text = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
        if (task) {
          const box = h('input', {
            type: 'checkbox', checked: task[1] !== ' ', 'aria-label': 'Toggle task',
            onchange: (e) => { if (opts.onTask) opts.onTask(lineNo, e.target.checked); },
          });
          items.push(h('li', { class: 'task' }, box, h('span', {}, inline(task[2], opts))));
        } else items.push(h('li', {}, inline(text, opts)));
        i++;
      }
      root.append(h(ordered ? 'ol' : 'ul', {}, items));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|---+\s*$|\s*([-*]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    root.append(h('p', {}, inline(buf.join(' '), opts)));
  }
  return root;
}
