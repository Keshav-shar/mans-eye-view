'use strict';
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { canonicalize } = require('./canonical');
const { simhash } = require('../ml/simhash');
const { sha } = require('../fsutil');

// HTML → { markdown, text, metadata, JSON-LD, links }. Firecrawl's /scrape, locally.
// Page content is only ever DATA: nothing here executes scripts, follows instructions or loads assets.

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg', 'canvas', 'video', 'audio', 'img']);

const MAX_MD = 200000;

function metaContent(doc, sel) {
  const el = doc.querySelector(sel);
  return el ? String(el.getAttribute('content') || '').trim() : '';
}

function flattenLd(node, out, depth = 0) {
  if (!node || depth > 4 || out.length >= 60) return;
  if (Array.isArray(node)) { for (const n of node) flattenLd(n, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  if (node['@graph']) flattenLd(node['@graph'], out, depth + 1);
  if (node['@type']) out.push(node);
}

function jsonLd(doc) {
  const out = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = String(s.textContent || '').trim();
    if (!raw || raw.length > 500000) continue;
    try { flattenLd(JSON.parse(raw), out); } catch { /* ignore broken JSON-LD */ }
  }
  return out;
}

function mdToText(md) {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+]+\s*/gm, '').replace(/[*_`|]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extract(html, pageUrl) {
  const src = String(html || '').slice(0, 6 * 1024 * 1024);
  const { document: doc } = parseHTML(src.includes('<html') ? src : `<!doctype html><html><head></head><body>${src}</body></html>`);
  const baseEl = doc.querySelector('base[href]');
  const base = (baseEl && canonicalize(baseEl.getAttribute('href'), pageUrl)) || pageUrl;

  const robots = `${metaContent(doc, 'meta[name="robots"]')} ${metaContent(doc, 'meta[name="nexusbot"]')}`.toLowerCase();
  const title = String((doc.querySelector('title') || {}).textContent || metaContent(doc, 'meta[property="og:title"]') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const meta = {
    title,
    description: (metaContent(doc, 'meta[name="description"]') || metaContent(doc, 'meta[property="og:description"]')).slice(0, 600),
    siteName: metaContent(doc, 'meta[property="og:site_name"]').slice(0, 120),
    ogType: metaContent(doc, 'meta[property="og:type"]').slice(0, 40),
    lang: String(doc.documentElement && doc.documentElement.getAttribute('lang') || '').slice(0, 12),
    published: (metaContent(doc, 'meta[property="article:published_time"]') || metaContent(doc, 'meta[name="date"]')).slice(0, 40),
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
  };
  const ld = jsonLd(doc);
  const canonEl = doc.querySelector('link[rel="canonical"][href]');
  const canonical = canonEl ? canonicalize(canonEl.getAttribute('href'), base) : null;
  const scriptCount = doc.querySelectorAll('script').length;

  const links = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    const url = canonicalize(href, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const rel = String(a.getAttribute('rel') || '').toLowerCase();
    links.push({ url, anchor: String(a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 160), nofollow: /nofollow|ugc|sponsored/.test(rel) });
    if (links.length >= 600) break;
  }
  const mailtos = [...doc.querySelectorAll('a[href^="mailto:"]')].map((a) => String(a.getAttribute('href')).slice(7).split('?')[0].trim().toLowerCase()).slice(0, 20);

  // Main content. Readability mutates the DOM, so links and metadata are collected first.
  let contentHtml = '';
  let readText = 0;
  try {
    const art = new Readability(doc, { charThreshold: 300, keepClasses: false }).parse();
    readText = art ? (art.textContent || '').trim().length : 0;
    if (art && art.content && readText > 200) contentHtml = art.content;
  } catch { /* fall back below */ }
  // Readability is built for articles. On author, profile and listing pages it often keeps a ~200-char
  // fragment of a page that holds thousands of characters, so the page looked "JavaScript-only". When it
  // keeps much less than the cleaned body, use the cleaned body instead.
  let bodyChars = readText;
  if (readText < 600) {
    const { document: d2 } = parseHTML(src.includes('<html') ? src : `<html><body>${src}</body></html>`);
    for (const el of d2.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,iframe,svg,template')) el.remove();
    const root = d2.querySelector('main') || d2.querySelector('article') || d2.body || d2.documentElement;
    bodyChars = String(root.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (!contentHtml || (bodyChars >= 500 && bodyChars >= 2 * readText)) contentHtml = root.innerHTML || '';
  }
  let markdown = '';
  try { markdown = turndown.turndown(contentHtml); } catch { markdown = ''; }
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_MD);
  // Facts the page states in JSON-LD but may not repeat in visible text (job title, employer, bio).
  const ldText = ldFacts(ld);
  if (ldText) markdown = `${markdown}\n\n${ldText}`.trim();
  const text = mdToText(markdown);

  return {
    url: pageUrl, ...meta, canonical, markdown, text, links, mailtos, jsonld: ld, scriptCount,
    visibleChars: text.length, bodyChars: Math.max(bodyChars, text.length), contentHash: sha(text, 'sha1'), simhash: simhash(text),
  };
}

// One sentence per JSON-LD Person/Organization/Article, e.g. "Yashi Sharma, Editor at OpGov.News. Writes about…"
function ldFacts(ld) {
  const name = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.name || '') : '');
  const out = [];
  for (const o of ld || []) {
    const types = [].concat(o['@type'] || []).map(String);
    const subject = types.includes('ProfilePage') && o.mainEntity ? o.mainEntity : o;
    const st = [].concat(subject['@type'] || []).map(String);
    if (!st.some((t) => /Person|Organization|Corporation|NewsMediaOrganization/.test(t))) continue;
    const n = name(subject);
    if (!n) continue;
    const title = subject.jobTitle ? String(subject.jobTitle) : '';
    const org = name(subject.worksFor);
    let line = title && org ? `${n}, ${title} at ${org}.` : title ? `${n}, ${title}.` : org ? `${n} works at ${org}.` : `${n}.`;
    if (subject.description) line += ` ${String(subject.description).replace(/\s+/g, ' ').slice(0, 300)}`;
    if (!out.includes(line)) out.push(line);
    if (out.length >= 6) break;
  }
  return out.join('\n\n').slice(0, 2000);
}

module.exports = { extract, jsonLd, mdToText };
