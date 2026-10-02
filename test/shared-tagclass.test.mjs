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
  buildReceipt, receiptFromFdDoc, receiptFromAiPrompt, writeReceipts, refreshTagContributions, FD_CONTENT_KIND, FD_TAGS,
} from '../lib/receipt.mjs';
import delta from '../lib/kinds/fd-tagclass-delta.mjs';
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
      if (path.startsWith('/rest/tagclass/Uxc')) return { id: idOf(path) }; // receipt infra already there
      if (path.startsWith('/rest/tagclass/')) return structuredClone(tcs.get(idOf(path)) ?? null);
      if (path.startsWith('/rest/documentclass/')) return { id: 'UxcPackage', tagReferences: [...FD_TAGS, 'UxcCompat'].map((tagName) => ({ tagName })) };
      return null;
    },
    upsertDoc: async (doc, files = []) => {
      const prev = rcpt.get(doc.id);
      rcpt.set(doc.id, {
        doc: { ...(prev?.doc ?? {}), ...doc, files: files.length ? [{ id: 'f' }] : (prev?.doc?.files ?? []) },
        content: files.length ? JSON.parse(String(files[0].bytes)) : (prev?.content ?? null),
      });
      log.receipts = (log.receipts ?? 0) + 1;
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

/** The receipt a `push --all` leaves: the REAL writeReceipts (FD doc + content file). */
async function receiptOf(core, X) {
  const res = await writeReceipts(X.ctx, X.pkg.manifest, { resources: X.pkg.entries().map((e) => `${e.kind}/${e.id}`) });
  assert.equal(res[0].ok, true, JSON.stringify(res));
  return res[0].receipt;
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

test('#126 receipts record tagContributions: delta = own prefixed values + legacyAdded (never a pre-existing legacy value); owner = its list; [] = none', async () => {
  const { E, P, core } = await bothInstalled();
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'PO_ORDER', 'ORDER']);
  assert.deepEqual(E.pkg.resState('t1', 'fd.tagclass-delta', TC).legacyAdded, ['ORDER']);
  const r = await receiptOf(core, E);
  assert.deepEqual(r.tagContributions, [{ tagClass: TC, values: ['ORDER', 'PO_ORDER'] }]);
  assert.deepEqual(core.rcpt.get('UXC_PKG_PO').content.tagContributions, r.tagContributions, 'in the content file');
  // the owner lists its own values (shared-claim source for the extension's rm/prune)
  assert.deepEqual((await receiptOf(core, P)).tagContributions, [{ tagClass: TC, values: ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT'] }]);
  // both carriers round-trip it; an older receipt reads as null (= unknown), [] stays [] (= none)
  assert.deepEqual(receiptFromAiPrompt({ id: 'uxcPkgPo', content: JSON.stringify(r) }).tagContributions, r.tagContributions);
  assert.deepEqual(receiptFromFdDoc({ id: 'X', tags: [] }, { kind: FD_CONTENT_KIND, tagContributions: r.tagContributions }).tagContributions, r.tagContributions);
  assert.equal(receiptFromFdDoc({ id: 'X', tags: [] }).tagContributions, null);
  assert.deepEqual(receiptFromFdDoc({ id: 'X', tags: [] }, { kind: FD_CONTENT_KIND, tagContributions: [] }).tagContributions, []);
  assert.equal(receiptFromAiPrompt({ id: 'uxcPkgPo', content: JSON.stringify({ ...r, tagContributions: undefined }) }).tagContributions, null);
  assert.deepEqual(buildReceipt({ code: 'cm' }, { tagContributions: [] }).tagContributions, [], 'written even when empty');
  assert.equal(buildReceipt({ code: 'cm' }, {}).tagContributions, undefined, 'unknown when not computed');
});

test('#126 item 1: an extension upgrade from a FRESH directory keeps the legacy attribution (carried from the previous receipt) and seeds legacyAdded', async () => {
  const { core, P } = await bothInstalled();
  const E2 = ctxFor(makeExtension(), core); // mp install / import upgrade: no state, ORDER already on the server
  const [pushed] = await pushResources(E2.ctx, E2.pkg.entries());
  assert.notEqual(pushed.action, 'refused');
  assert.equal(E2.pkg.resState('t1', 'fd.tagclass-delta', TC)?.legacyAdded?.length ?? 0, 0, 'the push alone cannot know');
  const r = await receiptOf(core, E2);
  assert.deepEqual(r.tagContributions, [{ tagClass: TC, values: ['ORDER', 'PO_ORDER'] }], 'ORDER carried forward');
  assert.deepEqual(E2.pkg.resState('t1', 'fd.tagclass-delta', TC).legacyAdded, ['ORDER'], 'seeded for rm --server');
  // the product still sees ORDER as the extension's
  const row = (await statusAll(P.ctx, { remote: true })).rows[0];
  assert.equal(row.state, 'insync');
  assert.match(row.note, /^\+2 values of po/);
  // rm --server with the seeded state removes the extension's values, never PROJECT (pre-existing legacy)
  await delta.remove(E2.ctx, TC);
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
  // a value the delta no longer declares is not carried forward
  const p = join(E2.pkg.dir, `fd/tagclass-deltas/${TC}.delta.json`);
  const f = JSON.parse(readFileSync(p, 'utf8'));
  f.allowedValues = f.allowedValues.filter((v) => v.symbolicName !== 'ORDER'); f.legacy = ['PROJECT'];
  writeFileSync(p, JSON.stringify(f));
  assert.deepEqual((await receiptOf(core, E2)).tagContributions, [{ tagClass: TC, values: ['PO_ORDER'] }]);
});

test('#126 item 2: a receipt from uxc < 0.25.1 (no tagContributions) -> its unprefixed values are UNATTRIBUTED: in the hash, never pulled, never removed', async () => {
  const { core, cmDir, P } = await bothInstalled();
  const po = core.rcpt.get('UXC_PKG_PO');
  po.content = null; po.doc.files = []; // what uxc 0.25.0 left: no content file, resources tag only
  po.doc.tags.push(tag('UxcResources', `fd.tagclass-delta/${TC}`));
  const row = (await statusAll(P.ctx, { remote: true })).rows[0];
  assert.equal(row.state, 'server', 'conservative: kept in the hash, drift shown');
  assert.match(row.note, /\+1 value of po .*1 unattributed value: ORDER \(receipt written by uxc < 0\.25\.1 — re-push po to attribute them; counted in the hash, never pulled\)/);
  const [r] = await pullResources(P.ctx, P.pkg.entries(), { force: true });
  assert.equal(r.action, 'pulled');
  assert.match(r.detail, /not pulled: ORDER — unattributed/);
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
  await pushResources(P.ctx, P.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'PO_ORDER', 'ORDER'], 'never removed');
  // a package whose resources hold no delta for this class is "none", not unknown
  po.doc.tags = po.doc.tags.filter((t) => t.name !== 'UxcResources');
  po.doc.tags.push(tag('UxcResources', 'fd.tagclass-delta/OtherClass'));
  assert.doesNotMatch((await statusAll(P.ctx, { remote: true })).rows[0].note ?? '', /unattributed/);
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

test('#126 removal rule: a value missing from the file is removed unless (possibly) another package\'s — alone from a fresh dir = full replace', async () => {
  // product alone, installed from a .uxpkg: a fresh directory with NO state for the resource
  const core = fakeCore();
  const first = ctxFor(makeProduct(), core);
  await pushResources(first.ctx, first.pkg.entries());
  await receiptOf(core, first);
  const freshDir = makeProduct([d('CM_CLAIM', 'Claim'), d('PROJECT', 'Project')]); // CM_INCIDENT dropped
  const F = ctxFor(freshDir, core);
  assert.equal(F.pkg.resState('t1', 'fd.tagclass', TC), null);
  await pushResources(F.ctx, F.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'PROJECT'], 'as main: the dropped value is removed');
  assert.ok(F.lines.some((l) => /removing CM_INCIDENT — no longer in the file/.test(l)), F.lines.join('\n'));
});

test('#126 removal rule with an extension installed: its values survive (plain and --force), the product\'s dropped and hand-added values go', async () => {
  const { core, cmDir, P, E } = await bothInstalled();
  core.tcs.get(TC).allowedValues.push({ type: FQ, ...d('GUI_ADDED') }); // added on the server by hand
  for (const force of [false, true]) {
    const f = localFile(cmDir);
    f.allowedValues = force
      ? [...f.allowedValues, d('CM_EXTRA', 'Extra')]
      : [f.allowedValues[0], f.allowedValues[2], d('CM_NEW', 'New')]; // CM_INCIDENT deleted locally
    writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
    const [r] = await pushResources(P.ctx, P.pkg.entries(), { force: true });
    assert.equal(r.action, 'updated', JSON.stringify(r));
  }
  assert.ok(P.lines.some((l) => /removing CM_INCIDENT, GUI_ADDED — no longer in the file/.test(l)), P.lines.join('\n'));
  assert.ok(P.notes.some((n) => /keeping 2 server value\(s\) not in the file \(PO_ORDER, ORDER\) — another installed package's/.test(n)), P.notes.join('\n'));
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'PROJECT', 'CM_NEW', 'CM_EXTRA', 'PO_ORDER', 'ORDER']);
  assert.deepEqual(names(localFile(cmDir)), ['CM_CLAIM', 'PROJECT', 'CM_NEW', 'CM_EXTRA'], 'never another package\'s values in the file');
  assert.equal((await statusAll(P.ctx, { remote: true })).rows[0].state, 'insync');
  assert.equal((await statusAll(E.ctx, { remote: true })).rows[0].state, 'insync');
});

test('#126 removal rule: an UNKNOWN receipt (uxc < 0.25.1) keeps every unprefixed value missing from the file, with a note', async () => {
  const { core, cmDir, P } = await bothInstalled();
  const po = core.rcpt.get('UXC_PKG_PO');
  po.content = null; po.doc.files = [];
  po.doc.tags.push(tag('UxcResources', `fd.tagclass-delta/${TC}`));
  const f = localFile(cmDir);
  f.allowedValues = f.allowedValues.filter((v) => v.symbolicName !== 'PROJECT' && v.symbolicName !== 'CM_INCIDENT');
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  await pushResources(P.ctx, P.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'PROJECT', 'PO_ORDER', 'ORDER'], 'own-prefixed CM_INCIDENT goes; unprefixed values stay');
  assert.ok(P.notes.some((n) => /keeping 3 server value\(s\) not in the file \(PROJECT, PO_ORDER, ORDER\) — the receipt of po predates uxc 0\.25\.1/.test(n)), P.notes.join('\n'));
});

test('#126 a previous receipt that cannot be read: tagContributions left ABSENT (unknown), never a list missing carried values; refresh writes nothing', async () => {
  const { core, P } = await bothInstalled();
  const E2 = ctxFor(makeExtension(), core, { gateway: { get: async () => { throw new Error('HTTP 503'); } } });
  await pushResources(E2.ctx, E2.pkg.entries());
  const r = await receiptOf(core, E2);
  assert.equal(r.tagContributions, undefined);
  assert.equal(core.rcpt.get('UXC_PKG_PO').content?.tagContributions, undefined, 'the previous field is not replaced by a partial list');
  assert.ok(E2.warns.some((w) => /tag contributions NOT recorded — this package's previous receipt could not be read \(uxopian-ai: HTTP 503\)/.test(w)), E2.warns.join('\n'));
  // the product now sees po as UNKNOWN: ORDER kept in its hash and never pulled/removed — not absorbed
  assert.match((await statusAll(P.ctx, { remote: true })).rows[0].note, /unattributed value: ORDER/);
  const before = structuredClone(core.rcpt.get('UXC_PKG_PO'));
  assert.deepEqual(await refreshTagContributions(E2.ctx, E2.pkg), [{ surface: 'receipts', ok: false, reason: 'could not read the receipts (uxopian-ai: HTTP 503)' }]);
  assert.deepEqual(core.rcpt.get('UXC_PKG_PO'), before);
});

test('#126 item 3: shared claim — a value the product file lists stays in its view; the extension\'s rm/prune never removes a value the product lists', async () => {
  const { core, cmDir, P, E } = await bothInstalled();
  const f = localFile(cmDir);
  f.allowedValues.push(d('ORDER', 'Order')); // the product claims ORDER too (e.g. absorbed by a 0.25.0 pull)
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  const row = (await statusAll(P.ctx, { remote: true })).rows[0];
  assert.equal(row.state, 'rebased', 'same content already on the server: ORDER is in the product view');
  assert.match(row.note, /^\+1 value of po/);
  await receiptOf(core, P); // the product's receipt now lists ORDER
  await delta.remove(E.ctx, TC);
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'ORDER'], 'PO_ORDER removed, ORDER kept');
  assert.ok(E.lines.some((l) => /kept: ORDER — also listed by another installed package/.test(l)), E.lines.join('\n'));
  // the product dropping it later: it holds ORDER in ownValues and nobody else lists it any more -> removed
  core.rcpt.get('UXC_PKG_PO').content.tagContributions = [];
  f.allowedValues.pop();
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  await pushResources(P.ctx, P.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT']);
});

test('#126 item 5: a partial push of a delta refreshes the receipt\'s tagContributions (only that key)', async () => {
  const { core, P, E } = await bothInstalled();
  const p = join(E.pkg.dir, `fd/tagclass-deltas/${TC}.delta.json`);
  const f = JSON.parse(readFileSync(p, 'utf8'));
  f.allowedValues.push(d('SHIPMENT', 'Shipment')); f.legacy.push('SHIPMENT');
  writeFileSync(p, JSON.stringify(f));
  await pushResources(E.ctx, E.pkg.entries());
  const before = structuredClone(core.rcpt.get('UXC_PKG_PO').doc.tags);
  const res = await refreshTagContributions(E.ctx, E.pkg);
  assert.deepEqual(res, [{ surface: 'flowerdocs', ok: true, action: 'updated' }]);
  assert.deepEqual(core.rcpt.get('UXC_PKG_PO').content.tagContributions, [{ tagClass: TC, values: ['ORDER', 'PO_ORDER', 'SHIPMENT'] }]);
  assert.deepEqual(core.rcpt.get('UXC_PKG_PO').doc.tags, before, 'version/resources untouched');
  assert.deepEqual(await refreshTagContributions(E.ctx, E.pkg), [{ surface: 'flowerdocs', ok: true, action: 'unchanged' }]);
  assert.match((await statusAll(P.ctx, { remote: true })).rows[0].note, /^\+3 values of po/);
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
  // a forced product push keeps every value that may be another package's (unreadable receipts)
  const f = localFile(cmDir);
  f.allowedValues = f.allowedValues.slice(0, 2);
  writeFileSync(join(cmDir, `fd/tagclasses/${TC}.json`), JSON.stringify(f));
  await pushResources(P.ctx, P.pkg.entries(), { force: true });
  assert.deepEqual(names(core.tcs.get(TC)), ['CM_CLAIM', 'CM_INCIDENT', 'PROJECT', 'PO_ORDER', 'ORDER'], 'unprefixed PROJECT possibly foreign: kept');
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
