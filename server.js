'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const defaultConfig = require('./lib/config');
const { Store } = require('./lib/store');
const S = require('./lib/schema');
const T = require('./lib/tree');
const { runOps } = require('./lib/ops');
const groq = require('./lib/groq');
const { createWeb } = require('./lib/web');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const today = () => new Date().toISOString().slice(0, 10);

function createApp({ store, config = defaultConfig, ai = groq, web = null }) {
  const app = express();
  const W = web || createWeb({ store, config });
  app.disable('x-powered-by');

  // Security: loopback hosts only (blocks DNS rebinding), same-origin JSON writes only (blocks CSRF).
  app.use((req, res, next) => {
    if (!LOOPBACK_HOST.test(req.headers.host || '')) return res.status(403).json({ error: 'Forbidden host' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* invalid origin */ }
        if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Send JSON' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
    ].join('; '));
    next();
  });
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const node = (tree, id) => {
    const n = tree.nodes[id];
    if (!n) throw new HttpError(404, 'That node no longer exists');
    return n;
  };

  // ---- State -----------------------------------------------------------------------------------
  app.get('/api/status', (req, res) => {
    const tree = store.get();
    res.json({
      ai: { configured: Boolean(config.groqKey && config.groqModel), hasKey: Boolean(config.groqKey), model: config.groqModel || null },
      rev: tree.rev,
      nodeCount: Object.keys(tree.nodes).length,
      undo: store.peekUndo(),
      web: W.status(),
    });
  });

  app.get('/api/tree', (req, res) => {
    const tree = store.get();
    res.json({ rev: tree.rev, nodes: Object.values(tree.nodes) });
  });

  // ---- Manual editing ---------------------------------------------------------------------------
  app.post('/api/nodes', wrap(async (req, res) => {
    const parentId = req.body.parentId || null;
    const tree = store.get();
    if (parentId) {
      node(tree, parentId);
      if (T.depthOf(tree, parentId) >= S.LIMITS.depth - 1) throw new HttpError(400, 'Nesting is limited to 16 levels');
    }
    if (Object.keys(tree.nodes).length >= S.LIMITS.nodes) throw new HttpError(400, 'The tree is full');
    const created = await store.mutate('Add node', (t) => {
      const n = S.blankNode({ parentId, order: T.nextOrder(t, parentId), type: req.body.type, title: req.body.title });
      t.nodes[n.id] = n;
      return n;
    });
    res.status(201).json(created);
  }));

  app.patch('/api/nodes/:id', wrap(async (req, res) => {
    const id = req.params.id;
    node(store.get(), id);
    const updated = await store.mutate(`Edit "${store.get().nodes[id].title}"`, (t) => {
      const n = node(t, id);
      S.applyPatch(n, req.body);
      n.updatedAt = S.nowIso();
      return n;
    }, { coalesce: `edit:${id}` });
    res.json(updated);
  }));

  app.post('/api/nodes/:id/move', wrap(async (req, res) => {
    const id = req.params.id;
    const parentId = req.body.parentId || null;
    const index = Number.isInteger(req.body.index) ? req.body.index : null;
    await store.mutate(`Move "${node(store.get(), id).title}"`, (t) => {
      const n = node(t, id);
      if (parentId) {
        node(t, parentId);
        if (T.inSubtree(t, id, parentId)) throw new HttpError(400, 'A node cannot be moved inside itself');
        if (T.depthOf(t, parentId) + 1 + T.height(t, id) > S.LIMITS.depth) throw new HttpError(400, 'Nesting is limited to 16 levels');
      }
      n.parentId = parentId;
      const sibs = Object.values(t.nodes).filter((x) => (x.parentId || null) === parentId && x.id !== id).sort((a, b) => a.order - b.order);
      const at = index == null ? sibs.length : Math.max(0, Math.min(index, sibs.length));
      sibs.splice(at, 0, n);
      sibs.forEach((x, i) => { x.order = i * 10; });
      n.updatedAt = S.nowIso();
    });
    res.json({ ok: true });
  }));

  app.delete('/api/nodes/:id', wrap(async (req, res) => {
    const id = req.params.id;
    const target = node(store.get(), id);
    const forget = req.query.forget === '1';
    const removed = T.subtreeIds(store.get(), id).map((x) => store.get().nodes[x]).filter(Boolean);
    const count = await store.mutate(`Delete "${target.title}"`, (t) => {
      const ids = T.subtreeIds(t, id);
      ids.forEach((x) => delete t.nodes[x]);
      return ids.length;
    });
    const forgotten = forget ? W.forgetNodes(removed, store.get()) : null;
    res.json({ deleted: count, forgotten });
  }));

  // ---- AI capture ---------------------------------------------------------------------------------
  const proposals = new Map();
  const remember = (operations, limits = null) => {
    for (const [id, p] of proposals) if (Date.now() - p.at > 30 * 60 * 1000) proposals.delete(id);
    if (proposals.size >= 50) proposals.delete(proposals.keys().next().value);
    const proposalId = crypto.randomBytes(8).toString('hex');
    proposals.set(proposalId, { operations, limits, at: Date.now() });
    return proposalId;
  };
  const aiCalls = [];
  const throttle = () => {
    const now = Date.now();
    while (aiCalls.length && now - aiCalls[0] > 60000) aiCalls.shift();
    if (aiCalls.length >= 20) throw new HttpError(429, 'Too many AI requests in a minute. Wait a moment.');
    aiCalls.push(now);
  };
  const requireAi = () => {
    if (!config.groqKey) throw new HttpError(503, 'No Groq API key found. Add GROQ_API_KEY to your .env file and restart Nexus.');
    if (!config.groqModel) throw new HttpError(503, 'No model name found. Add GROQ_MODEL to your .env file and restart Nexus.');
  };

  app.post('/api/ai/propose', wrap(async (req, res) => {
    requireAi();
    throttle();
    const text = S.text(req.body.text, 12000, { multiline: true });
    if (!text) throw new HttpError(400, 'Write or paste something first');
    const tree = store.get();
    const focusId = tree.nodes[req.body.contextNodeId] ? req.body.contextNodeId : null;
    const scores = await W.rankFor(text);
    const out = await ai.capture(config, tree, { text, focusId, today: today(), scores });
    // Dry run: shows exactly what would change, without touching the tree.
    const dry = runOps(tree, out.operations);
    await W.duplicateWarnings(dry.report);
    const proposalId = remember(out.operations);
    res.json({ proposalId, reply: S.text(out.reply, 300), report: dry.report, stats: dry.stats });
  }));

  app.post('/api/ai/apply', wrap(async (req, res) => {
    const p = proposals.get(req.body.proposalId);
    if (!p) throw new HttpError(404, 'This suggestion expired. Run it again.');
    const accepted = Array.isArray(req.body.accepted) ? new Set(req.body.accepted.filter(Number.isInteger)) : null;
    const limits = p.limits || {};
    const dry = runOps(store.get(), p.operations, { accepted, ...limits });
    if (!dry.stats.changed) {
      proposals.delete(req.body.proposalId);
      return res.json({ stats: dry.stats, createdIds: [], rev: store.get().rev });
    }
    const label = `AI capture (${dry.stats.created} new, ${dry.stats.merged + dry.stats.updated} updated)`;
    const result = await store.mutate(label, (t) => runOps(t, p.operations, { accepted, inPlace: true, ...limits }));
    proposals.delete(req.body.proposalId);
    res.json({ stats: result.stats, createdIds: result.createdIds, rev: store.get().rev });
  }));

  app.post('/api/ai/ask', wrap(async (req, res) => {
    requireAi();
    throttle();
    const question = S.text(req.body.question, 1000);
    if (!question) throw new HttpError(400, 'Type a question first');
    const tree = store.get();
    const focusId = tree.nodes[req.body.contextNodeId] ? req.body.contextNodeId : null;
    const [scores, evidence] = await Promise.all([W.rankFor(question), W.evidenceFor(question)]);
    const out = await ai.ask(config, tree, { question, focusId, today: today(), scores, evidence });
    res.json({
      answer: S.text(out.answer, 6000, { multiline: true }) || 'The model returned no answer.',
      nodes: [...new Set(out.nodes)].filter((id) => tree.nodes[id]).slice(0, 12),
    });
  }));

  // ---- Web research (Firecrawl-style scrape / map / search-and-crawl sessions) ------------------------
  const webCalls = [];
  const webThrottle = () => {
    const now = Date.now();
    while (webCalls.length && now - webCalls[0] > 60000) webCalls.shift();
    if (webCalls.length >= 30) throw new HttpError(429, 'Too many web requests in a minute. Wait a moment.');
    webCalls.push(now);
  };
  const webErr = (e) => (e instanceof HttpError ? e : new HttpError(e.status || 502, e.message || 'The web request failed'));
  const urlParam = (v) => {
    const u = S.text(v, 2048);
    if (!u) throw new HttpError(400, 'Enter a web address');
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
  };

  app.post('/api/web/scrape', wrap(async (req, res) => {
    webThrottle();
    let out;
    try { out = await W.scrapePreview(urlParam(req.body.url)); } catch (e) { throw webErr(e); }
    const limits = { maxOps: 400, maxCreate: 100 };
    const dry = runOps(store.get(), out.ops, limits);
    await W.duplicateWarnings(dry.report);
    const proposalId = remember(out.ops, limits);
    const p = out.page;
    const what = `"${p.title || p.url}" (${p.pageType} page, value ${p.value})`;
    const reply = dry.report.length ? `Read ${what}.` : `Read ${what} but found nothing new to add.`;
    res.json({ proposalId, reply, report: dry.report, stats: dry.stats, page: p });
  }));

  app.post('/api/web/map', wrap(async (req, res) => {
    webThrottle();
    let urls;
    try { urls = await W.map(urlParam(req.body.url)); } catch (e) { throw webErr(e); }
    res.json({ count: urls.length, urls: urls.slice(0, 500) });
  }));

  app.get('/api/web/sessions', (req, res) => {
    const a = W.sessions.active;
    res.json({ active: a ? a.summary() : null, recent: W.evidence.listSessions(20) });
  });

  app.post('/api/web/sessions', wrap(async (req, res) => {
    webThrottle();
    const mode = req.body.mode === 'crawl' ? 'crawl' : 'search';
    const seed = (Array.isArray(req.body.seed) ? req.body.seed : String(req.body.seed || '').split(',')).map((x) => S.text(x, 80)).filter(Boolean);
    const url = mode === 'crawl' ? urlParam(req.body.url) : null;
    if (mode === 'search' && !seed.length) throw new HttpError(400, 'Enter what to research');
    if (mode === 'search' && !W.search.configured) throw new HttpError(503, `Web search is not configured. ${W.search.hint} (SEARCH_PROVIDER=${W.search.name}), then restart Nexus. You can still crawl a site you name.`);
    let s;
    try { s = W.sessions.start({ seed, mode, url, budget: req.body.budget && typeof req.body.budget === 'object' ? req.body.budget : {} }); } catch (e) { throw webErr(e); }
    res.status(201).json(s.summary());
  }));

  const sessionOr404 = (id) => {
    const s = W.sessions.get(id);
    if (s) return s.summary({ full: true });
    const saved = W.evidence.loadSession(id);
    if (!saved) throw new HttpError(404, 'That research session was not found');
    return saved;
  };

  app.get('/api/web/sessions/:id', (req, res) => res.json(sessionOr404(req.params.id)));

  app.get('/api/web/sessions/:id/events', (req, res) => {
    const s = W.sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'That research session is not running' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev) => res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev.type === 'log' ? ev : { type: ev.type, id: s.id, summary: s.summary() }) + '\n\n');
    send({ type: 'progress' });
    if (s.status !== 'running') { send({ type: 'done' }); return res.end(); }
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
    const fn = (ev) => { send(ev); if (ev.type === 'done') { clearInterval(beat); s.listeners.delete(fn); res.end(); } };
    s.listeners.add(fn);
    req.on('close', () => { clearInterval(beat); s.listeners.delete(fn); });
  });

  app.post('/api/web/sessions/:id/stop', (req, res) => {
    if (!W.sessions.stop(req.params.id)) return res.status(404).json({ error: 'That research session is not running' });
    res.json({ ok: true });
  });

  app.get('/api/web/review', (req, res) => {
    const status = ['open', 'accepted', 'rejected', 'separated', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ items: W.reviewList({ status }), open: W.evidence.openReviews().length });
  });

  app.post('/api/web/review/:id', wrap(async (req, res) => {
    const action = ['accept', 'reject', 'separate'].includes(req.body.action) ? req.body.action : null;
    if (!action) throw new HttpError(400, 'Choose accept, separate or reject');
    try { res.json(await W.reviewAct(req.params.id, action)); } catch (e) { throw webErr(e); }
  }));

  app.get('/api/web/domains', (req, res) => res.json(W.domains()));

  app.put('/api/web/domains', (req, res) => {
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null);
    res.json(W.setDomains({ deny: list(req.body.deny), trusted: list(req.body.trusted), unblock: req.body.unblock ? S.text(req.body.unblock, 253) : null }));
  });

  app.get('/api/web/provenance/:id', (req, res) => res.json({ facts: W.provenance(req.params.id) }));

  app.get('/api/web/sources', (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter((x) => /^s_[a-f0-9]{6,32}$/.test(x)).slice(0, 60);
    res.json({ sources: W.sources(ids) });
  });

  // ---- History and data portability -------------------------------------------------------------------
  app.post('/api/undo', wrap(async (req, res) => {
    const label = await store.undo();
    if (!label) throw new HttpError(404, 'Nothing to undo');
    res.json({ label });
  }));

  app.get('/api/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="nexus-${today()}.json"`);
    res.json(store.get());
  });

  app.post('/api/import', wrap(async (req, res) => {
    let clean;
    try { clean = S.sanitizeTree(req.body.tree); } catch (e) { throw new HttpError(400, e.message); }
    await store.mutate('Import', (t) => {
      for (const id of Object.keys(t.nodes)) delete t.nodes[id];
      Object.assign(t.nodes, clean.nodes);
    });
    res.json({ nodeCount: Object.keys(clean.nodes).length });
  }));

  // ---- Errors -------------------------------------------------------------------------------------------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to save' });
    if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Could not read the request' });
    if (err instanceof HttpError || err instanceof groq.AiError) return res.status(err.status).json({ error: err.message });
    if (/cycle|nesting|missing parent|limited to/i.test(err.message)) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Your tree was not changed.' });
  });

  return app;
}

function start() {
  const config = defaultConfig;
  const store = new Store(config.dataDir).init().migrate();
  const web = createWeb({ store, config });
  web.start();
  const app = createApp({ store, config, web });
  const server = app.listen(config.port, config.host, () => {
    console.log(`\n  Nexus is running at http://localhost:${config.port}`);
    if (config.groqKey && config.groqModel) console.log(`  AI: Groq model "${config.groqModel}" (key from ${config.groqKeyVar}, model from ${config.groqModelVar})`);
    else console.log(`  AI: not configured. Missing ${!config.groqKey ? 'GROQ_API_KEY' : ''}${!config.groqKey && !config.groqModel ? ' and ' : ''}${!config.groqModel ? 'GROQ_MODEL' : ''} in .env`);
    const ws = web.status();
    console.log(`  Research: search ${ws.search.configured ? ws.search.provider : `not configured (${ws.search.hint})`}; embeddings ${config.embedder === 'hash' ? 'feature hashing' : 'all-MiniLM-L6-v2 (loading in the background)'}`);
    for (const w of config.envWarnings || []) console.log(`  Warning: ${w}`);
    console.log(`  Data: ${config.dataDir}\n`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set PORT in .env to another number.`);
    else console.error(e);
    process.exit(1);
  });
}

if (require.main === module) start();
module.exports = { createApp, HttpError };
