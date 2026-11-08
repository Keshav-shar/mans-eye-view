'use strict';
require('./classify');
require('./tagger');
require('./relations');
const { build } = require('../strategy');
const { chunk, tokens, normalize } = require('../ml/text');
const { BM25 } = require('../ml/bm25');
const { scoreLinks } = require('./outlinks');
const { sourceId } = require('../web/evidence');
const { domainOf } = require('../web/canonical');
const { extractWithHaiku, mergeMentions } = require('./haiku');
const { TYPE_VALUE } = require('./classify');
const { compactName } = require('./tagger');

// Page Parser (low affinity): extracted page → typed, scored facts. Steps:
//   classify (value) → gate → chunk → tag mentions → extract relations → score outlinks → query seeds
// LLM fallbacks only ever see the top-k chunks for this page (BM25 against the seed and the mentions),
// after the prompt-injection guard has screened them. Rules always see the whole page.

class PageParser {
  constructor({ settings, gateway, guard, logModel = null }) {
    this.s = settings;
    this.gateway = gateway;
    this.guard = guard;
    const deps = { gateway, model: logModel };
    this.classifier = build('page_classifier', settings, deps);
    this.tagger = build('entity_tagger', settings, deps);
    this.relations = build('relation_extractor', settings, deps);
    // Haiku-first extraction (strategy "extractor"): on by default; set {"strategies":{"extractor":{"use":"rules"}}}
    // in data/config.json to go back to rules with per-task LLM fallbacks.
    this.useHaiku = ((settings.strategies || {}).extractor || {}).use !== 'rules';
  }

  // Top chunks for the LLM: relevant to the seed and to what the rules found, and screened.
  async llmChunks(chunks, query, k = 4) {
    if (!chunks.length) return [];
    const bm = new BM25();
    chunks.forEach((c, i) => bm.add(String(i), c));
    const ranked = bm.search(query, k).map((r) => chunks[Number(r.id)]);
    const pick = ranked.length ? ranked : chunks.slice(0, k);
    const screened = this.guard ? await this.guard.screen(pick) : pick.map((text) => ({ text, safe: true }));
    return screened.filter((x) => x.safe).map((x) => x.text);
  }

  // seed: { phrases: ['yashi sharma'], kind: 'person' | 'org' | 'topic' } — the research subject.
  // forced: { pageType, value } skips classification (search-result snippets).
  async parse(page, { tree = null, seedTerms = [], seed = null, forced = null, depth = 0, trust = 0.6, seenDomainPages = () => 0, followLinks = true, sameDomainOnly = true } = {}) {
    const t = this.s.thresholds;
    if (this.gateway) this.gateway.addUnits(1);
    const seedPhrases = seed ? seed.phrases : [];
    // With Haiku on, its page type replaces the classifier's own LLM fallback (value 0 keeps that gate shut).
    // Search snippets stay rules-only: they are tiny and "Name, Title at Org" lines are what the rules read best.
    const haikuOn = !forced && this.useHaiku && this.gateway && this.gateway.enabled() && this.gateway.budgetOk();
    const cls = forced ? { ...forced, conf: 1, relevance: 1, source: 'forced' } : await this.classifier.run({ page, seedTerms, seedPhrases }, { value: haikuOn ? 0 : 1 });
    let value = cls ? cls.value : 0.3;
    const base = {
      url: page.url, domain: domainOf(page.url), sourceId: sourceId(page.url), title: page.title, pageType: cls ? cls.pageType : 'other',
      value, relevance: cls ? cls.relevance : 0, classifiedBy: cls ? cls.source : 'none', contentHash: page.contentHash, simhash: page.simhash,
      noindex: Boolean(page.noindex), mentions: [], facts: [], outlinks: [], chunks: [], querySeeds: [], suggestedQueries: [], extractedBy: 'rules', aiCalls: 0,
    };
    // With the Haiku extractor available, only clearly worthless pages are dropped before it reads them;
    // its own page type and relevance then decide (rules alone misjudge person and news pages).
    if (value < (haikuOn && !forced ? Math.min(t.relevanceGate, 0.2) : t.relevanceGate)) return { ...base, dropped: true };
    page.pageType = base.pageType;

    const chunks = chunk(page.markdown, { size: this.s.vector.chunkSize, overlap: this.s.vector.chunkOverlap, max: 60 });
    base.chunks = page.noindex ? [] : chunks;
    let relevance = cls ? cls.relevance || 0 : 0;
    // Without Haiku: valuable or squarely on-topic pages get the gated per-task LLM fallbacks.
    const allowLlm = !haikuOn && !forced && (value >= t.highValue || (relevance >= 0.8 && value >= 0.5));
    const seedQ = seedTerms.join(' ');
    const memo = new Map();
    const lazyChunks = (q) => { if (!memo.has(q)) memo.set(q, this.llmChunks(chunks, q)); return memo.get(q); };

    // 1. Deterministic facts first (JSON-LD, site org, your tree, the seed, lexicons, cue patterns).
    const llmText = async (extra = '') => (await lazyChunks(`${seedQ} ${extra}`.trim())).join('\n\n');
    let mentions = await this.tagger.run({ page, tree, text: page.text, llmText, seed }, { value: allowLlm ? value : 0 });
    mentions = mentions.filter((m) => m.spans.length || m.source === 'jsonld' || m.source === 'site');
    const names = mentions.slice(0, 15).map((m) => m.text).join(' ');
    const facts = await this.relations.run({ page, mentions, llmText: () => llmText(names) }, { value: allowLlm ? value : 0 });

    // 2. Haiku reads the page (heading groups) and is checked against the page; its findings are merged in.
    const candidates = followLinks && !page.nofollow && !forced
      ? scoreLinks(page.links || [], { pageUrl: page.url, depth: depth + 1, seedTerms, trust, seenDomainPages, sameDomainOnly, max: 30 })
      : [];
    // A link whose anchor names an organisation on the page leads to that organisation: worth following
    // even off-site (the session decides), and first in line.
    const entityKeys = new Set(mentions.filter((m) => ['org', 'vc', 'school', 'person', 'product'].includes(m.type)).map((m) => compactName(m.text)).filter((k) => k.length >= 3));
    for (const c of candidates) {
      if (entityKeys.has(compactName(c.anchor))) { c.entityLink = true; c.priority = Math.min(0.9, Math.round((c.priority + 0.15) * 1000) / 1000); }
    }
    candidates.sort((a, b) => b.priority - a.priority);
    let follow = [];
    if (haikuOn) {
      const subject = seed && seed.phrases.length ? seed.phrases.join(', ') : seedTerms.join(' ');
      const hk = await extractWithHaiku({ page, gateway: this.gateway, guard: this.guard, subject, candidates, opts: this.s.extract || {} });
      if (hk) {
        const merged = mergeMentions(mentions, hk.mentions);
        mentions = merged.mentions;
        const have = new Map(facts.map((f) => [`${f.subj}|${f.rel}|${f.obj}`, f]));
        for (const f of hk.facts) {
          const s = merged.remap.get(f.subj); const o = merged.remap.get(f.obj);
          if (!s || !o || s === o) continue;
          const k = `${s}|${f.rel}|${o}`;
          if (have.has(k)) { const old = have.get(k); old.conf = Math.max(old.conf, f.conf); continue; } // rules and model agree
          const nf = { ...f, subj: s, obj: o };
          facts.push(nf);
          have.set(k, nf);
        }
        if (!forced) {
          const hv = (TYPE_VALUE[hk.pageType] ?? 0.3) * (0.45 + 0.55 * hk.relevance);
          value = Math.round((0.5 * value + 0.5 * Math.max(hv, 0.8 * hk.relevance)) * 100) / 100;
          relevance = Math.max(relevance * 0.5 + hk.relevance * 0.5, 0);
          if ((cls && cls.conf < 0.6) || base.pageType === 'other') base.pageType = hk.pageType;
        }
        follow = hk.follow;
        base.suggestedQueries = hk.queries;
        base.extractedBy = hk.extractor;
        base.aiCalls = hk.calls;
        base.haikuDropped = hk.dropped;
      }
      base.value = value;
      base.relevance = Math.round(relevance * 100) / 100;
      if (!forced && value < t.relevanceGate) return { ...base, dropped: true, mentions: [], facts: [] };
    }

    // 3. Links: the ones Haiku chose (by number), plus a few of the best heuristic ones; without Haiku,
    //    the heuristic list on valuable or on-topic pages.
    const followOk = !forced && (value >= t.highValue || (relevance >= 0.8 && value >= 0.5) || follow.length > 0);
    let outlinks = [];
    if (followOk && candidates.length) {
      const chosen = follow.map((i) => ({ ...candidates[i], priority: Math.min(0.9, candidates[i].priority + 0.25), chosenBy: 'haiku' }));
      const rest = candidates.filter((_, i) => !follow.includes(i)).slice(0, base.extractedBy === 'rules' ? 30 : 3);
      outlinks = [...chosen, ...rest];
    }

    // Names worth searching for next. Previously only conf ≥ 0.8 mentions that took part in a fact
    // qualified, so person/topic research found nothing to follow and stopped after the seed queries.
    const used = new Set(facts.flatMap((f) => [f.subj, f.obj]));
    const seedKeys = new Set(seedPhrases.map((p) => normalize(p)));
    const querySeeds = mentions
      .filter((m) => m.conf >= 0.6 && ['org', 'vc', 'person', 'product', 'school', 'event'].includes(m.type) && !seedKeys.has(m.key) && m.source !== 'seed')
      .sort((a, b) => (used.has(b.mid) - used.has(a.mid)) || (b.spans.length - a.spans.length) || (b.conf - a.conf))
      .slice(0, (this.s.extract && this.s.extract.maxQuerySeeds) || 10).map((m) => ({ text: m.text, type: m.type, weight: Math.min(1, 0.4 + 0.1 * m.spans.length + (used.has(m.mid) ? 0.2 : 0)) }));
    return { ...base, mentions, facts, outlinks, querySeeds, textForContext: page.text };
  }
}

const seedTermsOf = (seed) => [...new Set(tokens([].concat(seed).join(' ')))].slice(0, 20);

module.exports = { PageParser, seedTermsOf };
