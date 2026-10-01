// Offline tests for #126 (DESIGN §28): a product (cm) owns the CHOICELIST tag class CmCaseType and an
// installed extension (po) adds values to it through an fd.tagclass-delta. The product's view of the
// class leaves the extension's contributed values out (receipt tagContributions + the §31 prefix rule):
// status is quiet on both sides with a note, pull never absorbs them, push merges instead of wiping them.
// Receipts unreadable -> fail safe: values stay in the hash, are never pulled, prefixed ones never removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { pushResources, pullResources, statusAll, serverHash } from '../lib/sync.mjs';
import { hashResource } from '../lib/canonical.mjs';
import {
  buildReceipt, tagContributionsFromPkg, receiptFromFdDoc, receiptFromAiPrompt, FD_CONTENT_KIND,
} from '../lib/receipt.mjs';
import { splitTagValues } from '../lib/ownership.mjs';
import { tag } from '../lib/util.mjs';

const TC = 'CmCaseType';
const FQ = 'com.flower.docs.domain.tagclass.AllowedValue';
const d = (n, en = n) => ({ symbolicName: n, displayNames: [{ language: 'EN', value: en }] });
const names = (o) => (o?.allowedValues ?? []).map((x) => x.symbolicName);

function fakeCore() {
  const tcs = new Map();
  const rcpt = new Map(); // id -> {doc, content}
  const log = { posts: [] };
  const idOf = (path) => decodeURIComponent(path.split('/').pop());
  return {
    tcs, rcpt, log,
    get: async (path) => (path === '/rest/tagclass' ? [...tcs.values()].map((t) => structuredClone(t)) : null),
    getOne: async (path) => {
      if (path.startsWith('/rest/tagclass/')) return structuredClone(tcs.get(idOf(path)) ?? null);
      if (path.startsWith('/rest/documentclass/')) return rcpt.size ? { id: 'UxcPackage' } : null;
      return null;
    },
    post: async (path, body) => {
      assert.ok(Array.isArray(body), 'array body');
      const o = structuredClone(body[0]);
      // the echo carries the Java discriminator on every value (stripped by canonicalize)
      o.allowedValues = (o.allowedValues ?? []).map((v) => ({ type: FQ, ...v }));
      tcs.set(path === '/rest/tagclass' ? o.id : idOf(path), o);
      log.posts.push({ path, names: names(o) });
      return {};
    },
    search: async ({ classId }) => {
      const list = classId === 'UxcPackage' ? [...rcpt.keys()] : [];
      return { found: list.length, results: list.map((id) => ({ id })) };
    },
    getDoc: async (id) => structuredClone(rcpt.get(id)?.doc ?? null),
    getContent: async (id) => (rcpt.get(id)?.content ? Buffer.from(JSON.stringify(rcpt.get(id).content)) : null),
  };
}

/** Write the receipt a `push --all` would leave (tags + content file), computed from the package. */
async function receiptOf(core, X) {
  const m = X.pkg.manifest;
  const tagContributions = await tagContributionsFromPkg(X.pkg, 't1');
  const r = buildReceipt(m, { resources: X.pkg.entries().map((e) => `${e.kind}/${e.id}`), tagContributions });
  const id = `UXC_PKG_${m.code.toUpperCase()}`;
  const content = r.tagContributions || r.dataSets ? { kind: FD_CONTENT_KIND, ...(r.tagContributions ? { tagContributions: r.tagContributions } : {}), ...(r.dataSets ? { dataSets: r.dataSets } : {}) } : null;
  core.rcpt.set(id, {
    doc: { id, tags: [tag('UxcPackageCode', m.code), tag('UxcPackageVersion', m.version)], ...(content ? { files: [{ id: 'f' }] } : {}) },
    content,
  });
  return r;
}

function makeProduct(values = [d('CM_CLAIM', 'Claim'), d('CM_INCIDENT', 'Incident'), d('PROJECT', 'Project')]) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-stc-cm-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'cm', name: 'cm', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'] }));
  mkdirSync(join(dir, 'fd/tagclasses'), { recursive: true });
  writeFileSync(join(dir, `fd/tagclasses/${TC}.json`), JSON.stringify({ id: TC, type: 'CHOICELIST', searchable: true, displayNames: [{ language: 'EN', value: 'Case type' }], allowedValues: values }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [{ kind: 'fd.tagclass', id: TC, path: `fd/tagclasses/${TC}.json` }] }));
  return dir;
}

function makeExtension() {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-stc-po-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'po', name: 'po', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'], dependencies: { cm: '*' } }));
  mkdirSync(join(dir, 'fd/tagclass-deltas'), { recursive: true });
  // PROJECT: declared legacy but already on the server (the product's) -> never a contribution
  // ORDER:   declared legacy, absent -> the push adds it -> legacyAdded -> a contribution
  writeFileSync(join(dir, `fd/tagclass-deltas/${TC}.delta.json`), JSON.stringify({
    tagclass: TC, legacy: ['ORDER', 'PROJECT'],
    allowedValues: [d('PO_ORDER', 'Purchase order'), d('ORDER', 'Order'), d('PROJECT', 'Project')],
  }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [{ kind: 'fd.tagclass-delta', id: TC, path: `fd/tagclass-deltas/${TC}.delta.json` }] }));
  return dir;
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

const localFile = (dir) => JSON.parse(readFileSync(join(dir, `fd/tagclasses/${TC}.json`), 'utf8'));

/** gfdefault after both installs: product pushed + receipt, extension pushed + receipt. */
async function bothInstalled({ gateway } = {}) {
  const core = fakeCore();
  const cmDir = makeProduct(); const poDir = makeExtension();
  const P = ctxFor(cmDir, core, { gateway }); const E = ctxFor(poDir, core, { gateway });
  await pushResources(P.ctx, P.pkg.entries());
  await receiptOf(core, P);
  await pushResources(E.ctx, E.pkg.entries());
  await receiptOf(core, E);
  return { core, cmDir, poDir, P, E };
}

test('#126 receipts record tagContributions: own prefixed values + legacyAdded only (never a pre-existing legacy value)', async () => {
  const { E, core } = await bothInstalled();
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'PO_ORDER', 'ORDER']);
  assert.deepEqual(E.pkg.resState('t1', 'fd.tagclass-delta', TC).legacyAdded, ['ORDER']);
  const r = await receiptOf(core, E);
  assert.deepEqual(r.tagContributions, [{ tagClass: TC, values: ['ORDER', 'PO_ORDER'] }]);
  // both carriers round-trip it; an older receipt reads as null (tolerated)
  assert.deepEqual(receiptFromAiPrompt({ id: 'uxcPkgPo', content: JSON.stringify(r) }).tagContributions, r.tagContributions);
  assert.deepEqual(receiptFromFdDoc({ id: 'X', tags: [] }, { kind: FD_CONTENT_KIND, tagContributions: r.tagContributions }).tagContributions, r.tagContributions);
  assert.equal(receiptFromFdDoc({ id: 'X', tags: [] }).tagContributions, null);
  assert.equal(receiptFromAiPrompt({ id: 'uxcPkgPo', content: JSON.stringify({ ...r, tagContributions: undefined }) }).tagContributions, null);
  // a package without deltas records none (the receipt is unchanged)
  assert.equal(buildReceipt({ code: 'cm' }, { tagContributions: [] }).tagContributions, undefined);
});

test('#126 status --remote is quiet on BOTH sides after both pushed; the product notes the extension\'s values', async () => {
  const { P, E } = await bothInstalled();
  const prod = (await statusAll(P.ctx, { remote: true })).rows;
  assert.equal(prod.length, 1);
  assert.equal(prod[0].state, 'insync', JSON.stringify(prod[0]));
  assert.equal(prod[0].note, '+2 values of po (another installed package\'s values in this tag class — not hashed, not drift)');
  const ext = (await statusAll(E.ctx, { remote: true })).rows;
  assert.equal(ext[0].state, 'insync', JSON.stringify(ext[0]));
  // the per-id path (classify / serverHash) sees the same view as the batch-listed status path
  const sh = await serverHash(P.ctx, { kind: 'fd.tagclass', id: TC });
  assert.equal(sh, hashResource('fd.tagclass', localFile(P.ctx.pkg.dir), []));
  assert.equal(sh, P.pkg.resState('t1', 'fd.tagclass', TC).syncedHash);
});

test('#126 product pull never absorbs the extension\'s values (also --force); a real server edit still pulls', async () => {
  const { core, cmDir, P } = await bothInstalled();
  core.tcs.get(TC).allowedValues[0].displayNames = [{ language: 'EN', value: 'Claim (edited)' }];
  const P2 = ctxFor(cmDir, core);
  assert.equal((await statusAll(P2.ctx, { remote: true })).rows[0].state, 'server');
  const [r] = await pullResources(P2.ctx, P.pkg.entries());
  assert.equal(r.action, 'pulled');
  const f = localFile(cmDir);
  assert.deepEqual(names(f), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
  assert.equal(f.allowedValues[0].displayNames[0].value, 'Claim (edited)');
  const [again] = await pullResources(P2.ctx, P.pkg.entries(), { force: true });
  assert.equal(again.action, 'insync');
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
});

test('#126 product push MERGES: keeps the extension\'s values, removes the product\'s own deleted value (plain and --force)', async () => {
  const { core, cmDir, P, E } = await bothInstalled();
  for (const force of [false, true]) {
    const f = localFile(cmDir);
    f.allowedValues = force
      ? [...f.allowedValues, d('CM_EXTRA', 'Extra')]
      : [f.allowedValues[0], f.allowedValues[2], d('CM_NEW', 'New')]; // CM_INCIDENT deleted locally
    writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
    const [r] = await pushResources(P.ctx, P.pkg.entries(), { force });
    assert.equal(r.action, 'updated', JSON.stringify(r));
    assert.ok(P.notes.some((n) => /keeping 2 value\(s\) of other installed packages on the server \(PO_ORDER, ORDER\)/.test(n)), P.notes.join('\n'));
  }
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'PROJECT', 'CM_NEW', 'CM_EXTRA', 'PO_ORDER', 'ORDER']);
  // the echo write never brought them into the product file; both sides quiet again
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'PROJECT', 'CM_NEW', 'CM_EXTRA']);
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'insync');
  assert.equal((await statusAll(E.ctx, { remote: true })).rows[0].state, 'insync');
});

test('#126 a product file that absorbed extension values (0.25.0 pull) self-heals: push keeps them on the server, the echo drops them locally', async () => {
  const { core, cmDir, P } = await bothInstalled();
  const f = localFile(cmDir);
  f.allowedValues.push(d('PO_ORDER', 'Purchase order'), d('ORDER', 'Order'));
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'local');
  await pushResources(P.ctx, P.pkg.entries());
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'PO_ORDER', 'ORDER']);
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'insync');
});

test('#126 receipts unreadable: values stay in the hash (drift), are never pulled, and push never removes them', async () => {
  let down = false;
  const gateway = { get: async () => { if (down) throw new Error('ECONNREFUSED'); return []; } };
  const { core, cmDir, P } = await bothInstalled({ gateway });
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'insync'); // readable: records the ledger
  down = true;
  const row = (await statusAll(P.ctx, { remote: true })).rows[0];
  assert.equal(row.state, 'server', 'fail safe: the values count (false drift), never silently dropped');
  assert.match(row.note, /receipts could not be read \(uxopian-ai: ECONNREFUSED\) — PO_ORDER, ORDER may be another installed package's: counted in the hash \(fail safe\), never pulled/);
  for (const force of [false, true]) {
    const [r] = await pullResources(P.ctx, P.pkg.entries(), { force });
    assert.equal(r.action, 'refused');
    assert.match(r.detail, /PO_ORDER, ORDER may be another installed package's values: not pulled \(fail safe\)/);
  }
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
  // a forced product push keeps the prefixed value AND the legacy one recorded at the last good read
  const f = localFile(cmDir);
  f.allowedValues = f.allowedValues.slice(0, 2);
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  await pushResources(P.ctx, P.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PO_ORDER', 'ORDER']);
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'CM_INCIDENT'], 'the echo never writes them locally');
});

test('#126 receipts unreadable and never read: no installed ledger -> any value without the own prefix is refused by pull', async () => {
  const { core, P } = await bothInstalled();
  const fresh = ctxFor(makeProduct(), core, { gateway: { get: async () => { throw new Error('down'); } } });
  assert.equal(fresh.pkg.installedSeen('t1'), null);
  const [r] = await pullResources(fresh.ctx, P.pkg.entries(), { force: true });
  assert.equal(r.action, 'refused');
  assert.match(r.detail, /PO_ORDER, ORDER may be/);
});

test('#126 alone on the target: the view is the object as read (hash byte-identical); splitTagValues pure rules', async () => {
  const core = fakeCore();
  const cmDir = makeProduct();
  const P = ctxFor(cmDir, core);
  await pushResources(P.ctx, P.pkg.entries());
  await receiptOf(core, P);
  const raw = await core.getOne(`/rest/tagclass/${TC}`);
  assert.equal(await serverHash(P.ctx, { kind: 'fd.tagclass', id: TC }), hashResource('fd.tagclass', raw, []));
  const st = (await statusAll(P.ctx, { remote: true })).rows[0];
  assert.equal(st.state, 'insync');
  assert.equal(st.note, undefined);
  assert.equal(JSON.parse(readFileSync(join(cmDir, '.uxc/state.json'), 'utf8')).targets.t1.foreignTagValues, undefined);
  // pure: contributions first, then the longest prefix (cm2 out-matches cm), unprefixed -> own
  const view = { receiptsReadable: true, owners: [{ code: 'cm2', forms: { upper: 'CM2_', pascal: 'Cm2', camel: 'cm2', kebab: 'cm2-' } }], contributions: new Map([[TC, new Map([['ORDER', 'po']])]]) };
  const s = splitTagValues(['CM_A', 'CM2_B', 'ORDER', 'PLAIN'], TC, { code: 'cm' }, view);
  assert.deepEqual(s, { own: ['CM_A', 'PLAIN'], foreign: [{ name: 'ORDER', code: 'po' }, { name: 'CM2_B', code: 'cm2' }] });
  assert.deepEqual(splitTagValues(['ORDER'], TC, { code: 'cm' }, { ...view, receiptsReadable: false }).foreign, []);
});
