// Offline unit tests for lib/canonical.mjs — strip/normalize rules that make
// local-authored and server-echoed forms hash identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalText, hashResource } from '../lib/canonical.mjs';

test('volatile data fields are stripped (version, dates, owner, users)', () => {
  const server = {
    id: 'CtTypeCode',
    data: {
      version: 7,
      creationDate: '2026-06-01 10:00:00.000 +0000',
      lastUpdateDate: '2026-06-11 10:00:00.000 +0000',
      owner: 'system',
      lastUpdateUser: 'system',
      creationUser: 'system',
      keepMe: 'x',
    },
    type: 'CHOICELIST',
  };
  const canon = canonicalize('fd.tagclass', server);
  assert.deepEqual(canon.data, { keepMe: 'x' });
  assert.equal(canon.type, 'CHOICELIST');
  // local form without the volatile fields hashes the same
  const local = { id: 'CtTypeCode', data: { keepMe: 'x' }, type: 'CHOICELIST' };
  assert.equal(hashResource('fd.tagclass', server), hashResource('fd.tagclass', local));
  // input object is not mutated
  assert.equal(server.data.version, 7);
});

test('fd.taskclass: server-echoed answers[].type is dropped', () => {
  const server = {
    id: 'CtDeviationReview',
    answers: [
      { id: 'APPROVE', type: 'com.flower.docs.domain.taskclass.ReasonedAnswer' },
      { id: 'REJECT', type: 'com.flower.docs.domain.taskclass.ReasonedAnswer' },
    ],
  };
  const canon = canonicalize('fd.taskclass', server);
  assert.deepEqual(canon.answers, [{ id: 'APPROVE' }, { id: 'REJECT' }]);
  const local = { id: 'CtDeviationReview', answers: [{ id: 'APPROVE' }, { id: 'REJECT' }] };
  assert.equal(hashResource('fd.taskclass', server), hashResource('fd.taskclass', local));
});

test('fd.taskclass: children attachment slots round-trip losslessly (§20)', () => {
  // a slot the way the server echoes it (LEARNINGS §20 shape) vs the same slot authored locally
  // with the keys in a different order — must hash identically (no per-slot field dropped/added).
  const slot = (extra) => ({
    classId: '*', id: 'OriginalContract', category: 'DOCUMENT',
    displayNames: [{ language: 'EN', value: 'Contract under review' }],
    multivalued: false, readonly: false, required: 'NO', technical: false, order: 0, ...extra,
  });
  const server = { id: 'CtHandoff', category: 'TASK', children: [slot()] };
  // locally authored: keys deliberately shuffled — stableStringify sorts them, so the hash agrees
  const local = {
    children: [{
      order: 0, required: 'NO', id: 'OriginalContract', classId: '*',
      displayNames: [{ value: 'Contract under review', language: 'EN' }],
      technical: false, readonly: false, multivalued: false, category: 'DOCUMENT',
    }],
    category: 'TASK', id: 'CtHandoff',
  };
  assert.equal(hashResource('fd.taskclass', server), hashResource('fd.taskclass', local));
  // canon keeps the slot intact — no field silently lost on update
  assert.deepEqual(canonicalize('fd.taskclass', server).children, [slot()]);
  // empty children [] hashes like absent children (cleanData drops empty top-level arrays)
  assert.equal(
    hashResource('fd.taskclass', { id: 'X', children: [] }),
    hashResource('fd.taskclass', { id: 'X' }),
  );
  // array ORDER is semantic: reordering slots changes the hash (real drift, not masked)
  assert.notEqual(
    hashResource('fd.taskclass', { id: 'X', children: [slot({ id: 'A', order: 0 }), slot({ id: 'B', order: 1 })] }),
    hashResource('fd.taskclass', { id: 'X', children: [slot({ id: 'B', order: 1 }), slot({ id: 'A', order: 0 })] }),
  );
});

test('ai.prompt: temperature 0 vs "0" hash-equal; createdAt stripped', () => {
  const a = { id: 'ctSummary', role: 'SYSTEM', temperature: 0, createdAt: '2026-06-01T00:00:00Z' };
  const b = { id: 'ctSummary', role: 'SYSTEM', temperature: '0' };
  assert.equal(hashResource('ai.prompt', a), hashResource('ai.prompt', b));
  const canon = canonicalize('ai.prompt', a);
  assert.equal(canon.createdAt, undefined);
  assert.equal(canon.temperature, '0'); // normalized to string
  // null/undefined temperature left alone (not coerced to "null")
  assert.equal(canonicalize('ai.prompt', { id: 'p', temperature: null }).temperature, null);
});

test('hashResource is stable across key order', () => {
  const h1 = hashResource('fd.tagclass', { b: 2, a: 1, nested: { y: 2, x: 1 } });
  const h2 = hashResource('fd.tagclass', { a: 1, nested: { x: 1, y: 2 }, b: 2 });
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});

test('fd.script: files[] and currentVersion dropped; content bytes drive the hash', () => {
  const meta = { id: 'ct-widgets', name: 'ct-widgets' };
  const echo = { ...meta, files: [{ id: 'tmp_churned_123', size: 0 }], currentVersion: 4 };
  const canon = canonicalize('fd.script', echo);
  assert.equal(canon.files, undefined);
  assert.equal(canon.currentVersion, undefined);
  const buf = Buffer.from('console.log(1);\n');
  assert.equal(hashResource('fd.script', echo, [buf]), hashResource('fd.script', meta, [buf]));
  // different content bytes -> different hash
  assert.notEqual(
    hashResource('fd.script', meta, [buf]),
    hashResource('fd.script', meta, [Buffer.from('console.log(2);\n')]),
  );
});

test('canonicalize(null) is null; canonicalText is deterministic', () => {
  assert.equal(canonicalize('fd.tagclass', null), null);
  const t1 = canonicalText('fd.tagclass', { b: 1, a: 2 });
  const t2 = canonicalText('fd.tagclass', { a: 2, b: 1 });
  assert.equal(t1, t2);
  assert.ok(t1.endsWith('\n'));
});

// ---------------------------------------------------------------------------
// FD 2026 echo normalization (CHANGE-REQUEST-fd2026-canon.md): active:true,
// empty arrays at ANY depth, and FQCN `type` discriminators. Applied to both
// sides, so ONE package hashes clean on FD 2025 AND FD 2026.
// ---------------------------------------------------------------------------

test('fd2026: active:true dropped (echo omits it); active:false KEPT', () => {
  // documentclass/folderclass/taskclass echoes omit active; local writes active:true -> hash equal
  assert.equal(
    hashResource('fd.documentclass', { id: 'PoEmail', category: 'DOCUMENT', active: true }),
    hashResource('fd.documentclass', { id: 'PoEmail', category: 'DOCUMENT' }),
  );
  assert.equal(
    hashResource('fd.folderclass', { id: 'PoOrder', category: 'FOLDER', active: true, children: [{ category: 'DOCUMENT', id: '*' }] }),
    hashResource('fd.folderclass', { id: 'PoOrder', category: 'FOLDER', children: [{ category: 'DOCUMENT', id: '*' }] }),
  );
  // active:false is a genuine state — NOT dropped, and still distinct from active:true
  assert.equal(canonicalize('fd.documentclass', { id: 'X', active: false }).active, false);
  assert.notEqual(
    hashResource('fd.documentclass', { id: 'X', active: false }),
    hashResource('fd.documentclass', { id: 'X', active: true }),
  );
});

test('fd2026: empty arrays stripped at ANY depth (not just top level)', () => {
  // nested empty descriptions[] on a tagReference (a 2026 echo extra) hashes like absent
  const echo = { id: 'CtBar', category: 'DOCUMENT', tagReferences: [{ tagName: 'CtFoo', order: 0, descriptions: [] }] };
  const local = { id: 'CtBar', category: 'DOCUMENT', tagReferences: [{ tagName: 'CtFoo', order: 0 }] };
  assert.equal(hashResource('fd.documentclass', echo), hashResource('fd.documentclass', local));
  // vfclass search with nested empty nested[]/context[]
  const vfEcho = { id: 'CtRev', category: 'VIRTUAL_FOLDER', searches: [{ id: 's', request: { aggregation: { field: 'F', nested: [] }, context: [] } }] };
  const vfLocal = { id: 'CtRev', category: 'VIRTUAL_FOLDER', searches: [{ id: 's', request: { aggregation: { field: 'F' } } }] };
  assert.equal(hashResource('fd.vfclass', vfEcho), hashResource('fd.vfclass', vfLocal));
});

test('fd2026: nested FQCN `type` stripped; tagclass TOP-LEVEL type PRESERVED', () => {
  // allowedValues[].type = FQCN discriminator -> stripped; the tag's own data type stays
  const echo = {
    id: 'CtChoice', type: 'CHOICELIST',
    allowedValues: [{ symbolicName: 'A', type: 'com.flower.docs.domain.tagclass.AllowedValue' }],
  };
  const canon = canonicalize('fd.tagclass', echo);
  assert.equal(canon.type, 'CHOICELIST');                 // load-bearing top-level type SURVIVES
  assert.equal(canon.allowedValues[0].type, undefined);   // nested FQCN discriminator dropped
  const local = { id: 'CtChoice', type: 'CHOICELIST', allowedValues: [{ symbolicName: 'A' }] };
  assert.equal(hashResource('fd.tagclass', echo), hashResource('fd.tagclass', local));
  // a NON-FQCN nested `type` value is left alone (only com.flower.docs.* is a discriminator)
  assert.equal(canonicalize('fd.folderclass', { id: 'X', children: [{ category: 'DOCUMENT', id: '*', type: 'DOCUMENT' }] }).children[0].type, 'DOCUMENT');
});
