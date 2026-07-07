// Offline unit tests for the duplicate-proofing layer (LEARNINGS §25):
// search is eventually consistent — a lagging/rebuilt index must never make uxc create a second
// live object. State hints are verified by direct GET; exists-errors HEAL into updates; the
// prompt create asserts the server did not silently duplicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRegistrations } from '../lib/kinds/fd-handler.mjs';
import { readServerRows } from '../lib/kinds/fd-dataset.mjs';
import { classKindAdapter } from '../lib/kinds/base.mjs';
import { isExistsError } from '../lib/http.mjs';
import prompt from '../lib/kinds/ai-prompt.mjs';
import { dupBy } from '../lib/commands/doctor.mjs';

/** ctx with a scripted core client; records calls. */
function coreCtx({ searchResults = [], docs = {} } = {}) {
  const calls = [];
  return {
    calls,
    out: { warn: (m) => calls.push(['warn', m]) },
    clients: {
      core: {
        search: async () => { calls.push(['search']); return { found: searchResults.length, results: searchResults }; },
        getDoc: async (id) => { calls.push(['getDoc', id]); return docs[id] ?? null; },
        post: async (p, b) => { calls.push(['post', p, b]); return b; },
        del: async (p) => { calls.push(['del', p]); return {}; },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// fd.handler liveRegistrations — the duplicate-execution fix
// ---------------------------------------------------------------------------

test('liveRegistrations: a state hint invisible to search is recovered by direct GET', async () => {
  const ctx = coreCtx({ searchResults: [], docs: { CtIngest_onCreate_v13: { id: 'CtIngest_onCreate_v13' } } });
  const reg = await liveRegistrations(ctx, 'CtIngest_onCreate', { hints: ['CtIngest_onCreate_v13'] });
  assert.equal(reg.live, 'CtIngest_onCreate_v13'); // rotation now deploys _v14, NOT _v1
  assert.equal(reg.n, 13);
  assert.deepEqual(reg.recovered, ['CtIngest_onCreate_v13']);
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /LAGGING/.test(m))); // loud
});

test('liveRegistrations: hint already visible in search is NOT re-verified (no extra GET)', async () => {
  const ctx = coreCtx({ searchResults: [{ id: 'CtIngest_onCreate_v13' }] });
  const reg = await liveRegistrations(ctx, 'CtIngest_onCreate', { hints: ['CtIngest_onCreate_v13'] });
  assert.equal(reg.live, 'CtIngest_onCreate_v13');
  assert.deepEqual(reg.recovered, []);
  assert.ok(!ctx.calls.some(([k]) => k === 'getDoc'));
});

test('liveRegistrations: dead hint (search empty, GET null) -> no live registration', async () => {
  const ctx = coreCtx({ searchResults: [], docs: {} });
  const reg = await liveRegistrations(ctx, 'CtIngest_onCreate', { hints: ['CtIngest_onCreate_v13'] });
  assert.equal(reg.live, null); // genuinely deleted remotely — fresh _v1 is correct
  assert.deepEqual(reg.recovered, []);
});

test('liveRegistrations: recovered hint merges with search results; max-N wins, rest are orphans', async () => {
  const ctx = coreCtx({
    searchResults: [{ id: 'CtIngest_onCreate_v11' }],
    docs: { CtIngest_onCreate_v13: { id: 'CtIngest_onCreate_v13' } },
  });
  const reg = await liveRegistrations(ctx, 'CtIngest_onCreate', { hints: ['CtIngest_onCreate_v13'] });
  assert.equal(reg.live, 'CtIngest_onCreate_v13');
  assert.deepEqual(reg.orphans, ['CtIngest_onCreate_v11']); // swept by the next rotation
});

test('liveRegistrations: hints not matching the logical _vN pattern are ignored', async () => {
  const ctx = coreCtx({ searchResults: [], docs: { OtherHandler_v2: { id: 'OtherHandler_v2' } } });
  const reg = await liveRegistrations(ctx, 'CtIngest_onCreate', { hints: ['OtherHandler_v2', null] });
  assert.equal(reg.live, null);
  assert.ok(!ctx.calls.some(([k]) => k === 'getDoc')); // pattern-filtered before any GET
});

// ---------------------------------------------------------------------------
// fd.dataset readServerRows — lag recovery (pull must not drop rows)
// ---------------------------------------------------------------------------

test('readServerRows: known rows invisible to search are recovered by direct GET', async () => {
  const ctx = coreCtx({
    searchResults: [],
    docs: { R1: { id: 'R1', name: 'row one', category: 'DOCUMENT', data: { classId: 'CtX' }, tags: [] } },
  });
  const rows = await readServerRows(ctx, { classId: 'CtX' }, { known: ['R1', 'Rgone'] });
  assert.ok(rows.has('R1'));           // recovered — pull will NOT drop it as "deleted on server"
  assert.ok(!rows.has('Rgone'));       // genuinely absent stays absent
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /LAGGING/.test(m)));
});

test('readServerRows: recovered doc of a DIFFERENT class is not merged (stale state id)', async () => {
  const ctx = coreCtx({
    searchResults: [],
    docs: { R1: { id: 'R1', name: 'foreign', category: 'DOCUMENT', data: { classId: 'SomethingElse' }, tags: [] } },
  });
  const rows = await readServerRows(ctx, { classId: 'CtX' }, { known: ['R1'] });
  assert.equal(rows.size, 0);
});

// ---------------------------------------------------------------------------
// exists-error healing
// ---------------------------------------------------------------------------

test('isExistsError matches T00108 / F00903 / already-exist, rejects others', () => {
  assert.ok(isExistsError({ body: { code: 'T00108' }, message: 'x' }));
  assert.ok(isExistsError({ message: 'POST … -> 500: {"code":"F00903","message":"exists"}' }));
  assert.ok(isExistsError({ message: 'Components [X] already exist' }));
  assert.ok(!isExistsError({ message: 'T00104 search engine' }));
  assert.ok(!isExistsError(null));
});

test('classKindAdapter.create heals an exists-race into an update (managed kinds)', async () => {
  const a = classKindAdapter({ kind: 'x.test', dir: 'x', restPath: 'xclass' });
  const calls = [];
  const ctx = {
    target: { user: 'u' },
    out: { warn: (m) => calls.push(['warn', m]) },
    clients: { core: {
      post: async (p, b) => {
        calls.push(['post', p]);
        if (p === '/rest/xclass') throw new Error('500 {"code":"F00903","message":"class already exist"}');
        return b;
      },
      getOne: async () => ({ id: 'X1', data: {} }),
    } },
  };
  await a.create(ctx, { obj: { id: 'X1' } }); // must NOT throw
  assert.deepEqual(calls.filter(([k]) => k === 'post').map(([, p]) => p), ['/rest/xclass', '/rest/xclass/X1']);
  assert.ok(calls.some(([k, m]) => k === 'warn' && /healed/.test(m)));
});

test('classKindAdapter.create does NOT heal pure createOnly kinds (policy bypass)', async () => {
  const a = classKindAdapter({ kind: 'x.test', dir: 'x', restPath: 'xclass', defaultPolicy: 'createOnly' });
  const ctx = {
    target: { user: 'u' },
    clients: { core: { post: async () => { throw new Error('T00108: Components [X1] already exist'); } } },
  };
  await assert.rejects(a.create(ctx, { obj: { id: 'X1' } }), /T00108/);
});

// ---------------------------------------------------------------------------
// ai.prompt create — exists-first + post-create duplicate assertion
// ---------------------------------------------------------------------------

function promptCtx({ list, postOk = true }) {
  const calls = [];
  let lists = 0;
  return {
    calls,
    flags: {},
    clients: { gateway: {
      get: async () => { lists++; return typeof list === 'function' ? list(lists) : list; },
      post: async (p, b) => { calls.push(['post', p, b?.id]); if (!postOk) throw new Error('boom'); },
      put: async (p, b) => { calls.push(['put', p, b?.id]); },
    } },
  };
}

test('ai.prompt create: existing id routes to update (PUT) — POST is never sent', async () => {
  const ctx = promptCtx({ list: [{ id: 'ctX', content: 'old' }] });
  await prompt.create(ctx, { obj: { id: 'ctX', role: 'user', content: 'new' } });
  assert.deepEqual(ctx.calls.map(([k]) => k), ['put']);
});

test('ai.prompt create: absent id POSTs, then asserts the list holds exactly one', async () => {
  const ctx = promptCtx({ list: (n) => (n === 1 ? [] : [{ id: 'ctX' }]) });
  await prompt.create(ctx, { obj: { id: 'ctX', role: 'user', content: 'c' } });
  assert.deepEqual(ctx.calls.map(([k]) => k), ['post']);
});

test('ai.prompt create: a gateway that DUPLICATES on create fails loudly', async () => {
  const ctx = promptCtx({ list: (n) => (n === 1 ? [] : [{ id: 'ctX' }, { id: 'ctX' }]) });
  await assert.rejects(
    prompt.create(ctx, { obj: { id: 'ctX', role: 'user', content: 'c' } }),
    /DUPLICATED/,
  );
});

// ---------------------------------------------------------------------------
// doctor dupBy
// ---------------------------------------------------------------------------

test('dupBy groups and sorts duplicate keys, ignores null keys', () => {
  const rows = [{ k: 'a' }, { k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'c' }, { k: 'c' }, { k: null }];
  assert.deepEqual(dupBy(rows, (r) => r.k), [['c', 3], ['a', 2]]);
});
