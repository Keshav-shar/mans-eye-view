'use strict';
const undici = require('undici');
const { canonicalize } = require('./canonical');

// The only way the crawler touches the network. Each hop: shape check → DNS resolve + vet → connect to
// the vetted address (pinned in the dispatcher, SNI/Host stay the real name) → manual redirect → repeat.
// Bodies are streamed and cut at maxBytes of DECODED data, which also stops decompression bombs.
// No cookies, no auth headers, an honest User-Agent.

class FetchError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml|application\/(ld\+)?json|application\/rss\+xml|application\/atom\+xml)\b/i;

function pinnedAgent(address, family) {
  return new undici.Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
    },
    connections: 2,
    keepAliveTimeout: 4000,
    headersTimeout: 15000,
    bodyTimeout: 15000,
  });
}

async function readCapped(body, maxBytes, signal) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      if (signal && signal.aborted) throw new FetchError('timeout', 'The page took too long to load');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new FetchError('too_large', `The page is larger than ${Math.round(maxBytes / 1048576)} MB`);
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(parts, total);
}

function decode(buf, contentType) {
  const m = /charset=["']?([\w.:-]+)/i.exec(contentType || '');
  let label = m ? m[1].toLowerCase() : 'utf-8';
  if (!m) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const meta = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head);
    if (meta) label = meta[1].toLowerCase();
  }
  try { return new TextDecoder(label).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// fetchImpl(url, init) is injectable for tests; init.pinned tells the fake which address was vetted.
async function safeFetch(url, {
  guard, timeoutMs = 15000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5, userAgent = 'NexusBot/1.0',
  accept = 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,application/xml;q=0.4', etag = null, lastModified = null,
  fetchImpl = null, allowTypes = TEXT_TYPES, allowPdf = false,
} = {}) {
  if (!guard) throw new Error('safeFetch needs a guard');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const hops = [];
  let cur = canonicalize(url);
  if (!cur) throw new FetchError('bad_url', 'Not a valid web address');
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const shape = guard.check(cur);
      if (!shape.ok) throw new FetchError('blocked_url', shape.reason, { url: cur, hops });
      const addr = await guard.resolve(shape.host);
      if (!addr.ok) throw new FetchError('blocked_address', addr.reason, { url: cur, hops });
      const headers = { 'User-Agent': userAgent, Accept: accept, 'Accept-Language': 'en;q=1, *;q=0.5' };
      if (hop === 0 && etag) headers['If-None-Match'] = etag;
      if (hop === 0 && lastModified) headers['If-Modified-Since'] = lastModified;
      const init = { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal, pinned: addr };
      let res;
      let agent = null;
      try {
        if (fetchImpl) res = await fetchImpl(cur, init);
        else {
          agent = pinnedAgent(addr.address, addr.family);
          const { pinned, ...real } = init; // eslint-disable-line no-unused-vars
          res = await undici.fetch(cur, { ...real, dispatcher: agent });
        }
      } catch (e) {
        if (agent) agent.close().catch(() => {});
        if (e instanceof FetchError) throw e;
        throw new FetchError(ctrl.signal.aborted ? 'timeout' : 'network', ctrl.signal.aborted ? 'The page took too long to load' : `Could not connect (${e.cause && e.cause.code ? e.cause.code : e.message})`, { url: cur, hops });
      }
      try {
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location');
          if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
          const next = loc && canonicalize(loc, cur);
          if (!next) throw new FetchError('bad_redirect', 'The page redirected to an invalid address', { url: cur, hops });
          hops.push({ from: cur, to: next, status: res.status });
          cur = next;
          continue;
        }
        const contentType = res.headers.get('content-type') || '';
        const meta = {
          url: cur, status: res.status, contentType, hops, address: addr.address,
          etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'),
          retryAfter: res.headers.get('retry-after'), headers: Object.fromEntries(res.headers.entries()),
        };
        if (res.status === 304) { if (res.body) await res.body.cancel().catch(() => {}); return { ...meta, notModified: true, text: '', bytes: 0 }; }
        if (res.status >= 400) {
          // Read a little of error bodies: block pages are often 403/503 with a challenge in them.
          const buf = await readCapped(res.body, 256 * 1024, ctrl.signal).catch(() => Buffer.alloc(0));
          return { ...meta, text: decode(buf, contentType), bytes: buf.length };
        }
        // PDFs (reports, filings, decks) are returned as bytes for lib/web/pdf.js, under the same size cap.
        if (allowPdf && /^application\/pdf\b/i.test(contentType)) {
          const buf = await readCapped(res.body, maxBytes, ctrl.signal);
          return { ...meta, text: '', buffer: buf, bytes: buf.length, isPdf: true };
        }
        if (contentType && !allowTypes.test(contentType)) {
          if (res.body) await res.body.cancel().catch(() => {});
          throw new FetchError('bad_type', `Skipped a ${contentType.split(';')[0]} file`, { url: cur, hops });
        }
        const buf = await readCapped(res.body, maxBytes, ctrl.signal);
        return { ...meta, text: decode(buf, contentType), bytes: buf.length };
      } finally {
        if (agent) agent.close().catch(() => {});
      }
    }
    throw new FetchError('too_many_redirects', 'Too many redirects', { url: cur, hops });
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (ctrl.signal.aborted) throw new FetchError('timeout', 'The page took too long to load', { url: cur, hops });
    throw new FetchError('network', e.message, { url: cur, hops });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { safeFetch, FetchError, TEXT_TYPES };
