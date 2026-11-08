'use strict';
const path = require('path');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
// Project .env first, then a .env in the directory you launched from. Real env vars always win.
dotenv.config({ path: path.join(root, '.env'), quiet: true });
dotenv.config({ quiet: true });

const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^['"]|['"]$/g, '').trim() : '');

// Accept the usual spellings so the existing .env works without renaming.
const KEY_VARS = ['GROQ_API_KEY', 'GROQ_KEY', 'GROQ_API_TOKEN', 'GROQ_TOKEN'];
const MODEL_VARS = ['GROQ_MODEL', 'GROQ_MODEL_NAME', 'GROQ_MODEL_ID', 'MODEL_NAME', 'MODEL'];

function pick(names) {
  for (const name of names) {
    const value = clean(process.env[name]);
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

// Search provider for research sessions. SEARCH_PROVIDER wins when set; otherwise it is inferred from
// which key is present (FIRECRAWL_API_KEY or an "fc-" key → firecrawl, SEARXNG_URL → searxng, else brave),
// so a Firecrawl key is never sent to Brave by accident.
function searchSettings() {
  const firecrawlKey = clean(process.env.FIRECRAWL_API_KEY);
  const braveKey = clean(process.env.BRAVE_API_KEY);
  const generic = clean(process.env.SEARCH_API_KEY);
  const searxngUrl = clean(process.env.SEARXNG_URL).replace(/\/+$/, '');
  let provider = clean(process.env.SEARCH_PROVIDER).toLowerCase();
  if (!provider) {
    if (firecrawlKey || /^fc-/i.test(generic)) provider = 'firecrawl';
    else if (searxngUrl && !generic && !braveKey) provider = 'searxng';
    else provider = 'brave';
  }
  const searchKey = provider === 'firecrawl' ? (firecrawlKey || generic) : provider === 'brave' ? (braveKey || generic) : generic;
  return { searchProvider: provider, searchKey, searxngUrl, searchProviderSet: Boolean(clean(process.env.SEARCH_PROVIDER)), envWarnings: envDuplicates() };
}

// A setting written twice in .env silently takes the LAST value (e.g. two SEARCH_PROVIDER blocks).
// Report those so the Research tab and the startup log can say which one is in effect.
function envDuplicates() {
  let raw = '';
  try { raw = require('fs').readFileSync(path.join(root, '.env'), 'utf8'); } catch { return []; }
  const seen = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/\s+#.*$/, '').trim();
    if (!seen.has(m[1])) seen.set(m[1], []);
    seen.get(m[1]).push(v);
  }
  const out = [];
  for (const [k, vals] of seen) {
    if (vals.length < 2 || /KEY|TOKEN|SECRET/.test(k)) { if (vals.length >= 2) out.push(`${k} is set ${vals.length} times in .env; the last one is used.`); continue; }
    out.push(`${k} is set ${vals.length} times in .env (${vals.join(', ')}); the last one, "${vals[vals.length - 1]}", is used.`);
  }
  return out;
}

function load() {
  const key = pick(KEY_VARS);
  const model = pick(MODEL_VARS);
  return {
    root,
    port: Number(process.env.PORT) || 3000,
    host: '127.0.0.1', // loopback only: there is no login, so the app is never exposed to the network
    dataDir: clean(process.env.DATA_DIR) || path.join(root, 'data'),
    groqKey: key.value,
    groqKeyVar: key.name,
    groqModel: model.value,
    groqModelVar: model.name,
    groqBase: (clean(process.env.GROQ_BASE_URL) || clean(process.env.LLM_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    // One key, several models: each research role can be pinned; unset roles are discovered via GET /models.
    modelFast: clean(process.env.NEXUS_MODEL_FAST),
    modelSmart: clean(process.env.NEXUS_MODEL_SMART),
    modelGuard: clean(process.env.NEXUS_MODEL_GUARD),
    // Web search for research sessions: brave (default) | searxng | firecrawl.
    ...searchSettings(),
    // transformers (local all-MiniLM-L6-v2, downloaded once) | hash (pure JS, no download).
    embedder: (clean(process.env.NEXUS_EMBEDDER) || 'transformers').toLowerCase(),
    // Render JavaScript-only pages with Playwright (must be installed separately). Off by default.
    browser: /^(on|1|true|yes)$/i.test(clean(process.env.NEXUS_BROWSER)),
  };
}

module.exports = load();
module.exports.load = load;
