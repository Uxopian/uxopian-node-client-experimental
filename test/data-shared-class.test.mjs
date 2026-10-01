// Offline tests for #113/#114 (DESIGN §31): a product (cm) and its extension (po) feed ONE dataset
// class. Each package pushes, hashes and reports only its OWN rows; another installed package's rows
// are never classified as a collision, never overwritten, never deleted (also under --force), and
// status reports them as a note, not drift. A package alone on its target hashes exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import adapter, { pushRows, pullRows, rowStatus, foreignNote } from '../lib/kinds/fd-dataset.mjs';
import { pushResources, statusAll, serverHash } from '../lib/sync.mjs';
import { canonicalize, hashResource } from '../lib/canonical.mjs';

const CLASS = 'CmCaseTypes';
const row = (id, v = '1') => ({ id, name: id, category: 'DOCUMENT', data: { classId: CLASS }, tags: [{ name: 'X', value: [v], readOnly: false }] });
const receiptDoc = (code) => ({ id: `UXC_PKG_${code.toUpperCase()}`, tags: [{ name: 'UxcPackageCode', value: [code] }, { name: 'UxcPackageVersion', value: ['1.0.0'] }] });

function fakeCore({ docs = [], receipts = [] } = {}) {
  const store = new Map(docs.map((d) => [d.id, structuredClone(d)]));
  const rcpt = new Map(receipts.map((c) => [`UXC_PKG_${c.toUpperCase()}`, receiptDoc(c)]));
  const log = { deleted: [], upserted: [] };
  return {
    log, store, rcpt,
    search: async ({ classId }) => {
      const list = classId === 'UxcPackage' ? [...rcpt.values()] : [...store.values()].filter((d) => d.data?.classId === classId);
      return { found: list.length, results: list.map((d) => ({ id: d.id })) };
    },
    getDoc: async (id) => structuredClone(rcpt.get(id) ?? store.get(id) ?? null),
    getOne: async () => null,
    upsertDoc: async (d) => { store.set(d.id, structuredClone(d)); log.upserted.push(d.id); },
    del: async (path) => { const id = decodeURIComponent(path.split('/').pop()); store.delete(id); log.deleted.push(id); },
  };
}

function makePkg({ code, rows, name = `${code === 'cm' ? 'Cm' : 'Po'}CaseTypes`, deps = null }) {
  const dir = mkdtempSync(join(os.tmpdir(), `uxc-shared-${code}-`));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({
    code, name: code, format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'],
    dataSets: [{ name, classId: CLASS, path: `data/${name}.jsonl` }],
    ...(deps ? { dependencies: deps } : {}),
  }));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, `data/${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [{ kind: 'fd.dataset', id: name, path: `data/${name}.jsonl` }] }));
  return { dir, name };
}

function ctxFor(dir, core, { gateway } = {}) {
  const warns = []; const notes = []; const lines = [];
  const pkg = openPackage(dir);
  const ctx = {
    pkg, requirePkg: () => pkg, connect: () => {}, target: { name: 't1', user: 'admin' },
    clients: { core, gateway: gateway ?? { get: async () => [] }, cacheClear: async () => {} },
    out: { line: (m) => lines.push(m), note: (m) => notes.push(m), warn: (m) => warns.push(m) },
  };
  return { ctx, pkg, warns, notes, lines };
}

const PRODUCT_ROWS = ['CmCaseTypes_CLAIM', 'CmCaseTypes_INCIDENT', 'CM_LEGACY_TYPE'];
const EXT_ROWS = ['PO_ORDER', 'PO_RETURN'];

/** gfdefault after the product install: cm's rows on the server, both receipts present. */
function sharedTarget() {
  const core = fakeCore({ docs: PRODUCT_ROWS.map((id) => row(id)), receipts: ['cm', 'po'] });
  const cm = makePkg({ code: 'cm', rows: PRODUCT_ROWS.map((id) => row(id)) });
  const po = makePkg({ code: 'po', rows: EXT_ROWS.map((id) => row(id)), deps: { cm: '*' } });
  return { core, cm, po };
}

test('#113 push --all of the extension upserts its own rows — no whole-class collision, product rows untouched', async () => {
  const { core, cm, po } = sharedTarget();
  const P = ctxFor(cm.dir, core);
  await pushResources(P.ctx, P.pkg.entries()); // product: adopted (own rows already there)
  const E = ctxFor(po.dir, core);
  const before = structuredClone([...core.store.entries()].filter(([id]) => id.startsWith('Cm') || id.startsWith('CM_')));
  const [r] = await pushResources(E.ctx, E.pkg.entries());
  assert.equal(r.action, 'created', JSON.stringify(r)); // was: refused "collision: a DIFFERENT same-id object exists"
  assert.deepEqual(core.log.upserted.sort(), EXT_ROWS);
  assert.deepEqual(core.log.deleted, []);
  for (const [id, d] of before) assert.deepEqual(core.store.get(id), d, `product row ${id} untouched`);
});

test('#114 status --remote: product and extension both in sync after both pushed; foreign rows are a note', async () => {
  const { core, cm, po } = sharedTarget();
  const P = ctxFor(cm.dir, core); const E = ctxFor(po.dir, core);
  await pushResources(P.ctx, P.pkg.entries());
  await pushResources(E.ctx, E.pkg.entries());
  for (const [X, other, n] of [[P, 'po', 2], [E, 'cm', 3]]) {
    const { rows } = await statusAll(X.ctx, { remote: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'insync', JSON.stringify(rows[0]));
    assert.equal(rows[0].note, `+${n} rows of ${other} (another installed package's rows in this class — not hashed, not drift)`);
  }
  // and a product-side edit still reads as drift for the product only
  core.store.get('CmCaseTypes_CLAIM').tags[0].value = ['2'];
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'server');
  assert.equal((await statusAll(E.ctx, { remote: true })).rows[0].state, 'insync');
});

test('#114 server form of each package = its own rows only; rowStatus/pull never bring the other package\'s rows in', async () => {
  const { core, cm, po } = sharedTarget();
  const E = ctxFor(po.dir, core);
  await pushRows(E.ctx, E.pkg, po.name, {});
  const sRes = await adapter.readServer(E.ctx, po.name);
  assert.deepEqual([...sRes.rows.keys()], EXT_ROWS);
  assert.deepEqual(sRes.foreign.map((f) => `${f.id}:${f.code}`).sort(), PRODUCT_ROWS.map((id) => `${id}:cm`).sort());
  const st = await rowStatus(E.ctx, E.pkg, po.name);
  assert.deepEqual([st.added, st.conflict, st.changedServer], [[], [], []]);
  const rep = await pullRows(E.ctx, E.pkg, po.name);
  assert.deepEqual(rep.added, []);
  const text = readFileSync(join(po.dir, `data/${po.name}.jsonl`), 'utf8');
  assert.ok(!/CmCaseTypes_CLAIM/.test(text), 'the extension file never receives the product rows');
  const P = ctxFor(cm.dir, core);
  assert.deepEqual([...(await adapter.readServer(P.ctx, cm.name)).rows.keys()], PRODUCT_ROWS.slice().sort());
});

test('#113 --force on the extension (generic and data push --prune --yes) never deletes or overwrites product rows', async () => {
  const { core, po } = sharedTarget();
  // the extension's file carries stale copies of product rows (an old pull) — edited, and one tombstoned
  const rows = [...EXT_ROWS.map((id) => row(id)), row('CmCaseTypes_CLAIM', 'HIJACK'), { _id: 'CmCaseTypes_INCIDENT', _deleted: true }];
  writeFileSync(join(po.dir, `data/${po.name}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const E = ctxFor(po.dir, core);
  await pushResources(E.ctx, E.pkg.entries(), { force: true });
  const rep = await pushRows(E.ctx, E.pkg, po.name, { force: true, prune: true, yes: true });
  assert.deepEqual(core.log.deleted, []);
  for (const id of PRODUCT_ROWS) assert.ok(core.store.has(id), `${id} kept`);
  assert.deepEqual(core.store.get('CmCaseTypes_CLAIM').tags[0].value, ['1'], 'never overwritten');
  assert.deepEqual(rep.skippedForeign.map((f) => `${f.id}:${f.code}`), ['CmCaseTypes_CLAIM:cm', 'CmCaseTypes_INCIDENT:cm']);
  assert.ok(E.warns.some((w) => /belong to another installed package — never pushed nor deleted/.test(w)));
});

test('#113 receipts unreadable, never read before: the hash is the full class (0.24.0), but no write touches the dependency\'s rows', async () => {
  const { core, po } = sharedTarget();
  core.rcpt.clear(); core.store.set('LEGACY', row('LEGACY'));
  const gateway = { get: async () => { throw new Error('ECONNREFUSED'); } };
  // the extension's file carries a stale, edited copy of a product row and a tombstone for another
  const rows = [...EXT_ROWS.map((id) => row(id)), row('CmCaseTypes_CLAIM', 'HIJACK'), { _id: 'CmCaseTypes_INCIDENT', _deleted: true }];
  writeFileSync(join(po.dir, `data/${po.name}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const E = ctxFor(po.dir, core, { gateway });
  const sRes = await adapter.readServer(E.ctx, po.name);
  // no installed set was ever recorded: nothing is foreign, every class row hashes (as 0.24.0 did)
  assert.deepEqual([...sRes.rows.keys()], ['CM_LEGACY_TYPE', 'CmCaseTypes_CLAIM', 'CmCaseTypes_INCIDENT', 'LEGACY']);
  assert.equal(E.pkg.installedSeen('t1'), null);
  // WRITES fail safe: push --force --prune --yes never creates/updates/deletes a cm-prefixed row
  const rep = await pushRows(E.ctx, E.pkg, po.name, { force: true, prune: true, yes: true });
  assert.deepEqual(core.log.deleted, []);
  assert.deepEqual(core.store.get('CmCaseTypes_CLAIM').tags[0].value, ['1'], 'never overwritten');
  assert.deepEqual(rep.skippedForeign.map((f) => `${f.id}:${f.code}`), ['CmCaseTypes_CLAIM:cm', 'CmCaseTypes_INCIDENT:cm']);
  assert.deepEqual(rep.keptForeign.map((f) => f.id).sort(), ['CM_LEGACY_TYPE']);
  assert.deepEqual(rep.keptUnproven, ['LEGACY']);
  assert.ok(E.warns.some((w) => /receipts could not be read \(uxopian-ai: ECONNREFUSED\)/.test(w) && /NOT written \(fail safe\)/.test(w) && /CmCaseTypes_CLAIM \(cm\)/.test(w)), E.warns.join('\n'));
  // ... and pull never brings them in (nor drops the local lines)
  const pulled = await pullRows(E.ctx, E.pkg, po.name);
  assert.deepEqual(pulled.added, ['LEGACY']); // an unprefixed row is not another package's: pulled as before
  assert.deepEqual(pulled.skippedGuarded.sort(), ['CM_LEGACY_TYPE', 'CmCaseTypes_CLAIM', 'CmCaseTypes_INCIDENT']);
  const text = readFileSync(join(po.dir, `data/${po.name}.jsonl`), 'utf8');
  assert.ok(!/CM_LEGACY_TYPE/.test(text) && /HIJACK/.test(text), 'nothing pulled, the stale local line kept as is');
});

test('#113 receipts unreadable AFTER a successful read: the last installed set keeps the hash stable', async () => {
  const { core, po } = sharedTarget();
  core.store.set('LEGACY', row('LEGACY'));
  let down = false;
  const gateway = { get: async () => { if (down) throw new Error('ECONNREFUSED'); return []; } };
  const E = ctxFor(po.dir, core, { gateway });
  await pushRows(E.ctx, E.pkg, po.name, {});
  const readable = await adapter.readServer(E.ctx, po.name);
  const statusReadable = (await statusAll(E.ctx, { remote: true })).rows[0];
  assert.deepEqual(E.pkg.installedSeen('t1'), ['cm'], 'persisted at the successful read');
  assert.deepEqual(JSON.parse(readFileSync(join(po.dir, '.uxc/state.json'), 'utf8')).targets.t1.installedPackages, ['cm']);
  down = true; core.rcpt.clear();
  const unreadable = await adapter.readServer(E.ctx, po.name);
  assert.deepEqual([...unreadable.rows.keys()], ['LEGACY', ...EXT_ROWS]);
  assert.equal(unreadable.contents[`${po.name}.jsonl`].toString(), readable.contents[`${po.name}.jsonl`].toString());
  const statusDown = (await statusAll(E.ctx, { remote: true })).rows[0];
  assert.equal(statusDown.state, statusReadable.state, 'no drift from the read failure');
  await pushRows(E.ctx, E.pkg, po.name, { prune: true, yes: true, force: true });
  assert.deepEqual(core.log.deleted, []); // LEGACY unproven, cm rows foreign: nothing provably ours to prune
});

test('#114 alone on the target: server form and hash are byte-identical to the full-class read', async () => {
  for (const receipts of [['cm'], [], null]) { // own receipt only / none / unreadable
    const ids = ['CmA', 'CM_B', 'LEGACY', 'Cm2024Team'];
    const core = fakeCore({ docs: ids.map((id) => row(id)), receipts: receipts ?? [] });
    const { dir, name } = makePkg({ code: 'cm', rows: [row('CmA')] });
    const gateway = receipts ? undefined : { get: async () => { throw new Error('down'); } };
    const X = ctxFor(dir, core, { gateway });
    const sRes = await adapter.readServer(X.ctx, name);
    assert.equal(sRes.foreign, undefined);
    // the pre-§31 server form, built independently: every class row, canonical, sorted, one per line
    const canon = (d) => {
      const r = canonicalize('fd.document', { id: d.id, name: d.name, category: 'DOCUMENT', data: { classId: CLASS }, tags: d.tags });
      const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
      return JSON.stringify(sort(r));
    };
    const text = ids.slice().sort().map((id) => canon(row(id))).join('\n') + '\n';
    assert.equal(sRes.contents[`${name}.jsonl`].toString(), text);
    assert.equal(await serverHash(X.ctx, { kind: 'fd.dataset', id: name }), hashResource('fd.dataset', { name, classId: CLASS }, [Buffer.from(text)]));
    const { rows } = await statusAll(X.ctx, { remote: true });
    assert.equal(rows[0].note, undefined);
  }
});

test('foreignNote groups by owner, singular/plural', () => {
  assert.equal(foreignNote([]), null);
  assert.match(foreignNote([{ id: 'a', code: 'po' }, { id: 'b', code: 'cm' }, { id: 'c', code: 'po' }]), /^\+1 row of cm, \+2 rows of po /);
});
