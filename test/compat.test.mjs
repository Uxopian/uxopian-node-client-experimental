// Offline tests for lib/compat.mjs + the receipt/report/gate wiring (DESIGN §26, lot U1).
// Two fake versions of a product ("sp" 0.1.0 -> 0.2.0: v2 renames an id and bumps a contract),
// three extension receipts (holds / breaks by rename / breaks by range), and a client that
// THROWS on any write: `--report` must never touch the server (nor the checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompat, judgeUpgrade, validateCompat, receiptDeps, hasBreaks } from '../lib/compat.mjs';
import { buildReceipt, writeFdReceipt, receiptFromFdDoc, receiptFromAiPrompt, FD_TAGS } from '../lib/receipt.mjs';
import { importPackage } from '../lib/packageio.mjs';
import { zipDir } from '../lib/zip.mjs';
import { tag } from '../lib/util.mjs';

const SAMPLE = new URL('../examples/sample-package', import.meta.url).pathname;

// product v2: renames detector "late" -> "overdue", bumps contract of "resolvers" v1 -> v2
const V2 = {
  kind: 'uxc-compat/1',
  provides: {
    detectors: { contract: 'v1', ids: { overdue: { params: ['days'] }, stalled: { params: ['hours'] } } },
    resolvers: { contract: 'v2', ids: ['owner'] },
  },
  renames: { detectors: { late: 'overdue' } },
};
const V1 = { ...V2, provides: { detectors: { contract: 'v1', ids: { late: { params: ['days'] }, stalled: { params: ['hours'] } } }, resolvers: { contract: 'v1', ids: ['owner'] } }, renames: {} };

const rec = (code, version, requires, dependencies) => ({ surface: 'flowerdocs', code, version, requires, dependencies });
const EXT_HOLDS = rec('ext-ok', '1.0.0', { sp: { families: { detectors: { contract: 'v1', ids: { stalled: { params: ['hours'] } } } } } }, { sp: { versions: ['>=0.1'] } });
const EXT_RENAME = rec('ext-rename', '1.0.0', { sp: { families: { detectors: { contract: 'v1', ids: ['late'] } } } }, { sp: { versions: ['>=0.1'] } });
const EXT_CONTRACT = rec('ext-contract', '1.0.0', { sp: { families: { resolvers: { contract: 'v1', ids: ['owner'] } } } });
const EXT_RANGE = rec('ext-range', '1.0.0', { sp: { versions: '0.1.*' } });
const EXT_PARAMS = rec('ext-params', '1.0.0', { sp: { families: { detectors: { ids: { stalled: { params: ['hours', 'plant'] } } } } } });
const UNRELATED = rec('other', '3.0.0', null, { llm: { versions: ['*'] } });

test('judgeUpgrade: holds / breaks by rename (remedy = new name) / breaks by range / contract / review on params', () => {
  const rows = judgeUpgrade([EXT_HOLDS, EXT_RENAME, EXT_RANGE, EXT_CONTRACT, EXT_PARAMS, UNRELATED, rec('sp', '0.1.0')],
    { code: 'sp', version: '0.2.0' }, V2);
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.deepEqual(Object.keys(by).sort(), ['ext-contract', 'ext-ok', 'ext-params', 'ext-range', 'ext-rename']); // unrelated + the product itself are not judged
  assert.equal(by['ext-ok'].verdict, 'holds');
  assert.equal(by['ext-rename'].verdict, 'breaks');
  assert.equal(by['ext-rename'].reasons[0].kind, 'renamed');
  assert.match(by['ext-rename'].reasons[0].remedy, /"overdue"/);
  assert.equal(by['ext-range'].verdict, 'breaks');
  assert.equal(by['ext-range'].reasons[0].kind, 'version-range');
  assert.equal(by['ext-contract'].verdict, 'breaks');
  assert.match(by['ext-contract'].reasons[0].detail, /v1.*v2/);
  assert.equal(by['ext-params'].verdict, 'review');
  assert.match(by['ext-params'].reasons[0].detail, /plant/);
  assert.equal(hasBreaks(rows), true);
});

test('judgeUpgrade: same version holds; a removed id without rename breaks with no replacement; no compat = nothing judged', () => {
  const same = judgeUpgrade([EXT_HOLDS, EXT_RENAME], { code: 'sp', version: '0.1.0' }, V1);
  assert.deepEqual(same.map((r) => r.verdict), ['holds', 'holds']);
  const gone = judgeUpgrade([rec('e', '1', { sp: { families: { resolvers: { ids: ['zzz'] } } } })], { code: 'sp', version: '0.2.0' }, V2);
  assert.equal(gone[0].reasons[0].kind, 'missing');
  assert.deepEqual(judgeUpgrade([EXT_RENAME], { code: 'sp', version: '0.2.0' }, null), []);
});

test('judgeUpgrade: product rows edited on the instance -> review (from the collision table)', () => {
  const rows = judgeUpgrade([EXT_HOLDS], { code: 'sp', version: '0.2.0' }, V2, { collisions: [{ kind: 'fd.tagclass', id: 'SpStatus', state: 'collision' }] });
  assert.equal(rows[0].verdict, 'review');
  assert.equal(rows[0].reasons[0].kind, 'product-row-edited');
});

test('validateCompat: rejects malformed sections', () => {
  assert.deepEqual(validateCompat(V2), []);
  assert.ok(validateCompat({ provides: { x: 3 } }).length);
  assert.ok(validateCompat({ renames: { x: [] } }).length);
  assert.ok(validateCompat({ kind: 'nope' }).length);
});

test('receipts keep dependencies and compat.requires; round-trip through FD tags and the AI prompt', async () => {
  assert.ok(FD_TAGS.includes('UxcCompat'));
  const manifest = { code: 'ext', version: '1.0.0', products: ['flowerdocs', 'uxopian-ai'], dependencies: { sp: { versions: '>=0.1', slug: 'sp-addon' }, llm: '*' } };
  const compat = { requires: { sp: { families: { detectors: { ids: ['late'] } } } } };
  const r = buildReceipt(manifest, { compat });
  assert.deepEqual(r.dependencies.sp, { versions: ['>=0.1'], slug: 'sp-addon' });
  assert.deepEqual(r.dependencies.llm, { versions: ['*'] });
  assert.deepEqual(r.requires, compat.requires);
  // absent when undeclared: today's receipts are byte-identical
  const plain = buildReceipt({ code: 'x', version: '1.0.0', products: [] });
  assert.equal('dependencies' in plain, false);
  assert.equal('requires' in plain, false);

  let written;
  const ctx = { target: { user: 'u' }, clients: { core: {
    getOne: async () => ({ id: 'x', tagReferences: FD_TAGS.map((tagName) => ({ tagName })) }),
    upsertDoc: async (d) => { written = d; },
  } } };
  await writeFdReceipt(ctx, manifest, { compat });
  const back = receiptFromFdDoc(written);
  assert.deepEqual(back.requires, compat.requires);
  assert.deepEqual(back.dependencies.sp.versions, ['>=0.1']);
  const ai = receiptFromAiPrompt({ id: 'uxcPkgExt', content: JSON.stringify(r) });
  assert.deepEqual(ai.requires, compat.requires);
  // a receipt without the tag reads back with nulls (older uxc)
  assert.equal(receiptFromFdDoc({ id: 'UXC_PKG_OLD', tags: [tag('UxcPackageCode', 'old')] }).requires, null);
  assert.equal(receiptDeps({ code: 'a' }, null).dependencies, null);
});

// ---- importPackage: --report is read-only, and "breaks" refuses an install unless --force ----

function product(version, compat) {
  const dir = mkdtempSync(join(tmpdir(), 'uxc-compat-pkg-'));
  cpSync(SAMPLE, dir, { recursive: true });
  const mf = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ ...mf, version, ...(compat ? { compat: 'compat.json' } : {}) }));
  if (compat) writeFileSync(join(dir, 'compat.json'), JSON.stringify(compat));
  return dir;
}

const fdDoc = (r) => ({ id: `UXC_PKG_${r.code.toUpperCase()}`, tags: [
  tag('UxcPackageCode', r.code), tag('UxcPackageVersion', r.version),
  tag('UxcCompat', JSON.stringify({ dependencies: r.dependencies, requires: r.requires })),
] });

function fakeCtx(receipts, { serverEdits = {} } = {}) {
  const docs = Object.fromEntries(receipts.map((r) => [fdDoc(r).id, fdDoc(r)]));
  const writes = [];
  const boom = (n) => async (...a) => { writes.push([n, a[0]]); throw new Error(`WRITE ${n}`); };
  const lines = [];
  const out = { json: false, result() {}, line: (...p) => lines.push(p.join(' ')), note() {}, warn: (m) => lines.push(`WARN ${m}`), table: (rows) => lines.push(`TABLE ${JSON.stringify(rows)}`) };
  return {
    writes, lines,
    flags: {}, out, target: { name: 't', user: 'u' },
    connect() {},
    clients: {
      core: {
        getOne: async (p) => serverEdits[p] ?? null,
        getDoc: async (id) => docs[id] ?? null,
        search: async () => ({ results: Object.keys(docs).map((id) => ({ id })) }),
        post: boom('core.post'), put: boom('core.put'), del: boom('core.del'), upsertDoc: boom('core.upsertDoc'),
      },
      gateway: { get: async () => [], post: boom('gw.post'), put: boom('gw.put'), delete: boom('gw.delete') },
    },
  };
}

test('import --report: judges from receipts, writes NOTHING (no POST/PUT, checkout untouched), breaks flagged', async () => {
  const dir = product('0.2.0', V2);
  const before = readdirSync(dir).sort().join();
  const ctx = fakeCtx([EXT_HOLDS, EXT_RENAME, EXT_RANGE]);
  const prevExit = process.exitCode;
  try {
    const res = await importPackage(ctx, dir, { report: true });
    assert.equal(res.report, true);
    assert.equal(res.written ?? false, false);
    assert.equal(res.upgrade.breaks, true);
    assert.deepEqual(res.upgrade.rows.map((r) => [r.code, r.verdict]), [['ext-ok', 'holds'], ['ext-range', 'breaks'], ['ext-rename', 'breaks']]);
    assert.equal(process.exitCode, 2);
    assert.deepEqual(ctx.writes, []);
    assert.equal(readdirSync(dir).sort().join(), before);
    assert.match(ctx.lines.join('\n'), /remedy: use "overdue"/);
  } finally { process.exitCode = prevExit; rmSync(dir, { recursive: true, force: true }); }
});

test('import --report: a product row edited on the instance turns "holds" into "review" (exit stays 0)', async () => {
  const dir = product('0.2.0', V2);
  const ctx = fakeCtx([EXT_HOLDS], { serverEdits: { '/rest/tagclass/SpStatus': { id: 'SpStatus', type: 'STRING', edited: true } } });
  const prevExit = process.exitCode;
  try {
    const res = await importPackage(ctx, dir, { report: true });
    assert.equal(res.upgrade.rows[0].verdict, 'review');
    assert.notEqual(process.exitCode, 2);
    assert.deepEqual(ctx.writes, []);
  } finally { process.exitCode = prevExit; rmSync(dir, { recursive: true, force: true }); }
});

test('import --report from a .uxpkg archive leaves no ./<code> directory behind', async () => {
  const dir = product('0.2.0', V2);
  const cwd = mkdtempSync(join(tmpdir(), 'uxc-compat-cwd-'));
  const archive = join(cwd, 'sp-0.2.0.uxpkg');
  await zipDir(dir, archive);
  assert.deepEqual((await readCompat(archive)).renames, V2.renames);
  const old = process.cwd();
  const prevExit = process.exitCode;
  process.chdir(cwd);
  try {
    const res = await importPackage(fakeCtx([EXT_HOLDS]), archive, { report: true });
    assert.equal(res.upgrade.rows[0].verdict, 'holds');
    assert.equal(existsSync(join(cwd, 'sp')), false);
  } finally { process.chdir(old); process.exitCode = prevExit; rmSync(dir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test('install gate: "breaks" refuses before any write unless --force; without compat.json nothing changes', async () => {
  const dir = product('0.2.0', V2);
  const realExit = process.exit;
  const realErr = console.error;
  let msg = '';
  process.exit = (c) => { throw Object.assign(new Error('exit'), { code: c }); };
  console.error = (m) => { msg += `${m}\n`; };
  try {
    const ctx = fakeCtx([EXT_RENAME]);
    await assert.rejects(() => importPackage(ctx, dir, {}), /exit/);
    assert.match(msg, /breaks installed extension\(s\): ext-rename/);
    assert.deepEqual(ctx.writes, []); // refused before the first write attempt
    // --force goes past the gate (and hits the write guard of the fake client — proof it proceeded)
    const forced = fakeCtx([EXT_RENAME]);
    await assert.rejects(() => importPackage(forced, dir, { force: true }), /WRITE|exit/);
    assert.ok(forced.writes.length > 0 || /INSTALLING ANYWAY/.test(forced.lines.join('\n')));
    assert.match(forced.lines.join('\n'), /INSTALLING ANYWAY/);
  } finally { process.exit = realExit; console.error = realErr; rmSync(dir, { recursive: true, force: true }); }
  // a package that ships no compat.json is not judged at all
  const plain = product('0.2.0', null);
  try {
    const ctx = fakeCtx([EXT_RENAME]);
    const res = await importPackage(ctx, plain, { report: true });
    assert.equal(res.upgrade, null);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});
