'use strict';
const crypto = require('crypto');
const { runOps } = require('./ops');
const { Frontier } = require('./web/frontier');
const { mapSite } = require('./web/map');
const { extract } = require('./web/scrape');
const { domainOf, canonicalize, hostOf } = require('./web/canonical');
const { PageParser, seedTermsOf } = require('./parse/pageParser');
const { GraphBuilder, compactOps } = require('./graph/builder');
const { suggest } = require('./graph/linkpred');
const { Planner, seedKind } = require('./plan/planner');
const { Gateway } = require('./llm/gateway');
const { Guard } = require('./llm/guard');
const { PROMPT_VERSION } = require('./llm/prompts');
const { urlType } = require('./parse/classify');
const { nearDuplicate } = require('./ml/simhash');
const S = require('./schema');

// Session orchestrator. Deterministic workflow; LLMs only at gated points inside the parser, planner
// and builder, all through one per-session Gateway with hard budgets.
//
//   search mode: seed → planner queries → search API → frontier (depth 0) → fetch → parse → build
//                → outlinks (depth+1, same site, valuable pages only) and new entities → planner
//   crawl mode:  a URL you give → its sitemap/homepage links (Firecrawl /map) → same loop on that site
//
// Stops on: page/query/time budget, frontier and planner exhausted, Stop pressed, or a stall (the last
// N pages added fewer than M facts). Writes are batched and coalesced into ONE undo step per session.

const MAX_LOG = 300;
const MAX_OPS_PER_COMMIT = 3000;
// People-search and contact-data brokers: their pages and snippets are never used (privacy).
const CONTACT_BROKERS = /(^|\.)(rocketreach\.co|zoominfo\.com|contactout\.com|lusha\.com|apollo\.io|signalhire\.com|spokeo\.com|truecaller\.com|whitepages\.com|peoplefinders\.com|beenverified\.com|instantcheckmate\.com|radaris\.com|clustrmaps\.com)$/i;
const BRANCH_MIN = 0.35; // a branch stops following below this relevance
const MAX_AI_CALLS = 600;
// An entity's own site: which of its pages are worth reading, best first.
const HOME_PAGES = { team: 0.95, about: 0.9, portfolio: 0.9, press: 0.75, careers: 0.7, job: 0.6, product: 0.6, profile: 0.55, blog: 0.4 };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }; // vectors are unit length

class Session {
  constructor({ id, seed, mode, url, budget, deps }) {
    this.id = id;
    this.seed = seed;
    this.mode = mode;
    this.url = url;
    this.d = deps;
    this.budget = { ...deps.settings.budgets, ...budget };
    // Haiku reads every kept page (up to extract.maxGroupsPerPage sections each), so the AI budget scales
    // with pages unless you set it.
    const groups = ((deps.settings.extract || {}).maxGroupsPerPage) || 4;
    if (budget.maxAiCalls == null) this.budget.maxAiCalls = Math.min(MAX_AI_CALLS, (groups + 1) * this.budget.maxPages + 20);
    this.status = 'running';
    this.startedAt = new Date().toISOString();
    this.endedAt = null;
    this.stats = {
      queries: 0, results: 0, pages: 0, fetched: 0, unchanged: 0, dropped: 0, skipped: 0, blocked: 0, deferred: 0, created: 0, merged: 0, edges: 0, inferred: 0, queued: 0, commits: 0, snippets: 0,
      // Why URLs never became pages: already queued, on the deny list, over a site's page cap, too deep,
      // refused by robots.txt, JavaScript-only, blocked, other policy, or a network error.
      rejected: { seen: 0, denied: 0, cap: 0, depth: 0, robots: 0, js: 0, blocked: 0, policy: 0, error: 0, dup: 0 },
    };
    this.stopReason = null;
    this.deferred = [];
    this.logLines = [];
    this.queries = [];
    this.touched = new Set();
    this.recentFacts = [];
    this.stopRequested = false;
    this.listeners = new Set();
    this.error = null;
    this.sessionNodeId = null;
  }

  label() { return Array.isArray(this.seed) && this.seed.length ? this.seed.join(', ') : (this.url ? hostOf(this.url) : 'research'); }

  emit(type, payload = {}) {
    const ev = { type, id: this.id, status: this.status, stats: this.stats, ...payload };
    for (const fn of this.listeners) { try { fn(ev); } catch { /* listener gone */ } }
  }

  log(msg, extra = {}) {
    const line = { at: new Date().toISOString(), msg: String(msg).slice(0, 300), ...extra };
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG) this.logLines.shift();
    this.emit('log', { line });
  }

  summary({ full = false } = {}) {
    const g = this.gateway ? this.gateway.usage() : null;
    return {
      id: this.id, seed: this.seed, mode: this.mode, url: this.url, status: this.status, error: this.error,
      startedAt: this.startedAt, endedAt: this.endedAt, budget: this.budget, stats: this.stats, stopReason: this.stopReason,
      ai: g && { calls: g.calls, tokens: g.tokens, cacheHits: g.cacheHits, failures: g.failures, maxCalls: g.maxCalls, maxTokens: g.maxTokens, byTask: g.byTask, guardCalls: this.guard ? this.guard.calls : 0, flagged: this.guard ? this.guard.flagged : 0, failReasons: g.failReasons, lastError: g.lastError, waitedMs: g.waitedMs },
      deferred: this.deferred.slice(-100), queries: this.queries.slice(-50), sessionNodeId: this.sessionNodeId,
      log: full ? this.logLines : this.logLines.slice(-60),
    };
  }

  save() { try { this.d.evidence.saveSession(this.summary({ full: true })); } catch { /* best effort */ } }

  shouldStop() {
    const b = this.budget;
    if (this.stopRequested) return this.error ? `Stopped: ${this.error}` : 'Stopped by you';
    if (this.stats.pages >= b.maxPages) return 'Page budget reached';
    if ((Date.now() - Date.parse(this.startedAt)) / 1000 >= b.maxWallSeconds) return 'Time budget reached';
    if (this.recentFacts.length >= b.stallWindow && this.recentFacts.slice(-b.stallWindow).reduce((a, x) => a + x, 0) < b.stallMinFacts) return 'Stalled: recent pages added almost nothing new';
    return null;
  }

  async run() {
    const { settings, store, fetcher, guard: urlGuard, evidence, retrieval, embedder, search, cfg, scorer, logModel } = this.d;
    const b = this.budget;
    this.gateway = new Gateway({ cfg, router: this.d.router, cacheDir: this.d.cacheDir, maxCalls: b.maxAiCalls, maxTokens: b.maxTokens });
    this.guard = new Guard({ cfg, router: this.d.router, maxCalls: settings.guard.maxCalls, threshold: settings.guard.threshold });
    const parser = new PageParser({ settings, gateway: this.gateway, guard: this.guard, logModel });
    const db = this.d.db || null;
    const builder = new GraphBuilder({ settings, retrieval, evidence, embedder, gateway: this.gateway, scorer, db });
    const planner = new Planner({ settings, embedder, gateway: this.gateway });
    const seedTerms = seedTermsOf(this.mode === 'crawl' ? [...(this.seed || []), hostOf(this.url).split('.').slice(-2, -1)[0] || ''] : this.seed);
    // The research subject: its phrases are looked for on every page, and its kind picks the templates.
    const seedText = (this.seed || []).join(' ').trim();
    const seed = { phrases: (this.seed || []).filter(Boolean), kind: seedText ? seedKind(seedText) : 'topic' };
    const snippets = new Map(); // canonical URL → { title, snippet, query } from search results
    const snippetDone = new Set();
    const dom = settings.domains;
    const siteDomain = this.mode === 'crawl' ? domainOf(this.url) : null;
    // Entity homes: official sites of organisations found on pages ("[Two Sigma](https://www.twosigma.com/)").
    const entityDomains = new Map(); // domain → entity name
    const tierOf = (url) => {
      if (siteDomain && domainOf(url) === siteDomain) return 'site';
      const t = urlGuard.tierOf(hostOf(url));
      return t === 'open' && entityDomains.has(domainOf(url)) ? 'entity' : t;
    };
    const frontier = new Frontier({
      maxDepthFor: (tier) => (tier === 'site' ? b.maxDepth + 1 : tier === 'trusted' ? Math.min(b.maxDepth + 1, dom.trustedDepth)
        : tier === 'entity' ? (dom.entityDepth ?? 2) : Math.min(b.maxDepth, dom.openDepth)),
      capFor: (tier, d) => (tier === 'site' ? b.maxPages : (tier === 'trusted' ? dom.trustedPerDomain : tier === 'entity' ? (dom.entityPerDomain ?? 6) : dom.openPerDomain) + (this.highValueDomains.has(d) ? dom.highValueBonus : 0)),
    });
    const loggedFails = {};
    const reportAiFailures = () => {
      const fr = (this.gateway && this.gateway.stats.failReasons) || {};
      const fresh = Object.entries(fr).filter(([k, n]) => n > (loggedFails[k] || 0));
      if (!fresh.length) return;
      for (const [k, n] of fresh) loggedFails[k] = n;
      this.log(`AI calls failing: ${fresh.map(([k, n]) => `${k} ×${n}`).join(', ')}${this.gateway.lastError ? ` (last: ${this.gateway.lastError})` : ''}`, { kind: 'skip' });
    };
    this.highValueDomains = new Set();
    const seenHashes = new Set();
    const simhashes = []; // near-duplicate check
    const ingested = []; // vectors of pages read this session (novelty)
    let batch = builder.newBatch();
    let lastCommit = Date.now();
    let planLock = Promise.resolve();

    await embedder.init().catch(() => {});
    const seedVec = await embedder.embedOne(`${seedText || seedTerms.join(' ')} ${seed.kind === 'topic' ? '' : seed.kind}`.trim());
    planner.subject = seedText || seedTerms.join(' ');
    planner.kind = seed.kind;
    if (cfg.groqKey) await this.d.router.refresh().catch(() => {});

    const commit = async (final = false) => {
      if (!batch.ops.length && !batch.review.length) { batch = builder.newBatch(); return; }
      const cur = batch;
      batch = builder.newBatch();
      let refs = {};
      if (cur.ops.length) {
        try {
          const res = await store.mutate(`Research: ${this.label()}`, (t) => runOps(t, compactOps(cur.ops).slice(0, MAX_OPS_PER_COMMIT), { inPlace: true, maxOps: MAX_OPS_PER_COMMIT, maxCreate: 400 }), { coalesce: `research:${this.id}`, window: 24 * 3600e3 });
          refs = res.refs || {};
          this.stats.commits++;
          for (const id of cur.touched) { const real = refs[id] || id; if (store.get().nodes[real]) this.touched.add(real); }
          this.log(`Saved ${res.stats.created} new, ${res.stats.merged + res.stats.updated} updated`);
        } catch (e) {
          this.log(`Could not save a batch: ${e.message}`);
        }
      }
      const fix = (v) => (typeof v === 'string' && refs[v] ? refs[v] : v);
      for (const item of cur.review) {
        for (const op of [...(item.ops || []), ...(item.altOps || [])]) {
          for (const k of ['id', 'parent', 'from', 'to']) op[k] = fix(op[k]);
          for (const l of op.links || []) l.to = fix(l.to);
        }
        if (evidence.addReview(item)) this.stats.queued++;
      }
      for (const l of cur.log) evidence.logMerge({ session: this.id, ...l, nodeId: fix(l.nodeId) });
      // Fact-level provenance: which page said it, the snippet, and which extractor/prompt version.
      if (db && cur.prov.length) {
        try { db.addFacts(cur.prov.map((r) => ({ ...r, nodeId: fix(r.nodeId), version: PROMPT_VERSION, session: this.id }))); } catch (e) { this.log(`Could not record provenance: ${e.message}`); }
      }
      evidence.flushEdges();
      evidence.flushDomains();
      retrieval.save();
      lastCommit = Date.now();
      if (!final) this.save();
    };

    const processEntry = async (e) => {
      this.stats.pages++;
      const r = await fetcher.fetch(e.url);
      if (!r.ok) {
        if (r.blocked) this.stats.blocked++;
        if (r.deferred) { this.stats.deferred++; this.deferred.push({ url: r.url || e.url, reason: r.reason }); } else this.stats.skipped++;
        const kind = r.kind && r.kind in this.stats.rejected ? r.kind : r.policy ? 'policy' : 'error';
        this.stats.rejected[kind]++;
        this.log(`Skipped ${e.url}: ${r.reason}`, { url: e.url, kind: r.blocked ? 'blocked' : 'skip' });
        // We could not read the page, but the search engine already told us what it says.
        if (snippets.has(e.url)) await processSnippet(e.url);
        return;
      }
      if (r.notModified) { this.stats.unchanged++; return; }
      this.stats.fetched++;
      const page = r.page;
      if (page.contentHash && seenHashes.has(page.contentHash)) { this.stats.skipped++; this.stats.rejected.dup++; return; }
      if (page.contentHash) seenHashes.add(page.contentHash);
      // Near-duplicates (mirrors, syndicated copies) of a page already read add nothing new.
      if (page.simhash && page.simhash !== '0' && simhashes.some((h) => nearDuplicate(h, page.simhash))) {
        this.stats.skipped++; this.stats.rejected.dup++;
        this.log(`Skipped a near-copy of a page already read: ${page.title || page.url}`, { url: page.url, kind: 'skip' });
        return;
      }
      if (page.simhash && page.simhash !== '0') simhashes.push(page.simhash);
      if (r.url !== e.url) frontier.markSeen(r.url);
      // Links to other sites are scored too; below, they are followed only from valuable pages or when the
      // anchor names an entity on the page (crawl mode stays on the one site).
      const parsed = await parser.parse(page, {
        tree: store.get(), seedTerms, seed, depth: e.depth, trust: e.tier === 'trusted' || e.tier === 'site' ? 0.9 : e.tier === 'entity' ? 0.75 : 0.6,
        seenDomainPages: (d) => frontier.admitted(d), followLinks: true, sameDomainOnly: this.mode === 'crawl',
      });
      reportAiFailures();
      evidence.putSource({
        id: parsed.sourceId, url: page.url, domain: parsed.domain, title: page.title.slice(0, 200), fetchedAt: new Date().toISOString(),
        hash: page.contentHash, simhash: page.simhash, pageType: parsed.pageType, value: parsed.value, etag: r.res && r.res.etag, lastModified: r.res && r.res.lastModified,
        snapshot: page.noindex || !settings.store.snapshots ? null : evidence.snapshot(page.contentHash, page.markdown), session: this.id, noindex: Boolean(page.noindex),
      });
      // An entity's homepage: queue its best pages (team, about, portfolio, press, careers) from its own
      // links, even when the homepage itself holds little.
      if (e.via === 'entity' && e.depth === 0) {
        const own = domainOf(page.url);
        const best = (page.links || []).filter((l) => domainOf(l.url) === own && !l.nofollow)
          .map((l) => ({ l, t: urlType(l.url) })).filter((x) => HOME_PAGES[x.t])
          .sort((a, b2) => HOME_PAGES[b2.t] - HOME_PAGES[a.t]).slice(0, Math.max(0, (dom.entityPerDomain ?? 6) - 1));
        let n = 0;
        for (const x of best) if (frontier.push({ url: x.l.url, depth: 1, priority: Math.round((0.5 + 0.35 * HOME_PAGES[x.t]) * 1000) / 1000, parent: page.url, via: 'entity-page', tier: 'entity', anchor: x.l.anchor, entity: e.entity, branch: e.branch, rParent: Math.max(e.rParent || 0, 0.5) }).ok) n++;
        if (n) this.log(`Reading ${n} more page${n === 1 ? '' : 's'} on ${e.entity || own}'s own site`, { url: page.url, kind: 'query' });
      }
      if (parsed.dropped) { this.stats.dropped++; this.recentFacts.push(0); this.log(`Low value (${parsed.value}): ${page.title || page.url}`, { url: page.url, kind: 'drop' }); return; }
      if (parsed.value >= settings.thresholds.highValue) this.highValueDomains.add(parsed.domain);
      if (parsed.chunks.length) await retrieval.addChunks(parsed.sourceId, parsed.chunks, { url: page.url, title: page.title });
      // Planning is serialised: pages are fetched and parsed in parallel, but resolved one at a time so
      // two pages can never both create the same new entity.
      parsed.tier = e.tier; // site trust: crawl target and trusted sites count as one trusted source
      const step = planLock.then(() => builder.planPage(store.get(), parsed, batch, { policy: 'auto', sessionId: this.id }));
      planLock = step.catch(() => {});
      const ps = await step;
      const facts = ps.created + ps.merged + ps.edges;
      this.recentFacts.push(facts);
      for (const k of ['created', 'merged', 'edges']) this.stats[k] += ps[k];

      // Relevance of this page to the subject: embedding similarity blended with the extractor's own
      // judgement, smoothed along the branch (r = 0.6·r_page + 0.4·r_parent). Below 0.35 the branch
      // stops here: the page's facts are kept, but nothing found on it is followed.
      const pageVec = await embedder.embedOne(`${page.title}. ${page.text.slice(0, 1000)}`);
      const rEmb = Math.max(0, Math.min(1, (dot(seedVec, pageVec) - 0.1) / 0.5));
      const rPage = Math.round((0.5 * rEmb + 0.5 * (parsed.relevance || 0)) * 100) / 100;
      const rBranch = Math.round((e.rParent == null ? rPage : 0.6 * rPage + 0.4 * e.rParent) * 100) / 100;
      ingested.push(pageVec);
      if (e.branch != null) {
        planner.branchPage(e.branch, { facts, r: rBranch, title: page.title, type: parsed.pageType });
        if (db) { try { db.queryYield(this.id, e.branch, facts); } catch { /* best-effort */ } }
      }
      this.stats.aiPages = (this.stats.aiPages || 0) + (parsed.extractedBy !== 'rules' ? 1 : 0);
      this.stats.mentioned = (this.stats.mentioned || 0) + (ps.mentioned || 0);
      this.log(`${parsed.pageType} page (value ${parsed.value}, relevance ${rBranch}${parsed.extractedBy !== 'rules' ? `, read by AI in ${parsed.aiCalls} part${parsed.aiCalls === 1 ? '' : 's'}` : ''}): ${page.title || page.url} → ${ps.created} new, ${ps.merged} matched, ${ps.edges} links${ps.mentioned ? `, ${ps.mentioned} mentioned` : ''}, ${ps.queued} for review`, { url: page.url, kind: 'page' });
      const stopped = e.via !== 'entity' && e.via !== 'entity-page' && (rBranch < BRANCH_MIN || planner.isDropped(e.branch));
      if (stopped) {
        this.stats.branchStops = (this.stats.branchStops || 0) + 1;
        this.log(`Not following anything from this page: ${planner.isDropped(e.branch) ? 'its search branch was dropped' : `off-topic (relevance ${rBranch} < ${BRANCH_MIN})`}`, { url: page.url, kind: 'skip' });
        return;
      }
      // Organisations this page links to their own site: read that site too (search mode, capped).
      if (this.mode === 'search') {
        for (const h of ps.homes || []) {
          if (entityDomains.has(h.domain) || entityDomains.size >= (dom.maxEntityDomains ?? 15) || h.domain === parsed.domain) continue;
          const home = canonicalize(`https://${h.domain}/`);
          const shape = home && urlGuard.check(home);
          if (!shape || !shape.ok || shape.tier === 'deny') continue;
          entityDomains.set(h.domain, h.name);
          const pushed = frontier.push({ url: home, depth: 0, priority: Math.round((0.6 + 0.3 * rBranch) * 1000) / 1000, parent: page.url, via: 'entity', tier: tierOf(home), anchor: h.name, entity: h.name, branch: e.branch, rParent: rBranch });
          if (pushed.ok) { this.stats.entityHomes = (this.stats.entityHomes || 0) + 1; this.log(`Queued ${h.name}'s own site (${h.domain})`, { url: home, kind: 'query' }); }
        }
      }
      for (const l of parsed.outlinks) {
        const external = domainOf(l.url) !== parsed.domain;
        if (external && !(parsed.value >= settings.thresholds.highValue || l.entityLink)) continue;
        frontier.push({ url: l.url, depth: e.depth + 1, priority: l.priority, parent: page.url, via: 'link', tier: tierOf(l.url), anchor: l.anchor, branch: e.branch, rParent: rBranch });
      }
      if (this.mode === 'search') {
        for (const q of parsed.querySeeds) planner.enqueue({ text: q.text, type: q.type, priority: Math.min(0.9, rBranch * (q.weight || 0.8)), branch: e.branch });
        planner.addSuggestions(parsed.suggestedQueries, { branch: e.branch, priority: Math.min(0.9, 0.45 + 0.45 * rBranch) });
      }
    };

    // A search result we will not or cannot fetch (deny list, robots.txt, JavaScript-only, blocked): its
    // title and snippet were written by the search engine, so they can still be read. Anything found
    // goes to Review as one item; nothing from a snippet is written automatically.
    const processSnippet = async (url) => {
      if (snippetDone.has(url) || snippetDone.size >= 20) return;
      snippetDone.add(url);
      const sn = snippets.get(url);
      if (!sn || !sn.snippet) return;
      // Privacy: never use results from people-search / contact-data brokers, or ones advertising contact details.
      if (CONTACT_BROKERS.test(hostOf(url)) || /\b(e-?mail|phone( number)?|contact (info|details)|mobile number|home address)\b/i.test(sn.title)) return;
      const text = `${sn.title}\n\n${sn.snippet}`;
      const page = { url, title: sn.title, description: '', siteName: '', markdown: text, text, links: [], jsonld: [], mailtos: [], visibleChars: text.length, contentHash: null, simhash: '0', scriptCount: 0 };
      const parsed = await parser.parse(page, { tree: store.get(), seedTerms, seed, forced: { pageType: 'snippet', value: 0.5 }, followLinks: false });
      parsed.textForContext = text;
      const tmp = builder.newBatch();
      const step = planLock.then(() => builder.planPage(store.get(), parsed, tmp, { policy: 'preview', sessionId: this.id }));
      planLock = step.catch(() => {});
      await step;
      const ops = compactOps(tmp.ops);
      this.stats.snippets++;
      if (!ops.length) return;
      const names = ops.filter((o) => o.op === 'create').map((o) => o.title).slice(0, 4);
      if (evidence.addReview({
        kind: 'snippet', key: `snippet|${url}`, sessionId: this.id, url, p: 0.5, snippet: sn.snippet.slice(0, 400),
        title: `From a search result: ${names.length ? names.join(', ') : sn.title}`.slice(0, 160), ops,
      })) this.stats.queued++;
      this.log(`Read the search snippet for ${hostOf(url)} → ${ops.length} change${ops.length === 1 ? '' : 's'} for review`, { url, kind: 'snippet' });
    };

    try {
      if (this.mode === 'crawl') {
        const start = canonicalize(this.url);
        if (!start) throw new Error('Not a valid web address');
        const shape = urlGuard.check(start);
        if (!shape.ok) throw new Error(shape.reason);
        frontier.push({ url: start, depth: 0, priority: 1, via: 'seed', tier: 'site' });
        try {
          const urls = await mapSite(start, { fetchPage: (u, o) => fetcher.page(u, o), robots: fetcher.robots, extract, limit: 1500 });
          const ranked = urls.map((u) => ({ u, t: urlType(u) })).filter((x) => x.t !== 'legal' && x.t !== 'listing')
            .map((x) => ({ ...x, p: { team: 0.95, about: 0.9, careers: 0.85, job: 0.8, portfolio: 0.9, press: 0.75, product: 0.6, blog: 0.45, docs: 0.4 }[x.t] || 0.3 }))
            .sort((a, b2) => b2.p - a.p).slice(0, Math.min(60, b.maxPages * 2));
          for (const x of ranked) frontier.push({ url: x.u, depth: 1, priority: x.p * 0.9, via: 'map', tier: 'site' });
          this.log(`Mapped ${urls.length} URLs on ${hostOf(start)}; queued the ${ranked.length} most promising`);
        } catch (e) { this.log(`Could not map the site: ${e.message}`); }
      } else {
        if (!search.configured) throw new Error(`Web search is not configured. ${search.hint} (SEARCH_PROVIDER=${search.name}).`);
        planner.enqueue({ text: seedText, type: `seed-${seed.kind}`, priority: 1 });
        this.log(`Researching "${seedText}" as a ${seed.kind}`);
      }
      this.emit('progress');

      const stop = (reason) => { this.stopReason = reason; this.log(reason); };
      for (;;) {
        const why = this.shouldStop();
        if (why) { stop(why); break; }
        // Search again when the queue is short, or when all that is left are weak links off pages already
        // read (search results enter at ≥ 0.55; site navigation like About/Careers scores far lower), so
        // the page budget is not spent on a site's generic pages while searches remain.
        const weakOnly = frontier.size > 0 && frontier.peekPriority() < 0.5;
        if (this.mode === 'search' && (frontier.size < b.parallel || weakOnly) && this.stats.queries < b.maxQueries && planner.hasMore()) {
          // At most 2 searches per round: the first round no longer spends every seed query at once, and
          // later rounds can use names found on the pages read so far.
          const qs = await planner.next(Math.min(2, b.maxQueries - this.stats.queries), { left: b.maxQueries - this.stats.queries });
          for (const q of qs) {
            this.stats.queries++;
            let rows = [];
            try { rows = await search.search(q.q, { count: b.resultsPerQuery }); } catch (e) {
              this.log(`Search failed for "${q.q}": ${e.message}`);
              if (e.fatal) { this.stopRequested = true; this.error = e.message; break; }
              continue;
            }
            this.stats.results += rows.length;
            const branch = planner.openBranch(q);
            const n = { queued: 0, seen: 0, denied: 0, cap: 0, depth: 0, policy: 0 };
            const deniedHosts = new Set();
            const deniedUrls = [];
            for (const [i, row] of rows.entries()) {
              const c = canonicalize(row.url);
              if (!c) { n.policy++; continue; }
              if (row.snippet && !snippets.has(c)) snippets.set(c, { title: row.title || '', snippet: row.snippet, query: q.q });
              const shape = urlGuard.check(c);
              if (!shape.ok) {
                if (shape.tier === 'deny') { n.denied++; deniedHosts.add(shape.domain); deniedUrls.push(c); } else n.policy++;
                continue;
              }
              // priority = rank prior × novelty, novelty = 1 − max similarity to pages already read.
              let novelty = 1;
              if (ingested.length && (row.title || row.snippet)) {
                const v = await embedder.embedOne(`${row.title || ''}. ${row.snippet || ''}`);
                novelty = 1 - Math.max(0, ...ingested.map((x) => dot(x, v)));
              }
              const prior = 0.55 + 0.4 * (1 - i / Math.max(1, rows.length));
              const pushed = frontier.push({ url: c, depth: 0, priority: Math.round(prior * (0.6 + 0.4 * novelty) * 1000) / 1000, via: 'search', tier: tierOf(c), anchor: row.title, branch, rParent: null });
              if (pushed.ok) n.queued++; else if (pushed.reason === 'seen') n.seen++;
              else if (pushed.reason === 'domain cap') n.cap++; else if (pushed.reason === 'depth') n.depth++; else n.policy++;
            }
            for (const k of ['seen', 'denied', 'cap', 'depth', 'policy']) this.stats.rejected[k] += n[k];
            this.queries.push({ q: q.q, arm: q.arm, results: rows.length, queued: n.queued, branch, source: q.source || 'template' });
            if (db) { try { db.addQuery({ session: this.id, text: q.q, branch, source: q.source || 'template', results: rows.length, queued: n.queued }); } catch { /* history is best-effort */ } }
            const parts = [`${n.queued} queued`];
            if (n.seen) parts.push(`${n.seen} already queued`);
            if (n.denied) parts.push(`${n.denied} deny list (${[...deniedHosts].slice(0, 3).join(', ')})`);
            if (n.cap) parts.push(`${n.cap} over the per-site limit`);
            if (n.depth) parts.push(`${n.depth} too deep`);
            if (n.policy) parts.push(`${n.policy} not allowed`);
            this.log(`Searched "${q.q}" → ${rows.length} results: ${parts.join(' · ')}`, { kind: 'query' });
            for (const u of deniedUrls) await processSnippet(u);
          }
        }
        const room = b.maxPages - this.stats.pages;
        const entries = frontier.popMany(Math.max(0, Math.min(b.parallel, room)));
        if (!entries.length) {
          if (this.mode === 'search' && this.stats.queries < b.maxQueries && planner.hasMore()) continue;
          if (this.mode === 'search' && this.stats.queries >= b.maxQueries) stop(`Query budget used (${b.maxQueries} searches) and every result has been read or ruled out`);
          else if (this.mode === 'search') stop(`Out of things to search: used ${this.stats.queries} of ${b.maxQueries} searches; ${planner.exhaustedReason()}`);
          else stop('Read every page worth reading on this site');
          break;
        }
        await Promise.all(entries.map((e) => processEntry(e).catch((err) => this.log(`Error on ${e.url}: ${err.message}`))));
        this.emit('progress');
        if (batch.pages >= b.commitEveryPages || Date.now() - lastCommit >= b.commitEveryMs) await commit();
      }
      await commit(true);
      await this.finish(store, retrieval, builder);
      this.status = this.stopRequested && !this.error ? 'stopped' : this.error ? 'failed' : 'done';
    } catch (e) {
      this.error = e.message;
      this.status = 'failed';
      this.stopReason = this.stopReason || `Failed: ${e.message}`;
      this.log(`Session failed: ${e.message}`);
      try { await commit(true); } catch { /* ignore */ }
    } finally {
      this.endedAt = new Date().toISOString();
      this.save();
      this.emit('done', { summary: this.summary() });
    }
  }

  // Research node under "Research", plus backlinker suggestions over everything this session touched.
  async finish(store, retrieval, builder) {
    const { evidence, settings } = this.d;
    const touched = [...this.touched].filter((id) => store.get().nodes[id]);
    if (!touched.length && !this.stats.fetched) return;
    const area = builder.areaId(store.get(), 'Research');
    const date = this.startedAt.slice(0, 10);
    const op = {
      op: 'create', ref: 'session', parent: area, type: 'session', title: `${this.label()} (${date})`.slice(0, 120),
      summary: `Web research ${this.mode === 'crawl' ? `crawl of ${hostOf(this.url)}` : `for "${this.label()}"`}: read ${this.stats.fetched} pages, added ${this.stats.created} nodes, matched ${this.stats.merged}, ${this.stats.edges} links, ${this.stats.queued} items for review.`,
      fields: [
        { key: 'Session', value: this.id, kind: 'text' }, { key: 'Pages read', value: String(this.stats.fetched), kind: 'number' },
        { key: 'Queries', value: String(this.stats.queries), kind: 'number' }, { key: 'Date', value: date, kind: 'date' },
      ],
      tags: ['research', 'web'], links: touched.slice(0, S.LIMITS.links).map((to) => ({ to, relation: 'found' })),
    };
    // Backlinker: inferred links with independent evidence go in as "inferred" (dotted in the graph);
    // the rest are suggestions in the review queue.
    const ops = [op];
    try {
      await retrieval.syncNodes(store.get());
      const sugg = suggest(store.get(), touched, { vectorOf: (id) => retrieval.nodeVector(id), min: settings.thresholds.suggestMin, max: 10 });
      for (const s of sugg) {
        const a = store.get().nodes[s.a]; const bb = store.get().nodes[s.b];
        const ver = builder.verifier ? await builder.verifier.run({ a: a.title, b: bb.title, rel: 'related to' }) : null;
        const link = { to: s.b, relation: 'related to', conf: ver && ver.supported ? Math.max(s.score, ver.confidence) : s.score, status: 'inferred' };
        if (ver && ver.supported && s.score >= 0.5) { ops.push({ op: 'update', id: s.a, links: [link] }); this.stats.inferred++; } else {
          if (evidence.addReview({ kind: 'suggestion', key: `suggest|${[s.a, s.b].sort().join('|')}`, sessionId: this.id, p: s.score, title: `Link "${a.title}" and "${bb.title}"?`, features: { aa: s.aa, ra: s.ra, cos: s.cos, common: s.common.map((id) => (store.get().nodes[id] || {}).title).filter(Boolean) }, evidence: ver ? ver.evidence : [], ops: [{ op: 'update', id: s.a, links: [{ ...link, status: 'confirmed' }] }] })) this.stats.queued++;
        }
      }
    } catch (e) { this.log(`Backlinker skipped: ${e.message}`); }
    try {
      const res = await store.mutate(`Research: ${this.label()}`, (t) => runOps(t, ops, { inPlace: true, maxOps: 100, maxCreate: 5 }), { coalesce: `research:${this.id}`, window: 24 * 3600e3 });
      this.sessionNodeId = res.refs && res.refs.session;
    } catch (e) { this.log(`Could not add the session node: ${e.message}`); }
  }
}

class SessionManager {
  constructor(deps) {
    this.deps = deps;
    this.live = new Map();
    this.active = null;
  }

  start({ seed = [], mode = 'search', url = null, budget = {} }) {
    if (this.active && this.active.status === 'running') {
      const err = new Error('A research session is already running. Stop it first.');
      err.status = 409;
      throw err;
    }
    const clean = {};
    const lim = { maxQueries: [1, 60], maxPages: [1, 300], maxDepth: [0, 3], maxAiCalls: [0, MAX_AI_CALLS], maxWallSeconds: [30, 3600], maxTokens: [0, 1000000] };
    for (const [k, [lo, hi]] of Object.entries(lim)) if (Number.isFinite(Number(budget[k]))) clean[k] = Math.max(lo, Math.min(hi, Math.round(Number(budget[k]))));
    const id = `w_${crypto.randomBytes(5).toString('hex')}`;
    const s = new Session({ id, seed: seed.map((x) => S.text(x, 80)).filter(Boolean).slice(0, 5), mode, url, budget: clean, deps: this.deps });
    this.live.set(id, s);
    if (this.live.size > 20) this.live.delete(this.live.keys().next().value);
    this.active = s;
    s.run().catch(() => {});
    return s;
  }

  get(id) { return this.live.get(id) || null; }

  stop(id) {
    const s = this.live.get(id);
    if (!s) return false;
    s.stopRequested = true;
    return true;
  }
}

module.exports = { Session, SessionManager };
