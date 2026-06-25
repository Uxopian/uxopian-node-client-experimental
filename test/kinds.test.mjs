// Offline unit tests for adapter policy wiring — specifically the `inPlaceUpdate` flag that lets a
// `createOnly` kind (fd.taskclass) be UPDATED in place while its server-delete stays gated (§14/§20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classKindAdapter } from '../lib/kinds/base.mjs';
import taskclass from '../lib/kinds/fd-taskclass.mjs';
import documentclass from '../lib/kinds/fd-documentclass.mjs';
import vfinstance from '../lib/kinds/fd-vfinstance.mjs';

test('classKindAdapter carries inPlaceUpdate onto the adapter (defaults false)', () => {
  assert.equal(classKindAdapter({ kind: 'x', dir: 'x', restPath: 'x' }).inPlaceUpdate, false);
  assert.equal(
    classKindAdapter({ kind: 'x', dir: 'x', restPath: 'x', inPlaceUpdate: true }).inPlaceUpdate,
    true,
  );
});

test('fd.taskclass is createOnly but in-place updatable (delete stays gated by policy)', () => {
  assert.equal(taskclass.defaultPolicy, 'createOnly'); // rm.mjs keeps gating server delete
  assert.equal(taskclass.inPlaceUpdate, true);         // sync.pushOne updates it in place
});

test('other createOnly / managed kinds do NOT opt into inPlaceUpdate', () => {
  assert.equal(documentclass.inPlaceUpdate, false); // managed already updates; flag is irrelevant
  // fd.vfinstance stays genuinely create-only: no live verification that an in-place VF-instance
  // update is binding-safe (unlike taskclass §20). Opt in here only once a round-trip is recorded.
  assert.equal(vfinstance.defaultPolicy, 'createOnly');
  assert.notEqual(vfinstance.inPlaceUpdate, true);
});
