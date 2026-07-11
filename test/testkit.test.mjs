// Offline unit tests for lib/testkit.mjs — the package-embedded functional-test harness
// (DESIGN §24): fixture namespacing, tracked LIFO teardown, waitFor, requires pre-flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintId, makeRunId, createHarness, checkRequires, TestFail, TEST_ID_PREFIX } from '../lib/testkit.mjs';

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
