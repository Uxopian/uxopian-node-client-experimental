// Offline unit tests for lib/testkit.mjs — the package-embedded functional-test harness
// (DESIGN §24): fixture namespacing, tracked LIFO teardown, waitFor, requires pre-flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintId, makeRunId, createHarness, checkRequires, TestFail, TEST_ID_PREFIX } from '../lib/testkit.mjs';
import { tag } from '../lib/util.mjs';

/** ctx with scripted clients; records every mutating call. */
function mockCtx({ docs = {}, providers = [], promptsOk = true } = {}) {
  const calls = [];
  const core = {
    calls,
    getDoc: async (id) => docs[id] ?? null,
    getOne: async (path) => {
      const id = decodeURIComponent(path.split('/').pop());
      return docs[id] ?? null;
    },
    upsertDoc: async (doc, files = []) => { calls.push(['upsert', doc.id, files.length]); ctx.lastFiles = files; return { action: 'created', id: doc.id }; },
    del: async (path) => { calls.push(['del', path]); return {}; },
    put: async (path, body) => { calls.push(['put', path, body]); return {}; },
    search: async () => ({ found: 0, results: [] }),
  };
  const gateway = {
    get: async (path) => {
      if (path.includes('llm/provider-conf')) return providers;
      if (path.includes('prompts')) { if (!promptsOk) throw new Error('gateway down'); return []; }
      return [];
    },
  };
  const ctx = {
    calls,
    lastFiles: [],
    target: { name: 'mock', scope: 'S' },
    clients: { core, gateway, gui: {} },
    pkg: { manifest: { code: 'tp' }, registry: { resources: [{ kind: 'fd.tagclass', id: 'TpX', path: 'x.json' }] } },
  };
  return ctx;
}

test('mintId: namespaced, sanitized, run-scoped', () => {
  const run = makeRunId();
  assert.match(run, /^[0-9a-f]{8}$/);
  assert.equal(mintId('ct', 'nda-1', run), `ZZTEST_CT_nda1_${run}`);
  assert.equal(mintId('ct', '', run), `ZZTEST_CT_fx_${run}`);
  assert.ok(mintId('ct', 'x'.repeat(40), run).length < 40 + 20);
});

test('doc.create: mints + tracks; REFUSES ids outside the namespace; file bytes uploaded', async () => {
  const ctx = mockCtx();
  const { t, teardown } = createHarness(ctx, { runId: 'aabbccdd', testsDir: '/nope' });
  const echo = await t.doc.create({ classId: 'CtContract', tags: { CtTypeCode: 'NDA' }, file: { bytes: Buffer.from('hello'), filename: 'a.txt' } });
  assert.match(echo.id, new RegExp(`^${TEST_ID_PREFIX}_TP_Contract_aabbccdd$`));
  assert.deepEqual(ctx.calls[0], ['upsert', echo.id, 1]);
  assert.equal(ctx.lastFiles[0].mime, 'text/plain');       // inferred from .txt (a wrong mime stalls server extractors)
  const echo2 = await t.doc.create({ classId: 'CtContract', file: { bytes: Buffer.from('x'), filename: 'b.bin' }, mime: 'text/plain' });
  assert.equal(ctx.lastFiles[0].mime, 'text/plain');       // explicit option wins over the .bin fallback
  assert.equal(echo2.id, `${TEST_ID_PREFIX}_TP_Contract2_aabbccdd`); // same hint twice -> distinct ids (never collide)
  assert.equal(echo.tags[0].name, 'CtTypeCode');
  await assert.rejects(() => t.doc.create({ classId: 'X', id: 'REAL_DOC' }), /outside the ZZTEST_ namespace/);
  await assert.rejects(() => t.doc.create({}), /classId is required/);
  // teardown deletes the tracked doc (REAL_DOC was refused BEFORE tracking)
  const td = await teardown({});
  assert.deepEqual(td.deleted, [`doc/${echo2.id}`, `doc/${echo.id}`]); // LIFO
  assert.ok(!ctx.calls.some(([op, p]) => op === 'del' && String(p).includes('REAL_DOC')));
});

test('teardown: LIFO order, tasks vs docs, per-item failure tolerance, keep mode', async () => {
  const ctx = mockCtx();
  ctx.clients.core.del = async (path) => {
    ctx.calls.push(['del', path]);
    if (path.includes('BOOM')) throw new Error('cannot delete');
    if (path.includes('GONE')) { const e = new Error('F00012 component does not exist'); throw e; }
    return {};
  };
  const { t, teardown } = createHarness(ctx, { runId: 'r', testsDir: '/nope' });
  let fnRan = false;
  t.track('doc', 'ZZTEST_TP_a_r');
  t.cleanup(() => { fnRan = true; }, 'custom');
  t.track('task', 'ZZTEST_TP_task_r');
  t.track('doc', 'ZZTEST_TP_BOOM_r');
  t.track('doc', 'ZZTEST_TP_GONE_r');
  const td = await teardown({});
  assert.equal(fnRan, true);
  const dels = ctx.calls.filter(([op]) => op === 'del').map(([, p]) => p);
  assert.match(dels[0], /GONE/);                       // LIFO: last tracked, first deleted
  assert.match(dels[1], /BOOM/);
  assert.match(dels[2], /\/rest\/tasks\/ZZTEST_TP_task_r/); // tasks use the task endpoint
  assert.equal(td.failed.length, 1);                   // BOOM survives, loudly
  assert.match(td.failed[0].key, /BOOM/);
  assert.ok(td.deleted.some((k) => /GONE/.test(k)));   // already-absent counts as clean
  // keep mode: nothing deleted, everything reported kept
  const h2 = createHarness(ctx, { runId: 'r2', testsDir: '/nope' });
  h2.t.track('doc', 'ZZTEST_TP_keepme_r2');
  const kept = await h2.teardown({ keep: true });
  assert.deepEqual(kept.kept, ['doc/ZZTEST_TP_keepme_r2']);
  assert.equal(t.track.length, 2); // (kind, id)
  assert.throws(() => h2.t.track('vf', 'x'), /unknown kind/);
});

test('waitFor: returns truthy value, tolerates probe throws, times out with label', async () => {
  const ctx = mockCtx();
  const { t } = createHarness(ctx, { runId: 'r', testsDir: '/nope' });
  let n = 0;
  const v = await t.waitFor(() => { n++; if (n < 3) throw new Error('search lag'); return { hit: n }; },
    { everyMs: 5, timeoutMs: 1_000, label: 'x' });
  assert.equal(v.hit, 3);
  await assert.rejects(
    () => t.waitFor(() => false, { everyMs: 5, timeoutMs: 40, label: 'clauses extracted' }),
    (e) => e instanceof TestFail && /waiting for: clauses extracted/.test(e.message));
});

test('expect/fail throw TestFail; answerTask hits the answer endpoint', async () => {
  const ctx = mockCtx();
  const { t } = createHarness(ctx, { runId: 'r', testsDir: '/nope' });
  assert.equal(t.expect(1, 'ok'), 1);
  assert.throws(() => t.expect(false, 'no clauses'), /no clauses/);
  assert.throws(() => t.fail('boom'), TestFail);
  await t.answerTask('T1', 'APPROVE');
  assert.deepEqual(ctx.calls.at(-1), ['put', '/rest/tasks/T1/answer', { id: 'APPROVE' }]);
});

test('checkRequires: resources (registry + server), docs, llmProvider, gateway reachability', async () => {
  // resource present on server (fd.tagclass GET-by-id -> docs map)
  const ok = await checkRequires(mockCtx({ docs: { TpX: { id: 'TpX' } } }), { registry: { resources: [{ kind: 'fd.tagclass', id: 'TpX' }] } }, { resources: ['fd.tagclass/TpX'] });
  assert.equal(ok.ok, true);
  // resource missing on server
  const miss = await checkRequires(mockCtx(), { registry: { resources: [{ kind: 'fd.tagclass', id: 'TpX' }] } }, { resources: ['fd.tagclass/TpX'] });
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /not deployed/);
  // resource not even in the registry
  const notMine = await checkRequires(mockCtx(), { registry: { resources: [] } }, { resources: ['fd.tagclass/TpX'] });
  assert.match(notMine.reason, /not in this package's registry/);
  // required doc (instance config) absent vs present
  const noDoc = await checkRequires(mockCtx(), {}, { docs: ['CT_CONFIG'] });
  assert.match(noDoc.reason, /CT_CONFIG.*absent/);
  const hasDoc = await checkRequires(mockCtx({ docs: { CT_CONFIG: { id: 'CT_CONFIG' } } }), {}, { docs: ['CT_CONFIG'] });
  assert.equal(hasDoc.ok, true);
  // llm provider
  const noLlm = await checkRequires(mockCtx(), {}, { llmProvider: true });
  assert.match(noLlm.reason, /none configured/);
  const llm = await checkRequires(mockCtx({ providers: [{ id: 'openai' }] }), {}, { llmProvider: true });
  assert.equal(llm.ok, true);
  // gateway down -> uxopian-ai product unmet
  const down = await checkRequires(mockCtx({ promptsOk: false }), {}, { products: ['uxopian-ai'] });
  assert.match(down.reason, /gateway unreachable/);
});

test('checkRequires caps: resolved from the pinned dialect, mismatches skip', async () => {
  const ctx = mockCtx();
  ctx.target = { name: 'mock', scope: 'S', aiVersion: '2026.7.0' }; // pin -> no network probe
  const good = await checkRequires(ctx, {}, { caps: { 'uxopian-ai': { adminPromptList: true } } });
  assert.equal(good.ok, true, good.reason);
  const bad = await checkRequires(ctx, {}, { caps: { 'uxopian-ai': { neverSuchCap: true } } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /neverSuchCap/);
});

test('checkRequires: a transient read error is retried; a persistent one says "could not check", never "not deployed"', async () => {
  const pkg = { registry: { resources: [{ kind: 'fd.tagclass', id: 'TpX' }] } };
  // 1) two 429s then success -> ok
  const flaky = mockCtx({ docs: { TpX: { id: 'TpX' } } });
  flaky.requiresBackoffMs = [1, 1];
  const real = flaky.clients.core.getOne;
  let n = 0;
  flaky.clients.core.getOne = async (p) => { if (++n <= 2) throw new Error('HTTP 429 slow down'); return real(p); };
  assert.equal((await checkRequires(flaky, pkg, { resources: ['fd.tagclass/TpX'] })).ok, true);
  assert.equal(n, 3);
  // 2) always failing -> honest reason
  const down = mockCtx({ docs: { TpX: { id: 'TpX' } } });
  down.requiresBackoffMs = [1, 1];
  down.target = { name: 'gfdefault' };
  let m = 0;
  down.clients.core.getOne = async () => { m++; throw new Error('HTTP 503'); };
  const r = await checkRequires(down, pkg, { resources: ['fd.tagclass/TpX'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not check fd\.tagclass\/TpX on gfdefault: .*503/);
  assert.doesNotMatch(r.reason, /not deployed/);
  assert.equal(m, 3);
  // 3) same for required documents
  const d = mockCtx();
  d.requiresBackoffMs = [1];
  d.clients.core.getDoc = async () => { throw new Error('timeout'); };
  assert.match((await checkRequires(d, {}, { docs: ['CT_CONFIG'] })).reason, /could not check document CT_CONFIG/);
});

// #115 — a required resource the package does not carry resolves through its dependencies' receipts
const receiptDoc = (code, version, resources) => ({
  id: `UXC_PKG_${code.toUpperCase()}`,
  tags: [tag('UxcPackageCode', code), tag('UxcPackageVersion', version),
    ...(resources ? [tag('UxcResources', resources.join(','))] : [])],
});
/** mockCtx whose FlowerDocs search returns the given receipt docs (AI surface: no receipts). */
function depCtx({ receipts = [], docs = {}, searchError = null } = {}) {
  const all = { ...docs };
  for (const r of receipts) all[r.id] = r;
  const ctx = mockCtx({ docs: all });
  ctx.target = { name: 'gfdefault', scope: 'S' };
  ctx.requiresBackoffMs = [1, 1];
  ctx.clients.core.search = async () => {
    if (searchError) throw new Error(searchError);
    return { found: receipts.length, results: receipts.map((r) => ({ id: r.id })) };
  };
  return ctx;
}
const ext = { manifest: { code: 'pom', dependencies: { cm: '>=0.4' } }, registry: { resources: [] } };
const KEY = 'fd.tagclass/CmEmail';

test('checkRequires #115: a dependency\'s receipt listing the resource -> checked on the server', async () => {
  const ok = await checkRequires(depCtx({ receipts: [receiptDoc('cm', '0.4.0', [KEY])], docs: { CmEmail: { id: 'CmEmail' } } }), ext, { resources: [KEY] });
  assert.equal(ok.ok, true, ok.reason);
  // listed by the dependency but absent on the server: the reason names the dependency
  const gone = await checkRequires(depCtx({ receipts: [receiptDoc('cm', '0.4.0', [KEY])] }), ext, { resources: [KEY] });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /requires fd\.tagclass\/CmEmail: listed by dependency cm@0\.4\.0 but not deployed on gfdefault/);
  // a pre-list receipt (no UxcResources) is trusted; the server check decides
  const old = await checkRequires(depCtx({ receipts: [receiptDoc('cm', '0.3.0', null)], docs: { CmEmail: { id: 'CmEmail' } } }), ext, { resources: [KEY] });
  assert.equal(old.ok, true, old.reason);
});

test('checkRequires #115: skips name the dependency — not listed, not installed, no dependency at all', async () => {
  const notListed = await checkRequires(depCtx({ receipts: [receiptDoc('cm', '0.4.0', ['fd.tagclass/CmOther'])], docs: { CmEmail: { id: 'CmEmail' } } }), ext, { resources: [KEY] });
  assert.equal(notListed.reason, 'requires fd.tagclass/CmEmail: dependency cm@0.4.0 is installed but does not list it');
  const notInstalled = await checkRequires(depCtx(), ext, { resources: [KEY] });
  assert.equal(notInstalled.reason, 'requires fd.tagclass/CmEmail: dependency cm not installed on gfdefault');
  const noDeps = await checkRequires(depCtx(), { manifest: { code: 'pom' }, registry: { resources: [] } }, { resources: [KEY] });
  assert.match(noDeps.reason, /not in this package's registry \(and it declares no dependencies\)/);
  // its own code listed as a dependency is a self-reference, not a dependency
  const self = await checkRequires(depCtx(), { manifest: { code: 'pom', dependencies: { pom: '*' } }, registry: { resources: [] } }, { resources: [KEY] });
  assert.match(self.reason, /declares no dependencies/);
});

test('checkRequires #115: unreadable receipts are retried, then "could not check" — never "not installed"', async () => {
  const ctx = depCtx({ searchError: 'HTTP 503' });
  let probes = 0;
  ctx.clients.core.getOne = async () => { probes++; throw new Error('HTTP 503'); }; // class probe fails too
  const r = await checkRequires(ctx, ext, { resources: [KEY] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not check fd\.tagclass\/CmEmail on gfdefault: receipts unreadable \(flowerdocs: HTTP 503/);
  assert.doesNotMatch(r.reason, /not installed/);
  assert.equal(probes, 3); // first read + 2 retries
  // the receipts are read once per run: a second requirement re-uses them
  const again = await checkRequires(ctx, ext, { resources: ['fd.tagclass/CmOther'] });
  assert.match(again.reason, /could not check fd\.tagclass\/CmOther/);
  assert.equal(probes, 3);
});

// #125 — a required fd.dataset owned by a dependency: definition from the dependency's receipt
// (uxc-receipt.json `dataSets`), then the class + the dependency's rows checked on the server
const DS_KEY = 'fd.dataset/CmTransitions';
function dsCtx({ content = undefined, classes = ['CmTransitionsClass'], rows = [] } = {}) {
  const rc = receiptDoc('cm', '0.5.0', [DS_KEY]);
  if (content !== undefined) rc.files = [{ id: 'f1' }];
  const ctx = depCtx({ receipts: [rc, receiptDoc('pom', '1.0.0', null)] });
  const core = ctx.clients.core;
  core.getContent = async () => Buffer.from(JSON.stringify(content));
  const getOne = core.getOne;
  core.getOne = async (path) => (/\/rest\/documentclass\//.test(path)
    ? (classes.includes(decodeURIComponent(path.split('/').pop())) ? { id: decodeURIComponent(path.split('/').pop()) } : null)
    : getOne(path));
  const search = core.search;
  core.search = async (q) => (q.classId === 'UxcPackage' ? search(q)
    : { found: rows.length, results: rows.slice(q.start ?? 0, (q.start ?? 0) + (q.max ?? 200)).map((id) => ({ id })) });
  return ctx;
}
const extDs = { manifest: { code: 'pom', dependencies: { cm: '>=0.4' }, dataSets: [{ name: 'PoTransitions', classId: 'CmTransitionsClass', path: 'data/PoTransitions.jsonl' }] }, registry: { resources: [{ kind: 'fd.dataset', id: 'PoTransitions' }] } };
const DEFS = { kind: 'uxc-receipt-content/1', dataSets: [{ name: 'CmTransitions', classId: 'CmTransitionsClass', path: 'data/CmTransitions.jsonl' }] };

test('checkRequires #125: a dependency\'s dataset resolves through its receipt — class present + its rows -> ok', async () => {
  const ok = await checkRequires(dsCtx({ content: DEFS, rows: ['PomTransitions_A', 'CmTransitions_OPEN'] }), extDs, { resources: [DS_KEY] });
  assert.equal(ok.ok, true, ok.reason);
  // only the extension's own rows in the class: the dependency's dataset is not there
  const onlyOurs = await checkRequires(dsCtx({ content: DEFS, rows: ['PomTransitions_A', 'POM_B'] }), extDs, { resources: [DS_KEY] });
  assert.equal(onlyOurs.reason, 'requires fd.dataset/CmTransitions: class CmTransitionsClass holds no rows of dependency cm@0.5.0 on gfdefault — push the dependency\'s dataset');
  // an unprefixed row is the dependency's (§31: unprefixed -> the owner reading it)
  assert.equal((await checkRequires(dsCtx({ content: DEFS, rows: ['LEGACY_ROW'] }), extDs, { resources: [DS_KEY] })).ok, true);
  // the class itself is absent
  const noClass = await checkRequires(dsCtx({ content: DEFS, classes: [] }), extDs, { resources: [DS_KEY] });
  assert.match(noClass.reason, /class CmTransitionsClass \(dataset of dependency cm@0\.5\.0\) is not on gfdefault/);
  // never the old "has no manifest" — the package's own dataset still takes the normal path
  assert.doesNotMatch(String(noClass.reason), /no manifest/);
});

test('checkRequires #125: an old receipt (no dataSets) skips with the re-push reason; a receipt without the name says so', async () => {
  const old = await checkRequires(dsCtx({ rows: ['CmTransitions_OPEN'] }), extDs, { resources: [DS_KEY] });
  assert.equal(old.reason, 'requires fd.dataset/CmTransitions: dependency cm@0.5.0 installed by a uxc older than 0.25.1: re-push it to record its datasets');
  const fileNoDefs = await checkRequires(dsCtx({ content: { kind: 'uxc-receipt-content/1', resourceHashes: { a: 'b' } } }), extDs, { resources: [DS_KEY] });
  assert.match(fileNoDefs.reason, /older than 0\.25\.1/);
  const other = await checkRequires(dsCtx({ content: { kind: 'uxc-receipt-content/1', dataSets: [{ name: 'CmOther', classId: 'X' }] } }), extDs, { resources: [DS_KEY] });
  assert.equal(other.reason, 'requires fd.dataset/CmTransitions: dependency cm@0.5.0 defines no dataset "CmTransitions" in its receipt');
});

test('checkRequires #125: a throwing search is "could not check", after the retries', async () => {
  const ctx = dsCtx({ content: DEFS });
  let n = 0;
  const search = ctx.clients.core.search;
  ctx.clients.core.search = async (q) => { if (q.classId === 'UxcPackage') return search(q); n++; throw new Error('HTTP 503'); };
  const r = await checkRequires(ctx, extDs, { resources: [DS_KEY] });
  assert.match(r.reason, /could not check fd\.dataset\/CmTransitions on gfdefault: HTTP 503/);
  assert.equal(n, 3);
});
