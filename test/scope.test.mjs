// Offline unit tests for the REST scope payload builders. The client itself is one-line wrappers
// over the verified `core` REST surface (GET/POST/DELETE /rest/scope), exercised live by doctor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { blankScope, retargetScope, readScopeFile } from '../lib/scope.mjs';

test('blankScope: minimal valid scope object (verified field set)', () => {
  const s = blankScope('Acme', { description: 'Demo', admins: ['system', 'admin'], languages: ['EN'] });
  assert.equal(s.id, 'Acme');
  assert.equal(s.description, 'Demo');
  assert.deepEqual(s.displayNames, [{ value: 'Acme', language: 'EN' }, { value: 'Acme', language: 'FR' }]);
  assert.deepEqual(s.languages, ['EN']);
  assert.equal(s.data.ACL, 'acl-scope');
  assert.deepEqual(s.people.profiles, [{ id: 'ADMIN', name: 'Administrator', principals: ['system', 'admin'] }]);
});

test('blankScope: id-derived defaults when fields omitted', () => {
  const s = blankScope('Beta');
  assert.equal(s.description, 'Beta');
  assert.deepEqual(s.displayNames.map((d) => d.value), ['Beta', 'Beta']);
  assert.deepEqual(s.languages, ['EN', 'FR']);
  assert.deepEqual(s.people.profiles[0].principals, ['system']);
});

test('retargetScope: clones an existing scope object onto a new id, leaving the rest intact', () => {
  const src = { id: 'IRIS', description: 'Source', languages: ['FR'], people: { profiles: [{ id: 'ADMIN' }] } };
  const out = retargetScope(src, 'SwissLife');
  assert.equal(out.id, 'SwissLife');
  assert.equal(out.description, 'Source');           // everything else carried over
  assert.deepEqual(out.people, src.people);
  assert.equal(src.id, 'IRIS');                       // source object not mutated
  assert.throws(() => retargetScope(null, 'X'), /expected a scope object/);
});

test('readScopeFile: parses a JSON scope dump; clear error on bad JSON', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-scope-test-'));
  try {
    const p = join(dir, 's.json');
    writeFileSync(p, JSON.stringify({ id: 'IRIS', description: 'x', people: { profiles: [] } }));
    const s = readScopeFile(p);
    assert.equal(s.id, 'IRIS');
    writeFileSync(p, '{ not json');
    assert.throws(() => readScopeFile(p), /cannot read a JSON scope object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
