'use strict';
const path = require('path');
const fs = require('fs');

// SQLite side store (data/web/nexus.db) for what the JSON tree should not carry:
//   provenance — every fact the research engine wrote: which page said it, the supporting snippet,
//                and which extractor (and prompt version) produced it. Answers "where did this come from?"
//   queries    — every search issued, its branch and how many facts it yielded
//   domains    — learned trust per site: up when its facts are corroborated elsewhere, down when you
//                reject them in Review
// If better-sqlite3 cannot load, a no-op store is returned and research still works (without these).

const DEFAULT_TRUST = { open: 0.6, trusted: 0.9, site: 0.9 };

function openDb(dir) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return nullStore(); }
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'nexus.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS provenance (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, node_id TEXT, fact_key TEXT NOT NULL, source_id TEXT NOT NULL,
      url TEXT, domain TEXT, snippet TEXT, extractor TEXT, version TEXT, session TEXT, at TEXT DEFAULT (datetime('now')),
      UNIQUE (fact_key, source_id));
    CREATE INDEX IF NOT EXISTS prov_node ON provenance (node_id);
    CREATE INDEX IF NOT EXISTS prov_source ON provenance (source_id);
    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY, session TEXT, text TEXT, branch INTEGER, source TEXT, results INTEGER, queued INTEGER,
      pages INTEGER DEFAULT 0, facts INTEGER DEFAULT 0, at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS domains (
      domain TEXT PRIMARY KEY, trust REAL, corroborated INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0, updated TEXT);
  `);
  const q = {
    addFact: db.prepare(`INSERT OR IGNORE INTO provenance (kind, node_id, fact_key, source_id, url, domain, snippet, extractor, version, session)
      VALUES (@kind, @nodeId, @factKey, @sourceId, @url, @domain, @snippet, @extractor, @version, @session)`),
    setNode: db.prepare('UPDATE provenance SET node_id = @nodeId WHERE node_id = @ref AND session = @session'),
    forNode: db.prepare('SELECT kind, fact_key, url, domain, snippet, extractor, version, at FROM provenance WHERE node_id = ? ORDER BY at DESC LIMIT ?'),
    sourcesOfNode: db.prepare('SELECT DISTINCT source_id FROM provenance WHERE node_id = ?'),
    otherUsers: db.prepare('SELECT COUNT(*) AS c FROM provenance WHERE source_id = ? AND (node_id IS NULL OR node_id != ?)'),
    purgeNode: db.prepare('DELETE FROM provenance WHERE node_id = ?'),
    addQuery: db.prepare('INSERT INTO queries (session, text, branch, source, results, queued) VALUES (@session, @text, @branch, @source, @results, @queued)'),
    yieldQuery: db.prepare('UPDATE queries SET pages = pages + 1, facts = facts + @facts WHERE session = @session AND branch = @branch'),
    getDomain: db.prepare('SELECT trust FROM domains WHERE domain = ?'),
    upsertDomain: db.prepare(`INSERT INTO domains (domain, trust, corroborated, rejected, updated) VALUES (@domain, @trust, @c, @r, datetime('now'))
      ON CONFLICT(domain) DO UPDATE SET trust = @trust, corroborated = corroborated + @c, rejected = rejected + @r, updated = datetime('now')`),
    allDomains: db.prepare('SELECT domain, trust, corroborated, rejected, updated FROM domains ORDER BY updated DESC LIMIT ?'),
  };
  const tx = (fn) => db.transaction(fn);
  return {
    enabled: true,
    addFacts: tx((rows) => { for (const r of rows) q.addFact.run({ nodeId: null, url: null, domain: null, snippet: null, extractor: null, version: null, session: null, ...r, snippet: r.snippet ? String(r.snippet).slice(0, 500) : null }); }),
    // After a commit, batch refs ("w12") become real node ids.
    resolveRefs: tx((refMap, session) => { for (const [ref, nodeId] of Object.entries(refMap)) q.setNode.run({ ref, nodeId, session }); }),
    factsForNode: (nodeId, limit = 50) => q.forNode.all(nodeId, limit),
    // Forget a node's web data: its provenance, and the sources nothing else still relies on.
    forgetNode: tx((nodeId) => {
      const sources = q.sourcesOfNode.all(nodeId).map((r) => r.source_id);
      const orphaned = sources.filter((s) => q.otherUsers.get(s, nodeId).c === 0);
      q.purgeNode.run(nodeId);
      return orphaned;
    }),
    addQuery: (r) => q.addQuery.run({ source: null, results: 0, queued: 0, ...r }),
    queryYield: (session, branch, facts) => q.yieldQuery.run({ session, branch, facts }),
    trust(domain, tier = 'open') {
      const row = q.getDomain.get(domain);
      return row ? row.trust : (DEFAULT_TRUST[tier] ?? 0.6);
    },
    // Corroborated by another domain: +0.02 (max 0.95). Rejected in Review: −0.05 (min 0.1).
    adjustTrust(domain, delta, tier = 'open') {
      const cur = this.trust(domain, tier);
      const next = Math.max(0.1, Math.min(0.95, Math.round((cur + delta) * 1000) / 1000));
      q.upsertDomain.run({ domain, trust: next, c: delta > 0 ? 1 : 0, r: delta < 0 ? 1 : 0 });
      return next;
    },
    domains: (limit = 100) => q.allDomains.all(limit),
    close: () => db.close(),
  };
}

function nullStore() {
  return {
    enabled: false, addFacts() {}, resolveRefs() {}, factsForNode: () => [], forgetNode: () => [], addQuery() {}, queryYield() {},
    trust: (d, tier = 'open') => DEFAULT_TRUST[tier] ?? 0.6, adjustTrust: (d, delta, tier = 'open') => DEFAULT_TRUST[tier] ?? 0.6, domains: () => [], close() {},
  };
}

module.exports = { openDb, DEFAULT_TRUST };
