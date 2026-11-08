'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const S = require('../lib/schema');
const { runOps } = require('../lib/ops');
const { Store } = require('../lib/store');
const { createApp } = require('../server');
const groq = require('../lib/groq');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
function baseTree() {
  const t = { version: 1, rev: 1, nodes: {} };
  const add = (n) => { t.nodes[n.id] = n; return n; };
  const companies = add(S.blankNode({ id: 'n_companies', type: 'area', title: 'Companies' }));
  const people = add(S.blankNode({ id: 'n_people', type: 'area', title: 'People' }));
  const razor = add(S.blankNode({ id: 'n_razor', parentId: companies.id, type: 'company', title: 'Razorpay' }));
  return { t, companies, people, razor };
}

test('text() strips control chars and caps length', () => {
  assert.equal(S.text('a\u0000b‮c', 10), 'abc');
  assert.equal(S.text('x'.repeat(500), 20).length, 20);
  assert.equal(S.text({ a: 1 }, 20), '');
});

test('field kinds are detected', () => {
  assert.equal(S.detectKind('Contact', '+91 98765 43210'), 'phone');
  assert.equal(S.detectKind('Reach', 'a@b.io'), 'email');
  assert.equal(S.detectKind('Page', 'https://x.com/y'), 'url');
  assert.equal(S.detectKind('Next', '2026-11-05'), 'date');
  assert.equal(S.detectKind('Office address', 'MG Road, Bengaluru'), 'address');
});

test('validateTree rejects cycles and missing parents', () => {
  const { t } = baseTree();
  t.nodes.n_companies.parentId = 'n_razor';
  assert.throws(() => S.validateTree(t), /cycle/);
  t.nodes.n_companies.parentId = 'nope';
  assert.throws(() => S.validateTree(t), /missing parent/);
});

test('create nests under an existing parent and resolves refs', () => {
  const { t } = baseTree();
  const { tree, stats, report } = runOps(t, [
    { op: 'create', ref: 'c1', parent: 'n_companies', type: 'Startup', title: 'Zeta', fields: [{ key: 'Address', value: 'Mumbai' }] },
    { op: 'create', ref: 'p1', parent: 'c1', type: 'hr', title: 'Priya Shah', fields: { Phone: '+91 98111 22233', Email: 'priya@zeta.in' }, pros: ['Responsive'], followUp: '2026-11-05' },
  ]);
  assert.equal(stats.created, 2);
  const zeta = Object.values(tree.nodes).find((n) => n.title === 'Zeta');
  const priya = Object.values(tree.nodes).find((n) => n.title === 'Priya Shah');
  assert.equal(zeta.type, 'company');
  assert.equal(priya.parentId, zeta.id);
  assert.deepEqual(priya.fields.map((f) => f.kind).sort(), ['email', 'phone']);
  assert.equal(priya.followUp, '2026-11-05');
  assert.deepEqual(report[1].dependsOn, [0]);
  assert.match(zeta.id, /^n_[0-9a-f]{12}$/);
});

test('duplicates merge instead of creating twins, and nothing is overwritten', () => {
  const { t, razor } = baseTree();
  razor.fields.push({ id: 'f_aaaaaa', key: 'Phone', value: '+91 90000 00001', kind: 'phone' });
  razor.summary = 'Payments company';
  const { tree, stats, report } = runOps(t, [
    { op: 'create', parent: 'n_companies', type: 'company', title: 'Razorpay Pvt Ltd', summary: 'Fintech', fields: [{ key: 'Phone', value: '090000 00001' }, { key: 'Phone', value: '+91 80000 00002' }], tags: ['Fintech'] },
  ]);
  assert.equal(stats.created, 0);
  assert.equal(stats.merged, 1);
  const r = tree.nodes.n_razor;
  assert.equal(r.summary, 'Payments company');           // kept
  assert.match(r.notes, /Update: Fintech/);              // new summary preserved as a note
  assert.equal(r.fields.length, 2);                       // same phone skipped, new phone added alongside
  assert.match(report[0].changes.find((c) => c.kind === 'field').note, /kept/);
  assert.deepEqual(r.tags, ['fintech']);
  assert.equal(Object.keys(tree.nodes).length, Object.keys(t.nodes).length);
});

test('people with the same name under different parents are created but flagged', () => {
  const { t } = baseTree();
  runOps(t, [{ op: 'create', parent: 'n_people', type: 'person', title: 'Rahul' }], { inPlace: true });
  const { stats, report } = runOps(t, [{ op: 'create', parent: 'n_razor', type: 'person', title: 'Rahul' }]);
  assert.equal(stats.created, 1);
  assert.match(report[0].warnings[0], /already exists/);
});

test('unsafe operations are refused', () => {
  const { t } = baseTree();
  const before = JSON.stringify(t);
  const { stats, report } = runOps(t, [
    { op: 'delete', id: 'n_razor' },
    { op: 'update', id: 'does_not_exist', summary: 'x' },
    { op: 'create', parent: 'ghost', title: 'Orphan' },
    { op: 'link', from: 'n_razor', to: 'n_razor' },
    'nonsense', null,
  ]);
  assert.equal(stats.changed, 0);
  assert.ok(report.every((r) => r.status === 'skipped'));
  assert.equal(JSON.stringify(t), before); // input tree untouched
});

test('parent can be matched by title when the model returns a name instead of an id', () => {
  const { t } = baseTree();
  const { tree, report } = runOps(t, [{ op: 'create', parent: 'Razorpay', type: 'person', title: 'Asha' }]);
  const asha = Object.values(tree.nodes).find((n) => n.title === 'Asha');
  assert.equal(asha.parentId, 'n_razor');
  assert.match(report[0].warnings[0], /matched/);
});

test('deselecting a parent operation also blocks its children', () => {
  const { t } = baseTree();
  const ops = [
    { op: 'create', ref: 'a', parent: 'n_companies', type: 'company', title: 'Acme' },
    { op: 'create', ref: 'b', parent: 'a', type: 'person', title: 'Bob' },
    { op: 'create', parent: 'n_people', type: 'person', title: 'Cara' },
  ];
  const { tree, report } = runOps(t, ops, { accepted: new Set([1, 2]) });
  assert.equal(Object.values(tree.nodes).some((n) => n.title === 'Bob'), false);
  assert.equal(Object.values(tree.nodes).some((n) => n.title === 'Cara'), true);
  assert.match(report[1].skipped, /Depends/);
});

test('hostile text stays inert data and limits hold', () => {
  const { t } = baseTree();
  const { tree } = runOps(t, [{ op: 'create', parent: null, type: '<script>', title: '<img src=x onerror=alert(1)>', notes: 'y'.repeat(50000), tags: new Array(100).fill(0).map((_, i) => `t${i}`) }]);
  const n = Object.values(tree.nodes).find((x) => x.title.startsWith('<img'));
  assert.equal(n.title, '<img src=x onerror=alert(1)>'); // stored as text; the UI only renders with textContent
  assert.equal(n.type, 'script');
  assert.ok(n.notes.length <= S.LIMITS.notes);
  assert.ok(n.tags.length <= S.LIMITS.tags);
});

test('sanitizeTree repairs imports', () => {
  const tree = S.sanitizeTree({ nodes: [
    { id: 'a', parentId: 'b', title: 'A', evil: 'x' },
    { id: 'b', parentId: 'a', title: 'B' },
    { id: 'c', parentId: 'missing', title: 'C', links: [{ to: 'a', relation: 'knows' }, { to: 'zzz' }] },
  ] });
  assert.equal(Object.keys(tree.nodes).length, 3);
  assert.equal(tree.nodes.c.parentId, null);
  assert.equal(tree.nodes.c.links.length, 1);
  assert.equal('evil' in tree.nodes.a, false);
  S.validateTree(tree);
});

test('store: atomic save, undo, coalescing, corruption recovery', async () => {
  const dir = tmp();
  const store = new Store(dir).init();
  const startCount = Object.keys(store.get().nodes).length;
  assert.equal(startCount, 6);
  const id = await store.mutate('Add', (t) => { const n = S.blankNode({ title: 'X' }); t.nodes[n.id] = n; return n.id; });
  assert.equal(Object.keys(store.get().nodes).length, 7);
  await store.mutate('Edit', (t) => { t.nodes[id].title = 'Y'; }, { coalesce: `e:${id}` });
  await store.mutate('Edit', (t) => { t.nodes[id].title = 'Z'; }, { coalesce: `e:${id}` });
  assert.equal(fs.readdirSync(path.join(dir, 'history')).length, 2); // second edit coalesced
  await assert.rejects(store.mutate('Bad', (t) => { t.nodes[id].parentId = id; }));
  assert.equal(store.get().nodes[id].title, 'Z'); // failed mutation changed nothing
  assert.equal(await store.undo(), 'Edit');
  assert.equal(store.get().nodes[id].title, 'X');
  assert.equal(await store.undo(), 'Add');
  assert.equal(Object.keys(store.get().nodes).length, 6);
  assert.equal(await store.undo(), null);
  // corrupt file recovery
  await store.mutate('Add', (t) => { const n = S.blankNode({ title: 'Keep' }); t.nodes[n.id] = n; });
  fs.writeFileSync(path.join(dir, 'tree.json'), '{ broken');
  const again = new Store(dir).init();
  assert.ok(Object.keys(again.get().nodes).length >= 6);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('tree.corrupt-')));
});

test('parseLoose handles fences, prose and think tags', () => {
  assert.deepEqual(groq.parseLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(groq.parseLoose('<think>hmm {x}</think> Sure! {"a":2} done'), { a: 2 });
  assert.throws(() => groq.parseLoose('no json here'));
});

// ---- Full HTTP flow with a fake Groq ---------------------------------------------------------
function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

test('HTTP: capture → preview → apply → undo, against a mock Groq', async () => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, parsed });
      const sys = parsed.messages[0].content;
      const user = parsed.messages[1].content;
      let content;
      if (sys.startsWith('You answer questions')) {
        const id = /(n_[0-9a-f]{12}) \|/.exec(user) ? null : null;
        content = JSON.stringify({ answer: 'Talk to **Priya**.', nodes: ['bogus-id'] });
      } else {
        const companies = /(n_[0-9a-f]{12}) \| area \| Companies/.exec(user)[1];
        content = JSON.stringify({
          reply: 'Added Zeta and Priya.',
          operations: [
            { op: 'create', ref: 'c', parent: companies, type: 'company', title: 'Zeta', fields: [{ key: 'Address', value: 'Mumbai' }] },
            { op: 'create', ref: 'p', parent: 'c', type: 'hr', title: 'Priya', fields: [{ key: 'Phone', value: '+91 98111 22233' }], followUp: '2026-11-05' },
            { op: 'delete', id: companies },
          ],
        });
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const store = new Store(tmp()).init();
  const config = { groqKey: 'test-key', groqModel: 'test-model', groqBase: `http://127.0.0.1:${mock.address().port}`, groqKeyVar: 'GROQ_API_KEY', groqModelVar: 'GROQ_MODEL' };
  const server = await listen(createApp({ store, config }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

  try {
    let r = await call('GET', '/api/status');
    const status = await r.json();
    assert.equal(status.ai.configured, true);
    assert.equal(JSON.stringify(status).includes('test-key'), false);

    r = await call('POST', '/api/ai/propose', { text: 'Met Priya, HR at Zeta, Mumbai. Call 98111 22233.' });
    assert.equal(r.status, 200);
    const prop = await r.json();
    assert.equal(seen[0].auth, 'Bearer test-key');
    assert.equal(seen[0].parsed.model, 'test-model');
    assert.equal(prop.report.length, 3);
    assert.equal(prop.report[2].status, 'skipped'); // delete refused
    assert.equal(prop.stats.created, 2);
    assert.equal(store.get().rev, 1);               // proposal changed nothing

    r = await call('POST', '/api/ai/apply', { proposalId: prop.proposalId, accepted: [0, 1] });
    const applied = await r.json();
    assert.equal(applied.stats.created, 2);
    assert.equal(applied.createdIds.length, 2);
    assert.equal(Object.keys(store.get().nodes).length, 8);

    r = await call('POST', '/api/ai/ask', { question: 'Who should I contact?' });
    const ask = await r.json();
    assert.equal(ask.answer, 'Talk to **Priya**.');
    assert.deepEqual(ask.nodes, []); // unknown ids dropped

    r = await call('POST', '/api/undo');
    assert.equal(r.status, 200);
    assert.equal(Object.keys(store.get().nodes).length, 6);

    // manual routes
    r = await call('POST', '/api/nodes', { parentId: null, title: 'Alpha', type: 'idea' });
    const alpha = await r.json();
    r = await call('POST', '/api/nodes', { parentId: alpha.id, title: 'Beta' });
    const beta = await r.json();
    r = await call('POST', `/api/nodes/${alpha.id}/move`, { parentId: beta.id });
    assert.equal(r.status, 400); // cannot move into own descendant
    r = await call('PATCH', `/api/nodes/${beta.id}`, { fields: [{ key: 'Phone', value: '12345 67890' }], pros: ['a', 'A', 'b'], level: 9 });
    const patched = await r.json();
    assert.equal(patched.fields[0].kind, 'phone');
    assert.deepEqual(patched.pros, ['a', 'b']);
    assert.equal(patched.level, 5);
    r = await call('DELETE', `/api/nodes/${alpha.id}`);
    assert.equal((await r.json()).deleted, 2);

    // guards
    r = await fetch(base + '/api/nodes', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
    r = await call('POST', '/api/nodes', { title: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const rebind = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/tree', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(rebind, 403); // DNS-rebinding style host is refused
  } finally {
    server.close();
    mock.close();
  }
});

test('HTTP: missing key gives a clear error', async () => {
  const store = new Store(tmp()).init();
  const server = await listen(createApp({ store, config: { groqKey: '', groqModel: '' } }));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /GROQ_API_KEY/);
  } finally { server.close(); }
});

test('Groq errors are translated', async () => {
  const mock = http.createServer((req, res) => { res.statusCode = 429; res.setHeader('retry-after', '7'); res.end('{"error":{"message":"slow down"}}'); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const cfg = { groqKey: 'k', groqModel: 'm', groqBase: `http://127.0.0.1:${mock.address().port}` };
  await assert.rejects(groq.capture(cfg, { nodes: {} }, { text: 'x', today: '2026-10-28' }), /7 seconds/);
  mock.close();
});
