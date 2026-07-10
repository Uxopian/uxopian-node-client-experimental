// Offline unit tests for lib/receipt.mjs — installation receipts on FD + uxopian-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReceipt, fdReceiptId, aiReceiptId, ensureFdInfra, writeFdReceipt, writeAiReceipt,
  writeReceipts, receiptFromFdDoc, receiptFromAiPrompt, FD_CLASS, FD_TAGS,
} from '../lib/receipt.mjs';
import { CLIENT_VERSION } from '../lib/version.mjs';

const MANIFEST = { code: 'ct', name: 'Contract Management', version: '1.7.1', products: ['flowerdocs', 'uxopian-ai'] };

function fdCtx({ existing = {} } = {}) {
  const calls = [];
  return {
    calls,
    target: { user: 'system' },
    clients: {
      core: {
        getOne: async (p) => { calls.push(['getOne', p]); return existing[p] ?? null; },
        getDoc: async (id) => { calls.push(['getDoc', id]); return existing[`doc:${id}`] ?? null; },
        post: async (p, b) => { calls.push(['post', p, Array.isArray(b) ? b[0]?.id : b?.id]); return b; },
        upsertDoc: async (doc) => { calls.push(['upsertDoc', doc.id, doc]); return { action: 'created', id: doc.id }; },
      },
      gateway: {
        get: async (p) => { calls.push(['gw.get', p]); return existing[`gw:${p}`] ?? []; },
        post: async (p, b) => { calls.push(['gw.post', p, b?.id, b]); },
        put: async (p, b) => { calls.push(['gw.put', p, b?.id, b]); },
      },
    },
  };
}

test('receipt ids: deterministic per code (direct-GET-able, never searched for)', () => {
  assert.equal(fdReceiptId('ct'), 'UXC_PKG_CT');
  assert.equal(aiReceiptId('ct'), 'uxcPkgCt');
});

test('buildReceipt carries code/version/products/uxcVersion + optional artifact sha', () => {
  const r = buildReceipt(MANIFEST, { artifactSha: 'sha256:abc', when: '2026-07-08T00:00:00Z' });
  assert.equal(r.kind, 'uxc-package-receipt/1');
  assert.equal(r.code, 'ct');
  assert.equal(r.version, '1.7.1');
  assert.equal(r.uxcVersion, CLIENT_VERSION);
  assert.equal(r.artifactSha, 'sha256:abc');
  assert.equal(buildReceipt(MANIFEST).artifactSha, undefined); // omitted when unknown
});

test('ensureFdInfra: creates the tagclasses + class when absent; idempotent when current; upgrades old classes', async () => {
  const ctx = fdCtx();
  await ensureFdInfra(ctx);
  const created = ctx.calls.filter(([k]) => k === 'post').map(([, , id]) => id);
  assert.deepEqual(created, [...FD_TAGS, FD_CLASS]); // tags first, class (referencing them) last

  const fullRefs = FD_TAGS.map((tagName, order) => ({ tagName, order }));
  const present = fdCtx({ existing: Object.fromEntries([
    ...FD_TAGS.map((t) => [`/rest/tagclass/${t}`, { id: t }]),
    [`/rest/documentclass/${FD_CLASS}`, { id: FD_CLASS, tagReferences: fullRefs }],
  ]) });
  await ensureFdInfra(present);
  assert.equal(present.calls.filter(([k]) => k === 'post').length, 0); // idempotent when current

  // a class created by an OLDER uxc (no UxcResources ref) gets the missing tagReference in place
  const oldRefs = FD_TAGS.filter((t) => t !== 'UxcResources').map((tagName, order) => ({ tagName, order }));
  const stale = fdCtx({ existing: Object.fromEntries([
    ...FD_TAGS.map((t) => [`/rest/tagclass/${t}`, { id: t }]),
    [`/rest/documentclass/${FD_CLASS}`, { id: FD_CLASS, tagReferences: oldRefs }],
  ]) });
  await ensureFdInfra(stale);
  const updates = stale.calls.filter(([k, path]) => k === 'post' && String(path).endsWith(`/${FD_CLASS}`));
  assert.equal(updates.length, 1); // schema upgraded in place
});

test('writeFdReceipt: upserts the deterministic doc with the receipt tags', async () => {
  const ctx = fdCtx();
  await writeFdReceipt(ctx, MANIFEST, { artifactSha: 'sha256:abc' });
  const up = ctx.calls.find(([k]) => k === 'upsertDoc');
  assert.equal(up[1], 'UXC_PKG_CT');
  const tags = Object.fromEntries(up[2].tags.map((t) => [t.name, t.value[0]]));
  assert.equal(up[2].data.classId, FD_CLASS);
  assert.equal(tags.UxcPackageCode, 'ct');
  assert.equal(tags.UxcPackageVersion, '1.7.1');
  assert.equal(tags.UxcClientVersion, CLIENT_VERSION);
  assert.equal(tags.UxcArtifactSha, 'sha256:abc');
});

test('writeAiReceipt: POSTs when absent, PUTs when the receipt prompt exists', async () => {
  const fresh = fdCtx();
  await writeAiReceipt(fresh, MANIFEST);
  assert.ok(fresh.calls.some(([k]) => k === 'gw.post'));
  // receipts must never surface in the Quick Prompt panel (absent displaySettings = SHOWN — §A8)
  assert.deepEqual(fresh.calls.find(([k]) => k === 'gw.post')[3].displaySettings, { enabled: false });

  const upd = fdCtx({ existing: { 'gw:/api/v1/prompts': [{ id: 'uxcPkgCt', content: '{}' }] } });
  await writeAiReceipt(upd, MANIFEST);
  assert.ok(upd.calls.some(([k]) => k === 'gw.put'));
  assert.ok(!upd.calls.some(([k]) => k === 'gw.post'));
});

test('writeReceipts: per-product surfaces; failures are captured, not thrown', async () => {
  const ctx = fdCtx();
  ctx.clients.gateway.get = async () => { throw new Error('gateway down'); };
  const res = await writeReceipts(ctx, MANIFEST, {});
  assert.equal(res.length, 2);
  assert.equal(res.find((r) => r.surface === 'flowerdocs').ok, true);
  const ai = res.find((r) => r.surface === 'uxopian-ai');
  assert.equal(ai.ok, false);
  assert.match(ai.error, /gateway down/);
  // fd-only package -> one surface
  const fdOnly = await writeReceipts(fdCtx(), { ...MANIFEST, products: ['flowerdocs'] }, {});
  assert.deepEqual(fdOnly.map((r) => r.surface), ['flowerdocs']);
});

test('receiptFromFdDoc / receiptFromAiPrompt parse their carriers (and reject non-receipts)', () => {
  const doc = {
    id: 'UXC_PKG_CT',
    tags: [
      { name: 'UxcPackageCode', value: ['ct'] }, { name: 'UxcPackageVersion', value: ['1.7.1'] },
      { name: 'UxcClientVersion', value: ['0.5.0'] }, { name: 'UxcInstalledAt', value: ['2026-07-08T00:00:00Z'] },
    ],
  };
  const r = receiptFromFdDoc(doc);
  assert.equal(r.code, 'ct');
  assert.equal(r.version, '1.7.1');
  assert.equal(r.artifactSha, null);

  const p = { id: 'uxcPkgCt', content: JSON.stringify(buildReceipt(MANIFEST, { when: 'x' })) };
  const ar = receiptFromAiPrompt(p);
  assert.equal(ar.code, 'ct');
  assert.equal(ar.surface, 'uxopian-ai');
  assert.equal(receiptFromAiPrompt({ id: 'ctSummary', content: 'not json' }), null);
  assert.equal(receiptFromAiPrompt({ id: 'uxcPkgX', content: '{"kind":"other"}' }), null);
});

// ---------------------------------------------------------------------------
// assertReceiptFlow — receipts as flow input: downgrade gate, upgrade/reinstall reporting
// ---------------------------------------------------------------------------

function flowCtx(installedVersion) {
  const calls = [];
  const doc = installedVersion == null ? null : {
    id: 'UXC_PKG_CT',
    tags: [
      { name: 'UxcPackageCode', value: ['ct'] },
      { name: 'UxcPackageVersion', value: [installedVersion] },
      { name: 'UxcClientVersion', value: ['0.5.0'] },
      { name: 'UxcInstalledAt', value: ['2026-07-08T00:00:00Z'] },
    ],
  };
  return {
    calls,
    target: { name: 'fddemo' },
    out: {
      warn: (m) => calls.push(['warn', m]),
      note: (m) => calls.push(['note', m]),
      line: (m) => calls.push(['line', m]),
    },
    clients: {
      core: { getDoc: async () => doc, search: async () => ({ found: 0, results: [] }) },
      gateway: { get: async () => [] },
    },
  };
}

test('assertReceiptFlow: fresh / upgrade / reinstall classifications', async () => {
  const { assertReceiptFlow } = await import('../lib/receipt.mjs');
  assert.equal((await assertReceiptFlow(flowCtx(null), { code: 'ct', version: '1.7.1' }, {})).kind, 'fresh');

  const up = flowCtx('1.6.0');
  const r = await assertReceiptFlow(up, { code: 'ct', version: '1.7.1' }, { out: up.out });
  assert.equal(r.kind, 'upgrade');
  assert.ok(up.calls.some(([k, m]) => k === 'line' && /1\.6\.0 -> 1\.7\.1/.test(m)));

  const re = flowCtx('1.7.1');
  assert.equal((await assertReceiptFlow(re, { code: 'ct', version: '1.7.1' }, { out: re.out })).kind, 'reinstall');
});

test('assertReceiptFlow: downgrade REFUSES without force, warns loudly with it', async () => {
  const { assertReceiptFlow } = await import('../lib/receipt.mjs');
  const ctx = flowCtx('2.0.0');
  await assert.rejects(
    assertReceiptFlow(ctx, { code: 'ct', version: '1.7.1' }, { out: ctx.out }),
    /downgrade: ct@2\.0\.0 is installed.*refusing/s,
  );
  const forced = flowCtx('2.0.0');
  const r = await assertReceiptFlow(forced, { code: 'ct', version: '1.7.1' }, { force: true, out: forced.out });
  assert.equal(r.kind, 'downgrade');
  assert.ok(forced.calls.some(([k, m]) => k === 'warn' && /DOWNGRADING/.test(m)));
});
