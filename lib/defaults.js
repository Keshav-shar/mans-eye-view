'use strict';
const path = require('path');
const { readJson } = require('./fsutil');

// Every tunable of the research pipeline. Override any of it in data/config.json (deep-merged), e.g.
//   { "strategies": { "adjudicator": { "use": "llm" } }, "budgets": { "maxPages": 120 } }
// Switching a strategy is one line: change `use`, run `node eval/regression.js`, compare.

const DEFAULTS = {
  strategies: {
    extractor: { use: 'haiku' }, // gpt-oss-20b reads every kept page; 'rules' = rules + gated per-task fallbacks
    query_planner: { use: 'sonnet' }, // gpt-oss-120b picks the next searches; 'templates' = templates + UCB only
    page_classifier: { use: 'rules', fallback: { use: 'llm', gate: { below: 0.45, valueAbove: 0.25 } } },
    entity_tagger: { use: 'rules', fallback: { use: 'llm', gate: { below: 0.34, valueAbove: 0.7 } } },
    relation_extractor: { use: 'rules', fallback: { use: 'llm', gate: { below: 0.5, valueAbove: 0.7 } } },
    query_generator: { use: 'templates', fallback: { use: 'llm', gate: { below: 0.5, valueAbove: 0 } } },
    adjudicator: { use: 'none' }, // set to "llm" to let gpt-oss decide merges inside the ambiguous band
    describer: { use: 'mmr' },
    edge_verifier: { use: 'cooccurrence' },
    link_predictor: { use: 'heuristic' },
  },
  thresholds: {
    tauHigh: 0.97, // auto-merge
    bandLow: 0.55, // below this a candidate is a different entity
    relevanceGate: 0.35, // pages below this are dropped
    highValue: 0.7, // pages at/above get LLM fallback + outlink following
    autoCreateConf: 0.8,
    autoCreateValue: 0.45, // pages at/above may create nodes (was 0.6: almost nothing new was saved)
    autoEdgeConf: 0.8,
    autoMentionConf: 0.75, // entities named on a page without a stated relation (see extract.autoMentioned)
    queryDedupCos: 0.9,
    queryDedupJaccard: 0.6,
    suggestMin: 0.35,
  },
  budgets: {
    maxQueries: 20, maxPages: 60, maxDepth: 2, maxAiCalls: 60, maxTokens: 400000, maxWallSeconds: 1500,
    parallel: 4, stallWindow: 10, stallMinFacts: 2, resultsPerQuery: 6, commitEveryPages: 5, commitEveryMs: 10000,
  },
  domains: {
    // Social networks (terms forbid scraping) and people-search / contact-data brokers (privacy).
    deny: ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'threads.net', 'rocketreach.co', 'zoominfo.com', 'contactout.com', 'lusha.com', 'signalhire.com', 'spokeo.com', 'truecaller.com', 'whitepages.com', 'peoplefinders.com', 'beenverified.com', 'radaris.com'],
    trusted: [],
    trustedDepth: 3, trustedPerDomain: 25, openDepth: 2, openPerDomain: 4, highValueBonus: 5,
    // Entity homes: when a page links an organisation to its own site ("[Two Sigma](https://www.twosigma.com/)"),
    // that site's homepage and its best pages (team, about, portfolio, press, careers) are read too.
    entityPerDomain: 6, entityDepth: 2, maxEntityDomains: 15,
  },
  fetch: {
    timeoutMs: 15000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5, minDelayMs: 1000, concurrency: 4,
    userAgent: 'NexusBot/1.0 (+local personal research tool; respects robots.txt)',
  },
  // How much of each page the extractor model reads, and what it may return. Sized for Groq's free tier
  // (8k tokens/minute): 4 sections of ~4,500 characters ≈ 18k characters per page, ~2k tokens per call.
  // On a paid tier raise maxGroupsPerPage (e.g. 8) in data/config.json.
  extract: {
    maxGroupsPerPage: 4, groupChars: 4500, maxTokens: 4000, maxEntities: 60, maxRelations: 50, maxQuerySeeds: 10,
    // Save entities a page names without stating a relation, linked "mentioned with" from the page's main entity.
    autoMentioned: true, maxMentionedPerPage: 25,
  },
  vector: { dim: 384, maxChunks: 20000, chunkSize: 1100, chunkOverlap: 150 },
  guard: { maxCalls: 120, threshold: 0.5 },
  // snapshots: keep the cleaned text of every page read (re-extraction, page-scorer training). Set to
  // false to keep only facts, short snippets and descriptions.
  store: { snapshots: true },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

function loadSettings(dataDir) {
  const over = dataDir ? readJson(path.join(dataDir, 'config.json'), null) : null;
  return merge(structuredClone(DEFAULTS), over);
}

module.exports = { DEFAULTS, loadSettings, merge };
