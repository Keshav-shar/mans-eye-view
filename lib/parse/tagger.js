'use strict';
const { register } = require('../strategy');
const { normalize, flat } = require('../ml/text');
const { TECH, CONCEPTS, TITLE, ORG_SUFFIX, VC_WORDS, NODE_TO_MENTION } = require('./lexicon');
const S = require('../schema');
const { registeredDomain } = require('../web/canonical');
const { urlType } = require('./classify');

// Finds entity mentions on a page. Default (rules), strongest evidence first:
//   1. JSON-LD (Organization, Person, JobPosting, SoftwareApplication…)     conf .95
//   2. the page's own organisation (JSON-LD or og:site_name + domain)        conf .9
//   3. gazetteer: names and aliases already in your tree                    conf .9
//   4. tech / concept lexicon                                                conf .85 / .8
//   5. "Name Surname, Title" lines (team pages)                             conf .75–.85
//   6. capitalised spans ending in an org suffix ("… Labs", "… Capital")    conf .6–.7
// plus strong identifiers (GitHub/LinkedIn/Crunchbase links) attached to the site org.
// Privacy: personal emails and phone numbers are never attached to people. Only generic company
// addresses (careers@, hello@…) on the company's own domain are kept, as org contact details.

const GENERIC_MAIL = /^(careers|jobs|hiring|recruit|recruiting|talent|hr|people|hello|hi|contact|info|team|press|media|partnerships?|investors?|ir|support|sales)@/i;

// Capitalised phrases that look like "First Last" but are teams, sections or products.
const NOT_A_PERSON = /\b(Team|Teams|Group|Department|Features?|Engineering|Product|Products|Platform|Cloud|Services?|Solutions?|Support|Sales|Marketing|Design|Research|Labs?|Office|Board|Committee|Program|Programme|Project|Community|Customers?|Partners?|Careers?|Jobs|News|Blog|Docs|Home|About|Contact|Privacy|Terms|Pricing|Enterprise|Open Source|Read More|Learn More|Get Started|Sign Up|Log In|View All)\b/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Two Sigma was founded…", "the fund Two Sigma", "Two Sigma manages $58 billion": the name is an
// organisation, whatever a "First Last" pattern says.
const ORG_AFTER = '(?:[\'’]s)?\\s+(?:(?:was|is|has been|were)\\s+(?:co-?founded|founded|established|started|incorporated|launched|headquartered|based|acquired|backed)|(?:manages|raised|has raised|announced|employs|operates|invests|is an? [a-z -]{0,30}(?:firm|fund|company|startup|bank|lab|group|platform|publisher|provider|manager|exchange|institution|organi[sz]ation))\\b|has (?:about |over |around |more than )?\\$[\\d.,]+)';
const ORG_BEFORE = '\\b(?:the|a|an)\\s+(?:hedge |investment |trading |venture |quant |tech |technology |asset management )?(?:fund|firm|company|startup|bank|lab|group|manager)\\s+';
function orgEvidence(name, text, linkDomains = null) {
  if (!name) return false;
  if (linkDomains && linkDomains.has(compactName(name))) return true;
  const n = esc(name);
  return new RegExp(`(?<![\\p{L}\\p{N}])${n}${ORG_AFTER}`, 'u').test(text) || new RegExp(`${ORG_BEFORE}${n}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

// Organisation names compared with domain labels: "The D.E. Shaw Group" → "deshaw", "Two Sigma" → "twosigma".
const CORP_NOISE = /\b(the|group|inc|ltd|llc|llp|plc|corp|corporation|company|co|limited|pvt|private|gmbh|ag|sa|holdings|international)\b/g;
const compactName = (s) => normalize(String(s || '').replace(/[.’']/g, '')).replace(CORP_NOISE, '').replace(/[^a-z0-9]/g, '');
// Sites that host other people's content: a link to them names the host, not the entity in the anchor.
const HOSTING = /^(youtube|youtu|wikipedia|wikimedia|github|gitlab|medium|substack|linkedin|twitter|x|facebook|instagram|tiktok|reddit|google|apple|amazon|bit|t|crunchbase|bloomberg|reuters|forbes|techcrunch|ft|wsj|nytimes|archive|web)$/;

// Links whose anchor names an organisation and whose domain is that organisation's own site:
// "[Two Sigma](https://www.twosigma.com/)" → Map("twosigma" → "twosigma.com"). The page's own domain is
// never assigned to someone else.
function linkDomains(page) {
  const out = new Map();
  let own = '';
  try { own = registeredDomain(new URL(page.url).hostname); } catch { /* no url */ }
  for (const l of page.links || []) {
    const key = compactName(l.anchor);
    if (key.length < 3 || key.length > 40) continue;
    let d;
    try { d = registeredDomain(new URL(l.url).hostname); } catch { continue; }
    if (!d || d === own) continue;
    const label = d.split('.')[0];
    if (HOSTING.test(label) || label.length < 3) continue;
    const match = label === key || (key.length >= 4 && label.startsWith(key)) || (label.length >= 5 && key.startsWith(label));
    if (match && !out.has(key)) out.set(key, d);
  }
  return out;
}
const SCHOOL_WORDS = /\b(University|College|Institute of Technology|Institute|Academy|Business School|School of [A-Z][a-z]+|Polytechnic|IIT|IIM)\b/;

function findAll(text, needle, { caseSensitive = false, max = 5 } = {}) {
  const out = [];
  if (!needle || needle.length < 2) return out;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(needle)}(?![\\p{L}\\p{N}])`, caseSensitive ? 'gu' : 'giu');
  let m;
  while ((m = re.exec(text)) && out.length < max) out.push([m.index, m.index + m[0].length]);
  return out;
}

const ldType = (o) => [].concat(o['@type'] || []).map(String);
const ldName = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.name || '') : '');

function idsFromSameAs(sameAs) {
  const ids = {};
  for (const u of [].concat(sameAs || [])) {
    if (typeof u !== 'string') continue;
    if (/github\.com\//i.test(u)) ids.github = u;
    else if (/linkedin\.com\//i.test(u)) ids.linkedin = u;
    else if (/crunchbase\.com\//i.test(u)) ids.crunchbase = u;
    else if (/(twitter|x)\.com\//i.test(u)) ids.twitter = u;
    else if (/wikidata\.org\/(wiki|entity)\/(Q\d+)/i.test(u)) ids.wikidata = /(Q\d+)/i.exec(u)[1].toLowerCase();
  }
  return S.normIdentifiers(ids);
}

class MentionSet {
  constructor(text, prefix = 'm') { this.text = text; this.prefix = prefix; this.map = new Map(); this.n = 0; }

  add({ text, type, conf, source, ids = {}, attrs = {}, spans = null }) {
    const clean = S.text(text, 120);
    if (!clean || clean.length < 2 || clean.length > 100) return null;
    const key = normalize(clean);
    if (!key || /^\d+$/.test(key)) return null;
    const k = `${type}|${key}`;
    let m = this.map.get(k);
    if (!m) {
      m = { mid: `${this.prefix}${this.n++}`, text: clean, key, type, conf, source, ids: {}, attrs: {}, spans: [] };
      this.map.set(k, m);
    }
    m.conf = Math.max(m.conf, conf);
    Object.assign(m.ids, Object.fromEntries(Object.entries(ids).filter(([ns]) => !m.ids[ns])));
    for (const [a, v] of Object.entries(attrs)) {
      if (Array.isArray(v)) m.attrs[a] = [...new Set([...(m.attrs[a] || []), ...v])].slice(0, 10);
      else if (v != null && v !== '' && m.attrs[a] == null) m.attrs[a] = v;
    }
    // Every occurrence counts (a name found on a title line is also mentioned in the prose).
    const sp = [...(spans || []), ...findAll(this.text, clean, { max: 5 })];
    for (const s of sp) if (!m.spans.some((x) => x[0] === s[0])) m.spans.push(s);
    return m;
  }

  list() { return [...this.map.values()]; }
}

// A figure about the site's own organisation ("founded in 2019", "$11 billion AUM"): its sentence names the
// organisation or speaks for it ("we", "our"), or it sits near the top of the site's own home/about/team
// page. An article on the site about other firms ("Two Sigma was founded in 2001") does not count.
function selfFigure(page, text, siteName, re) {
  const own = ['about', 'home', 'team'].includes(urlType(page.url));
  const name = flat(siteName || '');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const a = Math.max(text.lastIndexOf('.', m.index), text.lastIndexOf('\n', m.index)) + 1;
    let b = text.slice(m.index).search(/[.!?\n](\s|$)/);
    b = b < 0 ? text.length : m.index + b;
    const sent = text.slice(a, b);
    const fs = flat(sent);
    if (name && fs.includes(name)) return m;
    // "We were founded in 2019" speaks for the site; "the group we will look at is Citadel, which was
    // founded in 1990" does not: first person counts only when no other organisation is named.
    const named = /(?:^|[^.\n])\b[A-Z][a-z]+(?:\s+[A-Z][\w&.'’-]+)+/.test(sent.replace(/^\s*\S+/, ''));
    if (/\b(we|our|us)\b/i.test(sent) && !named) return m;
    // On the site's own pages, an unattributed figure counts when no other organisation opens the sentence.
    if (own && m.index < 4000 && !/^\s*(?:The\s+)?[A-Z][\w&.'’-]+(?:\s+[A-Z][\w&.'’-]+)*\s+(?:was|is|has)\b/.test(sent)) return m;
    if (m[0].length === 0) re.lastIndex++;
  }
  return null;
}

function siteOrg(page) {
  const domain = registeredDomain(new URL(page.url).hostname);
  const org = (page.jsonld || []).find((o) => ldType(o).some((t) => /Organization|Corporation|LocalBusiness|NGO|EducationalOrganization/.test(t)) && ldName(o));
  if (org) return { name: ldName(org), domain, ld: org };
  if (page.siteName && page.siteName.length <= 60) return { name: page.siteName, domain, ld: null };
  return null;
}

function rulesTag({ page, tree, seed = null }) {
  const text = page.text || '';
  const ms = new MentionSet(text);

  // 1. JSON-LD, including objects nested as a page's mainEntity (ProfilePage → Person) or in @graph.
  const ldObjects = [];
  for (const o of page.jsonld || []) {
    if (!o || typeof o !== 'object') continue;
    ldObjects.push(o);
    if (o.mainEntity && typeof o.mainEntity === 'object' && !Array.isArray(o.mainEntity)) ldObjects.push(o.mainEntity);
    for (const g of Array.isArray(o['@graph']) ? o['@graph'].slice(0, 30) : []) if (g && typeof g === 'object') ldObjects.push(g);
  }
  for (const o of ldObjects) {
    const types = ldType(o);
    const name = ldName(o);
    if (types.some((t) => /Organization|Corporation|LocalBusiness/.test(t)) && name) {
      const ids = idsFromSameAs(o.sameAs);
      if (typeof o.url === 'string') Object.assign(ids, S.normIdentifiers({ domain: o.url }));
      const m = ms.add({ text: name, type: VC_WORDS.test(name) ? 'vc' : 'org', conf: 0.95, source: 'jsonld', ids, attrs: { founded: o.foundingDate ? String(o.foundingDate).slice(0, 10) : null, address: ldName(o.address) || (o.address && o.address.addressLocality) || null } });
      for (const f of [].concat(o.founder || [], o.founders || [])) {
        const fn = ldName(f);
        if (fn) ms.add({ text: fn, type: 'person', conf: 0.9, source: 'jsonld', attrs: { title: 'Founder', founderOf: m && m.mid } });
      }
    }
    if (types.includes('Person') && name) {
      const ids = idsFromSameAs(o.sameAs);
      const works = ldName(o.worksFor);
      const p = ms.add({ text: name, type: 'person', conf: 0.95, source: 'jsonld', ids, attrs: { title: S.text(o.jobTitle, 80) || null } });
      if (works && p) { const w = ms.add({ text: works, type: 'org', conf: 0.9, source: 'jsonld' }); if (w) p.attrs.worksFor = w.mid; }
    }
    if (types.includes('JobPosting')) {
      const org = ldName(o.hiringOrganization);
      const title = S.text(o.title, 100);
      if (org && title) ms.add({ text: org, type: 'org', conf: 0.9, source: 'jsonld', attrs: { hiring: [title] } });
    }
    if (types.some((t) => /SoftwareApplication|Product|WebApplication/.test(t)) && name) ms.add({ text: name, type: 'product', conf: 0.9, source: 'jsonld' });
  }

  // 2. the site's own organisation
  const site = siteOrg(page);
  let siteMention = null;
  if (site) {
    const ids = { domain: site.domain };
    for (const l of page.links || []) {
      if (/github\.com\/[A-Za-z0-9_-]+\/?$/i.test(l.url)) ids.github = ids.github || l.url;
      else if (/linkedin\.com\/company\/[^/]+/i.test(l.url)) ids.linkedin = ids.linkedin || l.url;
      else if (/crunchbase\.com\/organization\//i.test(l.url)) ids.crunchbase = ids.crunchbase || l.url;
    }
    siteMention = ms.add({ text: site.name, type: VC_WORDS.test(site.name) ? 'vc' : 'org', conf: 0.9, source: 'site', ids: S.normIdentifiers(ids), spans: findAll(text, site.name, { max: 5 }) });
    if (siteMention) {
      siteMention.attrs.isSite = true;
      const mails = (page.mailtos || []).filter((e) => GENERIC_MAIL.test(e) && e.endsWith(`@${site.domain}`));
      if (mails.length) siteMention.attrs.emails = [...new Set(mails)].slice(0, 3);
      // Dates: "founded in 2019", "established 2015", "since 2008" on the company's own pages.
      if (!siteMention.attrs.founded) {
        const fy = selfFigure(page, text, site.name, /\b(?:founded|established|started|incorporated|launched)\s+(?:in\s+)?((?:19|20)\d{2})\b|\bsince\s+((?:19|20)\d{2})\b/gi);
        const year = fy && Number(fy[1] || fy[2]);
        if (year && year <= new Date().getFullYear()) siteMention.attrs.founded = String(year);
      }
    }
  }

  // 2b. the research subject itself: "yashi sharma" typed in lower case is still found as "Yashi Sharma"
  //     on her pages, so the rules (and the builder) can attach facts to it. Topics are not entities.
  if (seed && seed.kind !== 'topic') {
    const type = seed.kind === 'person' ? 'person' : 'org';
    for (const phrase of seed.phrases || []) {
      const spans = findAll(text, phrase, { caseSensitive: false, max: 8 });
      if (!spans.length) continue;
      const asWritten = text.slice(spans[0][0], spans[0][1]);
      const m = ms.add({ text: /[A-Z]/.test(asWritten) ? asWritten : phrase.replace(/\b\p{L}/gu, (c) => c.toUpperCase()), type, conf: 0.85, source: 'seed', spans });
      if (m && type === 'person' && siteMention && page.pageType === 'profile' && !m.attrs.worksFor) m.attrs.worksFor = siteMention.mid;
    }
  }

  // 3. gazetteer from the tree
  if (tree) {
    for (const n of Object.values(tree.nodes)) {
      const mt = NODE_TO_MENTION[n.type];
      if (!mt) continue;
      for (const name of [n.title, ...(n.aliases || [])]) {
        if (!name || name.length < 3) continue;
        const spans = findAll(text, name, { caseSensitive: name.length <= 4, max: 5 });
        if (spans.length) ms.add({ text: name, type: mt, conf: 0.9, source: 'gazetteer', spans, attrs: { nodeId: n.id } });
      }
    }
  }

  // 4. tech and concept lexicons
  for (const t of TECH) {
    const spans = findAll(text, t, { caseSensitive: t.length <= 4, max: 5 });
    if (spans.length) ms.add({ text: t, type: 'tech', conf: 0.85, source: 'lexicon', spans });
  }
  for (const c of CONCEPTS) {
    const spans = findAll(text, c, { caseSensitive: c.length <= 4, max: 5 });
    if (spans.length) ms.add({ text: c, type: 'concept', conf: 0.8, source: 'lexicon', spans });
  }

  // 5. "Name Surname, Title" / "Name Surname — Title" / "Name Surname\nTitle" (team, about, press pages)
  //    The title must START the text after the name and be short: "Two Sigma\nTwo Sigma was founded in
  //    2001 by computer scientist …" is a heading followed by a sentence, not a person and a job title.
  const links = linkDomains(page);
  const NAME = "([A-Z][a-z'’]+(?:[ -][A-Z][a-z'’.]+){1,2})";
  const lineRe = new RegExp(`${NAME}\\s*(?:,|–|—|-|\\||\\n|\\(|is the|is our|serves as)\\s*(?:our |the )?([^\\n,.;()]{2,60})`, 'g');
  const urlKind = urlType(page.url);
  let m;
  let people = 0;
  while ((m = lineRe.exec(text)) && people < 60) {
    const title = m[2].trim();
    const lead = title.replace(/^(?:(?:a|an|the|our|its|their|former|acting|interim)\s+)+/i, '');
    const tm = TITLE.exec(lead);
    const verbStart = /^(?:was|is|are|were|has|have|had|founded|co-?founded|launched|said|says|will|would|can|announced|raised|also|and|or|which|who|that|in|on|for|with|by|from|to)\b/i.test(title);
    if (!tm || tm.index !== 0 || verbStart || title.split(/\s+/).length > 8) { lineRe.lastIndex = m.index + m[1].length; continue; } // re-scan: the "title" may be the next name
    if (TECH.includes(m[1]) || ORG_SUFFIX.test(m[1]) || NOT_A_PERSON.test(m[1]) || orgEvidence(m[1], text, links)) continue;
    people++;
    // "at Org" always; "of Org" only for executive titles ("CEO of Qdrant", not "Head of Talent").
    const execOf = /^(ceo|cto|coo|cfo|cpo|ciso|president|chairman|co-?founder|founder|chief)/i.test(tm[0]);
    const at = new RegExp(`\\b${execOf ? '(?:at|of)' : 'at'}\\s+([A-Z][\\w&.'’-]*(?:\\s+[A-Z][\\w&.'’-]*){0,3})`).exec(title);
    const p = ms.add({ text: m[1], type: 'person', conf: page.pageType === 'team' ? 0.85 : ['about', 'profile', 'press'].includes(page.pageType) ? 0.8 : 0.75, source: 'title-line', spans: [[m.index, m.index + m[1].length]], attrs: { title: tm[0].replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60) } });
    if (p && at) { const o = ms.add({ text: at[1], type: VC_WORDS.test(at[1]) ? 'vc' : 'org', conf: 0.7, source: 'title-line' }); if (o) p.attrs.worksFor = o.mid; }
    // The site's own team/about pages only (by URL): an article that happens to read like an about page
    // ("founded in" several times) must not make everyone it mentions an employee of the publisher.
    else if (p && siteMention && ['team', 'about'].includes(urlKind) && ['team', 'about'].includes(page.pageType)) p.attrs.worksFor = siteMention.mid;
  }

  // 6. organisations by suffix
  const orgRe = /\b((?:[A-Z][A-Za-z0-9&'’.-]+\s){0,3}[A-Z][A-Za-z0-9&'’.-]+)\s(Inc\.?|Ltd\.?|LLC|Labs|Technologies|Capital|Ventures|Partners|Pvt\.? Ltd\.?|Private Limited|Systems|Software|Payments|Bank|University|College|Institute|Academy|Foundation|Hospital)\b/g;
  let om; let orgs = 0;
  while ((om = orgRe.exec(text)) && orgs < 40) {
    const full = `${om[1]} ${om[2]}`.replace(/\s+/g, ' ').trim();
    if (/^(The|Our|We|At|In|And|For|With|A|An)\s/i.test(full)) continue;
    if (/\.\s/.test(full)) { orgRe.lastIndex = om.index + full.search(/\.\s/) + 2; continue; } // ran across a sentence break ("AVP. Spark Capital"): retry after it
    orgs++;
    ms.add({ text: full, type: SCHOOL_WORDS.test(full) ? 'school' : VC_WORDS.test(full) ? 'vc' : 'org', conf: 0.65, source: 'suffix', spans: [[om.index, om.index + full.length]] });
  }
  // 7. cue-anchored names: entities named right next to a relation cue, for pages with no structured data
  //    and names without a suffix ("led by AVP and Spark Capital", "Qdrant was founded by …").
  const CAP = "[A-Z][\\w&.'’-]*(?:\\s+[A-Z][\\w&.'’-]*){0,3}";
  const LIST = `(${CAP}(?:\\s*,\\s*${CAP})*(?:\\s*,?\\s+and\\s+${CAP})?)`;
  const split = (s) => s.split(/\s*,\s*|\s*,?\s+and\s+/).map((x) => x.trim()).filter((x) => x.length >= 2 && !/^(The|A|An|Our|We|It|Its|This|That|In|On)$/.test(x));
  const typeOf = (name) => (VC_WORDS.test(name) ? 'vc' : 'org');
  const cueRules = [
    [new RegExp(`\\b(?:led by|backed by|participation from|investors include|funded by|investment from)\\s+${LIST}`, 'g'), (m) => split(m[1]).map((n) => [n, typeOf(n)])],
    [new RegExp(`\\b(?:competitors include|competes with|alternative to|partnered with|partnership with|acquired by|acquired)\\s+${LIST}`, 'g'), (m) => split(m[1]).map((n) => [n, typeOf(n)])],
    [new RegExp(`(${CAP})\\s+(?:was|were|is)\\s+(?:co-?founded|founded|started)\\s+by\\s+${LIST}`, 'g'), (m) => [[m[1], typeOf(m[1])], ...split(m[2]).map((n) => [n, 'person'])]],
    [new RegExp(`\\b(?:CEO|CTO|COO|CFO|founder|co-founder|head of [a-z]+|VP of [a-z]+)\\s+(?:of|at)\\s+(${CAP})`, 'g'), (m) => [[m[1], typeOf(m[1])]]],
    [new RegExp(`\\b[A-Z][a-z]+-based\\s+(${CAP})`, 'g'), (m) => [[m[1], typeOf(m[1])]]],
    [new RegExp(`\\b(?:studied at|graduated from|alumn(?:us|a|i) of|(?:degree|MBA|PhD|BTech|B\\.Tech|masters?) (?:from|at))\\s+(?:the\\s+)?(${CAP})`, 'g'), (m) => [[m[1], 'school']]],
    [new RegExp(`(${CAP}),?\\s+(?:announced|raised|launched|acquires|has raised)\\b`, 'g'), (m) => [[m[1], typeOf(m[1])]]],
  ];
  let cues = 0;
  for (const [re, pick] of cueRules) {
    let cm;
    while ((cm = re.exec(text)) && cues < 40) {
      for (const [name0, type] of pick(cm)) {
        const name = name0.replace(/\.\s[\s\S]*$/, '').replace(/^(?:The|Our)\s+/, '').replace(/['’]s$/, '').replace(/[.,;:]+$/, '').trim();
        if (name.length < 2 || (NOT_A_PERSON.test(name) && type === 'person') || /^(It|Its|They|This|That|These|He|She|We|You|There)$/.test(name)) continue;
        if (/^(Series|Round|Today|Yesterday|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(name)) continue;
        if (type === 'person' && !/^[A-Z][a-z'’]+(?:[ -][A-Z][a-z'’.]+){1,2}$/.test(name)) continue;
        // The cue decides the type: something that is founded, raises money or has competitors is an
        // organisation, even when the tech lexicon also knows the name (Qdrant the company vs the engine).
        ms.add({ text: name, type, conf: 0.7, source: 'cue' });
        cues++;
      }
    }
  }

  // 7b. Founding sentences with a year and descriptors: "Two Sigma was founded in 2001 by computer
  //     scientist David Siegel and mathematician John Overdeck." / "It was founded in 1988 by David E. Shaw".
  //     Every person-shaped name after "by" is a founder; the subject (when not a pronoun) is an org and
  //     gets the year. Pronoun subjects ("It was founded…") use the nearest heading above the sentence.
  const PERSON = /[A-Z][a-z'’]+(?:\s+[A-Z]\.)*(?:\s+(?:de |van |von |da )?[A-Z][a-z'’-]+)+/g;
  const PRON = /^(?:It|They|This|That|He|She|The (?:fund|firm|company|startup|group|bank))$/;
  const CAP1 = "[A-Z][\\w&.'’-]*(?:[ \\t]+[A-Z][\\w&.'’-]*){0,3}"; // one line only: a heading above is not part of the name
  const foundRe = new RegExp(`(${CAP1}),?\\s+(?:which\\s+|that\\s+)?(?:was|were|is|has been)\\s+(?:co-?founded|founded|started|established)(?:\\s+in\\s+((?:19|20)\\d{2}))?\\s+by\\s+((?:[^.;\\n]|(?<=\\s[A-Z])\\.){3,200})`, 'g');
  let fm;
  let founders = 0;
  while ((fm = foundRe.exec(text)) && founders < 30) {
    let subj = fm[1].replace(/^(?:The|Our)\s+(?=[A-Z])/, '').trim();
    if (PRON.test(fm[1].trim()) || PRON.test(subj)) {
      const before = text.slice(Math.max(0, fm.index - 2500), fm.index).split('\n').map((x) => x.trim()).filter(Boolean);
      const head = before.reverse().find((x) => x.length <= 60 && /^[A-Z]/.test(x) && !/[.!?]$/.test(x));
      subj = head ? head.replace(/^(?:The)\s+/, '').replace(/[*#_]/g, '').trim() : '';
    }
    const org = subj && subj.length >= 2 && !/^(It|They|This)$/.test(subj)
      ? ms.add({ text: subj, type: VC_WORDS.test(subj) ? 'vc' : 'org', conf: 0.8, source: 'cue', attrs: { founded: fm[2] || null } })
      : null;
    for (const pm of fm[3].matchAll(PERSON)) {
      const name = pm[0].trim();
      if (NOT_A_PERSON.test(name) || ORG_SUFFIX.test(name) || TECH.includes(name) || name.split(/\s+/).length > 4) continue;
      const p = ms.add({ text: name, type: 'person', conf: 0.8, source: 'cue', attrs: { title: 'Founder', founderOf: org ? org.mid : null, founderSentence: fm[0].trim().slice(0, 400) } });
      if (p && org && !p.attrs.founderOf) p.attrs.founderOf = org.mid;
      founders++;
    }
  }

  // 7c. Places: "headquartered in London", "based in New York", "Bengaluru-based".
  const PLACE = "([A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2}(?:,\\s*[A-Z][a-z]+(?: [A-Z][a-z]+)?)?)";
  const placeRes = [
    new RegExp(`\\b(?:headquartered|based|located|headquarters)\\s+in\\s+${PLACE}`, 'g'),
    new RegExp(`\\b${PLACE}-based\\b`, 'g'),
    new RegExp(`\\boffices?\\s+in\\s+${PLACE}`, 'g'),
  ];
  let places = 0;
  for (const re of placeRes) {
    let pm;
    while ((pm = re.exec(text)) && places < 20) {
      const name = pm[1].replace(/,\s*$/, '').trim();
      if (/^(The|Our|We|Series|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(name) || NOT_A_PERSON.test(name)) continue;
      ms.add({ text: name, type: 'place', conf: 0.75, source: 'cue' });
      places++;
    }
  }

  // 7d. Investment and size figures for the site's own organisation ("$60 billion AUM", "over 1,500 employees").
  if (siteMention) {
    const name = siteMention.text;
    const aum = selfFigure(page, text, name, /\$\s?[\d.,]+\s?(?:billion|million|trillion|bn|m|b)\b(?=[^.]{0,30}\b(?:AUM|assets under management|in assets)\b)/gi);
    if (aum) siteMention.attrs.aum = aum[0].replace(/\s+/g, ' ');
    const emp = selfFigure(page, text, name, /\b((?:over |more than |about |around )?[\d,]{2,7}\+?)\s+(?:employees|staff|team members)\b/gi);
    if (emp) siteMention.attrs.employees = emp[1].trim();
    const hq = selfFigure(page, text, name, /\b(?:headquartered|headquarters)\s+in\s+([A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2})/g);
    if (hq) siteMention.attrs.hq = hq[1];
  }

  // Organisation evidence beats a person guess: "Two Sigma" next to "was founded", a link to its own
  // domain, or the same name also found as an organisation on this page.
  const orgNames = new Set(ms.list().filter((x) => ['org', 'vc', 'school'].includes(x.type)).map((x) => x.key));
  for (const x of ms.list()) {
    if (x.type !== 'person' || x.source === 'jsonld') continue;
    if (orgNames.has(x.key) || orgEvidence(x.text, text, links)) x.type = '_org';
  }
  for (const x of ms.list().filter((y) => y.type === '_org')) {
    ms.map.delete(`_org|${x.key}`);
    ms.map.delete(`person|${x.key}`);
    const o = ms.add({ text: x.text, type: VC_WORDS.test(x.text) ? 'vc' : 'org', conf: x.conf, source: x.source, spans: x.spans });
    if (o) for (const y of ms.list()) if (y.attrs.worksFor === x.mid) delete y.attrs.worksFor;
  }

  // Domains from links whose anchor is the entity's name: a strong identifier, and a site to crawl.
  for (const x of ms.list()) {
    if (!['org', 'vc', 'school'].includes(x.type) || x.ids.domain) continue;
    const d = links.get(compactName(x.text));
    if (d) { x.ids.domain = d; x.conf = Math.max(x.conf, 0.85); } // named and linked to its own site
  }

  // Longest match wins: "Spark" (tech) inside "Spark Capital" (vc) is not a separate mention.
  const list = ms.list();
  const strong = list.filter((m) => ['org', 'vc', 'person'].includes(m.type));
  for (const m of list) {
    if (!['tech', 'concept', 'product'].includes(m.type)) continue;
    m.spans = m.spans.filter(([a, b]) => !strong.some((o) => o.text.length > m.text.length && o.spans.some(([x, y]) => x <= a && y >= b)));
  }
  return list.filter((m) => m.spans.length || ['jsonld', 'site'].includes(m.source));
}

register('entity_tagger', 'rules', () => ({ run: async (input) => rulesTag(input) }));

register('entity_tagger', 'llm', ({ gateway }) => ({
  async run({ page, llmText }) {
    const text = (llmText ? await llmText() : page.text).slice(0, 6000);
    if (!text.trim()) return [];
    const out = await gateway.run('tag_entities', { text }, { maxTokens: 1200 });
    if (!out) return [];
    const ms = new MentionSet(page.text, 'l');
    const hay = flat(page.text);
    for (const x of out.mentions) {
      if (!hay.includes(flat(x.text))) continue; // hallucinated: not in the page
      const spans = findAll(page.text, x.text, { max: 5 });
      ms.add({ text: x.text, type: x.type, conf: 0.7, source: 'llm', spans });
    }
    return ms.list();
  },
}));

module.exports = { rulesTag, findAll, MentionSet, siteOrg, idsFromSameAs, GENERIC_MAIL, orgEvidence, linkDomains, compactName, SCHOOL_WORDS };
