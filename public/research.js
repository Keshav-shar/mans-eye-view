import { h, icon, tc, toast } from './dom.js';
import { api } from './api.js';
import { state, refresh, select } from './state.js';

// Research tab: start a web research session (search or crawl), watch it live, review what it was unsure
// about, and manage which sites it may read. The panel owns its DOM so live updates never steal focus.

const R = {
  sub: 'run', mode: 'search', seed: '', url: '', pages: 30, ai: 'auto',
  active: null, last: null, recent: [], es: null,
  review: [], reviewOpen: 0, reviewBusy: new Set(),
  domains: null, denyText: '', trustText: '', busy: false, error: '',
};
let root = null;
let progressBox = null;

const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString(); };

function safeHref(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}
const extLink = (url, label) => { const href = safeHref(url); return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ext' }, label || new URL(href).hostname, icon('external', 11)) : h('span', {}, label || url); };

function webStatus() { return (state.status && state.status.web) || {}; }

// ---- live session --------------------------------------------------------------------------------------
function watch(id) {
  if (R.es) R.es.close();
  const es = new EventSource(`/api/web/sessions/${encodeURIComponent(id)}/events`);
  R.es = es;
  es.addEventListener('progress', (e) => { const d = JSON.parse(e.data); R.active = d.summary; paintProgress(); });
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    if (R.active) { R.active.log = [...(R.active.log || []), d.line].slice(-60); paintProgress(); }
  });
  es.addEventListener('done', async (e) => {
    const d = JSON.parse(e.data);
    R.last = d.summary; R.active = null; es.close(); R.es = null;
    const s = d.summary.stats;
    toast(`Research finished: ${s.created} new, ${s.merged} matched, ${s.edges} links, ${s.queued} to review`, { action: d.summary.sessionNodeId ? { label: 'Open', fn: () => select(d.summary.sessionNodeId, { view: 'note' }) } : null });
    await Promise.all([refresh(), loadReview(), loadRecent()]);
    paint();
  });
  es.onerror = () => { /* the browser reconnects; 'done' closes it */ };
}

async function start() {
  if (R.busy) return;
  R.busy = true; R.error = '';
  paint();
  try {
    const budget = { maxPages: R.pages };
    if (R.ai !== 'auto') budget.maxAiCalls = R.ai; // auto = 2 per page + 20
    const body = { mode: R.mode, seed: R.seed, url: R.url, budget };
    const s = await api.post('/api/web/sessions', body);
    R.active = s;
    watch(s.id);
  } catch (e) { R.error = e.message; }
  R.busy = false;
  paint();
}

async function stop() {
  if (!R.active) return;
  try { await api.post(`/api/web/sessions/${R.active.id}/stop`, {}); toast('Stopping after the pages in flight…'); } catch (e) { toast(e.message, { kind: 'error' }); }
}

async function loadRecent() {
  try {
    const r = await api.get('/api/web/sessions');
    R.recent = r.recent || [];
    if (r.active && r.active.status === 'running' && !R.es) { R.active = r.active; watch(r.active.id); }
  } catch { /* offline */ }
}

// ---- review ---------------------------------------------------------------------------------------------
async function loadReview() {
  try { const r = await api.get('/api/web/review'); R.review = r.items; R.reviewOpen = r.open; } catch { /* offline */ }
}

async function act(item, action) {
  if (R.reviewBusy.has(item.id)) return;
  R.reviewBusy.add(item.id);
  paint();
  try {
    const r = await api.post(`/api/web/review/${item.id}`, { action });
    R.review = R.review.filter((x) => x.id !== item.id);
    R.reviewOpen = Math.max(0, R.reviewOpen - 1);
    if (action !== 'reject') {
      await refresh();
      if (r.createdIds && r.createdIds[0]) toast('Added to your tree', { action: { label: 'Open', fn: () => select(r.createdIds[0], { view: 'note' }) } });
    }
  } catch (e) { toast(e.message, { kind: 'error' }); }
  R.reviewBusy.delete(item.id);
  paint();
}

// ---- sites ----------------------------------------------------------------------------------------------
async function loadDomains() {
  try {
    R.domains = await api.get('/api/web/domains');
    R.denyText = R.domains.deny.join('\n');
    R.trustText = R.domains.trusted.join('\n');
  } catch { /* offline */ }
}

async function saveDomains(extra = {}) {
  try {
    R.domains = await fetch('/api/web/domains', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deny: R.denyText, trusted: R.trustText, ...extra }) }).then((r) => r.json());
    R.denyText = R.domains.deny.join('\n'); R.trustText = R.domains.trusted.join('\n');
    toast('Site lists saved');
  } catch (e) { toast(e.message, { kind: 'error' }); }
  paint();
}

// ---- views ----------------------------------------------------------------------------------------------
function statGrid(s, ai, budget) {
  const cell = (label, v, tone) => h('div', { class: `rs-cell${tone ? ` ${tone}` : ''}` }, h('b', {}, String(v)), h('span', {}, label));
  // "tried" is what the page budget counts; "read" is how many of those had usable content.
  return h('div', { class: 'rs-grid' },
    cell('pages tried', `${s.pages}/${budget ? budget.maxPages : '—'}`),
    cell('pages read', s.aiPages ? `${s.fetched} (${s.aiPages} by AI)` : s.fetched),
    cell('searches', `${s.queries}/${budget ? budget.maxQueries : '—'}`),
    cell('new nodes', s.created, s.created ? 'ok' : ''),
    cell('matched', s.merged),
    cell('links', s.edges + (s.inferred || 0)),
    cell('to review', s.queued, s.queued ? 'warn' : ''),
    cell('AI calls', ai ? `${ai.calls}/${ai.maxCalls}` : 0),
    cell('blocked', s.blocked, s.blocked ? 'bad' : ''));
}

// One line on where search results and pages went, e.g. "Not read: 9 already queued · 6 deny list · 2 need JavaScript".
function rejectedLine(s) {
  const r = s.rejected || {};
  const label = { seen: 'already queued', denied: 'deny list', cap: 'over the per-site limit', depth: 'too deep', robots: 'robots.txt', js: 'need JavaScript', blocked: 'blocked', policy: 'not allowed', error: 'network errors', dup: 'duplicates' };
  const parts = Object.entries(label).filter(([k]) => r[k]).map(([k, l]) => `${r[k]} ${l}`);
  if (s.dropped) parts.push(`${s.dropped} low value`);
  if (s.snippets) parts.push(`${s.snippets} read from search snippets instead`);
  if (s.branchStops) parts.push(`${s.branchStops} off-topic pages not followed further`);
  return parts.length ? h('p', { class: 'hint' }, `Not read as pages: ${parts.join(' · ')}.`) : null;
}

function sessionCard(s, live) {
  const st = s.stats;
  return h('div', { class: 'rs-card' },
    h('div', { class: 'rs-head' },
      h('strong', {}, s.mode === 'crawl' ? `Crawling ${s.url ? new URL(s.url).hostname : ''}` : `Researching “${(s.seed || []).join(', ')}”`),
      h('span', { class: `badge ${live ? 'new' : s.status === 'failed' ? 'skipped' : 'merge'}` }, live ? 'running' : s.status),
      live ? h('button', { class: 'btn sm', type: 'button', onclick: stop }, icon('stop', 12), 'Stop') : null),
    live ? h('div', { class: 'rs-meter' }, h('i', { style: { width: `${pct(st.pages, s.budget.maxPages)}%` } })) : null,
    statGrid(st, s.ai, s.budget),
    s.error ? h('div', { class: 'banner error' }, s.error) : null,
    !live && s.stopReason && !s.error ? h('div', { class: 'banner ok' }, h('strong', {}, 'Why it stopped: '), s.stopReason) : null,
    rejectedLine(st),
    h('p', { class: 'hint' }, `AI runs only on valuable or on-topic pages${s.ai && s.ai.tokens ? `: ${s.ai.tokens.toLocaleString()} tokens on your Groq key so far, ${s.ai.cacheHits} cached answers reused` : ''}.`),
    s.deferred && s.deferred.length ? h('details', { class: 'rs-deferred' },
      h('summary', {}, `${s.deferred.length} page${s.deferred.length === 1 ? '' : 's'} deferred (blocked or need a browser). Open them yourself if you need them.`),
      h('ul', {}, s.deferred.slice(-20).map((d) => h('li', {}, extLink(d.url, d.url.replace(/^https?:\/\//, '').slice(0, 70)), h('span', { class: 'hint' }, ` ${d.reason}`))))) : null,
    h('ol', { class: 'rs-log', reversed: true }, (s.log || []).slice(-25).reverse().map((l) => h('li', { class: l.kind || '' }, l.msg))));
}

function paintProgress() {
  if (!progressBox) return;
  progressBox.replaceChildren(R.active ? sessionCard(R.active, true) : (R.last ? sessionCard(R.last, false) : ''));
}

function runView() {
  const ws = webStatus();
  const searchOk = ws.search && ws.search.configured;
  const seg = h('div', { class: 'rs-seg', role: 'radiogroup', 'aria-label': 'Research mode' },
    [['search', 'Search the web'], ['crawl', 'Crawl one site']].map(([id, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(R.mode === id), class: R.mode === id ? 'on' : '',
      onclick: () => { R.mode = id; paint(); },
    }, label)));
  const seedIn = h('input', { class: 'ai-ask', value: R.seed, maxlength: 200, placeholder: R.mode === 'crawl' ? 'Optional: what to focus on' : 'What to research, e.g. Qdrant, vector databases', 'aria-label': 'Research topic', oninput: (e) => { R.seed = e.target.value; } });
  const urlIn = h('input', { class: 'ai-ask', value: R.url, maxlength: 2048, placeholder: 'https://company.com', 'aria-label': 'Site to crawl', oninput: (e) => { R.url = e.target.value; } });
  const sel = (label, key, opts) => h('label', { class: 'rs-sel' }, label, h('select', { onchange: (e) => { R[key] = e.target.value === 'auto' ? 'auto' : Number(e.target.value); } }, opts.map((o) => h('option', { value: o, selected: R[key] === o ? 'selected' : null }, o === 'auto' ? 'Auto' : o === 0 ? '0 (rules only)' : String(o)))));
  const blocked = R.mode === 'search' && !searchOk;
  const running = Boolean(R.active);
  progressBox = h('div', { class: 'rs-progress' });
  const box = h('div', { class: 'ai-body' },
    seg,
    R.mode === 'crawl' ? urlIn : null,
    seedIn,
    h('div', { class: 'ai-row rs-budget' }, sel('Pages', 'pages', [10, 30, 60, 120]), sel('AI calls', 'ai', ['auto', 0, 50, 150, 300, 600]),
      h('button', { class: 'btn primary', type: 'button', disabled: running || R.busy || blocked, onclick: start }, icon('globe', 14), running ? 'Running…' : 'Start')),
    blocked ? h('div', { class: 'banner warn' }, h('strong', {}, 'Web search is not set up'), h('p', {}, `${(ws.search && ws.search.hint) || 'Set SEARCH_API_KEY in .env'} and restart Nexus. Crawling a site you name works without it.`)) : null,
    R.mode === 'search' && ws.search && ws.search.warning ? h('div', { class: 'banner warn' }, h('strong', {}, `Check your ${ws.search.provider} key`), h('p', {}, ws.search.warning)) : null,
    R.error ? h('div', { class: 'banner error', role: 'alert' }, R.error) : null,
    h('p', { class: 'hint rs-safety' }, icon('shield', 12), ' Reads only public https pages, obeys robots.txt and rate limits, never logs in or gets past bot walls. Confident results are saved as one undoable step; the rest wait in Review.'),
    progressBox,
    R.recent.length && !running ? h('details', { class: 'rs-recent' }, h('summary', {}, 'Earlier sessions'),
      h('ul', {}, R.recent.slice(0, 10).map((s) => h('li', {}, `${s.mode === 'crawl' ? 'Crawl' : 'Search'}: ${(s.seed || []).join(', ') || '—'} · ${s.stats ? `${s.stats.created} new, ${s.stats.merged} matched` : ''} · ${ago(s.startedAt)}`)))) : null);
  paintProgress();
  return box;
}

const KIND = { merge: 'Same entity?', create: 'New entity', edge: 'Connection', suggestion: 'Suggested link', snippet: 'From search' };

function reviewView() {
  if (!R.review.length) return h('div', { class: 'ai-body' }, h('p', { class: 'hint' }, 'Nothing to review. Research sessions put anything they are unsure about here: possible duplicates, weakly supported links, and people found on the web.'));
  return h('div', { class: 'ai-body' },
    h('p', { class: 'hint' }, 'Your choices also teach the matcher and the page scorer.'),
    h('ul', { class: 'prop-list' }, R.review.map((it) => {
      const busy = R.reviewBusy.has(it.id);
      return h('li', { class: 'prop-item rv' },
        h('div', { class: 'pi-head' }, h('span', { class: `badge ${it.kind === 'merge' ? 'merge' : it.kind === 'create' ? 'new' : 'link'}` }, KIND[it.kind] || it.kind),
          h('span', { class: 'pi-name' }, it.mention ? h('span', { class: 'tdot', style: tc(it.mention.type === 'org' ? 'company' : it.mention.type) }) : null, it.title),
          typeof it.p === 'number' ? h('span', { class: 'pi-type', title: it.kind === 'merge' ? 'Match probability' : 'Confidence' }, `${Math.round(it.p * 100)}%`) : null),
        it.mention && it.mention.context ? h('div', { class: 'rv-ctx' }, `“${it.mention.context.slice(0, 220)}”`) : null,
        it.snippet ? h('div', { class: 'rv-ctx' }, `“${it.snippet.slice(0, 220)}”`) : null,
        it.candidate ? h('div', { class: 'pi-where' }, `Existing: ${it.candidate.card}`) : null,
        it.features && it.features.common ? h('div', { class: 'pi-where' }, `Both connected to ${it.features.common.join(', ')}`) : null,
        (it.evidence || []).length ? h('div', { class: 'pi-where' }, 'Evidence: ', it.evidence.map((e) => extLink(e.url))) : null,
        it.url ? h('div', { class: 'pi-where' }, 'Found on ', extLink(it.url, it.url.replace(/^https?:\/\//, '').slice(0, 60))) : null,
        h('div', { class: 'prop-actions' },
          h('button', { class: 'btn primary sm', type: 'button', disabled: busy, onclick: () => act(it, 'accept') }, icon('check', 12), it.kind === 'merge' ? 'Same, merge' : 'Add'),
          it.canSeparate ? h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => act(it, 'separate') }, 'Different, add new') : null,
          h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: () => act(it, 'reject') }, it.kind === 'merge' ? 'Ignore' : 'Reject')));
    })));
}

function sitesView() {
  if (!R.domains) { loadDomains().then(paint); return h('div', { class: 'ai-body' }, h('p', { class: 'hint' }, 'Loading…')); }
  const ta = (key, label, hint) => h('label', { class: 'rs-list' }, h('strong', {}, label), h('span', { class: 'hint' }, hint),
    h('textarea', { class: 'ai-input', rows: 4, value: R[key], spellcheck: 'false', oninput: (e) => { R[key] = e.target.value; } }));
  return h('div', { class: 'ai-body' },
    ta('denyText', 'Never read', 'One domain per line. Subdomains are included. Social networks are here by default because their terms forbid scraping.'),
    ta('trustText', 'Trusted sites', 'Read deeper (more pages and one more level of links) than sites found by search.'),
    h('div', { class: 'ai-row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => saveDomains() }, 'Save lists')),
    R.domains.blocked.length ? h('div', {}, h('div', { class: 'sub-h' }, 'Paused after blocking us'),
      h('ul', { class: 'rs-blocked' }, R.domains.blocked.map((b) => h('li', {}, h('b', {}, b.domain), ` until ${new Date(b.until).toLocaleString()} (${b.reason || 'blocked'}) `,
        h('button', { class: 'btn sm', type: 'button', onclick: () => saveDomains({ unblock: b.domain }) }, 'Allow again'))))) : h('p', { class: 'hint' }, 'No site has blocked Nexus.'));
}

export function paint() {
  if (!root) return;
  const subs = [['run', 'Run'], ['review', R.reviewOpen ? `Review (${R.reviewOpen})` : 'Review'], ['sites', 'Sites']];
  root.replaceChildren(
    h('div', { class: 'tabs sub', role: 'tablist' }, subs.map(([id, label]) => h('button', {
      class: `tab${R.sub === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(R.sub === id), type: 'button',
      onclick: () => { R.sub = id; if (id === 'review') loadReview().then(paint); paint(); },
    }, label))),
    R.sub === 'run' ? runView() : R.sub === 'review' ? reviewView() : sitesView());
}

export function view() {
  if (!root) {
    root = h('div', { class: 'research' });
    loadRecent().then(paint);
    loadReview().then(paint);
  }
  paint();
  return root;
}
