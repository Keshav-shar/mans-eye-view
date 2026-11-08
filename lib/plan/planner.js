'use strict';
const { register, build } = require('../strategy');
const { UCB1 } = require('../ml/rank');
const { tokens, jaccard, cosine, normalize } = require('../ml/text');
const { ORG_SUFFIX, VC_WORDS, TECH, CONCEPTS } = require('../parse/lexicon');

// Query Planner (mid affinity): which searches to run next.
//   seed kind  — the seed is read as a person ("yashi sharma"), an organisation ("Qdrant") or a topic
//                ("diwali startups"); each kind has its own templates
//   candidates — templates for the seed, then for entities the session keeps finding on pages (weighted
//                by how many pages mention them), then LLM proposals once the queue runs dry
//   de-dup     — against every query already issued: exact, or cosine > .9 AND token-Jaccard > .6
//   choose     — UCB1 over arms "<kind>:<template>", rewarded by new facts per page; ties go to priority

const TEMPLATES = {
  'seed-person': [['plain', '{n}'], ['profile', '{n} profile'], ['interview', '{n} interview'], ['articles', '{n} author articles'], ['role', '{n} company role'], ['github', '{n} github']],
  'seed-topic': [['plain', '{n}'], ['news', '{n} news'], ['companies', '{n} list of companies'], ['founders', '{n} founders'], ['funding', '{n} funding'], ['report', '{n} report'], ['india', '{n} India']],
  'seed-org': [['plain', '{n}'], ['about', '{n} company about'], ['team', '{n} team leadership'], ['news', '{n} funding news'], ['careers', '{n} careers jobs'], ['eng', '{n} engineering blog tech stack']],
  org: [['investors', '{n} investors funding round'], ['careers', '{n} careers engineering jobs'], ['eng', '{n} engineering blog tech stack'], ['founders', '{n} founders']],
  vc: [['portfolio', '{n} portfolio companies'], ['team', '{n} partners team']],
  person: [['role', '{n} {org}'], ['talks', '{n} interview talk']],
  product: [['maker', '{n} company'], ['alts', '{n} alternatives']],
  tech: [['usedby', 'companies using {n}'], ['alts', '{n} alternatives comparison']],
  concept: [['overview', '{n} overview'], ['fields', '{n} techniques tools']],
  skill: [['learn', '{n} learning roadmap']],
};

const TOPIC_WORDS = new Set(('startup startups company companies funding news jobs market markets industry trends report ai ml tech technology '
  + 'software tools platform platforms ecosystem india indian list best top guide course courses salary salaries hiring internship internships '
  + 'database databases engineering design marketing finance fintech healthcare education crypto blockchain cloud data security').split(' '));
const LEXICON = new Set([...TECH, ...CONCEPTS].map((x) => normalize(x)));

// person | org | topic, from the words alone (the user may type in lower case).
function seedKind(text) {
  const raw = String(text || '').trim();
  const n = normalize(raw);
  const words = n.split(' ').filter(Boolean);
  if (!words.length) return 'topic';
  const concepts = new Set(CONCEPTS.map((x) => normalize(x)));
  if (words.length === 1) return concepts.has(n) || TOPIC_WORDS.has(n) ? 'topic' : 'org'; // "Qdrant", "Razorpay"
  const lastRaw = raw.split(/\s+/).pop();
  if (words.length <= 5 && (ORG_SUFFIX.test(lastRaw) || VC_WORDS.test(lastRaw)) && !TOPIC_WORDS.has(words[words.length - 1])) return 'org'; // "Peak XV Partners"
  if (LEXICON.has(n) || LEXICON.has(n.replace(/s$/, '')) || words.some((w) => TOPIC_WORDS.has(w)) || /\d/.test(n)) return 'topic';
  const last = words[words.length - 1];
  if (last.length > 5 && /[^s]s$/.test(last)) return 'topic'; // plural noun phrase
  if (words.length <= 3 && words.every((w) => /^[\p{L}'’.-]{2,20}$/u.test(w))) return 'person';
  return 'topic';
}

register('query_generator', 'templates', () => ({
  async run({ entity }) {
    const list = TEMPLATES[entity.type] || TEMPLATES.concept;
    return list.map(([arm, tpl]) => ({ q: tpl.replace('{n}', entity.text).replace('{org}', entity.org || '').replace(/\s+/g, ' ').trim(), arm: `${entity.type}:${arm}` }))
      .filter((x) => !x.q.includes('{')); // repeats (e.g. "{n} {org}" without an org) are dropped by de-dup
  },
}));

register('query_generator', 'llm', ({ gateway }) => ({
  async run({ entity, avoid }) {
    const out = await gateway.run('gen_queries', { name: entity.text, type: entity.type.replace(/^seed-/, ''), summary: entity.context || '', avoid }, { maxTokens: 400 });
    return out ? out.queries.filter((q) => q.length >= 3).map((q) => ({ q, arm: `${entity.type}:llm` })) : [];
  },
}));

const KEYED = (list) => list.map((x) => (typeof x === 'string' ? { q: x, arm: 'llm' } : x));
const MAX_ENTITIES = 30;
const MAX_LLM_ROUNDS = 3;

const URLISH = /https?:|www\.|[a-z0-9-]+\.[a-z]{2,}\//i;

class Planner {
  constructor({ settings, embedder, gateway = null, bandit = null }) {
    this.s = settings;
    this.embedder = embedder;
    this.gateway = gateway;
    this.gen = build('query_generator', settings, { gateway });
    this.llmGen = gateway ? build('query_generator', { strategies: { query_generator: { use: 'llm' } } }, { gateway }) : null;
    this.sonnet = Boolean(gateway) && (((settings.strategies || {}).query_planner || {}).use || 'sonnet') === 'sonnet';
    this.llmRounds = 0;
    this.bandit = bandit || new UCB1();
    this.entities = []; // { key, text, type, priority, seen, org?, expanded, branch }
    this.queue = []; // { q, arm, priority, source, branch }
    this.past = []; // { q, toks, vec }
    this.branches = []; // { id, q, arm, pages, facts, rSum, dropped }
    this.pages = []; // recent { title, type, facts } for the planner's "found so far"
    this.subject = ''; this.kind = 'topic';
    this.sonnetCalls = 0; this.sonnetFailures = 0;
  }

  // ---- branches: every issued query roots one; pages found through it report back -----------------
  openBranch(q) {
    const b = { id: this.branches.length, q: q.q, arm: q.arm, pages: 0, facts: 0, rSum: 0, dropped: false };
    this.branches.push(b);
    return b.id;
  }

  branchPage(id, { facts = 0, r = 0, title = '', type = '' } = {}) {
    const b = this.branches[id];
    if (b) { b.pages++; b.facts += facts; b.rSum += r; const y = Math.min(1, facts / 5); this.bandit.update(`branch:${id}`, y); if (b.arm) this.bandit.update(b.arm, y); }
    this.pages.push({ title: String(title).slice(0, 90), type, facts });
    if (this.pages.length > 12) this.pages.shift();
  }

  isDropped(id) { return id != null && this.branches[id] && this.branches[id].dropped; }

  // Searches the small model suggested while reading a page of branch `branch`.
  addSuggestions(queries, { branch = null, priority = 0.6 } = {}) {
    for (const q of queries || []) {
      if (!q || URLISH.test(q) || this.queue.some((c) => normalize(c.q) === normalize(q))) continue;
      this.queue.push({ q, arm: branch == null ? 'haiku' : `branch:${branch}`, priority, source: 'page', branch });
    }
    if (this.queue.length > 80) this.queue = this.queue.sort((a, b) => b.priority - a.priority).slice(0, 80);
  }

  findings() {
    const ents = this.entities.filter((e) => !e.type.startsWith('seed-')).sort((a, b) => b.seen - a.seen).slice(0, 12)
      .map((e) => `${e.text} (${e.type}, on ${e.seen} page${e.seen === 1 ? '' : 's'})`);
    const pages = this.pages.slice(-6).map((p) => `${p.type}: ${p.title} → ${p.facts} facts`);
    return [ents.length ? `Names: ${ents.join('; ')}` : '', pages.length ? `Recent pages:\n${pages.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  // Adds an entity, or makes an existing one more important each time another page mentions it.
  enqueue(entity) {
    if (!entity.text) return false;
    const key = `${entity.type}|${normalize(entity.text)}`;
    const known = this.entities.find((e) => e.key === key || normalize(e.text) === normalize(entity.text));
    if (known) { known.seen += 1; known.priority = Math.min(0.95, Math.max(known.priority, entity.priority) + 0.05); return false; }
    if (this.entities.length >= MAX_ENTITIES) return false;
    this.entities.push({ ...entity, key, seen: 1, expanded: false });
    return true;
  }

  async _expand(k) {
    const fresh = this.entities.filter((e) => !e.expanded).sort((a, b) => b.priority - a.priority || b.seen - a.seen).slice(0, Math.max(1, k));
    for (const e of fresh) {
      e.expanded = true;
      const raw = KEYED(await this.gen.run({ entity: e, avoid: this.past.map((p) => p.q) }, { value: e.priority }));
      for (const c of raw) this.queue.push({ ...c, priority: e.priority, source: e.type.startsWith('seed-') ? 'template' : `about ${e.text}`, branch: e.branch ?? null, arm: e.branch != null ? `branch:${e.branch}` : c.arm });
    }
  }

  // The template queue and every discovered entity are used up: ask the fast model for fresh angles on
  // the seed (budgeted by the session gateway, at most MAX_LLM_ROUNDS times).
  async _llmRefill() {
    if (!this.llmGen || this.llmRounds >= MAX_LLM_ROUNDS || !this.gateway.budgetOk()) return;
    this.llmRounds++;
    const seed = this.entities.find((e) => e.type.startsWith('seed-')) || this.entities[0];
    if (!seed) return;
    const found = this.entities.filter((e) => e !== seed).slice(0, 8).map((e) => e.text).join(', ');
    const raw = KEYED(await this.llmGen.run({ entity: { ...seed, context: found ? `Related names found so far: ${found}` : '' }, avoid: this.past.map((p) => p.q) }));
    for (const c of raw) this.queue.push({ ...c, priority: 0.6 });
  }

  async isDuplicate(q) {
    const n = normalize(q);
    if (this.past.some((p) => normalize(p.q) === n)) return true;
    const toks = new Set(tokens(q, { stop: false }));
    const close = this.past.filter((p) => jaccard(toks, p.toks) > this.s.thresholds.queryDedupJaccard);
    if (!close.length) return false;
    const v = await this.embedder.embedOne(q);
    return close.some((p) => cosine(v, p.vec) > this.s.thresholds.queryDedupCos);
  }

  // Sonnet tier: pick from the numbered pool (plus ≤ 2 own queries), drop dead branches. → [{q,…}] or null.
  async _sonnet(k, left) {
    if (!this.sonnet || !this.gateway.enabled() || !this.gateway.budgetOk()) return null;
    const pool = [];
    for (const c of this.queue.slice().sort((a, b) => b.priority - a.priority)) {
      if (pool.length >= 25) break;
      if (this.isDropped(c.branch) || await this.isDuplicate(c.q)) continue;
      pool.push(c);
    }
    const live = this.branches.filter((b) => !b.dropped).slice(-10);
    this.sonnetCalls++;
    const out = await this.gateway.run('plan_queries', {
      subject: this.subject, kind: this.kind, k, left, past: this.past.map((p) => p.q),
      candidates: pool.map((c) => `${c.q} [${c.source || 'template'}]`),
      findings: this.findings(),
      branches: live.map((b) => `"${b.q}" → ${b.pages} pages, ${b.facts} facts`),
    }, { maxTokens: 1200, role: 'smart' });
    if (!out) { this.sonnetFailures++; return null; }
    // Picks first (it chose them now), then drops, which only affect what is left for later rounds.
    const picked = [];
    for (const i of out.pick || []) if (pool[i] && !picked.includes(pool[i])) picked.push(pool[i]);
    for (const i of out.drop || []) if (live[i]) live[i].dropped = true;
    for (const q of out.own || []) {
      const t = String(q).replace(/\s+/g, ' ').trim().slice(0, 100);
      if (t.length >= 3 && !URLISH.test(t)) picked.push({ q: t, arm: 'sonnet', priority: 0.7, source: 'planner' });
    }
    return picked;
  }

  async next(k, { left = k } = {}) {
    if (this.queue.length < k + 2) await this._expand(k);
    if (!this.queue.length) await this._llmRefill();
    // Sonnet chooses when it can; otherwise UCB over arms (templates and branches) with priority ties.
    const chosen = await this._sonnet(k, left);
    if (chosen && chosen.length) {
      const out = [];
      for (const c of chosen) {
        if (out.length >= k) break;
        if (await this.isDuplicate(c.q)) continue;
        out.push(c);
        this.past.push({ q: c.q, toks: new Set(tokens(c.q, { stop: false })), vec: await this.embedder.embedOne(c.q) });
      }
      const used = new Set(chosen);
      this.queue = this.queue.filter((c) => !used.has(c) && !this.isDropped(c.branch));
      if (out.length) return out;
    }
    const out = [];
    const scored = this.queue.map((c) => ({ c, s: this.bandit.score(c.arm) }))
      .sort((a, b) => (b.s === a.s ? b.c.priority - a.c.priority : b.s - a.s || b.c.priority - a.c.priority));
    const used = new Set();
    for (const { c } of scored) {
      if (out.length >= k) break;
      used.add(c);
      if (await this.isDuplicate(c.q)) continue;
      out.push(c);
      this.past.push({ q: c.q, toks: new Set(tokens(c.q, { stop: false })), vec: await this.embedder.embedOne(c.q) });
    }
    this.queue = this.queue.filter((c) => !used.has(c) && !this.isDropped(c.branch));
    return out;
  }

  canRefill() { return Boolean(this.llmGen && this.llmRounds < MAX_LLM_ROUNDS && this.gateway.budgetOk()); }

  hasMore() { return this.queue.length > 0 || this.entities.some((e) => !e.expanded) || this.canRefill(); }

  // Why the planner has nothing left, for the session's stop message.
  exhaustedReason() {
    if (this.llmGen && this.llmRounds >= MAX_LLM_ROUNDS) return 'the AI query ideas were used up too';
    if (this.llmGen && !this.gateway.budgetOk()) return 'the AI budget is spent, so no new query ideas';
    if (!this.llmGen || !this.gateway.enabled()) return 'no AI query ideas without a Groq key';
    return 'no new names were found to search for';
  }

  reward(arm, facts) { if (arm) this.bandit.update(arm, Math.min(1, facts / 5)); }
}

module.exports = { Planner, TEMPLATES, seedKind };
