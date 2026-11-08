'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeAtomic, writeJson, readJson, appendLine, readLines, sha } = require('../fsutil');

// Everything the crawler learns that is NOT the tree itself lives under data/web/:
//   sources.jsonl     one line per fetched page (url, domain, type, value, hashes, ETag)
//   snapshots/        cleaned markdown per content hash (skipped for noindex pages)
//   domains.json      trust, crawl blocks, circuit breaker state, your deny/trusted lists
//   review.json       the review queue (ambiguous merges, web contact details, suggestions…)
//   merge_log.jsonl   every resolve decision with its features, p and who decided
//   labels.jsonl      your review decisions, used to retrain the matcher and page classifier
//   edges.json        per-edge evidence: which origins (domains, near-dup hashes) support it
//   sessions/<id>.json research session state, stats and deferred URLs
// This keeps tree.json small: nodes only carry source ids.

const SNAPSHOT_MAX = 300 * 1024;
const SNAPSHOT_TOTAL = 200 * 1024 * 1024;

const sourceId = (url) => `s_${sha(url, 'sha1').slice(0, 12)}`;

class Evidence {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    this.sources = new Map();
    for (const s of readLines(path.join(dir, 'sources.jsonl'))) { if (!s || !s.id) continue; if (s.removed) this.sources.delete(s.id); else this.sources.set(s.id, s); }
    this.domains = readJson(path.join(dir, 'domains.json'), { lists: { deny: null, trusted: null }, stats: {} });
    if (!this.domains.stats) this.domains.stats = {};
    if (!this.domains.lists) this.domains.lists = { deny: null, trusted: null };
    this.review = readJson(path.join(dir, 'review.json'), []);
    if (!Array.isArray(this.review)) this.review = [];
    this.edges = readJson(path.join(dir, 'edges.json'), {});
  }

  // ---- sources ------------------------------------------------------------------------------
  putSource(rec) {
    const id = rec.id || sourceId(rec.url);
    const prev = this.sources.get(id) || {};
    const next = { ...prev, ...rec, id };
    this.sources.set(id, next);
    appendLine(path.join(this.dir, 'sources.jsonl'), next);
    return next;
  }

  getSource(id) { return this.sources.get(id) || null; }

  // Forget a fetched page: its record and its cleaned snapshot (unless another source shares it).
  forgetSource(id) {
    const s = this.sources.get(id);
    if (!s) return false;
    this.sources.delete(id);
    appendLine(path.join(this.dir, 'sources.jsonl'), { id, removed: true, at: new Date().toISOString() });
    if (s.hash && ![...this.sources.values()].some((x) => x.hash === s.hash)) { try { fs.unlinkSync(path.join(this.dir, 'snapshots', `${s.hash}.md`)); } catch { /* already gone */ } }
    return true;
  }
  sourceByUrl(url) { return this.sources.get(sourceId(url)) || null; }

  snapshot(hash, markdown) {
    if (!hash || !markdown) return null;
    const file = path.join(this.dir, 'snapshots', `${hash}.md`);
    if (!fs.existsSync(file)) {
      writeAtomic(file, markdown.slice(0, SNAPSHOT_MAX));
      this._pruneSnapshots();
    }
    return `snapshots/${hash}.md`;
  }

  readSnapshot(hash) {
    try { return fs.readFileSync(path.join(this.dir, 'snapshots', `${hash}.md`), 'utf8'); } catch { return null; }
  }

  _pruneSnapshots() {
    if (Math.random() > 0.05) return; // amortised
    const dir = path.join(this.dir, 'snapshots');
    const files = fs.readdirSync(dir).map((f) => { const st = fs.statSync(path.join(dir, f)); return { f, size: st.size, t: st.mtimeMs }; });
    let total = files.reduce((s, x) => s + x.size, 0);
    for (const x of files.sort((a, b) => a.t - b.t)) {
      if (total <= SNAPSHOT_TOTAL) break;
      fs.unlinkSync(path.join(dir, x.f));
      total -= x.size;
    }
  }

  // ---- domains / circuit breaker ----------------------------------------------------------------
  _saveDomains() { writeJson(path.join(this.dir, 'domains.json'), this.domains); }

  lists(defaults) {
    const l = this.domains.lists || {};
    return { deny: Array.isArray(l.deny) ? l.deny : defaults.deny, trusted: Array.isArray(l.trusted) ? l.trusted : defaults.trusted };
  }

  setLists({ deny, trusted }) {
    const clean = (arr) => [...new Set((arr || []).map((d) => String(d).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 500);
    if (deny) this.domains.lists.deny = clean(deny);
    if (trusted) this.domains.lists.trusted = clean(trusted);
    this._saveDomains();
  }

  domainStat(domain) {
    if (!this.domains.stats[domain]) this.domains.stats[domain] = { pages: 0, blocks: 0, blockedUntil: 0, lastStatus: null };
    return this.domains.stats[domain];
  }

  isBlocked(domain, now = Date.now()) { const s = this.domains.stats[domain]; return Boolean(s && s.blockedUntil > now); }

  // Exponential cooldown: 10 min, 20, 40 … capped at 24 h. Never retried within the cooldown.
  trip(domain, reason, now = Date.now()) {
    const s = this.domainStat(domain);
    s.blocks += 1;
    s.blockedUntil = now + Math.min(24 * 3600e3, 10 * 60e3 * 2 ** (s.blocks - 1));
    s.lastReason = reason;
    this._saveDomains();
    return s.blockedUntil;
  }

  // Consecutive blocks; any successful page resets the count. → the new count.
  noteBlock(domain, reason) { const s = this.domainStat(domain); s.consecutive = (s.consecutive || 0) + 1; s.lastReason = reason; return s.consecutive; }
  noteOk(domain) { const s = this.domains.stats[domain]; if (s && s.consecutive) s.consecutive = 0; }

  unblock(domain) { const s = this.domains.stats[domain]; if (s) { s.blockedUntil = 0; s.blocks = 0; this._saveDomains(); } }

  notePage(domain, status) { const s = this.domainStat(domain); s.pages += 1; s.lastStatus = status; }

  blockedList(now = Date.now()) {
    return Object.entries(this.domains.stats).filter(([, s]) => s.blockedUntil > now).map(([domain, s]) => ({ domain, until: new Date(s.blockedUntil).toISOString(), blocks: s.blocks, reason: s.lastReason || '' }));
  }

  flushDomains() { this._saveDomains(); }

  // ---- review queue -----------------------------------------------------------------------------
  _saveReview() { writeJson(path.join(this.dir, 'review.json'), this.review.slice(-2000)); }

  addReview(item) {
    const key = item.key || null;
    if (key && this.review.some((r) => r.key === key && r.status === 'open')) return null;
    const rec = { id: `r_${crypto.randomBytes(5).toString('hex')}`, status: 'open', createdAt: new Date().toISOString(), ...item };
    this.review.push(rec);
    this._saveReview();
    return rec;
  }

  getReview(id) { return this.review.find((r) => r.id === id) || null; }

  updateReview(id, patch) {
    const r = this.getReview(id);
    if (!r) return null;
    Object.assign(r, patch);
    this._saveReview();
    return r;
  }

  // Replace batch refs with the real node ids once a commit has assigned them.
  resolveRefs(refMap) {
    const fix = (v) => (typeof v === 'string' && refMap[v] ? refMap[v] : v);
    let changed = false;
    for (const r of this.review) {
      if (r.status !== 'open') continue;
      for (const op of [...(r.ops || []), ...(r.altOps || [])]) {
        for (const k of ['id', 'parent', 'from', 'to']) { const v = fix(op[k]); if (v !== op[k]) { op[k] = v; changed = true; } }
        for (const l of op.links || []) { const v = fix(l.to); if (v !== l.to) { l.to = v; changed = true; } }
      }
    }
    if (changed) this._saveReview();
  }

  openReviews() { return this.review.filter((r) => r.status === 'open'); }

  // ---- logs -------------------------------------------------------------------------------------
  logMerge(rec) { appendLine(path.join(this.dir, 'merge_log.jsonl'), { at: new Date().toISOString(), ...rec }); }
  addLabel(rec) { appendLine(path.join(this.dir, 'labels.jsonl'), { at: new Date().toISOString(), ...rec }); }
  labels(kind) { return readLines(path.join(this.dir, 'labels.jsonl')).filter((l) => !kind || l.kind === kind); }

  // ---- edge evidence (distinct origins) ----------------------------------------------------------
  // Returns how many DISTINCT origins support the edge after adding this one. An origin is a domain;
  // a page that is a near-duplicate of evidence already counted (syndication) adds nothing.
  addEdgeEvidence(key, { domain, simhash, sourceId: sid }, nearDuplicate) {
    const e = this.edges[key] || (this.edges[key] = { origins: [] });
    const dup = e.origins.some((o) => o.domain === domain || (simhash && o.simhash && nearDuplicate(o.simhash, simhash)));
    if (!dup) e.origins.push({ domain, simhash, sourceId: sid });
    if (e.origins.length > 20) e.origins = e.origins.slice(-20);
    return { n: e.origins.length, added: !dup, sources: e.origins.map((o) => o.sourceId) };
  }

  edgeOrigins(key) { return (this.edges[key] && this.edges[key].origins) || []; }

  flushEdges() { writeJson(path.join(this.dir, 'edges.json'), this.edges); }

  // ---- sessions -----------------------------------------------------------------------------------
  saveSession(s) { writeJson(path.join(this.dir, 'sessions', `${s.id}.json`), s); }
  loadSession(id) { return /^w_[a-f0-9]{8,16}$/.test(id) ? readJson(path.join(this.dir, 'sessions', `${id}.json`), null) : null; }

  listSessions(limit = 20) {
    const dir = path.join(this.dir, 'sessions');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit)
      .map((s) => ({ id: s.id, seed: s.seed, mode: s.mode, status: s.status, startedAt: s.startedAt, stats: s.stats }));
  }
}

module.exports = { Evidence, sourceId };
