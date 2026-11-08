'use strict';
const path = require('path');
const { loadSettings, merge } = require('../defaults');
const { Evidence } = require('./evidence');
const { UrlGuard } = require('./urlGuard');
const { Fetcher } = require('./fetcher');
const { mapSite } = require('./map');
const { extract } = require('./scrape');
const { createSearch } = require('./search');
const { Renderer } = require('./browser');
const { ModelRouter } = require('../llm/models');
const { Gateway } = require('../llm/gateway');
const { Guard } = require('../llm/guard');
const { untrusted } = require('../llm/prompts');
const { Embedder } = require('../vector/embedder');
const { Retrieval } = require('../vector/retrieval');
const { PageParser, seedTermsOf } = require('../parse/pageParser');
const { features } = require('../parse/classify');
const { GraphBuilder, compactOps } = require('../graph/builder');
const { FellegiSunter } = require('../ml/fs');
const { LogReg } = require('../ml/logreg');
const { SessionManager } = require('../session');
const { runOps } = require('../ops');
const { readJson, writeJson } = require('../fsutil');
const { openDb } = require('../store/db');
const { domainOf } = require('./canonical');

// Wires the research engine together for server.js. Everything lives under <dataDir>/web.
// `overrides` exists for tests: { fetchImpl, lookup, search, embedder: 'hash', loader }.

function createWeb({ store, config, overrides = {} }) {
  const dataDir = store.dir;
  const webDir = path.join(dataDir, 'web');
  const settings = loadSettings(dataDir);
  const evidence = new Evidence(webDir);
  const guard = new UrlGuard({ ...evidence.lists(settings.domains), lookup: overrides.lookup });
  // Optional JavaScript rendering (NEXUS_BROWSER=on + Playwright installed), for JavaScript-only pages only.
  const renderer = overrides.renderer || (config.browser ? new Renderer({ guard, userAgent: settings.fetch.userAgent }) : null);
  const fetcher = new Fetcher({ guard, evidence, settings, fetchImpl: overrides.fetchImpl || null, renderer, retries: overrides.retries ?? 2, backoffBase: overrides.backoffBase ?? 500 });
  const router = new ModelRouter(config, { cacheFile: path.join(webDir, 'models.json') });
  const embedder = new Embedder({ prefer: overrides.embedder || config.embedder || 'hash', cacheDir: path.join(webDir, 'models'), loader: overrides.loader });
  const retrieval = new Retrieval({ dir: path.join(webDir, 'vectors'), embedder, maxChunks: settings.vector.maxChunks });
  const search = overrides.search || createSearch(config, { fetchImpl: overrides.searchFetch });
  const scorer = new FellegiSunter();
  const modelFile = path.join(webDir, 'models', 'page-logreg.json');
  const cacheDir = path.join(webDir, 'llm-cache');
  const db = overrides.db || openDb(webDir);
  const deps = { settings, store, fetcher, guard, evidence, retrieval, embedder, search, cfg: config, router, scorer, logModel: LogReg.fromJSON(readJson(modelFile, null)), cacheDir, db };
  const sessions = new SessionManager(deps);

  // Re-estimate the matcher from your merge decisions and the page classifier from your accept/reject
  // decisions. Cheap; run at start and after every review action.
  function retrain() {
    scorer.fitLabelled(evidence.labels('merge').filter((l) => l.levels));
    const pages = evidence.labels('page');
    if (pages.length >= 30 && pages.some((p) => p.y) && pages.some((p) => !p.y)) {
      const X = []; const y = [];
      for (const p of pages.slice(-2000)) {
        const src = evidence.sourceByUrl(p.url);
        const text = src && src.hash ? evidence.readSnapshot(src.hash) : null;
        if (!text) continue;
        X.push(features({ url: p.url, title: src.title || '', text }));
        y.push(p.y ? 1 : 0);
      }
      if (X.length >= 30) {
        const m = new LogReg().fit(X, y).calibrate(X, y);
        writeJson(modelFile, m.toJSON());
        deps.logModel = m;
      }
    }
  }
  retrain();

  function start() {
    embedder.init().then(() => retrieval.syncNodes(store.get())).catch(() => {});
    router.refresh().catch(() => {});
  }

  function status() {
    const a = sessions.active;
    return {
      search: { provider: search.name, configured: search.configured, hint: search.configured ? null : search.hint, warning: [search.warning, ...(config.envWarnings || [])].filter(Boolean).join(' ') || null },
      embedder: embedder.status(),
      browser: renderer ? { enabled: true, available: renderer.available(), error: renderer.error } : { enabled: false },
      models: router.roles(),
      session: a ? { id: a.id, status: a.status, seed: a.seed, mode: a.mode } : null,
      review: evidence.openReviews().length,
    };
  }

  // One page, Firecrawl /scrape style, ending in the existing preview → apply flow.
  async function scrapePreview(url) {
    const r = await fetcher.fetch(url, { revisit: false });
    if (!r.ok) { const e = new Error(r.reason || 'Could not read that page'); e.status = r.policy ? 403 : 422; throw e; }
    const page = r.page;
    const gateway = new Gateway({ cfg: config, router, cacheDir, maxCalls: 6, maxTokens: 30000 });
    const g = new Guard({ cfg: config, router, maxCalls: 12, threshold: settings.guard.threshold });
    const parser = new PageParser({ settings: merge(settings, { thresholds: { relevanceGate: 0.05 } }), gateway, guard: g, logModel: deps.logModel });
    const tree = store.get();
    const parsed = await parser.parse(page, { tree, seedTerms: seedTermsOf([page.title, page.siteName || '']), followLinks: false });
    evidence.putSource({
      id: parsed.sourceId, url: page.url, domain: parsed.domain, title: page.title.slice(0, 200), fetchedAt: new Date().toISOString(),
      hash: page.contentHash, simhash: page.simhash, pageType: parsed.pageType, value: parsed.value,
      snapshot: page.noindex || !settings.store.snapshots ? null : evidence.snapshot(page.contentHash, page.markdown), noindex: Boolean(page.noindex),
    });
    if (parsed.chunks.length) await retrieval.addChunks(parsed.sourceId, parsed.chunks, { url: page.url, title: page.title });
    retrieval.save();
    const builder = new GraphBuilder({ settings, retrieval, evidence, embedder, gateway, scorer });
    const batch = builder.newBatch();
    if (!parsed.dropped) await builder.planPage(tree, parsed, batch, { policy: 'preview' });
    evidence.flushEdges();
    const u = gateway.usage();
    return {
      ops: compactOps(batch.ops),
      page: {
        url: page.url, title: page.title, pageType: parsed.pageType, value: parsed.value, classifiedBy: parsed.classifiedBy,
        markdown: page.markdown.slice(0, 8000), chars: page.markdown.length, links: (page.links || []).length,
        jsonld: [...new Set((page.jsonld || []).flatMap((o) => [].concat(o['@type'] || [])))].slice(0, 10),
        mentions: parsed.mentions.length, facts: parsed.facts.length, ai: { calls: u.calls, tokens: u.tokens }, flagged: g.flagged,
      },
    };
  }

  async function map(url) {
    return mapSite(url, { fetchPage: (u, o) => fetcher.page(u, o), robots: fetcher.robots, extract, limit: 2000 });
  }

  // ---- review queue --------------------------------------------------------------------------------
  function reviewList({ status: st = 'open', limit = 100 } = {}) {
    return evidence.review.filter((r) => st === 'all' || r.status === st).slice(-limit).reverse()
      .map(({ ops, altOps, ...rest }) => ({ ...rest, opCount: (ops || []).length, canSeparate: Boolean(altOps && altOps.length) }));
  }

  async function reviewAct(id, action) {
    const item = evidence.getReview(id);
    if (!item) { const e = new Error('That review item no longer exists'); e.status = 404; throw e; }
    if (item.status !== 'open') { const e = new Error('That item was already handled'); e.status = 409; throw e; }
    let result = null;
    if (action === 'accept' || action === 'separate') {
      const ops = action === 'separate' ? item.altOps : item.ops;
      if (!ops || !ops.length) { const e = new Error('Nothing to apply for this choice'); e.status = 400; throw e; }
      result = await store.mutate(`Review: ${item.title}`.slice(0, 120), (t) => runOps(t, ops, { inPlace: true, maxOps: 200, maxCreate: 20 }));
    } else if (action !== 'reject') {
      const e = new Error('Unknown action'); e.status = 400; throw e;
    }
    evidence.updateReview(id, { status: action === 'reject' ? 'rejected' : action === 'separate' ? 'separated' : 'accepted', decidedAt: new Date().toISOString() });
    if (item.kind === 'merge' && item.levels && action !== 'reject') evidence.addLabel({ kind: 'merge', levels: item.levels, match: action === 'accept' });
    if (item.url && ['create', 'edge'].includes(item.kind)) evidence.addLabel({ kind: 'page', url: item.url, y: action === 'accept' });
    // Rejected facts lower that site's learned trust a little.
    if (item.url && action === 'reject' && ['create', 'edge', 'snippet'].includes(item.kind)) db.adjustTrust(domainOf(item.url), -0.05);
    retrain();
    return { status: evidence.getReview(id).status, stats: result ? result.stats : null, createdIds: result ? result.createdIds : [] };
  }

  // ---- retrieval for Ask / Capture ----------------------------------------------------------------------
  async function rankFor(query) {
    try { return await retrieval.rankNodes(store.get(), query); } catch { return null; }
  }

  async function evidenceFor(question, k = 4) {
    try {
      const hits = await retrieval.searchChunks(question, { k });
      if (!hits.length) return '';
      return hits.map((h) => `- ${String(h.title || h.url).slice(0, 120)} <${h.url}>:\n${untrusted(h.text, 600, 'untrusted')}`).join('\n');
    } catch { return ''; }
  }

  async function duplicateWarnings(report) {
    if (embedder.version === 'hash384-v1') return; // lexical vectors would just repeat titleKey
    const tree = store.get();
    for (const e of report) {
      if (e.status !== 'new' || !e.title) continue;
      const sim = await retrieval.similarNodes(tree, e.title, e.type, { k: 2, min: 0.9 }).catch(() => []);
      const other = sim.find((s) => s.id !== e.nodeId && tree.nodes[s.id] && tree.nodes[s.id].title.toLowerCase() !== e.title.toLowerCase());
      if (other) e.warnings.push(`Possibly the same as "${tree.nodes[other.id].title}" (${Math.round(other.score * 100)}% similar). If so, untick this and update that node instead.`);
    }
  }

  function setDomains({ deny, trusted, unblock }) {
    if (deny || trusted) evidence.setLists({ deny, trusted });
    if (unblock) evidence.unblock(String(unblock).toLowerCase());
    guard.setLists(evidence.lists(settings.domains));
    return domains();
  }

  // Delete-by-person/organisation: drop provenance for these nodes and every fetched page that no
  // remaining node relies on (record, snapshot, retrieval chunks). Not undoable.
  function forgetNodes(removed, remainingTree) {
    const stillUsed = new Set(Object.values(remainingTree.nodes).flatMap((n) => n.sources || []));
    const candidates = new Set();
    for (const n of removed) {
      for (const sid of n.sources || []) candidates.add(sid);
      for (const sid of db.forgetNode(n.id)) candidates.add(sid);
    }
    let pages = 0; let chunks = 0;
    for (const sid of candidates) {
      if (stillUsed.has(sid)) continue;
      if (evidence.forgetSource(sid)) pages++;
      chunks += retrieval.removeSource(sid);
    }
    retrieval.save();
    return { pages, chunks };
  }

  function provenance(nodeId) { return db.factsForNode(nodeId, 30); }

  function domains() { return { ...evidence.lists(settings.domains), blocked: evidence.blockedList() }; }

  function sources(ids) {
    return ids.map((id) => evidence.getSource(id)).filter(Boolean).map((s) => ({ id: s.id, url: s.url, title: s.title, domain: s.domain, fetchedAt: s.fetchedAt, pageType: s.pageType, value: s.value }));
  }

  return {
    settings, evidence, guard, fetcher, db, router, embedder, retrieval, search, sessions, scorer,
    start, status, forgetNodes, provenance, scrapePreview, map, reviewList, reviewAct, rankFor, evidenceFor, duplicateWarnings, setDomains, domains, sources, retrain,
  };
}

module.exports = { createWeb };
