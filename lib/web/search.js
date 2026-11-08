'use strict';

// Search provider adapter. Providers are fixed API hosts chosen in .env; their RESULT URLs are untrusted
// and go through the URL guard like any other link.
//   SEARCH_PROVIDER=brave     SEARCH_API_KEY=...      (default; api.search.brave.com)
//   SEARCH_PROVIDER=searxng   SEARXNG_URL=http://127.0.0.1:8888   (your own instance, JSON format on)
//   SEARCH_PROVIDER=firecrawl SEARCH_API_KEY=fc-...   (api.firecrawl.dev /v2/search)

const LABEL = { brave: 'Brave Search', firecrawl: 'Firecrawl', searxng: 'SearXNG' };

// Pulls the provider's own explanation out of an error body (Brave: error.detail, Firecrawl: error).
function providerMessage(data, raw) {
  const d = data || {};
  const m = (d.error && (d.error.detail || d.error.message || (typeof d.error === 'string' ? d.error : ''))) || d.message || d.detail || '';
  return String(m || raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function getJson(url, init, fetchImpl, provider) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON */ }
    if (!res.ok) {
      const name = LABEL[provider] || 'The search provider';
      const why = providerMessage(data, raw);
      let msg;
      if (res.status === 401 || res.status === 403) msg = `${name} rejected the API key`;
      // Brave answers 422 to a token it does not recognise, e.g. a Firecrawl key sent with the default provider.
      else if (res.status === 422 && provider === 'brave') msg = `${name} did not accept the key (HTTP 422). If this is a Firecrawl key, set SEARCH_PROVIDER=firecrawl in .env`;
      else if (res.status === 402) msg = `${name}: out of credits`;
      else if (res.status === 429) msg = `${name} rate limit reached; try again shortly`;
      else msg = `${name} search failed (HTTP ${res.status})`;
      const err = new Error(why && !msg.includes(why) ? `${msg}: ${why}` : msg);
      err.status = res.status;
      err.fatal = [401, 402, 403, 422].includes(res.status); // the session stops instead of retrying every query
      throw err;
    }
    return data || {};
  } catch (e) {
    const name = LABEL[provider] || 'The search provider';
    if (e.name === 'AbortError') throw new Error(`${name} took too long to answer`);
    if (e.status) throw e;
    // "fetch failed": nothing answered. Say where we tried and why, and stop the session.
    const code = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    let where = url;
    try { where = new URL(url).origin; } catch { /* keep url */ }
    const hint = code === 'ECONNREFUSED' ? (provider === 'searxng' ? ' Is SearXNG running? Start it, or set SEARCH_PROVIDER to firecrawl or brave.' : ' Nothing is listening there.')
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? ' Check your internet connection or DNS.'
        : /CERT|TLS|SSL/i.test(String(code)) ? ' A proxy or antivirus may be intercepting HTTPS.' : '';
    const err = new Error(`Could not reach ${name} at ${where} (${code}).${hint}`);
    err.fatal = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const clip = (s, n) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function createSearch(cfg, { fetchImpl = fetch } = {}) {
  const provider = cfg.searchProvider || 'brave';
  const key = cfg.searchKey || '';
  const providers = {
    brave: {
      configured: Boolean(key),
      async run(q, count) {
        const d = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}&safesearch=moderate`,
          { headers: { Accept: 'application/json', 'X-Subscription-Token': key } }, fetchImpl, 'brave');
        return ((d.web && d.web.results) || []).map((r) => ({ url: r.url, title: clip(r.title, 200), snippet: clip(r.description, 400) }));
      },
    },
    searxng: {
      configured: Boolean(cfg.searxngUrl),
      async run(q, count) {
        const d = await getJson(`${cfg.searxngUrl}/search?q=${encodeURIComponent(q)}&format=json&safesearch=1`, { headers: { Accept: 'application/json' } }, fetchImpl, 'searxng');
        return (d.results || []).slice(0, count).map((r) => ({ url: r.url, title: clip(r.title, 200), snippet: clip(r.content, 400) }));
      },
    },
    firecrawl: {
      configured: Boolean(key),
      async run(q, count) {
        const d = await getJson('https://api.firecrawl.dev/v2/search', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, limit: count, sources: ['web'], ignoreInvalidURLs: true }),
        }, fetchImpl, 'firecrawl');
        const list = (d.data && (d.data.web || d.data)) || [];
        return (Array.isArray(list) ? list : []).map((r) => ({ url: r.url, title: clip(r.title, 200), snippet: clip(r.description || r.snippet, 400) }));
      },
    },
  };
  const p = providers[provider] || providers.brave;
  return {
    name: providers[provider] ? provider : 'brave',
    configured: p.configured,
    // Cheap sanity check shown in the Research tab before any search is spent.
    warning: provider === 'firecrawl' && key && !/^fc-/.test(key) ? 'This does not look like a Firecrawl API key (they start with "fc-"). Copy it from firecrawl.dev → API Keys.'
      : provider === 'brave' && /^fc-/.test(key) ? 'This looks like a Firecrawl key, but the provider is Brave. Set SEARCH_PROVIDER=firecrawl.' : null,
    hint: provider === 'searxng' ? 'Set SEARXNG_URL in .env' : provider === 'firecrawl' ? 'Set FIRECRAWL_API_KEY (fc-…) in .env' : 'Set SEARCH_API_KEY in .env',
    async search(query, { count = 6 } = {}) {
      if (!p.configured) throw new Error(`Web search is not configured. ${provider === 'searxng' ? 'Set SEARXNG_URL' : 'Set SEARCH_API_KEY'} in .env (SEARCH_PROVIDER=${provider}).`);
      const q = clip(query, 300);
      if (!q) return [];
      const rows = await p.run(q, Math.max(1, Math.min(20, count)));
      return rows.filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url)).slice(0, count);
    },
  };
}

module.exports = { createSearch };
