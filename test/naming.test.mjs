// Offline unit tests for lib/naming.mjs — the naming-convention authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prefixForms,
  conventionalId,
  splitHandlerId,
  deployedHandlerId,
  vfOverrideBeanIds,
  allocateOrder,
  buildRemapMap,
  applyRemap,
} from '../lib/naming.mjs';

test('prefixForms derives the four forms from a code', () => {
  assert.deepEqual(prefixForms('ct'), { pascal: 'Ct', camel: 'ct', kebab: 'ct-', upper: 'CT_' });
  assert.deepEqual(prefixForms('env'), { pascal: 'Env', camel: 'env', kebab: 'env-', upper: 'ENV_' });
  // mixed-case input is lowercased first
  assert.deepEqual(prefixForms('Ct'), { pascal: 'Ct', camel: 'ct', kebab: 'ct-', upper: 'CT_' });
});

test('conventionalId builds per-kind ids and passes through already-prefixed names', () => {
  const m = { code: 'ct' };
  // pascal kinds
  assert.equal(conventionalId('fd.tagclass', m, 'TypeCode'), 'CtTypeCode');
  assert.equal(conventionalId('fd.documentclass', m, 'contract'), 'CtContract');
  assert.equal(conventionalId('fd.tagclass', m, 'CtTypeCode'), 'CtTypeCode'); // passthrough
  // camel kinds
  assert.equal(conventionalId('ai.prompt', m, 'Summary'), 'ctSummary');
  assert.equal(conventionalId('ai.prompt', m, 'summary'), 'ctSummary');
  assert.equal(conventionalId('ai.prompt', m, 'ctSummary'), 'ctSummary'); // passthrough
  // kebab kinds
  assert.equal(conventionalId('fd.script', m, 'widgets'), 'ct-widgets');
  assert.equal(conventionalId('fd.script', m, 'My_Widget'), 'ct-my-widget'); // underscores -> dashes, lowered
  assert.equal(conventionalId('fd.script', m, 'ct-widgets'), 'ct-widgets'); // passthrough
  assert.equal(conventionalId('fd.guiconfig', m, 'home'), 'ct-home');
  // ai.llm ids are VERBATIM (global provider names, never project-prefixed)
  assert.equal(conventionalId('ai.llm', m, 'openai'), 'openai');
  assert.equal(conventionalId('ai.llm', m, 'mistral-ai'), 'mistral-ai');
  // manifest idPrefixes win over derivation
  const m2 = { code: 'zz', idPrefixes: { pascal: 'Ct', camel: 'ct', kebab: 'ct-', upper: 'CT_' } };
  assert.equal(conventionalId('fd.tagclass', m2, 'Foo'), 'CtFoo');
});

test('splitHandlerId splits deployed _vN ids and leaves logical ids alone', () => {
  assert.deepEqual(splitHandlerId('CtIngest_onCreate_v13'), { logical: 'CtIngest_onCreate', n: 13 });
  assert.deepEqual(splitHandlerId('CtIngest_onCreate'), { logical: 'CtIngest_onCreate', n: null });
  assert.equal(deployedHandlerId('CtIngest_onCreate', 14), 'CtIngest_onCreate_v14');
});

test('vfOverrideBeanIds: LEARNINGS §15 mangle (segment first-upper rest-lower) + raw variant', () => {
  // ENV_ToutesLesEnveloppes -> EnvTouteslesenveloppes (mangled base)
  const env = vfOverrideBeanIds('ENV_ToutesLesEnveloppes');
  assert.ok(env.includes('contentEnvTouteslesenveloppesVirtualFolder'));
  assert.ok(env.includes('contentEnvTouteslesenveloppesVirtualFolderModify'));
  assert.ok(env.includes('contentEnvTouteslesenveloppesVirtualFolderReadOnly'));

  // CtReview -> both the mangled (Ctreview) and the raw (CtReview) casings are emitted
  const ct = vfOverrideBeanIds('CtReview');
  assert.ok(ct.includes('contentCtreviewVirtualFolder'));
  assert.ok(ct.includes('contentCtReviewVirtualFolder'));
  assert.ok(ct.includes('contentCtreviewVirtualFolderModify'));
  assert.ok(ct.includes('contentCtReviewVirtualFolderReadOnly'));
});

test('allocateOrder picks the lowest free order in the band; throws on exhaustion', () => {
  const m = { registrationOrderBands: { 'fd.script': [930, 932] } };
  assert.equal(allocateOrder(m, [], 'fd.script'), 930);
  assert.equal(allocateOrder(m, [930], 'fd.script'), 931);
  assert.equal(allocateOrder(m, [931], 'fd.script'), 930); // lowest free, not next-after-max
  assert.equal(allocateOrder(m, ['930', 931], 'fd.script'), 932); // string orders coerced
  assert.throws(
    () => allocateOrder(m, [930, 931, 932], 'fd.script'),
    /widen registrationOrderBands/,
  );
  assert.throws(() => allocateOrder(m, [], 'fd.handler'), /registrationOrderBands/); // no band declared
});

test('buildRemapMap + applyRemap: ct->xy token-boundary remap; common words survive', () => {
  const manifest = { code: 'ct' };
  const registryIds = [
    { kind: 'ai.prompt', id: 'ctSummary' },
    { kind: 'fd.documentclass', id: 'CtContract' },
  ];
  const map = buildRemapMap(manifest, registryIds, 'xy');
  assert.equal(map.get('ctSummary'), 'xySummary');
  assert.equal(map.get('CtContract'), 'XyContract');
  assert.equal(map.get('CT_'), 'XY_'); // runtime id prefix always present
  // longest-first ordering for safe replacement
  const keys = [...map.keys()];
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1].length >= keys[i].length);

  const snippet = [
    "const a = await promptAsUser('ctSummary');",
    'classid CtContract',
    'const id = `CT_APPR_X`;',
    'the contract was signed', // plain word must survive untouched
  ].join('\n');
  const { text, replaced, residual } = applyRemap(snippet, map, manifest);
  assert.ok(text.includes("promptAsUser('xySummary')"));
  assert.ok(text.includes('classid XyContract'));
  assert.ok(text.includes('XY_APPR_X'));
  assert.ok(text.includes('the contract was signed'));
  assert.ok(!text.includes('ctSummary'));
  assert.ok(!text.includes('CtContract'));
  assert.ok(!text.includes('CT_APPR_X'));
  assert.ok(replaced >= 3);
  assert.deepEqual(residual, []); // clean remap: no old-prefix tokens left
});

test('applyRemap residual detection: leftover old-prefix token is reported', () => {
  const manifest = { code: 'ct' };
  const map = buildRemapMap(manifest, [{ kind: 'ai.prompt', id: 'ctSummary' }], 'xy');
  const { residual } = applyRemap('keep CtOrphan here, ctSummary goes', map, manifest);
  assert.ok(residual.includes('CtOrphan'));
});
