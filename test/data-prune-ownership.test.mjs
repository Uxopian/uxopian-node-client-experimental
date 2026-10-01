// Offline tests for `data push --prune` row ownership (DESIGN §31): a shared dataset (CmTeams fed by a
// product AND its extension) never loses the other installed package's rows. Fake core, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { pushRows } from '../lib/kinds/fd-dataset.mjs';
import { splitRowOwnership, foreignOwners, rowOwners, prefixMatchLength } from '../lib/ownership.mjs';
import adapter from '../lib/kinds/fd-dataset.mjs';
import { readReceipts, readReceiptsChecked } from '../lib/receipt.mjs';
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

test('foreignOwners: other INSTALLED packages only — a declared dependency without a receipt is no owner; never the package itself', async () => {
  const core = fakeCore({ docs: [], receipts: ['cm', 'po', 'zz'] });
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_A')], deps: { cm: '*', qq: '*' } }), core);
  const o = await foreignOwners(ctx, ctx.pkg.manifest);
  assert.deepEqual(o.map((x) => `${x.code}:${x.source}`), ['cm:receipt', 'zz:receipt']);
  assert.deepEqual(ctx.pkg.installedSeen('t1'), ['cm', 'zz'], 'the installed set is recorded at each successful read');
  const r = await rowOwners(ctx, ctx.pkg.manifest);
  assert.equal(r.guardOwners, r.owners, 'receipts read: writes guard exactly the installed owners');
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

test('receipts unreadable: the declared dependency still protects its rows (writes fail safe)', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY'), row('PO_STALE')] });
  core.search = async ({ classId }) => {
    if (classId === 'UxcPackage') throw new Error('HTTP 500 boom');
    const list = [...core.store.values()]; return { found: list.length, results: list.map((d) => ({ id: d.id })) };
  };
  core.getOne = async () => ({ id: 'UxcPackage' }); // the class exists: the failure is real
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_KEEP')], deps: { cm: '*' } }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted, ['PO_STALE']);
  assert.deepEqual(rep.keptForeign, [{ id: 'CM_SUPPLY', code: 'cm' }]);
  const o = await rowOwners(ctx, ctx.pkg.manifest);
  assert.deepEqual([o.receiptsReadable, o.owners.length, o.guardOwners.map((g) => `${g.code}:${g.source}`)], [false, 0, ['cm:dependency']]);
});

test('receipts READ, declared dependency NOT installed: its prefix owns nothing (pruned as ours, as before §31)', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY'), row('PO_STALE')], receipts: ['po'] });
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_KEEP')], deps: { cm: '*' } }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted.sort(), ['CM_SUPPLY', 'PO_STALE']);
  assert.deepEqual(rep.keptForeign, []);
});

test('without --prune nothing changes: our server-only rows are serverOnly, foreign rows are reported apart (#114)', async () => {
  const core = fakeCore({ docs: [row('CM_SUPPLY'), row('PO_STALE')], receipts: ['cm'] });
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', {});
  assert.deepEqual(rep.serverOnly, ['PO_STALE']);
  assert.deepEqual(rep.foreign, [{ id: 'CM_SUPPLY', code: 'cm' }]);
  assert.deepEqual(core.log.deleted, []);
});

// ---------- review fixes (issue #107) ----------

const own = (code) => ({ code, forms: prefixForms(code) });

test('longest prefix wins: own cm vs installed cm2 — every form of cm2 is cm2\'s, never pruned as ours', () => {
  const ids = ['Cm2Team', 'cm2Team', 'cm2-team', 'CM2_TEAM', 'CmTeam', 'cmTeam', 'cm-team', 'CM_TEAM'];
  const r = splitRowOwnership(ids, { code: 'cm' }, [own('cm2')]);
  assert.deepEqual(r.own, ['CmTeam', 'cmTeam', 'cm-team', 'CM_TEAM']);
  assert.deepEqual(r.foreign.map((f) => `${f.id}:${f.code}`), ['Cm2Team:cm2', 'cm2Team:cm2', 'cm2-team:cm2', 'CM2_TEAM:cm2']);
});

test('longest prefix wins: own cm2 vs installed cm', () => {
  const r = splitRowOwnership(['Cm2Team', 'CM2_X', 'CmTeam', 'CM_X', 'cm-x', 'cm2-x'], { code: 'cm2' }, [own('cm')]);
  assert.deepEqual(r.own, ['Cm2Team', 'CM2_X', 'cm2-x']);
  assert.deepEqual(r.foreign.map((f) => f.id), ['CmTeam', 'CM_X', 'cm-x']);
});

test('longest prefix wins: cm/cmx and ct/ctx, both directions', () => {
  let r = splitRowOwnership(['CmxTeam', 'cmxTeam', 'cmx-a', 'CMX_A', 'CmTeam'], { code: 'cm' }, [own('cmx')]);
  assert.deepEqual(r.own, ['CmTeam']);
  assert.deepEqual(r.foreign.map((f) => f.code), ['cmx', 'cmx', 'cmx', 'cmx']);
  r = splitRowOwnership(['CtxFoo', 'ctx-foo', 'CTX_FOO', 'CtFoo', 'ct-foo', 'CT_FOO'], { code: 'ct' }, [own('ctx')]);
  assert.deepEqual(r.own, ['CtFoo', 'ct-foo', 'CT_FOO']);
  assert.deepEqual(r.foreign.map((f) => f.id), ['CtxFoo', 'ctx-foo', 'CTX_FOO']);
  r = splitRowOwnership(['CtxFoo', 'CtFoo', 'ctxBar', 'ctBar'], { code: 'ctx' }, [own('ct')]);
  assert.deepEqual(r.own, ['CtxFoo', 'ctxBar']);
  assert.deepEqual(r.foreign.map((f) => `${f.id}:${f.code}`), ['CtFoo:ct', 'ctBar:ct']);
});

test('longest prefix wins between foreign packages too (the label names the right owner)', () => {
  const r = splitRowOwnership(['Cm2Team', 'CmTeam', 'CmxA', 'CM2_B'], { code: 'po' }, [own('cm'), own('cm2'), own('cmx')]);
  assert.deepEqual(r.foreign.map((f) => `${f.id}:${f.code}`), ['Cm2Team:cm2', 'CmTeam:cm', 'CmxA:cmx', 'CM2_B:cm2']);
  assert.deepEqual(r.own, []);
});

test('boundary: our claim needs an uppercase word start; another package\'s protection also takes digits/_', () => {
  const f = prefixForms('cm');
  assert.equal(prefixMatchLength(f, 'CmTeam', { strict: true }), 2);
  assert.equal(prefixMatchLength(f, 'Cm2Team', { strict: true }), 0);
  assert.equal(prefixMatchLength(f, 'Cmd1', { strict: true }), 0);
  assert.equal(prefixMatchLength(f, 'Cm2Team'), 2);
  assert.equal(prefixMatchLength(f, 'Cmd1'), 0);
  assert.equal(prefixMatchLength(f, 'CM_X'), 3);
  assert.equal(prefixMatchLength(f, 'CM-x'), 3); // kebab is case-insensitive
  // own cm, no cm2 installed: Cm2Team is not provably ours -> unprefixed (deletable only when receipts read)
  let r = splitRowOwnership(['Cm2Team'], { code: 'cm' }, []);
  assert.deepEqual(r.own, ['Cm2Team']);
  r = splitRowOwnership(['Cm2Team'], { code: 'cm' }, [], { receiptsReadable: false });
  assert.deepEqual(r.unproven, ['Cm2Team']);
  // own po, installed cm, unknown cm2024-style id: shielded under cm (errs on keeping)
  r = splitRowOwnership(['Cm2024Team'], { code: 'po' }, [own('cm')]);
  assert.deepEqual(r.foreign, [{ id: 'Cm2024Team', code: 'cm' }]);
});

test('end-to-end: own cm + installed cm2 — prune --yes never deletes Cm2Team/cm2Team', async () => {
  const core = fakeCore({ docs: [row('CmKeep'), row('CmStale'), row('Cm2Team'), row('cm2Team')], receipts: ['cm', 'cm2'] });
  const { ctx } = ctxFor(makePkg({ code: 'cm', rows: [row('CmKeep')] }), core);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted, ['CmStale']);
  assert.deepEqual(rep.keptForeign.map((f) => `${f.id}:${f.code}`), ['Cm2Team:cm2', 'cm2Team:cm2']);
});

const failingReceiptSearch = (core) => {
  const orig = core.search;
  core.search = async (q) => { if (q.classId === 'UxcPackage') throw new Error('HTTP 500 boom'); return orig(q); };
  core.getOne = async () => ({ id: 'UxcPackage' }); // the class exists: the failure is real
};

test('readReceiptsChecked: "no receipts" (class absent / gateway 404) vs "could not read"', async () => {
  const core = fakeCore({ docs: [] });
  core.search = async () => { throw new Error('F00206 class absent'); }; // getOne -> null: class absent
  let r = await readReceiptsChecked({ clients: { core, gateway: { get: async () => [], tryGet: async () => null } } });
  assert.deepEqual([r.readable, r.receipts.length], [true, 0]);
  const core2 = fakeCore({ docs: [] }); failingReceiptSearch(core2);
  r = await readReceiptsChecked({ clients: { core: core2, gateway: { get: async () => [] } } });
  assert.equal(r.readable, false);
  assert.match(r.errors[0], /flowerdocs: HTTP 500 boom/);
  r = await readReceiptsChecked({ clients: { core: fakeCore({ docs: [] }), gateway: { get: async () => { throw new Error('ECONNREFUSED'); } } } });
  assert.equal(r.readable, false);
  assert.match(r.errors[0], /uxopian-ai: ECONNREFUSED/);
  // readReceipts itself keeps swallowing (other callers unchanged)
  assert.deepEqual(await readReceipts({ clients: { core: core2, gateway: { get: async () => { throw new Error('x'); } } } }), []);
});

test('receipts UNREADABLE: prune --yes deletes only own-prefixed rows, keeps unprefixed + says why', async () => {
  const core = fakeCore({ docs: [row('PO_STALE'), row('OLD_UNPREFIXED'), row('CmTeamX'), row('Cm2Team')], receipts: ['cm'] });
  failingReceiptSearch(core);
  const { ctx, warns } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  const o = await rowOwners(ctx, ctx.pkg.manifest);
  assert.equal(o.receiptsReadable, false);
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true, yes: true });
  assert.deepEqual(core.log.deleted, ['PO_STALE']);
  assert.deepEqual(rep.keptUnproven.sort(), ['Cm2Team', 'CmTeamX', 'OLD_UNPREFIXED']);
  assert.ok(warns.some((w) => /receipts could not be read \(flowerdocs: HTTP 500 boom\)/.test(w) && /OLD_UNPREFIXED/.test(w)));
  assert.ok(!warns.some((w) => /DELETE OLD_UNPREFIXED/.test(w)));
});

test('receipts unreadable (gateway down) without --yes: the kill list holds only own-prefixed rows', async () => {
  const core = fakeCore({ docs: [row('PO_STALE'), row('LEGACY')], receipts: [] });
  const { ctx, warns } = ctxFor(makePkg({ rows: [row('PO_KEEP')] }), core);
  ctx.clients.gateway = { get: async () => { throw new Error('502'); } };
  const rep = await pushRows(ctx, ctx.pkg, 'CmTeams', { prune: true });
  assert.deepEqual(rep.pruneCandidates, ['PO_STALE']);
  assert.deepEqual(rep.keptUnproven, ['LEGACY']);
  assert.ok(!warns.some((w) => /DELETE LEGACY/.test(w)));
});

test('remove() (rm --server / destroy / generic prune): alone on the target, every row goes as before', async () => {
  const core = fakeCore({ docs: [row('PO_A'), row('PO_B'), row('LEGACY')], receipts: ['po'] });
  const { ctx, notes } = ctxFor(makePkg({ rows: [row('PO_A')] }), core);
  const r = await adapter.remove(ctx, 'CmTeams');
  assert.deepEqual(core.log.deleted.sort(), ['LEGACY', 'PO_A', 'PO_B']);
  assert.deepEqual(r.keptForeign, []);
  assert.ok(notes.some((n) => /deleted 3 server documents$/.test(n)));
});

test('remove(): never deletes another installed package\'s rows, and names them', async () => {
  const core = fakeCore({ docs: [row('PO_A'), row('CM_SUPPLY'), row('CmTeamX'), row('LEGACY')], receipts: ['cm', 'po'] });
  const { ctx, warns, notes } = ctxFor(makePkg({ rows: [row('PO_A')] }), core);
  const r = await adapter.remove(ctx, 'CmTeams');
  assert.deepEqual(core.log.deleted.sort(), ['LEGACY', 'PO_A']);
  assert.deepEqual(r.keptForeign.map((f) => f.id).sort(), ['CM_SUPPLY', 'CmTeamX']);
  assert.ok(warns.some((w) => /remove dataset CmTeams: 2 row\(s\) of CmTeams belong to another installed package \(cm\)/.test(w)));
  assert.ok(notes.some((n) => /deleted 2 server documents \(2 kept/.test(n)));
});

test('remove(): receipts unreadable keeps unprefixed rows (and declared dependencies\' rows)', async () => {
  const core = fakeCore({ docs: [row('PO_A'), row('CM_SUPPLY'), row('LEGACY')] });
  failingReceiptSearch(core);
  const { ctx } = ctxFor(makePkg({ rows: [row('PO_A')], deps: { cm: '*' } }), core);
  const r = await adapter.remove(ctx, 'CmTeams');
  assert.deepEqual(core.log.deleted, ['PO_A']);
  assert.deepEqual(r.keptUnproven, ['LEGACY']);
  assert.deepEqual(r.keptForeign, [{ id: 'CM_SUPPLY', code: 'cm' }]);
});
