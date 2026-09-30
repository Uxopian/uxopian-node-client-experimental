// Offline tests for lib/compat.mjs + the receipt/report/gate wiring (DESIGN §26, lot U1).
// Two fake versions of a product ("sp" 0.1.0 -> 0.2.0: v2 renames an id and bumps a contract),
// three extension receipts (holds / breaks by rename / breaks by range), and a client that
// THROWS on any write: `--report` must never touch the server (nor the checkout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompat, judgeUpgrade, validateCompat, receiptDeps, hasBreaks, EXIT_BREAKS } from '../lib/compat.mjs';
import { buildReceipt, writeFdReceipt, receiptFromFdDoc, receiptFromAiPrompt, FD_TAGS, FD_COMPAT_TAG, FD_CLASS } from '../lib/receipt.mjs';
import { satisfiesRange, parseVersionRange, versionSupported } from '../lib/version.mjs';
import { LOCK_MODES } from '../lib/cli-meta.mjs';
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
  assert.equal(FD_COMPAT_TAG, 'UxcCompat');
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
    getOne: async () => ({ id: 'x', tagReferences: [...FD_TAGS, FD_COMPAT_TAG].map((tagName) => ({ tagName })) }),
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
    assert.equal(process.exitCode, EXIT_BREAKS);
    assert.equal(EXIT_BREAKS, 3); // distinct from fail()/crash (2)
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
    assert.notEqual(process.exitCode, EXIT_BREAKS);
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

// ---- review fixes (PR #86) ----

test('ranges: ^ ~ x, space-AND comparator sets, ||, prereleases (satisfiesRange)', () => {
  const cases = [
    ['1.3.0', '^1.2', true], ['1.2.0', '~1.2', true], ['1.4.0', '1.x', true], ['1.4.0', '1.*', true],
    ['2.5.0', '>=1.0 <2.0', false], ['1.5.0', '>=1.0 <2.0', true], ['1.5.0', '>= 1.0 < 2.0', true],
    ['2.0.0', '^1.2', false], ['1.1.9', '^1.2', false], ['1.3.0', '~1.2', false], ['1.9.0', '~1', true],
    ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.4', '^0.0.3', false],
    ['3.1.0', '^1 || ^3', true], ['2.0.0', '^1 || ^3', false], ['2.0.0', ['^1', '2.x'], true],
    ['1.2.0', '1.2', true], ['1.2.1', '1.2', false], ['1.2.1', '=1.2.1', true], ['9.9.9', '*', true],
    // prereleases: semver precedence; ^ ~ x upper bounds exclude the next version's prereleases
    ['2.0.0-rc.1', '^1.2', false], ['1.3.0-rc.1', '^1.2', true], ['1.2.0-rc.1', '^1.2', false],
    ['1.2.0-rc.2', '^1.2.0-rc.1', true], ['2.0.0-rc.1', '1.x', false], ['1.0.0-rc.1', '>=1.0', false],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfiesRange(v, r), want, `${v} vs ${JSON.stringify(r)}`);
  // every supportedVersions pattern means the same thing as a range
  for (const [v, p] of [['2025.4.1', '2025.*'], ['2026.1.0', '>=2026'], ['2026.0.0', '2026.0.0'], ['1.0.0-rc.1', '1.*'], ['0.9.0', '<1.0'], ['0.2.0', '0.1.*']]) {
    assert.equal(satisfiesRange(v, p), versionSupported(v, p), `${v} vs ${p}`);
  }
  for (const bad of ['', 'foo', '1.x.3', '1.0 - 2.0', '>=', '1.x-rc.1', '^1 ||', 42]) assert.equal(parseVersionRange(bad), null, JSON.stringify(bad));
  assert.equal(satisfiesRange('1.0.0', 'foo'), false);
  // versionSupported keeps its existing behavior for the server/dependency gates
  assert.equal(versionSupported('1.3.0', '^1.2'), false);
});

test('judgeUpgrade: ^/~/x ranges hold, an upper bound breaks', () => {
  const r = (versions) => rec('e', '1.0.0', { sp: { versions } });
  const verdict = (versions, version) => judgeUpgrade([r(versions)], { code: 'sp', version }, V1)[0].verdict;
  assert.equal(verdict('^1.2', '1.3.0'), 'holds');
  assert.equal(verdict('~1.2', '1.2.0'), 'holds');
  assert.equal(verdict('1.x', '1.4.0'), 'holds');
  assert.equal(verdict('>=1.0 <2.0', '2.5.0'), 'breaks');
});

test('validateCompat: an unparseable requires.*.versions is rejected (mp publish refuses it)', () => {
  assert.deepEqual(validateCompat({ requires: { sp: { versions: '^1.2 || >=3.0 <4' } } }), []);
  assert.deepEqual(validateCompat({ requires: { sp: { versions: ['1.x', '2.*'] } } }), []);
  const errs = validateCompat({ requires: { sp: { versions: '1.0 - 2.0' } } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /requires\.sp\.versions .* does not parse/);
  assert.ok(validateCompat({ requires: { sp: { versions: 12 } } }).length);
});

function infraCtx() {
  const calls = [];
  const have = new Set(FD_TAGS.map((t) => `/rest/tagclass/${t}`));
  return {
    calls, target: { user: 'u' },
    clients: { core: {
      getOne: async (p) => (have.has(p) ? { id: p }
        : p === `/rest/documentclass/${FD_CLASS}` ? { id: FD_CLASS, tagReferences: FD_TAGS.map((tagName) => ({ tagName })) } : null),
      post: async (p, b) => { calls.push([p, b[0]?.id]); },
      upsertDoc: async (d) => { calls.push(['upsertDoc', d]); },
    } },
  };
}

test('receipt without compat: no UxcCompat tagclass, no UxcPackage class update, no tag (as before §26)', async () => {
  const ctx = infraCtx(); // a server whose infra was set up by a pre-§26 uxc
  await writeFdReceipt(ctx, { code: 'plain', version: '1.0.0', products: ['flowerdocs'] }, { compat: null });
  assert.deepEqual(ctx.calls.filter(([p]) => p !== 'upsertDoc'), []); // zero schema writes
  const doc = ctx.calls.find(([p]) => p === 'upsertDoc')[1];
  assert.equal(doc.tags.some((t) => t.name === FD_COMPAT_TAG), false);

  const withCompat = infraCtx();
  await writeFdReceipt(withCompat, { code: 'ext', version: '1.0.0', products: ['flowerdocs'] }, { compat: { requires: { sp: { versions: '^1' } } } });
  const schema = withCompat.calls.filter(([p]) => p !== 'upsertDoc');
  assert.deepEqual(schema.map(([p, id]) => `${p}:${id}`), ['/rest/tagclass:UxcCompat', `/rest/documentclass/${FD_CLASS}:${FD_CLASS}`]);
  assert.ok(withCompat.calls.find(([p]) => p === 'upsertDoc')[1].tags.some((t) => t.name === FD_COMPAT_TAG));
});

test('--report is a READ for the lock (never queues, never waits the handler window); a plain install is a write', () => {
  for (const mod of ['import', 'mp-install']) {
    assert.equal(typeof LOCK_MODES[mod], 'function');
    assert.equal(LOCK_MODES[mod]({ report: true }), 'read');
    assert.equal(LOCK_MODES[mod]({}), 'write');
  }
});

test('import --report removes its uxc-report-* scratch dir on every path (return and fail)', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'uxc-compat-tmp-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const realExit = process.exit;
  const realErr = console.error;
  const good = product('0.2.0', V2);
  const bad = product('0.2.0', V2);
  writeFileSync(join(bad, 'compat.json'), '{ not json'); // fails AFTER the scratch copy exists
  const prevExit = process.exitCode;
  try {
    Object.assign(process.env, { TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot });
    const scratch = () => readdirSync(tmpRoot).filter((n) => n.startsWith('uxc-report-'));
    await importPackage(fakeCtx([EXT_HOLDS]), good, { report: true });
    assert.deepEqual(scratch(), []);
    process.exit = (c) => { throw Object.assign(new Error('exit'), { code: c }); };
    console.error = () => {};
    await assert.rejects(() => importPackage(fakeCtx([EXT_HOLDS]), bad, { report: true }), /exit/);
    assert.deepEqual(scratch(), []);
  } finally {
    process.exit = realExit; console.error = realErr; process.exitCode = prevExit;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [good, bad, tmpRoot]) rmSync(d, { recursive: true, force: true });
  }
});
