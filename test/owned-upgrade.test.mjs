// Offline tests for issue #52 — an upgrade's same-id objects that the installed RECEIPT lists as
// this package's own are upgrades, not no-base collisions. Fake receipts + fake server state:
//   untouched since install -> 'upgrade', no --force needed
//   edited on the server    -> refused, named "edited on the server since <code>@<v> was installed"
//   foreign (not in receipt / other code) -> the collision guard is unchanged
//   old receipt (no hashes) -> upgrade WITH a warning listing the resources
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPackage } from '../lib/packageio.mjs';
import { serverHash } from '../lib/sync.mjs';
import {
  buildReceipt, writeFdReceipt, writeReceipts, receiptFromFdDoc, receiptFromAiPrompt, ownedByReceipt,
  shortHash, resourceHashesFromState, FD_HASHES_TAG,
} from '../lib/receipt.mjs';
import { tag, tagsOf } from '../lib/util.mjs';

const SAMPLE = new URL('../examples/sample-package', import.meta.url).pathname;
const local = JSON.parse(readFileSync(join(SAMPLE, 'fd/tagclasses/SpStatus.json'), 'utf8'));
// what sp@0.1.0 installed: SpStatus without CLOSED (0.2.0 adds it)
const V1_STATUS = { ...local, allowedValues: local.allowedValues.slice(0, 2) };
// the same object, edited on the server after the install
const EDITED_STATUS = { ...V1_STATUS, searchable: false };

function pkgDir(version = '0.2.0') {
  const dir = mkdtempSync(join(tmpdir(), 'uxc-owned-pkg-'));
  cpSync(SAMPLE, dir, { recursive: true });
  const mf = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ ...mf, version }));
  return dir;
}

const receiptDoc = ({ code = 'sp', version = '0.1.0', resources = null, hashes = null }) => ({
  id: `UXC_PKG_${code.toUpperCase()}`,
  tags: [
    tag('UxcPackageCode', code), tag('UxcPackageVersion', version),
    ...(resources ? [tag('UxcResources', resources.join(','))] : []),
    ...(hashes ? [tag(FD_HASHES_TAG, Object.entries(hashes).map(([k, v]) => `${k}=${v}`).join(','))] : []),
  ],
});

function fakeCtx({ server = {}, receipts = [] } = {}) {
  const docs = Object.fromEntries(receipts.map((d) => [d.id, d]));
  const writes = [];
  const lines = [];
  const boom = (n) => async (...a) => { writes.push([n, a[0]]); throw new Error(`WRITE ${n}`); };
  const out = {
    json: false, result() {}, line: (...p) => lines.push(p.join(' ')), note: (m) => lines.push(`NOTE ${m}`),
    warn: (m) => lines.push(`WARN ${m}`), table: (rows) => lines.push(`TABLE ${JSON.stringify(rows.map(({ entry, ...r }) => r))}`),
  };
  return {
    writes, lines, flags: {}, out, target: { name: 't', user: 'u' },
    connect() {},
    clients: {
      core: {
        getOne: async (p) => server[p] ?? null,
        getDoc: async (id) => docs[id] ?? null,
        search: async () => ({ results: Object.keys(docs).map((id) => ({ id })) }),
        post: boom('core.post'), put: boom('core.put'), del: boom('core.del'), upsertDoc: boom('core.upsertDoc'),
      },
      gateway: { get: async () => [], post: boom('gw.post'), put: boom('gw.put'), delete: boom('gw.delete') },
    },
  };
}

const STATUS_KEY = 'fd.tagclass/SpStatus';
const ALL_KEYS = ['ai.prompt/spSummary', 'fd.documentclass/SpNote', STATUS_KEY];
const serverWith = (obj) => ({ '/rest/tagclass/SpStatus': obj });
async function shortOf(obj) {
  return shortHash(await serverHash(fakeCtx({ server: serverWith(obj) }), { kind: 'fd.tagclass', id: 'SpStatus' }));
}

async function withExitTrap(fn) {
  const realExit = process.exit; const realErr = console.error;
  let msg = '';
  process.exit = (c) => { throw Object.assign(new Error('exit'), { code: c }); };
  console.error = (m) => { msg += `${m}\n`; };
  try { return await fn(() => msg); } finally { process.exit = realExit; console.error = realErr; }
}

test('owned + untouched since install: --report shows an upgrade, no collision', async () => {
  const dir = pkgDir();
  try {
    const ctx = fakeCtx({ server: serverWith(V1_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS, hashes: { [STATUS_KEY]: await shortOf(V1_STATUS) } })] });
    const res = await importPackage(ctx, dir, { report: true });
    assert.deepEqual(res.collisions, []);
    assert.deepEqual(res.owned, { receipt: 'sp@0.1.0', upgraded: [STATUS_KEY], unknownBase: [], edited: [] });
    assert.match(ctx.lines.join('\n'), /"state":"upgrade"/);
    assert.deepEqual(ctx.writes, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owned + untouched since install: a real import proceeds to the push WITHOUT --force', async () => {
  const dir = pkgDir();
  try {
    const ctx = fakeCtx({ server: serverWith(V1_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS, hashes: { [STATUS_KEY]: await shortOf(V1_STATUS) } })] });
    await withExitTrap(async (msg) => {
      try { await importPackage(ctx, dir, {}); } catch { /* the fake client throws on writes */ }
      assert.doesNotMatch(msg(), /import aborted/);
    });
    assert.ok(ctx.writes.some(([n, p]) => n === 'core.post' && /tagclass/.test(String(p))), JSON.stringify(ctx.writes));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owned but edited on the server since install: refused with the named conflict (no write)', async () => {
  const dir = pkgDir();
  try {
    const ctx = fakeCtx({ server: serverWith(EDITED_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS, hashes: { [STATUS_KEY]: await shortOf(V1_STATUS) } })] });
    await withExitTrap(async (msg) => {
      await assert.rejects(() => importPackage(ctx, dir, {}), /exit/);
      assert.match(msg(), /import aborted before any write — 1 collision/);
      assert.match(msg(), /fd\.tagclass\/SpStatus\s+conflict\s+edited on the server since sp@0\.1\.0 was installed/);
      assert.match(msg(), /--force overwrites those edits/);
    });
    assert.deepEqual(ctx.writes, []);
    const rep = await importPackage(fakeCtx({ server: serverWith(EDITED_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS, hashes: { [STATUS_KEY]: await shortOf(V1_STATUS) } })] }), dir, { report: true });
    assert.deepEqual(rep.owned.edited, [STATUS_KEY]);
    assert.equal(rep.collisions[0].state, 'conflict');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('FOREIGN same-id object keeps the collision guard: not in our receipt, or another package\'s receipt', async () => {
  const dir = pkgDir();
  try {
    for (const receipts of [
      [receiptDoc({ resources: ['ai.prompt/spSummary'], hashes: { 'ai.prompt/spSummary': 'abc' } })], // ours, but SpStatus not listed
      [receiptDoc({ code: 'other', resources: [STATUS_KEY], hashes: { [STATUS_KEY]: await shortOf(V1_STATUS) } })], // another code lists it
      [], // no receipt at all
    ]) {
      const ctx = fakeCtx({ server: serverWith(V1_STATUS), receipts });
      await withExitTrap(async (msg) => {
        await assert.rejects(() => importPackage(ctx, dir, {}), /exit/);
        assert.match(msg(), /fd\.tagclass\/SpStatus\s+collision\s+a DIFFERENT same-id object/);
      });
      assert.deepEqual(ctx.writes, []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old receipt WITHOUT hashes: listed resources upgrade with a warning naming them (no --force)', async () => {
  const dir = pkgDir();
  try {
    const ctx = fakeCtx({ server: serverWith(EDITED_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS })] });
    const res = await importPackage(ctx, dir, { report: true });
    assert.deepEqual(res.collisions, []);
    assert.deepEqual(res.owned.unknownBase, [STATUS_KEY]);
    const warn = ctx.lines.find((l) => l.startsWith('WARN') && /no per-resource hashes/.test(l));
    assert.ok(warn, ctx.lines.join('\n'));
    assert.match(warn, /fd\.tagclass\/SpStatus/);
    // and a real run is not refused
    const run = fakeCtx({ server: serverWith(EDITED_STATUS), receipts: [receiptDoc({ resources: ALL_KEYS })] });
    await withExitTrap(async (msg) => {
      try { await importPackage(run, dir, {}); } catch { /* fake writes throw */ }
      assert.doesNotMatch(msg(), /import aborted/);
    });
    assert.ok(run.writes.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receipts record per-resource hashes: FD tag + AI JSON round-trip, derived from sync state, merged by ownedByReceipt', async () => {
  const hashes = { 'fd.tagclass/B': 'bbbb', 'ai.prompt/a': 'aaaa' };
  const r = buildReceipt({ code: 'sp', version: '1.0.0' }, { resources: ['ai.prompt/a', 'fd.tagclass/B'], resourceHashes: hashes });
  assert.deepEqual(Object.keys(r.resourceHashes), ['ai.prompt/a', 'fd.tagclass/B']);
  assert.equal(buildReceipt({ code: 'sp' }, { resources: ['x/y'] }).resourceHashes, undefined); // absent when none
  assert.deepEqual(receiptFromAiPrompt({ id: 'uxcPkgSp', content: JSON.stringify(r) }).resourceHashes, hashes);
  const fd = receiptFromFdDoc({ id: 'UXC_PKG_SP', tags: [tag('UxcPackageCode', 'sp'), tag(FD_HASHES_TAG, 'ai.prompt/a=aaaa,fd.tagclass/B=bbbb')] });
  assert.deepEqual(fd.resourceHashes, hashes);
  assert.equal(receiptFromFdDoc({ id: 'UXC_PKG_SP', tags: [] }).resourceHashes, null);

  const state = { 'fd.tagclass/B': { syncedHash: 'sha256:0123456789abcdef0123' } };
  const pkg = { resState: (_t, kind, id) => state[`${kind}/${id}`] ?? null };
  assert.deepEqual(resourceHashesFromState(pkg, 't', ['fd.tagclass/B', 'ai.prompt/a']), { 'fd.tagclass/B': '0123456789abcdef' });

  // writeReceipts defaults the hashes from ctx.pkg's sync state (push --all / installed --write)
  const docs = [];
  const ctx = {
    target: { name: 't', user: 'u' }, pkg,
    clients: { core: { getOne: async () => ({ tagReferences: [] }), post: async () => {}, upsertDoc: async (d) => { docs.push(d); } } },
  };
  await writeReceipts(ctx, { code: 'sp', version: '1.0.0', products: ['flowerdocs'] }, { resources: ['fd.tagclass/B'] });
  assert.equal(tagsOf(docs[0])[FD_HASHES_TAG], 'fd.tagclass/B=0123456789abcdef');

  // a server refusing the hash tag costs the hashes, never the receipt
  let n = 0;
  const flaky = { ...ctx, clients: { core: { ...ctx.clients.core, upsertDoc: async (d) => { n += 1; if (d.tags.some((t) => t.name === FD_HASHES_TAG)) throw new Error('value too long'); docs.push(d); } } } };
  const kept = await writeFdReceipt(flaky, { code: 'sp', version: '1.0.0' }, { resources: ['fd.tagclass/B'], resourceHashes: { 'fd.tagclass/B': 'x' } });
  assert.equal(n, 2);
  assert.equal(kept.resourceHashes, undefined);
  assert.match(kept.warning, /hashes not recorded/);

  // ownership merges every surface's receipt for THIS code only
  const own = ownedByReceipt([
    { code: 'sp', version: '1.0.0', resources: ['a/1'], resourceHashes: null },
    { code: 'sp', version: '1.0.0', resources: ['a/1', 'b/2'], resourceHashes: { 'b/2': 'h' } },
    { code: 'other', version: '9', resources: ['c/3'] },
  ], 'sp');
  assert.deepEqual([...own.keys].sort(), ['a/1', 'b/2']);
  assert.deepEqual(own.hashes, { 'b/2': 'h' });
  assert.equal(ownedByReceipt([{ code: 'sp', version: '1.0.0' }], 'sp'), null); // no resource list = nothing claimable
});
