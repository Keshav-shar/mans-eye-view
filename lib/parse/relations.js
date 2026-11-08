'use strict';
const { register } = require('../strategy');
const { flat, tokens } = require('../ml/text');
const { RELATIONS, relationAllowed } = require('./lexicon');

// Relations between mentions. Default (rules): sentence-level cue patterns with direction (who is
// before/after the cue) and the type constraints in lexicon.RELATIONS, plus facts implied by structured
// data (JSON-LD founder/worksFor, "Name, Title at Org" lines). The LLM alternative only picks entity
// NUMBERS and relation KEYS from closed lists; its snippet must be found in the page.

function sentenceSpans(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s|$)|\n|$)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 4000) {
    const s = m[0].trim();
    if (s.length >= 8) out.push({ start: m.index, end: m.index + m[0].length, text: s.slice(0, 600) });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// Cue → { rel, flip } where flip=false means subject BEFORE the cue and object AFTER it.
const CUES = [
  [/\b(?:was |were |is )?(?:co-?founded|founded|started|established)(?: in (?:19|20)\d{2})? by\b/i, 'founded', true],
  [/\b(?:co-?founded|founded|started)\b(?!(?: in (?:19|20)\d{2})? by)/i, 'founded', false],
  [/\b(?:formerly|previously|earlier|prior to that,?) (?:at|worked at|with|a [a-z ]{2,30} at)\b|\b(?:worked at|spent [a-z0-9 ]{1,20} years at|alumn(?:us|a|i) of)\b(?! (?:the )?(?:university|college|school|institute))/i, 'worked_at', false],
  [/\b(?:advis(?:es|ed|or to|er to|ing))\b/i, 'advises', false],
  [/\b(?:sits on the board of|board member (?:of|at)|serves on the board of|joined the board of|chairman of)\b/i, 'board_member_of', false],
  [/\b(?:is |was |became )?(?:a |an )?(?:wholly[- ]owned )?subsidiary of\b/i, 'subsidiary_of', false],
  [/\b(?:customers include|clients include|used by|trusted by)\b/i, 'customer_of', true],
  [/\b(?:headquartered in|based in|located in|headquarters in|offices? in)\b/i, 'located_in', false],
  [/\b(?:round was )?(?:led by|backed by|funded by|with participation from|investors include|investment from|raised [^.]{0,60}? from)\b/i, 'invested_in', true],
  [/\b(?:invested in|led (?:a|the) [^.]{0,40}?round in|backs|backed)\b/i, 'invested_in', false],
  [/\b(?:was |has been |is being )?acquired by\b/i, 'acquired', true],
  [/\b(?:acquired|acquires|has acquired|to acquire|bought)\b/i, 'acquired', false],
  [/\b(?:works at|working at|joined|joins|is (?:a|an|the) [a-z ]{2,40} (?:at|of)|serves as [a-z ]{2,40} (?:at|of))\b/i, 'works_at', false],
  [/\b(?:studied at|graduated from|alumn(?:us|a|i) of|degree from)\b/i, 'studied_at', false],
  [/\b(?:launched|released|builds|makes|develops|developed|created|ships|introduced|open-?sourced)\b(?! (?:on|with|using)\b)/i, 'builds', false],
  [/\b(?:uses|using|use|built (?:with|on)|powered by|runs on|migrated to|adopted|leverag(?:e|es|ing)|our stack|tech stack|experience with|proficien(?:t|cy) (?:in|with))\b/i, 'uses', false],
  [/\b(?:competitors? (?:include|are)|competes with|alternative to|rivals?)\b/i, 'competitor_of', false],
  [/\b(?:partnered with|partnership with|in partnership with|partners with)\b/, 'partner_of', false], // case-sensitive: not "Peak XV Partners with…"
  [/\b(?:is (?:a|an) (?:subfield|branch|type|kind|form|part) of|is part of)\b/i, 'part_of', false],
];

function mentionsIn(sent, mentions) {
  const out = [];
  for (const m of mentions) {
    const span = m.spans.find(([a, b]) => a >= sent.start && b <= sent.end);
    if (span) out.push({ m, pos: span[0] - sent.start });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function rulesExtract({ page, mentions }) {
  const text = page.text || '';
  const facts = [];
  const seen = new Set();
  const byMid = new Map(mentions.map((m) => [m.mid, m]));
  // The page's main subject, for sentences like "The round was led by …" that do not name it again:
  // the site's own organisation, else the organisation named in the title, else the most-mentioned one.
  const orgs = mentions.filter((m) => m.type === 'org' || m.type === 'vc');
  const titleKey = String(page.title || '').toLowerCase();
  const site = mentions.find((m) => m.attrs.isSite)
    || orgs.find((m) => titleKey.includes(m.text.toLowerCase()))
    || orgs.slice().sort((a, b) => b.spans.length - a.spans.length).find((m) => m.spans.length >= 2)
    || null;
  const add = (s, rel, o, snippet, conf, attrs = {}) => {
    if (!s || !o || s.mid === o.mid || !relationAllowed(rel, s.type, o.type)) return;
    const k = `${s.mid}|${rel}|${o.mid}`;
    if (seen.has(k)) return;
    seen.add(k);
    facts.push({ subj: s.mid, rel, obj: o.mid, snippet: String(snippet || '').slice(0, 400), conf, attrs, source: 'rules' });
  };

  // Implied by structure
  for (const m of mentions) {
    if (m.attrs.worksFor && byMid.get(m.attrs.worksFor)) add(m, 'works_at', byMid.get(m.attrs.worksFor), `${m.text}${m.attrs.title ? `, ${m.attrs.title}` : ''}`, m.source === 'jsonld' ? 0.9 : 0.82, { title: m.attrs.title || '' });
    if (m.attrs.founderOf && byMid.get(m.attrs.founderOf)) add(m, 'founded', byMid.get(m.attrs.founderOf), m.attrs.founderSentence || `${m.text} (founder)`, m.source === 'jsonld' ? 0.9 : 0.85);
    if (/founder/i.test(m.attrs.title || '') && m.attrs.worksFor && byMid.get(m.attrs.worksFor)) add(m, 'founded', byMid.get(m.attrs.worksFor), `${m.text}, ${m.attrs.title}`, 0.82);
  }

  // Sentence cues
  for (const sent of sentenceSpans(text)) {
    const inS = mentionsIn(sent, mentions);
    if (!inS.length) continue;
    for (const [re, rel, flip] of CUES) {
      const cm = re.exec(sent.text);
      if (!cm) continue;
      const cuePos = sent.text.indexOf(cm[0]);
      const before = inS.filter((x) => x.pos < cuePos).map((x) => x.m);
      const after = inS.filter((x) => x.pos >= cuePos + cm[0].length).map((x) => x.m);
      // Every mention at the nearest position: "Qdrant" may be both an org and a tech mention, and the
      // relation's type constraints pick the right one.
      const lastPos = before.length ? inS.filter((x) => x.pos < cuePos).pop().pos : -1;
      const nearestBefore = before.length ? inS.filter((x) => x.pos === lastPos).map((x) => x.m) : [];
      const subjects = flip ? after : (nearestBefore.length ? nearestBefore : (site && ['uses', 'builds', 'competitor_of', 'partner_of', 'invested_in', 'located_in'].includes(rel) ? [site] : []));
      const objects = flip ? (nearestBefore.length ? nearestBefore : (site ? [site] : [])) : after;
      for (const s of subjects) for (const o of objects.slice(0, 6)) add(s, rel, o, sent.text, 0.72);
    }
  }

  // Hiring pages: the site organisation uses the technologies its job posts ask for.
  if (site && ['job', 'careers'].includes(page.pageType)) {
    for (const t of mentions.filter((m) => m.type === 'tech').slice(0, 12)) add(site, 'uses', t, `Mentioned in a job posting: ${t.text}`, 0.62);
  }
  return facts;
}

register('relation_extractor', 'rules', () => ({ run: async (input) => rulesExtract(input) }));

function ground(snippet, sentences) {
  const f = flat(snippet);
  if (f.length < 8) return null;
  const exact = sentences.find((s) => flat(s.text).includes(f) || f.includes(flat(s.text)));
  if (exact) return exact.text;
  const want = new Set(tokens(snippet));
  if (want.size < 3) return null;
  let best = null; let bestR = 0;
  for (const s of sentences) {
    const have = new Set(tokens(s.text));
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    const r = hit / want.size;
    if (r > bestR) { bestR = r; best = s.text; }
  }
  return bestR >= 0.8 ? best : null;
}

register('relation_extractor', 'llm', ({ gateway }) => ({
  async run({ page, mentions, llmText }) {
    const text = (llmText ? await llmText() : page.text).slice(0, 6000);
    if (!text.trim()) return [];
    const hay = flat(text);
    const cands = mentions.filter((m) => hay.includes(flat(m.text))).slice(0, 40);
    if (cands.length < 2) return [];
    const out = await gateway.run('extract_relations', { text, mentions: cands }, { maxTokens: 2000 });
    if (!out) return [];
    const sentences = sentenceSpans(page.text);
    const facts = [];
    for (const f of out.facts) {
      const s = cands[f.s]; const o = cands[f.o];
      if (!s || !o || s.mid === o.mid || !RELATIONS[f.rel] || !relationAllowed(f.rel, s.type, o.type)) continue;
      const snippet = ground(f.snippet, sentences);
      if (!snippet) continue; // not grounded in the page: dropped
      facts.push({ subj: s.mid, rel: f.rel, obj: o.mid, snippet, conf: 0.75, attrs: f.title ? { title: f.title } : {}, source: 'llm' });
    }
    return facts;
  },
}));

module.exports = { rulesExtract, sentenceSpans, ground, CUES };
