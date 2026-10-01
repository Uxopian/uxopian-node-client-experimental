// Offline tests for `data push --prune` row ownership (DESIGN §31): a shared dataset (CmTeams fed by a
// product AND its extension) never loses the other installed package's rows. Fake core, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { pushRows } from '../lib/kinds/fd-dataset.mjs';
import { splitRowOwnership, foreignOwners } from '../lib/ownership.mjs';
import { prefixForms } from '../lib/naming.mjs';

const CLASS = 'CmTeams';
const row = (id) => ({ id, name: id, category: 'DOCUMENT', data: { classId: CLASS }, tags: [{ name: 'X', value: ['1'], readOnly: false }] });
const receiptDoc = (code) => ({ id: `UXC_PKG_${code.toUpperCase()}`, tags: [{ name: 'UxcPackageCode', value: [code] }, { name: 'UxcPackageVersion', value: ['1.0.0'] }] });

function fakeCore({ docs, receipts = [] }) {
  const store = new Map(docs.map((d) => [d.id, d]));
  const rcpt = new Map(receipts.map((c) => [`UXC_PKG_${c.toUpperCase()}`, receiptDoc(c)]));
  const log = { deleted: [] };
  return {
    log, store,
    search: async ({ classId }) => {
      const list = classId === 'UxcPackage' ? [...rcpt.values()] : [...store.values()].filter((d) => d.data?.classId === classId);
      return { found: list.length, results: list.map((d) => ({ id: d.id })) };
    },
    getDoc: async (id) => rcpt.get(id) ?? store.get(id) ?? null,
    getOne: async () => null,
    upsertDoc: async (d) => { store.set(d.id, d); },
    del: async (path) => { const id = decodeURIComponent(path.split('/').pop()); store.delete(id); log.deleted.push(id); },
  };
}

function makePkg({ code = 'po', rows, deps = null, idPrefixes = null }) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-own-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({
    code, name: 'x', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'],
    dataSets: [{ name: CLASS, classId: CLASS, path: `data/${CLASS}.jsonl` }],
    ...(deps ? { dependencies: deps } : {}),
    ...(idPrefixes ? { idPrefixes } : {}),
  }));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, `data/${CLASS}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [{ kind: 'fd.dataset', id: CLASS, path: `data/${CLASS}.jsonl` }] }));
  return dir;
}

function ctxFor(dir, core) {
  const warns = []; const notes = [];
  const pkg = openPackage(dir);
  return {
    ctx: { pkg, requirePkg: () => pkg, connect: () => {}, target: { name: 't1', user: 'admin' },
      clients: { core, gateway: { get: async () => [] } },
      out: { line: () => {}, note: (m) => notes.push(m), warn: (m) => warns.push(m) } },
    pkg, warns, notes,
  };
}

test('splitRowOwnership: own prefix wins, another package prefix is foreign, unknown prefix stays deletable', () => {
  const owners = [{ code: 'cm', forms: prefixForms('cm') }];
  const r = splitRowOwnership(['PO_TEAM_A', 'CM_SUPPLY', 'CmTeamX', 'cm-sales', 'LEGACY_TEAM', 'Cmd1'], { code: 'po' }, owners);
  assert.deepEqual(r.own, ['PO_TEAM_A', 'LEGACY_TEAM', 'Cmd1']);
  assert.deepEqual(r.foreign, [{ id: 'CM_SUPPLY', code: 'cm' }, { id: 'CmTeamX', code: 'cm' }, { id: 'cm-sales', code: 'cm' }]);
});

test('splitRowOwnership: a custom idPrefixes of the package keeps its rows its own', () => {
  const owners = [{ code: 'cm', forms: prefixForms('cm') }];
  const r = splitRowOwnership(['CM_MINE'], { code: 'po', idPrefixes: { pascal: 'Po', camel: 'po', kebab: 'po-', upper: 'CM_' } }, owners);
  assert.deepEqual(r.own, ['CM_MINE']);
  assert.deepEqual(r.foreign, []);
});

test('foreignOwners: other receipts + declared dependencies, never the package itself', async () => {
  const core = fakeCore({ docs: [], receipts: ['cm', 'po', 'zz'] });
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_A')], deps: { cm: '*', qq: '*' } }), core);
  const o = await foreignOwners(ctx, ctx.pkg.manifest);
  assert.deepEqual(o.map((x) => `${x.code}:${x.source}`), ['cm:receipt', 'qq:dependency', 'zz:receipt']);
});

test('prune --yes deletes our stale rows, keeps the other installed package\'s rows, and says so', async () => {
  const core = fakeCore({
    docs: [row('PO_KEEP'), row('PO_STALE'), row('CM_SUPPLY'), row('CmTeamX'), row('OLD_UNPREFIXED')],
    receipts: ['cm', 'po'],
  });
  const { ctx, warns } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted.sort(), ['OLD_UNPREFIXED', 'PO_STALE']);
  assert.deepEqual(rep.pruned.sort(), ['OLD_UNPREFIXED', 'PO_STALE']);
  assert.deepEqual(rep.keptForeign.map((f) => f.id).sort(), ['CM_SUPPLY', 'CmTeamX']);
  assert.ok(core.store.has('CM_SUPPLY') && core.store.has('CmTeamX'));
  assert.ok(warns.some((w) => /belong to another installed package \(cm\)/.test(w) && /CM_SUPPLY/.test(w)));
  assert.ok(!warns.some((w) => /DELETE CM_SUPPLY/.test(w)), 'never on the printed kill list');
});

test('prune without --yes prints a kill list without the foreign rows and deletes nothing', async () => {
  const core = fakeCore({ docs: [row('PO_STALE'), row('CM_SUPPLY')], receipts: ['cm'] });
  const { ctx, warns } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true });
  assert.deepEqual(core.log.deleted, []);
  assert.deepEqual(rep.pruneCandidates, ['PO_STALE']);
  assert.ok(warns.some((w) => /DELETE PO_STALE/.test(w)));
  assert.ok(!warns.some((w) => /DELETE CM_SUPPLY/.test(w)));
});

test('only foreign rows server-side: nothing to delete, no kill list at all', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY')], receipts: ['cm'] });
  const { ctx, warns } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(rep.pruned, []);
  assert.deepEqual(rep.pruneCandidates, []);
  assert.ok(!warns.some((w) => /kill list/.test(w)));
  assert.equal(rep.keptForeign.length, 1);
});

test('receipts unreadable: the declared dependency still protects its rows', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY'), row('PO_STALE')] });
  core.search = async ({ classId }) => {
    if (classId === 'UxcPackage') throw new Error('class absent');
    const list = [...core.store.values()]; return { found: list.length, results: list.map((d) => ({ id: d.id })) };
  };
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_KEEP')], deps: { cm: '*' } }), core);
  await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted, ['PO_STALE']);
});

test('without --prune nothing changes: foreign rows are just serverOnly', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY'), row('PO_STALE')], receipts: ['cm'] });
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', {});
  assert.deepEqual(rep.serverOnly.sort(), ['CM_SUPPLY', 'PO_STALE']);
  assert.deepEqual(core.log.deleted, []);
});
