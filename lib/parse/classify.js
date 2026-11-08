'use strict';
const { register } = require('../strategy');
const { PAGE_TYPES } = require('../llm/prompts');
const { tokens, normalize } = require('../ml/text');
const { hashFeatures } = require('../ml/tfidf');

// Page type + value (0..1). Value decides how hard the crawler works on a page:
//   ≥ highValue (0.7): full extraction, LLM fallback allowed, outlinks followed, bigger domain budget
//   ≥ relevanceGate (0.35): rules-only extraction, no outlinks
//   below: dropped (only the source record is kept)

const TYPE_VALUE = {
  team: 0.95, job: 0.9, portfolio: 0.9, about: 0.85, careers: 0.85, profile: 0.85, press: 0.8, news: 0.75, product: 0.65, article: 0.6,
  home: 0.6, blog: 0.55, docs: 0.5, listing: 0.45, pricing: 0.4, other: 0.3, legal: 0.05,
};

const URL_RULES = [
  // Profile pages first: /blog/author/yashi/ is a page about a person, not a blog post.
  [/\/(in|profile|profiles|author|authors|editor|editors|speakers?|contributors?|staff|members?)\/[^/]+\/?$/i, 'profile'],
  [/\/(team|people|leadership|founders|management|our-team|who-we-are)(\/|$)/i, 'team'],
  [/\/(about|about-us|company|our-story|mission)(\/|$)/i, 'about'],
  [/\/(careers?|jobs|join-us|work-with-us|hiring|openings)(\/|$)/i, 'careers'],
  [/\/(jobs?|careers?|positions?|openings?)\/[^/]+/i, 'job'],
  [/(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com)\//i, 'job'],
  [/\/(portfolio|companies|investments)(\/|$)/i, 'portfolio'],
  [/\/(press|news|newsroom|media|announcements?)(\/|$)/i, 'press'],
  [/\/blog\/[^/]*(fund|rais|series|seed|acqui|launch)/i, 'press'],
  [/\/(blog|engineering|insights|articles?|posts?)(\/|$)/i, 'blog'],
  [/\/(docs?|documentation|developers?|api|guides?|reference)(\/|$)/i, 'docs'],
  [/\/(products?|platform|solutions?|features)(\/|$)/i, 'product'],
  [/\/(pricing|plans)(\/|$)/i, 'pricing'],
  [/\/(privacy|terms|legal|cookies?|gdpr|imprint|disclaimer|security\.txt)(\/|$|\.)/i, 'legal'],
  [/\/(tag|tags|category|categories|search|page\/\d+)(\/|$)/i, 'listing'],
];

const LD_RULES = {
  JobPosting: 'job', Person: 'profile', ProfilePage: 'profile', NewsArticle: 'press', PressRelease: 'press', BlogPosting: 'blog',
  AboutPage: 'about', Organization: 'about', Corporation: 'about', SoftwareApplication: 'product', Product: 'product', TechArticle: 'docs', FAQPage: 'other',
  CollectionPage: 'listing', SearchResultsPage: 'listing',
};

const TEXT_RULES = [
  [/\b(our team|meet the team|leadership team|founding team|co-?founders?)\b/gi, 'team'],
  [/\b(open (positions|roles)|we['’]re hiring|join our team|apply now|job description|responsibilities|qualifications)\b/gi, 'careers'],
  [/\b(our portfolio|we invest|portfolio companies|backed by us|investment thesis)\b/gi, 'portfolio'],
  [/\b(raised|series [a-e]\b|seed round|funding round|led the round|announced today|acquired|acquisition)\b/gi, 'press'],
  [/\b(founded in|headquartered in|our mission|we are a|about us)\b/gi, 'about'],
];

function ldTypes(jsonld) {
  const out = [];
  for (const o of jsonld || []) for (const t of [].concat(o['@type'] || [])) if (typeof t === 'string') out.push(t);
  return out;
}

function urlType(url) {
  let path = '';
  try { const u = new URL(url); path = u.hostname + u.pathname; } catch { return null; }
  for (const [re, t] of URL_RULES) if (re.test(path)) return t;
  try { if (new URL(url).pathname.replace(/\/+$/, '') === '') return 'home'; } catch { /* ignore */ }
  return null;
}

function seedRelevance(page, seedTerms) {
  if (!seedTerms || !seedTerms.length) return 0.6;
  const hay = new Set(tokens(`${page.title} ${page.description || ''} ${page.text.slice(0, 20000)}`));
  const st = [...new Set(seedTerms)];
  const hit = st.filter((t) => hay.has(t)).length;
  return Math.min(1, 0.25 + 0.75 * (hit / st.length));
}

// True when the page title or URL contains a whole seed phrase ("yashi sharma", "yashi-sharma").
function seedHit(page, phrases) {
  const title = normalize(page.title || '');
  const url = normalize(String(page.url || '').replace(/[-_/.]+/g, ' '));
  return (phrases || []).some((p) => { const n = normalize(p); return n.length >= 3 && (title.includes(n) || url.includes(n)); });
}

const features = (page) => hashFeatures(`${page.url.replace(/[/._-]+/g, ' ')} ${page.title} ${(page.text || '').slice(0, 3000)}`);

register('page_classifier', 'rules', ({ model = null }) => ({
  async run({ page, seedTerms, seedPhrases = [] }) {
    const score = Object.fromEntries(PAGE_TYPES.map((t) => [t, 0]));
    const u = urlType(page.url);
    if (u) score[u] += 2;
    for (const t of ldTypes(page.jsonld)) if (LD_RULES[t]) score[LD_RULES[t]] += 1.5;
    const head = `${page.title}\n${page.text.slice(0, 8000)}`;
    for (const [re, t] of TEXT_RULES) score[t] += Math.min(2, (head.match(re) || []).length * 0.5);
    if (page.ogType === 'article') score.blog += 0.5;
    let best = 'other'; let bestS = 0; let total = 0;
    for (const [t, s] of Object.entries(score)) { total += s; if (s > bestS) { bestS = s; best = t; } }
    const conf = bestS ? Math.min(0.95, 0.35 + 0.6 * (bestS / Math.max(total, 1)) * Math.min(1, bestS / 2)) : 0.2;
    const relevance = seedRelevance(page, seedTerms);
    let value = TYPE_VALUE[best] * (0.45 + 0.55 * relevance);
    // A page whose title or URL names the research subject is worth reading whatever its type: the
    // type-only formula capped "other" pages at 0.3 and dropped them even when perfectly on-topic.
    const hit = seedHit(page, seedPhrases);
    if (hit) value = Math.max(value, 0.3 + 0.45 * relevance);
    if (page.visibleChars < 400) value *= 0.6;
    if (model && model.n >= 30) value = 0.5 * value + 0.5 * model.predict(features(page)); // learned from your reviews
    return { pageType: best, conf, value: Math.round(value * 100) / 100, relevance: Math.round(relevance * 100) / 100, source: 'rules' };
  },
}));

register('page_classifier', 'llm', ({ gateway }) => ({
  async run({ page }) {
    const out = await gateway.run('classify_page', { url: page.url, title: page.title, head: `${page.description || ''}\n${page.text.slice(0, 1600)}` }, { maxTokens: 300 });
    return out ? { pageType: out.pageType, value: out.value, conf: 0.7, source: 'llm' } : null;
  },
}));

module.exports = { TYPE_VALUE, urlType, seedRelevance, seedHit, features, ldTypes };
