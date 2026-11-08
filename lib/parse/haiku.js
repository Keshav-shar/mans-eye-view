'use strict';
const { chunkByHeadings, flat, normalize } = require('../ml/text');
const { BM25 } = require('../ml/bm25');
const { RELATIONS, relationAllowed, VC_WORDS } = require('./lexicon');
const { MentionSet, findAll, orgEvidence, linkDomains, compactName, SCHOOL_WORDS } = require('./tagger');
const { sentenceSpans, ground } = require('./relations');
const { PROMPT_VERSION, ATTR_KEYS, MENTION_TYPES, MENTION_SYNONYMS, coerceEnum } = require('../llm/prompts');
const S = require('../schema');

// Haiku tier: the small model (gpt-oss-20b) reads every kept page and returns entities, relations,
// page type, relevance, suggested searches and which numbered links to follow — one schema-validated
// call per heading group (at most 3 per page).
//
// The rules are the checks, not the primary:
//   - an entity is kept only if its text is in the page (no hallucinated names);
//   - a relation needs both ends kept, a type from the closed lexicon that fits the entity types, and a
//     snippet that is found in the page (it is replaced by the page's own sentence);
//   - links can only be chosen by number from the list we gave;
//   - personal contact details are never asked for and never attached.
// The caller merges these with the deterministic facts (JSON-LD, identifiers, site org), which win.

const EXTRACTOR = `haiku:${PROMPT_VERSION}`;

function ldSummary(jsonld) {
  const name = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.name || '') : '');
  const out = [];
  for (const o of jsonld || []) {
    const t = [].concat(o['@type'] || []).map(String).join('/');
    const subject = o.mainEntity && typeof o.mainEntity === 'object' ? o.mainEntity : o;
    const n = name(subject);
    if (!n) continue;
    const bits = [subject.jobTitle, name(subject.worksFor), name(subject.hiringOrganization), subject.foundingDate].filter(Boolean).map(String);
    out.push(`${t}: ${n}${bits.length ? ` (${bits.join(', ')})` : ''}`);
    if (out.length >= 8) break;
  }
  return out.join('\n');
}

async function screen(guard, text) {
  if (!guard) return text;
  const pieces = [];
  for (let i = 0; i < text.length; i += 1800) pieces.push(text.slice(i, i + 1800));
  const res = await guard.screen(pieces);
  return res.filter((r) => r.safe).map((r) => r.text).join('');
}

// The page's heading groups to read, at most `max`. A page longer than that keeps its first group (the
// intro usually names the subject) plus the groups most relevant to the subject, in page order.
function pickGroups(markdown, { size, max, subject }) {
  const all = chunkByHeadings(markdown, { size, maxGroups: 1000 });
  if (all.length <= max) return all;
  const bm = new BM25();
  all.forEach((g, i) => bm.add(String(i), g));
  const q = `${subject} founded founder ceo team investors funding raised acquired headquartered partner portfolio`;
  const ranked = bm.search(q, all.length).map((r) => Number(r.id)).filter((i) => i !== 0);
  const keep = new Set([0, ...ranked.slice(0, max - 1)]);
  for (let i = 1; keep.size < max && i < all.length; i++) keep.add(i);
  return all.filter((_, i) => keep.has(i));
}

// "works at X" from the model's own person → org pairing needs a sentence that says so: the person, the
// organisation and an employment cue ("at X", "X's CTO", "joined X"), not just both names nearby.
function employmentSentence(sents, person, org) {
  const o = org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cue = new RegExp(`\\b(?:at|of|for|joined|joins|joining|with)\\s+(?:the\\s+)?${o}|${o}['’]s\\s+(?:[a-z-]+\\s+){0,3}(?:ceo|cto|coo|cfo|founder|co-founder|head|director|partner|engineer|manager|president|vp|lead|scientist|researcher|analyst|chair|chairman)`, 'i');
  return sents.find((x) => flat(x.text).includes(flat(person)) && cue.test(x.text)) || null;
}

const DROPPED_TYPES = new Set(['_drop']);
const CONTACT_ATTR = /@|\+?\d[\d\s().-]{7,}\d|\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln)\b/;

// → null when the model could not be used (no key, budget spent, failed call); the caller then falls back
// to the rules pipeline. Otherwise { mentions, facts, pageType, relevance, queries, follow, calls }.
// opts: settings.extract ({ maxGroupsPerPage, groupChars, maxTokens, maxEntities, maxRelations }).
async function extractWithHaiku({ page, gateway, guard = null, subject = '', candidates = [], opts = {}, maxCalls = null }) {
  if (!gateway || !gateway.budgetOk()) return null;
  const o = { maxGroupsPerPage: 4, groupChars: 4500, maxTokens: 4000, maxEntities: 60, maxRelations: 50, ...opts };
  // ~4,500 chars per call keeps each read near 2k tokens, which matters on Groq's 8k-tokens/minute free tier.
  const groups = pickGroups(page.markdown || page.text, { size: o.groupChars, max: maxCalls || o.maxGroupsPerPage, subject });
  if (!groups.length) return null;
  const facts = ldSummary(page.jsonld);
  const links = candidates.map((l) => `${l.anchor || ''} — ${l.url}`.trim());
  const limits = { entities: o.maxEntities, relations: o.maxRelations };
  const outs = [];
  for (const g of groups) {
    if (!gateway.budgetOk()) break;
    const text = await screen(guard, g);
    if (!text.trim()) continue;
    const out = await gateway.run('extract_page', { subject, url: page.url, title: page.title, facts, text, links: outs.length ? [] : links, limits }, { maxTokens: o.maxTokens });
    if (out) outs.push(out);
  }
  if (!outs.length) return null;

  const hay = flat(page.text);
  const grounded = (v) => typeof v === 'string' && v.trim().length >= 1 && hay.includes(flat(v));
  const ms = new MentionSet(page.text, 'h');
  const sents = sentenceSpans(page.text);
  const factsOut = [];
  const seen = new Set();
  let relevance = 0;
  const types = {};
  const queries = [];
  const follow = new Set();
  let dropped = 0;
  const pairs = []; // [person mention, org text] from the model's "org" field
  const past = []; // [person mention, "Engineer at Stripe"]
  for (const out of outs) {
    relevance = Math.max(relevance, out.relevance == null ? 0.5 : out.relevance);
    types[out.page_type || 'other'] = (types[out.page_type || 'other'] || 0) + 1;
    const local = []; // entity number → mention (or null when dropped)
    for (const e0 of (out.entities || []).slice(0, o.maxEntities + 20)) {
      // Types are coerced by the task's prepare step; cached or older answers get the same treatment here.
      const e = { ...e0, type: coerceEnum(e0.type, MENTION_TYPES, MENTION_SYNONYMS, '_drop') };
      const txt = S.text(e.text, 120);
      if (!txt || DROPPED_TYPES.has(e.type) || !hay.includes(flat(txt))) { local.push(null); dropped++; continue; } // not in the page
      const spans = findAll(page.text, txt, { max: 6 });
      const attrs = {};
      if (e.type === 'person' && e.title && grounded(e.title)) attrs.title = S.text(e.title, 60);
      // Attributes count only when the page itself says them; never contact details.
      for (const [k, v] of Object.entries(e.attrs || {})) {
        if (!ATTR_KEYS.includes(k) || !grounded(v) || CONTACT_ATTR.test(v)) continue;
        if (e.type === 'person' && !['location', 'education'].includes(k)) continue;
        attrs[k] = S.text(v, 160);
      }
      const m = ms.add({ text: txt, type: e.type, conf: 0.8, source: 'haiku', spans, attrs });
      if (m && e.type === 'person' && e.org && grounded(e.org)) pairs.push([m, S.text(e.org, 120)]);
      if (m && e.type === 'person') for (const t of e.past_titles || []) if (typeof t === 'string') past.push([m, S.text(t, 120)]);
      local.push(m);
    }
    let nRel = 0;
    for (const r of out.relations || []) {
      if (nRel >= o.maxRelations) break;
      const s = local[r.s]; const ob = local[r.o];
      if (!s || !ob || s.mid === ob.mid || !RELATIONS[r.rel] || r.rel === 'mentioned_with') { dropped++; continue; }
      // "AVP invested_in Qdrant" with Qdrant typed as tech: the relation says Qdrant is an organisation.
      if (!relationAllowed(r.rel, s.type, ob.type)) {
        const want = RELATIONS[r.rel];
        const fix = (m, allowed) => { if (allowed && ['tech', 'product'].includes(m.type) && allowed.includes('org')) m.type = 'org'; };
        fix(ob, want.o); fix(s, want.s);
        if (!relationAllowed(r.rel, s.type, ob.type)) { dropped++; continue; }
      }
      const snippet = ground(r.snippet, sents);
      if (!snippet) { dropped++; continue; } // the page does not say it
      const k = `${s.mid}|${r.rel}|${ob.mid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      nRel++;
      factsOut.push({ subj: s.mid, rel: r.rel, obj: ob.mid, snippet, conf: 0.8, attrs: r.rel === 'works_at' && s.attrs.title ? { title: s.attrs.title } : {}, source: 'haiku' });
    }
    for (const q of out.suggested_queries || []) {
      const t = S.text(q, 100);
      if (t && !/https?:|www\.|[a-z0-9-]+\.[a-z]{2,}\//i.test(t) && !queries.some((x) => normalize(x) === normalize(t))) queries.push(t);
    }
    for (const i of out.follow || []) if (Number.isInteger(i) && i >= 0 && i < candidates.length) follow.add(i);
  }
  // Firms the model called people ("Two Sigma" as a person): organisation evidence on the page, a link to
  // the name's own domain, or the same name also listed as an organisation. Relations re-checked after.
  const homeLinks = linkDomains(page);
  const orgKeys = new Set(ms.list().filter((x) => ['org', 'vc', 'school'].includes(x.type)).map((x) => x.key));
  const retyped = new Map(); // old person mid → org mention
  for (const x of ms.list()) {
    if (x.type !== 'person' || !(orgKeys.has(x.key) || orgEvidence(x.text, page.text, homeLinks))) continue;
    ms.map.delete(`person|${x.key}`);
    const org = ms.add({ text: x.text, type: VC_WORDS.test(x.text) ? 'vc' : 'org', conf: x.conf, source: 'haiku', spans: x.spans });
    if (org) retyped.set(x.mid, org);
  }
  if (retyped.size) {
    for (const f of factsOut) { if (retyped.has(f.subj)) f.subj = retyped.get(f.subj).mid; if (retyped.has(f.obj)) f.obj = retyped.get(f.obj).mid; }
    const byMid = new Map(ms.list().map((x) => [x.mid, x]));
    for (let i = factsOut.length - 1; i >= 0; i--) {
      const f = factsOut[i]; const s = byMid.get(f.subj); const ob = byMid.get(f.obj);
      if (!s || !ob || s.mid === ob.mid || !relationAllowed(f.rel, s.type, ob.type)) factsOut.splice(i, 1);
    }
  }

  // Facts implied by the model's own person → employer pairing, only when a sentence states employment.
  for (const [m, orgText] of pairs) {
    if (m.type !== 'person' || retyped.has(m.mid)) continue;
    const sent = employmentSentence(sents, m.text, orgText);
    if (!sent) continue;
    const org = ms.add({ text: orgText, type: VC_WORDS.test(orgText) ? 'vc' : SCHOOL_WORDS.test(orgText) ? 'school' : 'org', conf: 0.75, source: 'haiku', spans: findAll(page.text, orgText, { max: 4 }) });
    if (!org || org.mid === m.mid) continue;
    if (!m.attrs.worksFor) m.attrs.worksFor = org.mid;
    const k = `${m.mid}|works_at|${org.mid}`;
    if (seen.has(k) || factsOut.some((f) => f.subj === m.mid && f.obj === org.mid)) continue;
    seen.add(k);
    factsOut.push({ subj: m.mid, rel: 'works_at', obj: org.mid, snippet: sent.text, conf: 0.78, attrs: m.attrs.title ? { title: m.attrs.title } : {}, source: 'haiku' });
  }
  // Past roles: "Engineer at Stripe" → a grounded "worked at Stripe" when the page names both in one sentence.
  for (const [m, t] of past) {
    if (m.type !== 'person' || retyped.has(m.mid)) continue;
    const at = /\b(?:at|@)\s+(.+)$/i.exec(t);
    const orgText = at ? at[1].trim() : '';
    if (!orgText || !grounded(orgText)) continue;
    const sent = sents.find((x) => flat(x.text).includes(flat(m.text)) && flat(x.text).includes(flat(orgText)))
      || sents.find((x) => flat(x.text).includes(flat(orgText)) && /\b(previously|formerly|before|prior|earlier|worked|spent|alumn)/i.test(x.text));
    if (!sent) continue;
    const org = ms.add({ text: orgText, type: VC_WORDS.test(orgText) ? 'vc' : 'org', conf: 0.72, source: 'haiku', spans: findAll(page.text, orgText, { max: 4 }) });
    if (!org || org.mid === m.mid || m.attrs.worksFor === org.mid) continue;
    const k = `${m.mid}|worked_at|${org.mid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    m.attrs.pastTitles = [...new Set([...(m.attrs.pastTitles || []), t])].slice(0, 8);
    factsOut.push({ subj: m.mid, rel: 'worked_at', obj: org.mid, snippet: sent.text, conf: 0.74, attrs: { title: t.replace(/\s+(?:at|@)\s+.+$/i, '') }, source: 'haiku' });
  }
  // Organisations linked to their own site: a strong identifier and an entity home to crawl.
  for (const x of ms.list()) {
    if (!['org', 'vc', 'school'].includes(x.type) || x.ids.domain) continue;
    const d = homeLinks.get(compactName(x.text));
    if (d) { x.ids.domain = d; x.conf = Math.max(x.conf, 0.85); }
  }
  const pageType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
  return { mentions: ms.list(), facts: factsOut, pageType, relevance, queries: queries.slice(0, 5), follow: [...follow], calls: outs.length, dropped, extractor: EXTRACTOR };
}

// Merge Haiku's mentions into the rule mentions. Deterministic sources (JSON-LD, the site org, your own
// tree, the seed) keep their type; weak rule guesses (lexicon, suffix, cue words) take the model's type.
// Returns { mentions, remap } where remap maps Haiku mids to merged mids.
const STRONG = new Set(['jsonld', 'site', 'gazetteer', 'seed']);
function mergeMentions(rules, haiku) {
  // When the rules hold several mentions with one name (JSON-LD org "Qdrant" and lexicon tech "Qdrant"),
  // the strongest one is the merge target.
  const rank = (m) => (STRONG.has(m.source) ? 2 : 0) + (m.type === 'org' || m.type === 'person' || m.type === 'vc' ? 1 : 0);
  const byKey = new Map();
  for (const m of rules) { const cur = byKey.get(m.key); if (!cur || rank(m) > rank(cur)) byKey.set(m.key, m); }
  const remap = new Map();
  const out = [...rules];
  for (const h of haiku) {
    const hit = byKey.get(h.key);
    if (hit) {
      if (!STRONG.has(hit.source) && hit.type !== h.type) hit.type = h.type;
      // A weak rule guess (suffix, lexicon) the model also lists is a confirmed name.
      if (['suffix', 'lexicon'].includes(hit.source)) hit.source = 'haiku';
      hit.conf = Math.max(hit.conf, h.conf);
      for (const s of h.spans) if (!hit.spans.some((x) => x[0] === s[0])) hit.spans.push(s);
      for (const [a, v] of Object.entries(h.attrs)) if (hit.attrs[a] == null) hit.attrs[a] = v;
      remap.set(h.mid, hit.mid);
    } else {
      out.push(h);
      byKey.set(h.key, h);
      remap.set(h.mid, h.mid);
    }
  }
  for (const m of out) if (m.attrs.worksFor && remap.has(m.attrs.worksFor)) m.attrs.worksFor = remap.get(m.attrs.worksFor);
  return { mentions: out, remap };
}

module.exports = { extractWithHaiku, mergeMentions, ldSummary, EXTRACTOR };
