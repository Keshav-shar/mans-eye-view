'use strict';
require('./strategies');
const { build } = require('../strategy');
const { FellegiSunter } = require('../ml/fs');
const { normalize, flat } = require('../ml/text');
const { nearDuplicate } = require('../ml/simhash');
const { titleKey, sharesIdentifier, GLOBAL_DEDUPE } = require('../ops');
const { RELATIONS, TYPE_MAP, relationAllowed } = require('../parse/lexicon');
const { sentenceSpans } = require('../parse/relations');
const S = require('../schema');

// Graph Builder (high affinity). Turns a parsed page into Nexus operations; lib/ops.js runOps stays the
// ONLY code that writes the tree. Per mention:
//   1. strong identifier shared with a node            → merge (decided_by: identifier)
//   2. same entity already created earlier in this batch → reuse its ref
//   3. block: exact name/alias + BM25 + dense (RRF) of compatible types; score with Fellegi-Sunter
//   4. p ≥ τhigh → merge;  band → adjudicator if enabled, else review queue;  else create or drop
// Policy "auto" (research sessions) commits only high-confidence results; "preview" (one-off scrape)
// returns everything for the existing preview screen, where you untick what you do not want.

const COMPAT = {
  org: ['company', 'vc'], vc: ['vc', 'company'], person: ['person', 'hr', 'recruiter', 'mentor'],
  product: ['product', 'project', 'tech'], tech: ['tech', 'skill', 'product'], concept: ['concept', 'field', 'skill', 'idea'], skill: ['skill', 'tech'],
  place: ['place'], sector: ['field', 'concept'], school: ['school', 'university', 'company'], event: ['event'],
};
const ORDER = { org: 0, vc: 0, school: 1, product: 1, tech: 2, place: 2, sector: 3, concept: 3, skill: 3, event: 4, person: 5 };
const CONTACT_KINDS = new Set(['phone', 'email', 'address']);
// Sources good enough to save a mentioned-only entity (the model or structure said it is a real name).
const MENTION_SOURCES = new Set(['haiku', 'jsonld', 'gazetteer', 'cue', 'title-line', 'site', 'seed', 'llm']);
// Extracted attributes → named fields. Fields can repeat only for keys listed in MULTI.
const ATTR_FIELDS = [
  ['founded', 'Founded'], ['hq', 'HQ'], ['sector', 'Sector'], ['employees', 'Employees'], ['funding_total', 'Total funding'], ['aum', 'AUM'],
  ['stage', 'Stage'], ['status', 'Status'], ['stage_focus', 'Stage focus'], ['sector_focus', 'Sector focus'], ['fund_size', 'Fund size'],
  ['location', 'Location'], ['education', 'Education'], ['category', 'Category'], ['launched', 'Launched'], ['license', 'License'],
  ['date', 'Date'], ['amount', 'Amount'], ['round', 'Round'], ['description', 'Description'],
];
const MULTI = new Set(['past role', 'hiring']);

// The page's main entity: the site's own organisation, else JSON-LD, else the organisation named in the
// title, else the research subject, else the most-mentioned organisation.
function primaryMention(page, mentions) {
  const orgs = mentions.filter((m) => ['org', 'vc', 'school'].includes(m.type));
  const title = normalize(page.title || '');
  return mentions.find((m) => m.attrs && m.attrs.isSite)
    || orgs.find((m) => m.source === 'jsonld')
    || orgs.filter((m) => m.key && m.key.length >= 3 && title.includes(m.key)).sort((a, b) => b.key.length - a.key.length)[0]
    || mentions.find((m) => m.source === 'seed')
    || orgs.slice().sort((a, b) => b.spans.length - a.spans.length).find((m) => m.spans.length >= 2)
    || null;
}

const edgeKey = (sType, sText, rel, oType, oText) => `${sType}|${normalize(sText)}|${rel}|${oType}|${normalize(oText)}`;

class GraphBuilder {
  constructor({ settings, retrieval, evidence, embedder, gateway = null, scorer = null, db = null }) {
    // Learned site trust (lib/store/db.js); without a store, fixed defaults by tier.
    this.db = db || { trust: (d, tier) => ({ trusted: 0.9, site: 0.9 }[tier] || 0.6), adjustTrust() {} };
    this.s = settings;
    this.retrieval = retrieval;
    this.evidence = evidence;
    this.embedder = embedder;
    this.gateway = gateway;
    this.scorer = scorer || new FellegiSunter();
    const deps = { gateway, embedder, retrieval };
    this.describer = build('describer', settings, deps);
    this.adjudicator = build('adjudicator', settings, deps);
    this.verifier = build('edge_verifier', settings, deps);
    this.refN = 0;
  }

  newBatch() {
    return { ops: [], pending: new Map(), refInfo: new Map(), review: [], touched: new Set(), edgeKeys: [], log: [], prov: [], pages: 0, stats: { merged: 0, created: 0, edges: 0, queued: 0, dropped: 0, adjudicated: 0 } };
  }

  areaId(tree, title) {
    const n = Object.values(tree.nodes).find((x) => !x.parentId && x.type === 'area' && x.title.toLowerCase() === title.toLowerCase());
    return n ? n.id : null;
  }

  card(node, tree) {
    const parent = node.parentId && tree.nodes[node.parentId];
    const ids = Object.entries(node.identifiers || {}).map(([k, v]) => `${k}:${v}`).join(', ');
    return `${node.title} (${node.type}${parent ? `, in ${parent.title}` : ''})${node.summary ? ` — ${node.summary.slice(0, 160)}` : ''}${ids ? ` [${ids}]` : ''}`;
  }

  neighbourTitles(tree, node) {
    const out = new Set();
    const p = node.parentId && tree.nodes[node.parentId];
    if (p && p.type !== 'area') out.add(normalize(p.title));
    for (const l of node.links || []) if (tree.nodes[l.to]) out.add(normalize(tree.nodes[l.to].title));
    for (const n of Object.values(tree.nodes)) if (n.parentId === node.id) out.add(normalize(n.title));
    return out;
  }

  // → { kind: 'node'|'ref'|'queue'|'new', id?, ref?, p, by, best?, candidates? }
  async resolve(tree, m, page, batch, ctx) {
    const map = TYPE_MAP[m.type];
    const types = COMPAT[m.type] || [map.type];
    const nodes = Object.values(tree.nodes);

    // 1. identifiers
    if (Object.keys(m.ids).length) {
      const hit = nodes.find((n) => types.includes(n.type) && sharesIdentifier(n, m.ids));
      if (hit) return { kind: 'node', id: hit.id, p: 1, by: 'identifier' };
    }
    // 2. created earlier in this batch
    const pkey = `${map.type}|${titleKey(m.text, map.type)}`;
    if (batch.pending.has(pkey)) return { kind: 'ref', ref: batch.pending.get(pkey), p: 1, by: 'batch' };
    for (const [ref, info] of batch.refInfo) {
      if (Object.keys(m.ids).length && types.includes(info.type) && Object.entries(m.ids).some(([ns, v]) => info.ids[ns] === v)) return { kind: 'ref', ref, p: 1, by: 'batch-identifier' };
    }

    // 3. blocking + scoring
    const key = titleKey(m.text, map.type);
    const exact = nodes.filter((n) => types.includes(n.type) && (titleKey(n.title, n.type) === key || (n.aliases || []).some((a) => titleKey(a, n.type) === key))).map((n) => n.id);
    const ctxText = `${m.text} . ${map.type} . ${m.attrs.title || ''} ${ctx.sentenceOf(m) || ''}`.slice(0, 600);
    let cand = { ids: [], cos: new Map(), vec: null };
    try { cand = await this.retrieval.candidates(tree, ctxText, types, { k: 20 }); } catch { /* retrieval unavailable: exact only */ }
    const ids = [...new Set([...exact, ...cand.ids])].slice(0, 20);
    const pageNbrs = ctx.neighboursOf(m);
    const scored = [];
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      let embCos = cand.cos.get(id);
      if (embCos == null && cand.vec) { const v = this.retrieval.nodeVector(id); if (v) embCos = require('../ml/text').cosine(v, cand.vec); }
      const srcDomains = (node.sources || []).map((sid) => { const s = this.evidence.getSource(sid); return s && s.domain; }).filter(Boolean);
      const domainMatch = node.identifiers && node.identifiers.domain && m.ids.domain ? node.identifiers.domain === m.ids.domain
        : srcDomains.length ? srcDomains.includes(page.domain) : null;
      scored.push(this.scorer.score({ text: m.text, ids: m.ids, attrs: m.attrs }, node, { embCos, pageNeighbours: pageNbrs, nodeNeighbours: this.neighbourTitles(tree, node), domainMatch }));
    }
    const live = scored.filter((r) => !r.veto).sort((a, b) => b.p - a.p);
    const best = live[0];
    const t = this.s.thresholds;
    if (best && best.p >= t.tauHigh) return { kind: 'node', id: best.nodeId, p: best.p, by: 'formula', best };
    // Same exact name and same type for a globally unique type (company, vc, tech, product, skill…):
    // lib/ops.js would merge these anyway, so the builder agrees instead of asking. People are excluded,
    // because two "Priya Shah"s are common.
    if (best && best.levels.name === 'exact' && tree.nodes[best.nodeId].type === map.type && GLOBAL_DEDUPE.has(map.type)) {
      return { kind: 'node', id: best.nodeId, p: Math.max(best.p, t.tauHigh), by: 'exact-name', best };
    }
    if (best && best.p >= t.bandLow) {
      const band = live.filter((r) => r.p >= t.bandLow).slice(0, 3);
      if (this.adjudicator && this.gateway && this.gateway.budgetOk()) {
        const d = await this.adjudicator.run({ mention: `${m.text} (${m.type}) on ${page.url}: ${ctx.sentenceOf(m) || ''}`, candidates: band.map((r) => ({ nodeId: r.nodeId, card: this.card(tree.nodes[r.nodeId], tree) })) });
        if (d) {
          batch.stats.adjudicated++;
          // Vetoes already removed conflicting identifiers, so an adjudicated merge can never override them.
          if (d.action === 'merge') return { kind: 'node', id: d.nodeId, p: best.p, by: 'adjudicator', best };
          return { kind: 'new', p: best.p, by: 'adjudicator', best };
        }
      }
      return { kind: 'queue', p: best.p, by: 'band', best, candidates: band };
    }
    return { kind: 'new', p: best ? best.p : 0, by: 'formula', best };
  }

  parentFor(tree, m, resolved, mentionsByMid, facts) {
    if (m.type === 'person') {
      const w = facts.find((f) => f.subj === m.mid && f.rel === 'works_at' && resolved.get(f.obj))
        || facts.find((f) => f.subj === m.mid && f.rel === 'founded' && resolved.get(f.obj) && ['company', 'vc'].includes(resolved.get(f.obj).type));
      const org = w && resolved.get(w.obj);
      if (org && (org.id || org.ref)) return org.id || org.ref;
    }
    return this.areaId(tree, TYPE_MAP[m.type].area);
  }

  fieldsFor(m, { forPerson = false } = {}) {
    const f = [];
    if (m.ids.domain && !forPerson) f.push({ key: 'Website', value: `https://${m.ids.domain}`, kind: 'url' });
    if (m.attrs.title && forPerson) f.push({ key: 'Title', value: m.attrs.title, kind: 'text' });
    for (const e of m.attrs.emails || []) if (!forPerson) f.push({ key: 'Email', value: e, kind: 'email' });
    for (const h of m.attrs.hiring || []) f.push({ key: 'Hiring', value: h, kind: 'text' });
    if (m.attrs.address && !forPerson) f.push({ key: 'Address', value: S.text(m.attrs.address, 200), kind: 'address' });
    for (const [a, key] of ATTR_FIELDS) {
      const v = m.attrs[a];
      if (v == null || v === '') continue;
      if (forPerson && !['location', 'education'].includes(a)) continue;
      const value = S.text(String(v), a === 'description' ? 240 : 120);
      if (value) f.push({ key, value, kind: a === 'employees' && /^\d+$/.test(value.replace(/,/g, '')) ? 'number' : 'text' });
    }
    for (const t of m.attrs.pastTitles || []) if (forPerson) f.push({ key: 'Past role', value: S.text(t, 120), kind: 'text' });
    // Privacy: contact details about people from the web are never written automatically.
    return forPerson ? f.filter((x) => !CONTACT_KINDS.has(x.kind)) : f;
  }

  // Plans one page into the batch. Returns per-page stats.
  async planPage(tree, page, batch, { policy = 'auto', sessionId = null } = {}) {
    const t = this.s.thresholds;
    const stats = { merged: 0, created: 0, edges: 0, queued: 0, dropped: 0 };
    batch.pages++;
    const mentionsByMid = new Map(page.mentions.map((m) => [m.mid, m]));
    const sents = sentenceSpans(page.textForContext || '');
    const ctx = {
      sentenceOf: (m) => { const s = m.spans[0] && sents.find((x) => m.spans[0][0] >= x.start && m.spans[0][0] < x.end); return s ? s.text : ''; },
      neighboursOf: (m) => new Set(page.facts.filter((f) => f.subj === m.mid || f.obj === m.mid).map((f) => mentionsByMid.get(f.subj === m.mid ? f.obj : f.subj)).filter(Boolean).map((x) => normalize(x.text))),
    };
    const hasFact = (m, min = 0.6) => page.facts.some((f) => (f.subj === m.mid || f.obj === m.mid) && f.conf >= min);
    // A product/tech/concept spelled exactly like an organisation ("Qdrant" the engine vs Qdrant the
    // company) is folded into the organisation instead of becoming a twin node.
    const pageOrgs = page.mentions.filter((m) => m.type === 'org' || m.type === 'vc');
    const treeOrgs = Object.values(tree.nodes).filter((n) => n.type === 'company' || n.type === 'vc');
    const orgKeys = new Set([...pageOrgs.map((m) => normalize(m.text)), ...treeOrgs.map((n) => normalize(n.title))]);
    // A "person" spelled exactly like an organisation on this page or in your tree ("Two Sigma") is that
    // organisation: the page's facts are re-pointed at the org mention and the person mention is dropped.
    const remap = new Map();
    for (const m of page.mentions) {
      if (m.type !== 'person' || m.source === 'jsonld' || !orgKeys.has(normalize(m.text))) continue;
      const org = pageOrgs.find((o) => normalize(o.text) === normalize(m.text));
      if (org) { remap.set(m.mid, org.mid); m.type = '_folded'; continue; }
      const node = treeOrgs.find((n) => normalize(n.title) === normalize(m.text));
      m.type = node && node.type === 'vc' ? 'vc' : 'org';
      delete m.attrs.worksFor; delete m.attrs.title;
    }
    if (remap.size) {
      for (const f of page.facts) { if (remap.has(f.subj)) f.subj = remap.get(f.subj); if (remap.has(f.obj)) f.obj = remap.get(f.obj); }
      page.facts = page.facts.filter((f) => { const s = mentionsByMid.get(f.subj); const o = mentionsByMid.get(f.obj); return s && o && f.subj !== f.obj && relationAllowed(f.rel, s.type, o.type); });
    }
    const primary = primaryMention(page, page.mentions.filter((m) => TYPE_MAP[m.type] && m.conf >= 0.6));
    const mentions = page.mentions.filter((m) => TYPE_MAP[m.type] && m.conf >= 0.6 && !(['product', 'tech', 'concept'].includes(m.type) && orgKeys.has(normalize(m.text))))
      .sort((a, b) => ((b === primary) - (a === primary)) || (ORDER[a.type] - ORDER[b.type]) || (Object.keys(b.ids).length - Object.keys(a.ids).length) || (b.conf - a.conf));
    const resolved = new Map(); // mid → { id } | { ref }
    const queued = new Map(); // mid → resolution
    const sentencesFor = (m) => sents.filter((s) => m.spans.some(([a]) => a >= s.start && a < s.end)).map((s) => s.text);
    // Entities named on the page without a stated relation: saved and linked "mentioned with" from the
    // page's main entity (best first, capped), so a page adds every real name it holds, not one or two.
    const ex = this.s.extract || {};
    const lexOnly = (m) => ['lexicon', 'suffix'].includes(m.source);
    const mentionedOk = new Set(
      (ex.autoMentioned && policy === 'auto' && primary && page.value >= t.relevanceGate ? mentions : [])
        .filter((m) => m !== primary && !hasFact(m) && m.conf >= (t.autoMentionConf ?? 0.75)
          && (MENTION_SOURCES.has(m.source) || m.ids.domain || (m.source === 'lexicon' && m.spans.length >= 2)))
        .sort((a, b) => (b.spans.length - a.spans.length) || (b.conf - a.conf))
        .slice(0, ex.maxMentionedPerPage ?? 25)
        .map((m) => m.mid),
    );
    const linkFromPrimary = (m, target) => {
      const p = primary && resolved.get(primary.mid);
      if (!p || (p.id || p.ref) === target) return false;
      const trust = this.db.trust(page.domain, page.tier || 'open');
      batch.ops.push({ op: 'update', id: p.id || p.ref, links: [{ to: target, relation: RELATIONS.mentioned_with.label, conf: Math.round(m.conf * trust * 100) / 100, status: 'single', n: 1 }] });
      return true;
    };
    const homes = []; // organisations with their own site, for the session to crawl

    for (const m of mentions) {
      const r = await this.resolve(tree, m, page, batch, ctx);
      const map = TYPE_MAP[m.type];
      batch.log.push({ mention: m.text, type: m.type, url: page.url, decision: r.kind, p: r.p, by: r.by, nodeId: r.id || null, levels: r.best ? r.best.levels : null });
      if (r.kind === 'node') {
        const node = tree.nodes[r.id];
        const op = { op: 'update', id: r.id, sources: [page.sourceId] };
        if (normalize(m.text) !== normalize(node.title)) op.aliases = [m.text];
        if (Object.keys(m.ids).length) op.identifiers = m.ids;
        const fields = this.fieldsFor(m, { forPerson: m.type === 'person' }).filter((f) => !node.fields.some((x) => x.key.toLowerCase() === f.key.toLowerCase() && (!MULTI.has(f.key.toLowerCase()) || x.value === f.value)));
        if (fields.length) op.fields = fields;
        if (!node.summary) { const d = await this.describer.run({ sentences: sentencesFor(m), name: node.title, type: node.type }); if (d) op.summary = d; }
        batch.ops.push(op);
        resolved.set(m.mid, { id: r.id, type: node.type, title: node.title });
        batch.prov.push({ kind: 'node', nodeId: r.id, factKey: `node|${m.type}|${normalize(m.text)}`, sourceId: page.sourceId, url: page.url, domain: page.domain, snippet: ctx.sentenceOf(m) || m.text, extractor: m.source === 'haiku' ? page.extractedBy : `rules:${m.source}` });
        batch.touched.add(r.id);
        stats.merged++;
        if (mentionedOk.has(m.mid) && linkFromPrimary(m, r.id)) stats.mentioned = (stats.mentioned || 0) + 1;
        if (m.ids.domain && ['org', 'vc', 'school'].includes(m.type)) homes.push({ domain: m.ids.domain, name: node.title });
        continue;
      }
      if (r.kind === 'ref') {
        resolved.set(m.mid, { ref: r.ref, type: batch.refInfo.get(r.ref).type, title: batch.refInfo.get(r.ref).title });
        batch.ops.push({ op: 'update', id: r.ref, sources: [page.sourceId] });
        if (mentionedOk.has(m.mid)) linkFromPrimary(m, r.ref);
        continue;
      }
      if (r.kind === 'queue') { queued.set(m.mid, r); continue; }
      // New entity: create only when confident, on a valuable page, and connected or identified.
      // No orphans: an automatic create needs a strong identifier, a fact strong enough to be linked
      // automatically too, or (mentioned-only entities) the page's main entity to hang it from.
      const strong = m.conf >= t.autoCreateConf && page.value >= t.autoCreateValue && (hasFact(m, t.autoEdgeConf) || Object.keys(m.ids).length > 0);
      // A name linked to its own site (ids.domain from the anchor) is not a lexicon guess.
      const lexiconOnly = lexOnly(m) && !hasFact(m, 0.7) && !m.ids.domain;
      const mentionedOnly = !strong && mentionedOk.has(m.mid) && primary && resolved.has(primary.mid);
      const allow = policy === 'preview' ? (m.conf >= 0.6 && (hasFact(m) || Object.keys(m.ids).length > 0)) : (strong && !lexiconOnly) || mentionedOnly;
      if (!allow) {
        if (policy === 'auto' && page.value >= t.highValue && hasFact(m) && m.conf >= 0.6 && !lexiconOnly) queued.set(m.mid, { kind: 'create', p: r.p });
        else stats.dropped++;
        continue;
      }
      const ref = `w${++this.refN}`;
      const parent = this.parentFor(tree, m, resolved, mentionsByMid, page.facts);
      const summary = (await this.describer.run({ sentences: sentencesFor(m), name: m.text, type: map.type })) || (m.attrs.description ? S.text(m.attrs.description, 300) : '');
      batch.ops.push({
        op: 'create', ref, parent, type: map.type, title: m.text, summary, tags: ['web'],
        fields: this.fieldsFor(m, { forPerson: m.type === 'person' }), identifiers: m.ids, sources: [page.sourceId],
      });
      batch.pending.set(`${map.type}|${titleKey(m.text, map.type)}`, ref);
      batch.refInfo.set(ref, { type: map.type, title: m.text, ids: m.ids });
      resolved.set(m.mid, { ref, type: map.type, title: m.text });
      batch.prov.push({ kind: 'node', nodeId: ref, factKey: `node|${m.type}|${normalize(m.text)}`, sourceId: page.sourceId, url: page.url, domain: page.domain, snippet: ctx.sentenceOf(m) || m.text, extractor: m.source === 'haiku' ? page.extractedBy : `rules:${m.source}` });
      batch.touched.add(ref);
      stats.created++;
      if (mentionedOk.has(m.mid) && linkFromPrimary(m, ref)) stats.mentioned = (stats.mentioned || 0) + 1;
      if (m.ids.domain && ['org', 'vc', 'school'].includes(m.type)) homes.push({ domain: m.ids.domain, name: m.text });
    }

    // Edges, with distinct-origin evidence.
    for (const f of page.facts) {
      const sm = mentionsByMid.get(f.subj); const om = mentionsByMid.get(f.obj);
      const s = resolved.get(f.subj); const o = resolved.get(f.obj);
      if (!sm || !om || !s || !o) continue;
      if ((s.id || s.ref) === (o.id || o.ref) || normalize(sm.text) === normalize(om.text)) continue; // "Qdrant builds Qdrant"
      const label = RELATIONS[f.rel].label;
      const k = edgeKey(sm.type, sm.text, f.rel, om.type, om.text);
      const ev = this.evidence.addEdgeEvidence(k, { domain: page.domain, simhash: page.simhash, sourceId: page.sourceId }, nearDuplicate);
      const rec = this.evidence.edges[k];
      // Two noisy-ORs over distinct origins only: `raw` (extraction confidence) decides whether the edge
      // is written automatically; `conf` (weighted by each site's learned trust) is what is stored.
      const trust = this.db.trust(page.domain, page.tier || 'open');
      rec.raw = ev.added ? 1 - (1 - (rec.raw || 0)) * (1 - f.conf) : Math.max(rec.raw || 0, f.conf);
      rec.conf = ev.added ? 1 - (1 - (rec.conf || 0)) * (1 - f.conf * trust) : Math.max(rec.conf || 0, f.conf * trust);
      if (ev.added && ev.n >= 2) for (const d of new Set(this.evidence.edgeOrigins(k).map((x) => x.domain))) this.db.adjustTrust(d, 0.02); // corroborated
      const conf = Math.round(rec.conf * 100) / 100;
      // Confirmed only with ≥ 2 independent sites, or one trusted site; otherwise "single" (shown fainter).
      const status = ev.n >= 2 || trust >= 0.9 ? 'confirmed' : 'single';
      const link = { to: o.id || o.ref, relation: label, conf, status, n: ev.n };
      const subject = s.id || s.ref;
      const ok = policy === 'preview' ? f.conf >= 0.6 : rec.raw >= t.autoEdgeConf;
      if (ok || policy === 'auto') batch.prov.push({ kind: 'edge', nodeId: subject, factKey: k, sourceId: page.sourceId, url: page.url, domain: page.domain, snippet: f.snippet, extractor: f.source === 'haiku' ? page.extractedBy : `rules:${f.source || 'rules'}` });
      if (ok) {
        batch.ops.push({ op: 'update', id: subject, links: [link] });
        batch.edgeKeys.push(k);
        stats.edges++;
      } else if (policy === 'auto' && f.conf >= 0.6) {
        this.queue(batch, {
          kind: 'edge', key: `edge|${k}`, title: `${s.title} ${label} ${o.title}`, p: conf, url: page.url, snippet: f.snippet, sessionId,
          ops: [{ op: 'update', id: subject, links: [link] }],
        });
        stats.queued++;
      }
    }

    // Ambiguous mentions and uncertain creates → review queue, with the facts that hang off them.
    for (const [mid, r] of queued) {
      const m = mentionsByMid.get(mid);
      const map = TYPE_MAP[m.type];
      const factsOf = page.facts.filter((f) => (f.subj === mid && resolved.get(f.obj)) || (f.obj === mid && resolved.get(f.subj)));
      const linkOps = (selfRef) => {
        const own = []; const others = [];
        for (const f of factsOf) {
          const label = RELATIONS[f.rel].label;
          if (f.subj === mid) { const o = resolved.get(f.obj); own.push({ to: o.id || o.ref, relation: label, conf: f.conf, status: 'confirmed', n: 1 }); } else { const s = resolved.get(f.subj); others.push({ op: 'update', id: s.id || s.ref, links: [{ to: selfRef, relation: label, conf: f.conf, status: 'confirmed', n: 1 }] }); }
        }
        return { own, others };
      };
      const parent = this.parentFor(tree, m, resolved, mentionsByMid, page.facts);
      const createRef = `q${++this.refN}`;
      const c = linkOps(createRef);
      const createOps = [{ op: 'create', ref: createRef, parent, type: map.type, title: m.text, tags: ['web'], fields: this.fieldsFor(m, { forPerson: m.type === 'person' }), identifiers: m.ids, sources: [page.sourceId], links: c.own }, ...c.others];
      if (r.kind === 'queue') {
        const top = r.candidates[0];
        const node = tree.nodes[top.nodeId];
        const mm = linkOps(top.nodeId);
        this.queue(batch, {
          kind: 'merge', key: `merge|${m.type}|${normalize(m.text)}|${top.nodeId}`, sessionId, url: page.url, p: Math.round(top.p * 100) / 100,
          title: `Is "${m.text}" (${map.type}) the same as your ${node.type} "${node.title}"?`, mention: { text: m.text, type: m.type, context: ctx.sentenceOf(m) },
          candidate: { id: node.id, title: node.title, type: node.type, card: this.card(node, tree) }, levels: top.levels,
          ops: [{ op: 'update', id: top.nodeId, sources: [page.sourceId], aliases: normalize(m.text) !== normalize(node.title) ? [m.text] : [], links: mm.own }, ...mm.others],
          altOps: createOps,
        });
      } else {
        this.queue(batch, { kind: 'create', key: `create|${m.type}|${normalize(m.text)}`, sessionId, url: page.url, p: Math.round(m.conf * 100) / 100, title: `Add ${map.type} "${m.text}"?`, mention: { text: m.text, type: m.type, context: ctx.sentenceOf(m) }, ops: createOps });
      }
      stats.queued++;
    }
    for (const k of Object.keys(stats)) batch.stats[k] = (batch.stats[k] || 0) + stats[k];
    stats.homes = homes;
    return stats;
  }

  queue(batch, item) { batch.review.push(item); }
}

// Folds the many small ops a batch produces into one op per target: updates aimed at a node created
// earlier in the same list merge into its create; repeated updates to one node merge together.
// Keeps previews readable and keeps commits well under runOps' per-call limits.
function compactOps(ops) {
  const out = [];
  const byTarget = new Map();
  const mergeInto = (dst, src) => {
    for (const k of ['sources', 'aliases', 'tags']) if (src[k] && src[k].length) dst[k] = [...new Set([...(dst[k] || []), ...src[k]])];
    if (src.links && src.links.length) {
      dst.links = dst.links || [];
      for (const l of src.links) {
        const same = dst.links.find((x) => x.to === l.to && x.relation === l.relation);
        if (!same) dst.links.push(l);
        else { same.conf = Math.max(same.conf || 0, l.conf || 0); same.n = Math.max(same.n || 0, l.n || 0); }
      }
    }
    if (src.fields && src.fields.length) { dst.fields = dst.fields || []; for (const f of src.fields) if (!dst.fields.some((x) => x.key === f.key && x.value === f.value)) dst.fields.push(f); }
    if (src.identifiers) dst.identifiers = { ...src.identifiers, ...(dst.identifiers || {}) };
    if (src.summary && !dst.summary) dst.summary = src.summary;
  };
  // Pass 1: fold non-link parts of updates into an earlier create of the same ref (always safe), and
  // collect each target's remaining update content plus the index of its LAST update, so a link is never
  // moved in front of the create of the node it points to.
  const updates = new Map(); // target → { op, last }
  const createdAt = new Map(); // ref → index of its create
  ops.forEach((op, i) => { if (op.op === 'create' && op.ref) createdAt.set(op.ref, i); });
  ops.forEach((op, i) => {
    if (op.op === 'create') { if (op.ref) byTarget.set(op.ref, { ...op }); return; }
    if (op.op !== 'update') return;
    const { links = [], ...rest } = op;
    let later = links;
    if (byTarget.has(op.id)) {
      // A link can live on the create itself when its target already exists at that point.
      const here = createdAt.get(op.id);
      const early = links.filter((l) => !createdAt.has(l.to) || createdAt.get(l.to) < here);
      later = links.filter((l) => !early.includes(l));
      mergeInto(byTarget.get(op.id), { ...rest, links: early });
    }
    const hasMore = later.length || !byTarget.has(op.id);
    if (!hasMore) return;
    const u = updates.get(op.id) || { op: { op: 'update', id: op.id }, last: i };
    mergeInto(u.op, byTarget.has(op.id) ? { links: later } : { ...op, links: later });
    u.last = i;
    updates.set(op.id, u);
  });
  // Pass 2: emit creates in place and each merged update at its last position.
  const lastAt = new Map([...updates.values()].map((u) => [u.last, u.op]));
  ops.forEach((op, i) => {
    if (op.op === 'create') out.push(op.ref ? byTarget.get(op.ref) : op);
    else if (op.op !== 'update') out.push(op);
    if (lastAt.has(i)) out.push(lastAt.get(i));
  });
  return out;
}

module.exports = { GraphBuilder, COMPAT, edgeKey, compactOps, flat, primaryMention };
