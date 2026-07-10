// Offline unit tests for lib/dependencies.mjs — package dependencies v1 (check-and-guide, DESIGN §22).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  declaredDependencies, installedVersionOf, checkDependencies, assertDependencies, fixCommand,
} from '../lib/dependencies.mjs';

const MANIFEST = {
  code: 'ct',
  dependencies: {
    uxoai: { versions: '>=1.1', slug: 'uxoai-flowerdocs' },
    llm: '*',                                    // shorthand form
  },
};

/** ctx whose receipts read resolves to the given rows (FD doc + AI prompt surfaces). */
function rctx(receipts) {
  return {
    target: { name: 'fddemo' },
    calls: [],
    out: { warn(m) { this._w = m; }, note(m) { this._n = m; } },
    clients: {
      core: {
        getDoc: async () => null,
        search: async () => ({ found: receipts.length, results: receipts.map((r, i) => ({ id: `UXC_PKG_${i}` })) }),
      },
      gateway: { get: async () => receipts.map((r) => ({ id: `uxcPkg${r.code}`, content: JSON.stringify({ kind: 'uxc-package-receipt/1', ...r }) })) },
    },
  };
}

test('declaredDependencies: object + shorthand forms, declaration order preserved', () => {
  const d = declaredDependencies(MANIFEST);
  assert.deepEqual(d.map((x) => x.code), ['uxoai', 'llm']);
  assert.deepEqual(d[0].versions, ['>=1.1']);
  assert.equal(d[0].slug, 'uxoai-flowerdocs');
  assert.deepEqual(d[1].versions, ['*']);
  assert.equal(d[1].slug, null);
  assert.deepEqual(declaredDependencies({}), []);
});

test('installedVersionOf: highest wins across surfaces; disagreement noted', () => {
  const rs = [
    { code: 'uxoai', version: '1.0.0', surface: 'flowerdocs' },
    { code: 'uxoai', version: '1.1.0', surface: 'uxopian-ai' },
  ];
  const r = installedVersionOf(rs, 'uxoai');
  assert.equal(r.version, '1.1.0');
  assert.match(r.note, /surfaces disagree/);
  assert.equal(installedVersionOf(rs, 'ghost').version, null);
});

test('checkDependencies: ok / too-old / missing / self-reference', async () => {
  const ctx = rctx([{ code: 'uxoai', version: '1.1.0', uxcVersion: 'x', installedAt: 'y' }]);
  const rows = await checkDependencies(ctx, MANIFEST);
  assert.equal(rows.find((r) => r.code === 'uxoai').ok, true);
  assert.equal(rows.find((r) => r.code === 'llm').ok, false); // '*' still needs SOMETHING installed
  const tooOld = await checkDependencies(rctx([{ code: 'uxoai', version: '1.0.0' }]), MANIFEST);
  assert.equal(tooOld.find((r) => r.code === 'uxoai').ok, false);
  assert.match(tooOld.find((r) => r.code === 'uxoai').why, /does not satisfy/);
  const selfDep = await checkDependencies(rctx([]), { code: 'ct', dependencies: { ct: '*' } });
  assert.equal(selfDep[0].ok, true);
  assert.match(selfDep[0].why, /self-reference/);
});

test('assertDependencies: refusal carries the ORDERED fix-it recipe; --ignore warns', async () => {
  const ctx = rctx([]);
  await assert.rejects(
    assertDependencies(ctx, MANIFEST, { out: ctx.out }),
    (e) => /unmet package dependencies on fddemo/.test(e.message)
      && e.message.indexOf('uxoai:') < e.message.indexOf('llm:')            // declaration order
      && /uxc mp install uxoai-flowerdocs --target fddemo/.test(e.message)  // slug used
      && /uxc mp install llm --target fddemo/.test(e.message)               // code fallback
      && /install them in the order listed/.test(e.message),
  );
  const ig = rctx([]);
  const rows = await assertDependencies(ig, MANIFEST, { ignore: true, out: ig.out });
  assert.equal(rows.filter((r) => !r.ok).length, 2);
  assert.match(ig.out._w, /OVERRIDDEN by --ignore-dependencies/);
});

test('assertDependencies: all met -> a quiet note, no throw', async () => {
  const ctx = rctx([{ code: 'uxoai', version: '1.2.0' }, { code: 'llm', version: '1.0.0' }]);
  const rows = await assertDependencies(ctx, MANIFEST, { out: ctx.out });
  assert.equal(rows.every((r) => r.ok), true);
  assert.match(ctx.out._n, /dependencies ok: uxoai@1.2.0, llm@1.0.0/);
});

test('fixCommand shapes', () => {
  assert.match(fixCommand({ code: 'x', slug: 's' }, 't1'), /uxc mp install s --target t1/);
  assert.match(fixCommand({ code: 'x', slug: null }), /uxc mp install x\s/);
});
