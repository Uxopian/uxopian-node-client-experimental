// Offline unit tests for lib/prune.mjs — DEFAULT upgrade pruning (DESIGN §23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { removalCandidates, partitionRemovals, pruneRemoved } from '../lib/prune.mjs';

const ENTRIES = [
  { kind: 'fd.script', id: 'consts' },
  { kind: 'fd.handler', id: 'CtIngest_onCreate' },
];

test('removalCandidates: state/old-catalog keys minus the incoming registry; unknown kinds dropped', () => {
  const oldKeys = [
    'fd.script/consts',            // still present -> not a candidate
    'fd.script/spurious',          // REMOVED -> candidate
    'fd.taskclass/CtOld',          // removed createOnly -> candidate (report-only later)
    'zz.unknown/x',                // unknown kind (newer client wrote it) -> ignored
    'fd.script/spurious',          // dupe -> once
  ];
  const c = removalCandidates(oldKeys, ENTRIES);
  assert.deepEqual(c.map((x) => `${x.kind}/${x.id}`), ['fd.script/spurious', 'fd.taskclass/CtOld']);
});

test('partitionRemovals: managed deletable; createOnly/external/dataset/surfacing report-only', () => {
  const { deletable, reportOnly } = partitionRemovals([
    { kind: 'fd.script', id: 's' },
    { kind: 'fd.handler', id: 'h' },
    { kind: 'ai.prompt', id: 'p' },
    { kind: 'fd.taskclass', id: 't' },
    { kind: 'fd.vfinstance', id: 'v' },
    { kind: 'fd.workflow', id: 'w' },
    { kind: 'fd.dataset', id: 'd' },
    { kind: 'fd.surfacing', id: 'surfacing' },
    { kind: 'fd.acl', id: 'a' },
  ]);
  assert.deepEqual(deletable.map((x) => x.kind).sort(), ['ai.prompt', 'fd.acl', 'fd.handler', 'fd.script', 'fd.workflow']);
  const why = Object.fromEntries(reportOnly.map((r) => [r.kind, r.why]));
  assert.match(why['fd.taskclass'], /§14/);            // the taskclass hazard is named
  assert.match(why['fd.dataset'], /user data/);
  assert.match(why['fd.surfacing'], /old spec/);
  assert.match(why['fd.vfinstance'], /createOnly/);
});

function pctx() {
  const calls = [];
  return {
    calls,
    out: { line: (m) => calls.push(['line', m]), warn: (m) => calls.push(['warn', m]), note: (m) => calls.push(['note', m]) },
    clients: {
      core: {
        del: async (p) => { calls.push(['del', p]); return {}; },
        getDoc: async () => null,
        search: async () => ({ found: 0, results: [] }),
        getOne: async () => null,
      },
      gateway: { del: async (p) => { calls.push(['gwdel', p]); }, get: async () => [] },
      cacheClear: async () => { calls.push(['cacheClear']); return {}; },
    },
    pkg: { resState: () => null },
    target: { name: 't' },
  };
}

test('pruneRemoved with --yes-removals: deletes managed, keeps report-only, clears caches once', async () => {
  const ctx = pctx();
  const deleted = [];
  const r = await pruneRemoved(ctx, ['fd.script/spurious', 'fd.taskclass/CtOld'], ENTRIES, {
    yes: true, out: ctx.out, onDeleted: (c) => deleted.push(`${c.kind}/${c.id}`),
  });
  assert.deepEqual(r.deleted, ['fd.script/spurious']);
  assert.deepEqual(deleted, ['fd.script/spurious']);
  assert.equal(r.reportOnly.length, 1);
  assert.ok(ctx.calls.some(([k]) => k === 'cacheClear'));           // scripts are cacheAffecting
  assert.ok(ctx.calls.some(([k, m]) => k === 'line' && /DELETE\s+fd\.script\/spurious/.test(m)));
  assert.ok(ctx.calls.some(([k, m]) => k === 'line' && /KEEP\s+fd\.taskclass\/CtOld/.test(m)));
});

test('pruneRemoved non-TTY without --yes-removals: upgrade proceeds, removals SKIPPED loudly with rm commands', async () => {
  const ctx = pctx();
  const r = await pruneRemoved(ctx, ['fd.script/spurious'], ENTRIES, { out: ctx.out }); // no yes, no TTY in tests
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(r.skipped, ['fd.script/spurious']);
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /uxc rm fd\.script\/spurious --server/.test(m)));
  assert.ok(!ctx.calls.some(([k]) => k === 'del'));                  // nothing deleted
});

test('pruneRemoved --keep-removed: explicit opt-out, loud, nothing deleted', async () => {
  const ctx = pctx();
  const r = await pruneRemoved(ctx, ['fd.script/spurious'], ENTRIES, { keep: true, yes: true, out: ctx.out });
  assert.deepEqual(r.deleted, []);
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /--keep-removed/.test(m)));
});

test('pruneRemoved: individual delete failures warn + continue, never throw', async () => {
  const ctx = pctx();
  ctx.clients.core.del = async (p) => { if (/spurious/.test(p)) throw new Error('F00xxx class has documents'); return {}; };
  const r = await pruneRemoved(ctx, ['fd.script/spurious', 'fd.script/other'], ENTRIES, { yes: true, out: ctx.out });
  assert.deepEqual(r.deleted, ['fd.script/other']);
  assert.deepEqual(r.skipped, ['fd.script/spurious']);
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /could not delete fd\.script\/spurious/.test(m)));
});

test('no candidates -> completely silent no-op', async () => {
  const ctx = pctx();
  const r = await pruneRemoved(ctx, ['fd.script/consts'], ENTRIES, { yes: true, out: ctx.out });
  assert.deepEqual(r, { deleted: [], skipped: [], reportOnly: [] });
  assert.equal(ctx.calls.length, 0);
});
