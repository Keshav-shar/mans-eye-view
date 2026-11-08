'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, migrateTree, V3_AREAS } = require('../lib/store');
const { runOps } = require('../lib/ops');
const { GraphBuilder, compactOps } = require('../lib/graph/builder');
const { PageParser, seedTermsOf } = require('../lib/parse/pageParser');
const { rulesTag, linkDomains } = require('../lib/parse/tagger');
const { rulesExtract } = require('../lib/parse/relations');
const { extractWithHaiku } = require('../lib/parse/haiku');
const { TASKS } = require('../lib/llm/prompts');
const { Gateway } = require('../lib/llm/gateway');
const { validate } = require('../lib/llm/validate');
const { Frontier } = require('../lib/web/frontier');
const { extract } = require('../lib/web/scrape');
const { DEFAULTS } = require('../lib/defaults');
const { openDb } = require('../lib/store/db');
const { Evidence } = require('../lib/web/evidence');
const { Retrieval } = require('../lib/vector/retrieval');
const { Embedder } = require('../lib/vector/embedder');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-extract-'));

// An article on a quant publisher's blog that profiles other firms. It used to turn "Two Sigma" into a
// person titled "Scientist" who "works at" the publisher.
const ARTICLE_URL = 'https://quantblog.example/how-to-build-a-quant-team/';
const ARTICLE = `<html><head><title>How to Build a Quant Team - Quant Blog</title><meta property="og:site_name" content="Quant Blog"></head><body><article>
<h1>How to Build a World-Class Quant Team</h1>
<p>${'Quant teams combine research, engineering and trading. We look at how leading firms organise them. '.repeat(3)}</p>
<h3>The D.E. Shaw Group</h3>
<p>We next take a look at <a href="https://www.deshaw.com/">The DE Shaw Group</a>, which is a global investment and technology firm. It was founded in 1988 by David E. Shaw, a computer scientist. The fund has about $60 billion AUM.</p>
<h3>Two Sigma</h3>
<p><a href="https://www.twosigma.com/">Two Sigma</a> was founded in 2001 by computer scientist David Siegel and mathematician John Overdeck. The fund has over $58 billion AUM.</p>
<p>The final group that we will look at is <a href="https://www.citadel.com/">Citadel Securities</a>, which was founded in 1990 by Kenneth C. Griffin.</p>
<p><a href="https://www.youtube.com/watch?v=1">Two Sigma video</a> <a href="https://quantblog.example/about">About Quant Blog</a></p>
</article></body></html>`;

const by = (mentions) => Object.fromEntries(mentions.map((m) => [m.mid, m]));

test('rules: a firm named in a heading is not a person, its founders are, and the publisher employs no one', () => {
  const page = extract(ARTICLE, ARTICLE_URL);
  page.pageType = 'about'; // the old failure: an article that reads like an about page
  const ms = rulesTag({ page, tree: null, seed: { phrases: ['quant'], kind: 'topic' } });
  const find = (t) => ms.find((m) => m.text === t);
  assert.equal(find('Two Sigma').type, 'org');
  assert.ok(!ms.some((m) => m.type === 'person' && /Two Sigma|Shaw Group|Citadel/.test(m.text)));
  assert.equal(find('Two Sigma').ids.domain, 'twosigma.com', 'anchored link to its own site');
  assert.equal(find('Two Sigma').attrs.founded, '2001');
  for (const p of ['David Siegel', 'John Overdeck', 'David E. Shaw', 'Kenneth C. Griffin']) assert.equal((find(p) || {}).type, 'person', p);
  const site = ms.find((m) => m.attrs.isSite);
  assert.equal(site.text, 'Quant Blog');
  assert.equal(site.attrs.founded, undefined, 'other firms\' founding years are not the publisher\'s');
  assert.equal(site.attrs.aum, undefined);
  const facts = rulesExtract({ page, mentions: ms });
  const b = by(ms);
  const said = facts.map((f) => `${b[f.subj].text} ${f.rel} ${b[f.obj].text}`);
  assert.ok(said.includes('David Siegel founded Two Sigma'), said.join(' | '));
  assert.ok(said.includes('John Overdeck founded Two Sigma'));
  assert.ok(said.includes('Kenneth C. Griffin founded Citadel Securities'));
  assert.ok(!facts.some((f) => f.rel === 'works_at'), `no works_at: ${said.join(' | ')}`);
  const founded = facts.find((f) => b[f.subj].text === 'David Siegel');
  assert.match(founded.snippet, /founded in 2001 by computer scientist David Siegel/);
});

test('rules: "Name, Title" lines still work when the title starts the line', () => {
  const html = '<html><head><title>Team</title><meta property="og:site_name" content="Zeta Labs"></head><body><main><h1>Our team</h1><p>Zeta Labs builds payments.</p><h3>Asha Rao, Co-founder &amp; CEO</h3><h3>Vikram Mehta — CTO</h3><h3>Two Sigma</h3><p>Two Sigma was founded in 2001 by computer scientist David Siegel.</p></main></body></html>';
  const page = extract(html, 'https://zetalabs.io/team');
  page.pageType = 'team';
  const ms = rulesTag({ page, tree: null });
  const asha = ms.find((m) => m.text === 'Asha Rao');
  assert.equal(asha.type, 'person');
  assert.match(asha.attrs.title, /Co-?founder/i);
  assert.ok(ms.find((m) => m.text === 'Vikram Mehta' && m.type === 'person'));
  assert.ok(!ms.some((m) => m.text === 'Two Sigma' && m.type === 'person'));
  const facts = rulesExtract({ page, mentions: ms });
  const b = by(ms);
  assert.ok(facts.some((f) => b[f.subj].text === 'Asha Rao' && f.rel === 'works_at' && b[f.obj].text === 'Zeta Labs'), 'team page by URL keeps the site fallback');
});

test('link domains: anchors matching their own site only; hosts and the page\'s own domain never', () => {
  const page = extract(ARTICLE, ARTICLE_URL);
  const d = linkDomains(page);
  assert.equal(d.get('twosigma'), 'twosigma.com');
  assert.equal(d.get('deshaw'), 'deshaw.com');
  assert.equal(d.get('citadelsecurities'), 'citadel.com');
  assert.ok(![...d.values()].includes('youtube.com'));
  assert.ok(![...d.values()].includes('quantblog.example'));
});

test('extract_page answers with off-list types are coerced, not thrown away', () => {
  const t = TASKS.extract_page;
  const raw = { page_type: 'News Article', entities: [{ text: 'Two Sigma', type: 'hedge fund' }, { text: 'London', type: 'city' }, { text: 'x', type: 'weird' }] };
  const v = validate(t.schema, t.prepare(raw));
  assert.ok(v, 'not null');
  assert.equal(v.page_type, 'news');
  assert.deepEqual(v.entities.map((e) => e.type), ['org', 'place', '_drop']);
  assert.deepEqual(v.relations, []);
  assert.equal(validate(t.schema, t.prepare({ page_type: 'blog', relevance: 0.4 })).entities.length, 0);
});

test('gateway: failures are counted by reason', async () => {
  const router = { get: () => 'm', markUnavailable() {} };
  const gw = new Gateway({ cfg: { groqKey: 'k' }, router, maxCalls: 5, complete: async () => { throw Object.assign(new Error('The model did not return valid JSON.'), {}); } });
  assert.equal(await gw.run('extract_page', { subject: 's', url: 'https://a.example', title: 't', text: 'x' }), null);
  assert.equal(gw.stats.failReasons['extract_page: invalid-json'], 1);
  assert.match(gw.lastError, /^extract_page:/);
  const ok = new Gateway({ cfg: { groqKey: 'k' }, router, maxCalls: 5, complete: async () => ({ page_type: 'essay', entities: [{ text: 'A', type: 'company' }] }) });
  const v = await ok.run('extract_page', { subject: 's', url: 'https://a.example', title: 't', text: 'y' });
  assert.equal(v.page_type, 'article');
  assert.equal(v.entities[0].type, 'org');
});

function fakeGateway(fn) {
  const calls = [];
  return { calls, enabled: () => true, budgetOk: () => true, addUnits() {}, run: async (task, input) => { calls.push({ task, input }); return fn(task, input, calls.length); } };
}

test('Haiku reads the page in up to maxGroupsPerPage sections, grounds attributes, fixes firms typed as people', async () => {
  const long = `<html><head><title>Quant firms</title></head><body><article>${Array.from({ length: 6 }, (_, i) => `<h2>Section ${i}</h2><p>${`Firm number ${i} is discussed here with many details about quant research. `.repeat(70)}</p>`).join('')}
<h2>Two Sigma</h2><p><a href="https://www.twosigma.com/">Two Sigma</a> was founded in 2001 and is based in New York. Jane Roe works at Two Sigma as a researcher. She was previously an engineer at Stripe.</p></article></body></html>`;
  const page = extract(long, 'https://quantblog.example/firms');
  const gw = fakeGateway((task, input) => {
    if (task !== 'extract_page') return null;
    if (!/Two Sigma/.test(input.text)) return { page_type: 'article', relevance: 0.6, entities: [], relations: [] };
    return {
      page_type: 'article', relevance: 0.9,
      entities: [
        { text: 'Two Sigma', type: 'person', org: 'Quant Blog' }, // a firm typed as a person
        { text: 'New York', type: 'place' },
        { text: 'Jane Roe', type: 'person', title: 'researcher', org: 'Two Sigma', past_titles: ['engineer at Stripe'], attrs: { location: 'New York' } },
        { text: 'Acme Fund', type: 'vc', attrs: { aum: '$999 billion' } }, // not on the page
        { text: 'Two Sigma', type: 'org', attrs: { founded: '2001', aum: '$500 billion' } }, // aum not on the page
      ],
      relations: [{ s: 4, rel: 'located_in', o: 1, snippet: 'Two Sigma was founded in 2001 and is based in New York.' }],
    };
  });
  const out = await extractWithHaiku({ page, gateway: gw, subject: 'quant', opts: { ...DEFAULTS.extract, maxGroupsPerPage: 3, groupChars: 4500 } });
  assert.equal(gw.calls.length, 3, 'three sections read');
  assert.ok(gw.calls.some((c) => /Two Sigma/.test(c.input.text)), 'the relevant section is among them, not just the first three');
  assert.deepEqual(gw.calls[0].input.limits, { entities: DEFAULTS.extract.maxEntities, relations: DEFAULTS.extract.maxRelations });
  const b = by(out.mentions);
  const ts = out.mentions.filter((m) => m.text === 'Two Sigma');
  assert.equal(ts.length, 1);
  assert.equal(ts[0].type, 'org');
  assert.equal(ts[0].attrs.founded, '2001');
  assert.equal(ts[0].attrs.aum, undefined, 'ungrounded attribute dropped');
  assert.equal(ts[0].ids.domain, 'twosigma.com');
  assert.ok(!out.mentions.some((m) => m.text === 'Acme Fund'));
  const said = out.facts.map((f) => `${b[f.subj].text} ${f.rel} ${b[f.obj].text}`);
  assert.ok(said.includes('Two Sigma located_in New York'), said.join(' | '));
  assert.ok(said.includes('Jane Roe works_at Two Sigma'), said.join(' | '));
  assert.ok(said.includes('Jane Roe worked_at Stripe'), said.join(' | '));
  assert.ok(!said.some((s) => /Quant Blog/.test(s)), 'no employment by the publisher');
  assert.equal(b[out.facts.find((f) => f.rel === 'works_at').subj].attrs.location, 'New York');
});

async function plan(html, url, { gateway = null, settings = DEFAULTS } = {}) {
  const dir = tmp();
  const store = new Store(dir).init().migrate();
  const embedder = new Embedder({ prefer: 'hash' });
  const page = extract(html, url);
  const parsed = await new PageParser({ settings, gateway }).parse(page, { tree: store.get(), seedTerms: seedTermsOf(['quant']), seed: { phrases: ['quant'], kind: 'topic' }, sameDomainOnly: false });
  parsed.tier = 'open';
  const builder = new GraphBuilder({ settings, retrieval: new Retrieval({ dir, embedder }), evidence: new Evidence(dir), embedder, db: openDb(dir) });
  const batch = builder.newBatch();
  const ps = await builder.planPage(store.get(), parsed, batch, { policy: 'auto' });
  await store.mutate('t', (t) => runOps(t, compactOps(batch.ops), { inPlace: true, maxOps: 3000, maxCreate: 400 }));
  const nodes = Object.values(store.get().nodes);
  const node = (title) => nodes.find((n) => n.title === title);
  return { store, ps, parsed, node, nodes, batch };
}

test('builder: the article becomes firms with websites and founders, no person "Two Sigma", entity homes listed', async () => {
  const { ps, node, nodes } = await plan(ARTICLE, ARTICLE_URL);
  const ts = node('Two Sigma');
  assert.equal(ts.type, 'company');
  assert.ok(ts.fields.some((f) => f.key === 'Website' && /twosigma\.com/.test(f.value)));
  assert.ok(ts.fields.some((f) => f.key === 'Founded' && f.value === '2001'));
  assert.ok(!nodes.some((n) => n.type === 'person' && n.title === 'Two Sigma'));
  const siegel = node('David Siegel');
  assert.equal(siegel.type, 'person');
  assert.ok(siegel.links.some((l) => l.relation === 'founded' && l.to === ts.id));
  assert.equal(siegel.parentId, ts.id, 'filed under the firm it founded');
  assert.ok(!nodes.some((n) => (n.links || []).some((l) => l.relation === 'works at')));
  const homes = ps.homes.map((h) => h.domain);
  for (const d of ['twosigma.com', 'deshaw.com', 'citadel.com']) assert.ok(homes.includes(d), `${d} in ${homes}`);
});

test('builder: entities named without a relation are saved, linked "mentioned with" from the page\'s main entity, capped', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `Firm${String.fromCharCode(65 + (i % 26))}${i} Holdings`);
  const html = `<html><head><title>About Orbit Capital</title><meta property="og:site_name" content="Orbit Capital"></head><body><main><h1>About Orbit Capital</h1><p>${'Orbit Capital invests in quant trading teams across Asia. '.repeat(4)}</p></main></body></html>`;
  const gw = fakeGateway((task, input, n) => (task === 'extract_page' && n === 1 ? {
    page_type: 'about', relevance: 0.9,
    entities: [{ text: 'Orbit Capital', type: 'vc' }, { text: 'Asia', type: 'place' }, { text: 'quant trading', type: 'sector' }],
    relations: [{ s: 0, rel: 'invests_in_sector', o: 2, snippet: 'Orbit Capital invests in quant trading teams across Asia.' }],
  } : null));
  const { node, ps } = await plan(html, 'https://orbitcapital.example/about', { gateway: gw });
  const orbit = node('Orbit Capital');
  assert.equal(orbit.type, 'vc');
  const asia = node('Asia');
  assert.equal(asia.type, 'place');
  assert.ok(orbit.links.some((l) => l.to === asia.id && l.relation === 'mentioned with' && l.status === 'single'));
  const sector = node('quant trading');
  assert.equal(sector.type, 'field');
  assert.ok(orbit.links.some((l) => l.to === sector.id && l.relation === 'invests in'));
  assert.ok(ps.mentioned >= 1);
  // The cap: many names on one page.
  const many = `<html><head><title>About Orbit Capital</title><meta property="og:site_name" content="Orbit Capital"></head><body><main><h1>About</h1><p>${'Orbit Capital invests in quant trading teams. '.repeat(4)}</p><p>${names.join(', ')}.</p></main></body></html>`;
  const gw2 = fakeGateway((task, input, n) => (task === 'extract_page' && n === 1 ? { page_type: 'about', relevance: 0.9, entities: [{ text: 'Orbit Capital', type: 'vc' }, ...names.map((t) => ({ text: t, type: 'org' }))], relations: [] } : null));
  const r2 = await plan(many, 'https://orbitcapital.example/about', { gateway: gw2 });
  assert.ok(r2.ps.mentioned <= DEFAULTS.extract.maxMentionedPerPage, `${r2.ps.mentioned}`);
  assert.ok(r2.ps.mentioned >= 20);
});

test('builder: a "person" spelled like a firm already in the tree is that firm', async () => {
  const dir = tmp();
  const store = new Store(dir).init().migrate();
  const companies = Object.values(store.get().nodes).find((n) => n.title === 'Companies');
  await store.mutate('seed', (t) => runOps(t, [{ op: 'create', parent: companies.id, type: 'company', title: 'Two Sigma' }], { inPlace: true }));
  const embedder = new Embedder({ prefer: 'hash' });
  const builder = new GraphBuilder({ settings: DEFAULTS, retrieval: new Retrieval({ dir, embedder }), evidence: new Evidence(dir), embedder, db: openDb(dir) });
  const parsed = {
    url: 'https://x.example/a', domain: 'x.example', sourceId: 's_x', title: 'A', pageType: 'blog', value: 0.8, relevance: 0.8, tier: 'open', simhash: '0', textForContext: 'Two Sigma is mentioned here. Jane works at Two Sigma.',
    mentions: [{ mid: 'p1', text: 'Two Sigma', key: 'two sigma', type: 'person', conf: 0.8, source: 'haiku', ids: {}, attrs: {}, spans: [[0, 9]] }],
    facts: [], outlinks: [], querySeeds: [],
  };
  const batch = builder.newBatch();
  await builder.planPage(store.get(), parsed, batch, { policy: 'auto' });
  assert.ok(!batch.ops.some((o) => o.op === 'create' && o.type === 'person'));
  assert.ok(!batch.review.some((r) => /person/.test(r.title)));
});

test('frontier: entity tier has its own depth and per-site cap', () => {
  const f = new Frontier({ maxDepthFor: (t) => (t === 'entity' ? 2 : 1), capFor: (t) => (t === 'entity' ? 6 : 4) });
  for (let i = 0; i < 8; i++) f.push({ url: `https://twosigma.com/p${i}`, depth: 1, tier: 'entity' });
  assert.equal(f.admitted('twosigma.com'), 6);
  assert.equal(f.push({ url: 'https://open.example/a', depth: 2, tier: 'open' }).reason, 'depth');
  assert.equal(f.push({ url: 'https://deshaw.com/a', depth: 2, tier: 'entity' }).ok, true);
});

test('search session: an article\'s linked firms get their own site and team page read', async () => {
  const { createWeb } = require('../lib/web');
  const store = new Store(tmp()).init().migrate();
  const TS_HOME = '<html><head><title>Two Sigma</title><meta property="og:site_name" content="Two Sigma"></head><body><main><h1>Two Sigma</h1><p>Two Sigma is a financial sciences company. We use data science to find value in markets.</p><a href="/about/leadership/">Leadership</a> <a href="/careers/">Careers</a> <a href="/privacy/">Privacy</a></main></body></html>';
  const TS_TEAM = '<html><head><title>Leadership - Two Sigma</title><meta property="og:site_name" content="Two Sigma"></head><body><main><h1>Our leadership</h1><p>Two Sigma is led by its co-founders.</p><h3>John Overdeck, Co-founder &amp; Co-chairman</h3><h3>David Siegel, Co-founder &amp; Co-chairman</h3></main></body></html>';
  const pages = {
    'quantblog.example': { '/robots.txt': 'User-agent: *\nAllow: /', '/how-to-build-a-quant-team/': ARTICLE },
    'twosigma.com': { '/robots.txt': 'User-agent: *\nAllow: /', '/': TS_HOME, '/about/leadership/': TS_TEAM, '/careers/': TS_HOME.replace('Two Sigma</title>', 'Careers at Two Sigma</title>') },
  };
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const body = (pages[host] || {})[u.pathname];
    if (!u.pathname.endsWith('.txt')) fetched.push(`${host}${u.pathname}`);
    if (body == null) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(body, { status: 200, headers: { 'content-type': u.pathname.endsWith('.txt') ? 'text/plain' : 'text/html' } });
  };
  const lookup = (host, o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }]);
  const rows = [{ url: ARTICLE_URL, title: 'How to Build a Quant Team', snippet: 'Two Sigma, D.E. Shaw and Citadel.' }];
  const search = { name: 'fake', configured: true, hint: '', search: async () => rows };
  const web = createWeb({ store, config: { groqKey: '' }, overrides: { fetchImpl, lookup, search, embedder: 'hash' } });
  web.fetcher.limiter.minDelay = 0;
  const s = await new Promise((resolve) => { const x = web.sessions.start({ mode: 'search', seed: ['quant team'], budget: { maxPages: 14, maxQueries: 2 } }); x.listeners.add((ev) => { if (ev.type === 'done') resolve(x); }); });
  assert.equal(s.status, 'done', s.error || '');
  assert.ok(fetched.includes('twosigma.com/'), fetched.join(' '));
  assert.ok(fetched.includes('twosigma.com/about/leadership/'), fetched.join(' '));
  assert.ok(!fetched.includes('twosigma.com/privacy/'));
  assert.ok(s.stats.entityHomes >= 1);
  const nodes = Object.values(store.get().nodes);
  const ts = nodes.filter((n) => n.title === 'Two Sigma');
  assert.equal(ts.length, 1, 'one Two Sigma node');
  assert.equal(ts[0].type, 'company');
  assert.ok(!nodes.some((n) => n.type === 'person' && n.title === 'Two Sigma'));
});

test('migration v3 adds Places, Education and Events once', () => {
  const store = new Store(tmp()).init().migrate();
  const titles = Object.values(store.get().nodes).filter((n) => !n.parentId).map((n) => n.title);
  for (const [t] of V3_AREAS) assert.ok(titles.includes(t), t);
  const tree = store.get();
  assert.equal(migrateTree(tree), false, 'idempotent');
});
