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
  shortHash, resourceHashesFromState, FD_CONTENT_KIND, FD_TAGS, readReceipts,
} from '../lib/receipt.mjs';
import { reclassifyOwned } from '../lib/packageio.mjs';
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

// hashes ride as the receipt document's JSON content file (never a tag — zero schema writes)
const receiptDoc = ({ code = 'sp', version = '0.1.0', resources = null, hashes = null }) => ({
  id: `UXC_PKG_${code.toUpperCase()}`,
  tags: [
    tag('UxcPackageCode', code), tag('UxcPackageVersion', version),
    ...(resources ? [tag('UxcResources', resources.join(','))] : []),
  ],
  ...(hashes ? { files: [{ id: `f_${code}` }], _content: JSON.stringify({ kind: FD_CONTENT_KIND, resourceHashes: hashes }) } : {}),
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
        getContent: async (id, fid) => (docs[id]?.files?.[0]?.id === fid ? Buffer.from(docs[id]._content) : null),
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

/** A fake FD core that stores documents WITH their content files the way upsertDoc does
 *  (files given -> replaced; none -> the server's kept) and serves them back through getContent. */
function fdStore({ failUpload = false } = {}) {
  const docs = new Map(); const blobs = new Map(); const calls = [];
  let n = 0;
  const core = {
    calls, docs,
    // infra present as any pre-#52 uxc left it (the class references exactly FD_TAGS)
    getOne: async (p) => (p.startsWith('/rest/documentclass/') ? { id: 'UxcPackage', tagReferences: FD_TAGS.map((tagName) => ({ tagName })) } : { id: p }),
    post: async (p, b) => { calls.push(['post', p, b?.[0]?.id]); },
    getDoc: async (id) => (docs.has(id) ? structuredClone(docs.get(id)) : null),
    getContent: async (id, fid) => blobs.get(fid) ?? null,
    upsertDoc: async (doc, files = []) => {
      calls.push(['upsertDoc', doc.id, files.length]);
      if (files.length && failUpload) throw new Error('413 upload refused');
      const prev = docs.get(doc.id);
      const refs = files.map((f) => { const fid = `file_${++n}`; blobs.set(fid, Buffer.from(f.bytes)); return { id: fid, name: f.filename }; });
      docs.set(doc.id, { ...prev, ...doc, files: refs.length ? refs : prev?.files ?? [] });
    },
    search: async () => ({ results: [...docs.keys()].map((id) => ({ id })) }),
  };
  return core;
}

test('receipts record per-resource hashes: FD content file + AI JSON round-trip, derived from sync state, merged by ownedByReceipt', async () => {
  const hashes = { 'fd.tagclass/B': 'bbbb', 'ai.prompt/a': 'aaaa' };
  const r = buildReceipt({ code: 'sp', version: '1.0.0' }, { resources: ['ai.prompt/a', 'fd.tagclass/B'], resourceHashes: hashes });
  assert.deepEqual(Object.keys(r.resourceHashes), ['ai.prompt/a', 'fd.tagclass/B']);
  assert.equal(buildReceipt({ code: 'sp' }, { resources: ['x/y'] }).resourceHashes, undefined); // absent when none
  assert.deepEqual(receiptFromAiPrompt({ id: 'uxcPkgSp', content: JSON.stringify(r) }).resourceHashes, hashes);
  const fd = receiptFromFdDoc({ id: 'UXC_PKG_SP', tags: [tag('UxcPackageCode', 'sp')] }, { kind: FD_CONTENT_KIND, resourceHashes: hashes });
  assert.deepEqual(fd.resourceHashes, hashes);
  assert.equal(receiptFromFdDoc({ id: 'UXC_PKG_SP', tags: [] }).resourceHashes, null); // older receipt: no file

  const state = { 'fd.tagclass/B': { syncedHash: 'sha256:0123456789abcdef0123' } };
  const pkg = { resState: (_t, kind, id) => state[`${kind}/${id}`] ?? null };
  assert.deepEqual(resourceHashesFromState(pkg, 't', ['fd.tagclass/B', 'ai.prompt/a']), { 'fd.tagclass/B': '0123456789abcdef' });

  // writeReceipts (the real path) defaults the hashes from ctx.pkg's sync state (push --all /
  // installed --write) and puts them in the receipt doc's CONTENT FILE — no tag, no schema write
  const core = fdStore();
  const ctx = { target: { name: 't', user: 'u' }, pkg, clients: { core, gateway: { get: async () => [] } } };
  const res = await writeReceipts(ctx, { code: 'sp', version: '1.0.0', products: ['flowerdocs'] }, { resources: ['fd.tagclass/B'] });
  assert.equal(res[0].ok, true);
  assert.deepEqual(core.calls.filter(([op]) => op !== 'upsertDoc'), [], 'zero schema writes');
  const doc = core.docs.get('UXC_PKG_SP');
  assert.equal(doc.tags.some((t) => /Hash/i.test(t.name)), false, 'no hash tag');
  assert.equal(doc.files.length, 1);
  const back = await readReceipts(ctx, { code: 'sp' });
  assert.deepEqual(back[0].resourceHashes, { 'fd.tagclass/B': '0123456789abcdef' }, 'round-trips through the content file');
  assert.deepEqual((await readReceipts(ctx))[0].resourceHashes, { 'fd.tagclass/B': '0123456789abcdef' }); // list-all path too

  // a later receipt WITHOUT hashes rewrites the file without them (never leaves stale ones), keeping its other keys
  const withExtra = fdStore();
  withExtra.docs.set('UXC_PKG_SP', { id: 'UXC_PKG_SP', tags: [], files: [{ id: 'old' }] });
  const blobOf = withExtra.getContent;
  withExtra.getContent = async (id, f) => (f === 'old'
    ? Buffer.from(JSON.stringify({ kind: FD_CONTENT_KIND, note: 'keep', resourceHashes: { 'x/y': 'stale' } }))
    : blobOf(id, f));
  const wctx = { target: { name: 't', user: 'u' }, clients: { core: withExtra, gateway: { get: async () => [] } } };
  await writeFdReceipt(wctx, { code: 'sp', version: '1.0.1' }, { resources: ['x/y'] });
  assert.equal(withExtra.calls.find(([op]) => op === 'upsertDoc')[2], 1, 'the file is rewritten');
  const newDoc = withExtra.docs.get('UXC_PKG_SP');
  assert.deepEqual(JSON.parse(String(await withExtra.getContent(newDoc.id, newDoc.files[0].id))), { kind: FD_CONTENT_KIND, note: 'keep' });
  assert.equal((await readReceipts(wctx, { code: 'sp' }))[0].resourceHashes, null);

  // a plain receipt on a doc WITHOUT content attaches nothing (the pre-#52 write, byte for byte)
  const plain = fdStore();
  await writeFdReceipt({ target: { name: 't', user: 'u' }, clients: { core: plain } }, { code: 'pl', version: '1.0.0' }, { resources: ['x/y'] });
  assert.deepEqual(plain.calls, [['upsertDoc', 'UXC_PKG_PL', 0]]);

  // a server refusing the content upload costs the hashes, never the receipt
  const flaky = fdStore({ failUpload: true });
  const kept = await writeFdReceipt({ target: { name: 't', user: 'u' }, clients: { core: flaky } }, { code: 'sp', version: '1.0.0' }, { resources: ['fd.tagclass/B'], resourceHashes: { 'fd.tagclass/B': 'x' } });
  assert.deepEqual(flaky.calls.map((c) => c[2]), [1, 0]);
  assert.equal(kept.resourceHashes, undefined);
  assert.match(kept.warning, /hashes not recorded/);
  assert.ok(flaky.docs.has('UXC_PKG_SP'));

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

test('stale receipt WITHOUT a hash may only claim ids carrying its own prefix; a recorded hash may claim any', async () => {
  const server = { '/rest/tagclass/SpStatus': V1_STATUS, '/rest/tagclass/Status': { ...V1_STATUS, id: 'Status' } };
  const ctx = fakeCtx({ server });
  const seeded = [];
  const pkg = { manifest: { code: 'sp' }, setResState: (_t, kind, id) => seeded.push(`${kind}/${id}`) };
  const rowsOf = () => ['SpStatus', 'Status'].map((id) => ({ state: 'collision', kind: 'fd.tagclass', id, entry: { kind: 'fd.tagclass', id } }));
  // hash-less receipt listing both: SpStatus (own prefix) upgrades, the unprefixed Status stays a collision
  let rows = rowsOf();
  let res = await reclassifyOwned(ctx, pkg, rows, ownedByReceipt([{ code: 'sp', version: '0.1.0', resources: ['fd.tagclass/SpStatus', 'fd.tagclass/Status'] }], 'sp'));
  assert.deepEqual(rows.map((r) => `${r.id}:${r.state}`), ['SpStatus:upgrade', 'Status:collision']);
  assert.deepEqual(res.unknownBase, ['fd.tagclass/SpStatus']);
  assert.deepEqual(seeded, ['fd.tagclass/SpStatus'], 'no base seeded for the unproven claim');
  // a recorded hash proves the claim whatever the id
  rows = rowsOf();
  const h = shortHash(await serverHash(fakeCtx({ server }), { kind: 'fd.tagclass', id: 'Status' }));
  res = await reclassifyOwned(ctx, pkg, rows, ownedByReceipt([{ code: 'sp', version: '0.1.0', resources: ['fd.tagclass/Status'], resourceHashes: { 'fd.tagclass/Status': h } }], 'sp'));
  assert.deepEqual(rows.map((r) => `${r.id}:${r.state}`), ['SpStatus:collision', 'Status:upgrade']);
  assert.deepEqual(res.upgraded, ['fd.tagclass/Status']);
});

test('#125/#126 receipts record dataSets (definitions only) + tagContributions in the content file — zero schema writes, stale copies dropped', async () => {
  const manifest = {
    code: 'cm', version: '1.0.0', products: ['flowerdocs', 'uxopian-ai'],
    dataSets: [{ name: 'CmTransitions', classId: 'CmTransitionsClass', path: 'data/CmTransitions.jsonl' }, { name: 'CmDocs', classId: 'CmDocClass', path: 'data/CmDocs.jsonl', content: true, extra: 'x' }],
  };
  const r = buildReceipt(manifest, { tagContributions: [{ tagClass: 'CmCaseType', values: ['ORDER', 'PO_ORDER'] }] });
  assert.deepEqual(r.dataSets, [
    { name: 'CmDocs', classId: 'CmDocClass', path: 'data/CmDocs.jsonl', content: true },
    { name: 'CmTransitions', classId: 'CmTransitionsClass', path: 'data/CmTransitions.jsonl' },
  ]);
  const core = fdStore();
  const gw = { prompts: [], get: async () => gw.prompts, post: async (_p, b) => { gw.prompts.push(b); } };
  const ctx = { target: { name: 't', user: 'u' }, clients: { core, gateway: gw } };
  const res = await writeFdReceipt(ctx, manifest, { tagContributions: r.tagContributions });
  assert.equal(res.dataSets.length, 2);
  assert.deepEqual(core.calls.filter(([op]) => op !== 'upsertDoc'), [], 'zero schema writes');
  const back = (await readReceipts(ctx, { code: 'cm' })).find((x) => x.surface === 'flowerdocs');
  assert.deepEqual(back.dataSets, r.dataSets);
  assert.deepEqual(back.tagContributions, r.tagContributions);
  assert.equal(back.resourceHashes, null);
  // the AI receipt JSON carries the same keys
  assert.deepEqual(receiptFromAiPrompt({ id: 'uxcPkgCm', content: JSON.stringify(r) }).dataSets, r.dataSets);
  // a later receipt of a package that dropped them rewrites the file without them
  await writeFdReceipt(ctx, { code: 'cm', version: '1.0.1' }, {});
  const again = (await readReceipts(ctx, { code: 'cm' })).find((x) => x.surface === 'flowerdocs');
  assert.equal(again.dataSets, null);
  assert.equal(again.tagContributions, null);
  // the upload refused: the receipt survives without its content (readers: an older receipt)
  const flaky = fdStore({ failUpload: true });
  const kept = await writeFdReceipt({ target: { name: 't', user: 'u' }, clients: { core: flaky } }, manifest, {});
  assert.equal(kept.dataSets, undefined);
  assert.match(kept.warning, /receipt content not recorded/);
});
