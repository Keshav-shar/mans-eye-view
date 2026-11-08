'use strict';
// Strategy regression harness. Runs each configuration over the gold pages and merge pairs and prints
// one comparison table:
//
//   node eval/regression.js            rules only (offline, free)
//   node eval/regression.js --llm      also "rules + gated LLM" and "LLM extractor" on your Groq key
//
// Promote an AI alternative to default only if it beats the rules on these numbers by enough to pay for
// its calls. Add your own pages to eval/gold/pages.json and pairs to eval/gold/pairs.json.

const path = require('path');
const fs = require('fs');
const config = require('../lib/config');
const { merge, DEFAULTS } = require('../lib/defaults');
const { extract } = require('../lib/web/scrape');
const { PageParser, seedTermsOf } = require('../lib/parse/pageParser');
const { FellegiSunter } = require('../lib/ml/fs');
const { Gateway } = require('../lib/llm/gateway');
const { Guard } = require('../lib/llm/guard');
const { ModelRouter } = require('../lib/llm/models');
const { normalize } = require('../lib/ml/text');

const pages = JSON.parse(fs.readFileSync(path.join(__dirname, 'gold', 'pages.json'), 'utf8'));
const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, 'gold', 'pairs.json'), 'utf8'));
const withLlm = process.argv.includes('--llm');

const key = (s, r, o) => `${normalize(s)}|${r}|${normalize(o)}`;

async function runConfig(name, overrides) {
  const settings = merge(structuredClone(DEFAULTS), overrides);
  const router = new ModelRouter(config);
  if (withLlm) await router.refresh();
  const gateway = withLlm ? new Gateway({ cfg: config, router, maxCalls: 60, maxTokens: 200000 }) : null;
  const guard = withLlm ? new Guard({ cfg: config, router }) : null;
  const parser = new PageParser({ settings, gateway, guard });
  let tp = 0; let fp = 0; let fn = 0;
  const t0 = Date.now();
  const misses = [];
  for (const g of pages) {
    const page = extract(g.html, g.url);
    const r = await parser.parse(page, { seedTerms: seedTermsOf([page.title]) });
    const by = Object.fromEntries(r.mentions.map((m) => [m.mid, m.text]));
    const got = new Set(r.facts.map((f) => key(by[f.subj], f.rel, by[f.obj])));
    const want = new Set(g.facts.map((f) => key(...f.split('|'))));
    for (const k of got) { if (want.has(k)) tp++; else { fp++; misses.push(`  + ${k}  (${new URL(g.url).hostname})`); } }
    for (const k of want) if (!got.has(k)) { fn++; misses.push(`  - ${k}  (${new URL(g.url).hostname})`); }
  }
  // Merge decisions at the configured threshold.
  const fsm = new FellegiSunter();
  let mtp = 0; let mfp = 0; let mfn = 0;
  for (const p of pairs) {
    const node = { id: 'x', aliases: [], identifiers: {}, ...p.node };
    const ctx = { ...p.ctx, pageNeighbours: p.ctx.pageNeighbours && new Set(p.ctx.pageNeighbours), nodeNeighbours: p.ctx.nodeNeighbours && new Set(p.ctx.nodeNeighbours) };
    const merged = fsm.score(p.mention, node, ctx).p >= settings.thresholds.tauHigh;
    if (merged && p.match) mtp++; else if (merged) mfp++; else if (p.match) mfn++;
  }
  const u = gateway ? gateway.usage() : { calls: 0, tokens: 0 };
  return {
    name, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn),
    mergePrecision: mtp + mfp ? mtp / (mtp + mfp) : 1, mergeRecall: mtp / Math.max(1, mtp + mfn),
    aiCalls: u.calls, tokens: u.tokens, ms: Date.now() - t0, misses,
  };
}

(async () => {
  const rulesOnly = { extractor: { use: 'rules' }, entity_tagger: { use: 'rules', fallback: { use: 'none' } }, relation_extractor: { use: 'rules', fallback: { use: 'none' } }, page_classifier: { use: 'rules', fallback: { use: 'none' } } };
  const configs = [['rules', { strategies: rulesOnly }]];
  if (withLlm) {
    if (!config.groqKey) { console.error('--llm needs GROQ_API_KEY in .env'); process.exit(1); }
    configs.push(['rules + gated LLM', { strategies: { extractor: { use: 'rules' } } }]);
    configs.push(['haiku (default)', { strategies: { extractor: { use: 'haiku' } } }]);
  }
  const rows = [];
  for (const [name, o] of configs) rows.push(await runConfig(name, o));
  const pctf = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
  console.log(`\n${'strategy'.padEnd(20)} | precision | recall  | merge P | merge R | AI calls | tokens  | ms`);
  console.log(`${'-'.repeat(20)}-+-----------+---------+---------+---------+----------+---------+------`);
  for (const r of rows) console.log(`${r.name.padEnd(20)} | ${pctf(r.precision)}   | ${pctf(r.recall)} | ${pctf(r.mergePrecision)} | ${pctf(r.mergeRecall)} | ${String(r.aiCalls).padStart(8)} | ${String(r.tokens).padStart(7)} | ${r.ms}`);
  if (process.argv.includes('--verbose')) for (const r of rows) console.log(`\n${r.name} differences (+ extra, - missed):\n${r.misses.join('\n')}`);
  console.log('\nAdd --verbose to list every extra (+) and missed (-) fact.');
})();
