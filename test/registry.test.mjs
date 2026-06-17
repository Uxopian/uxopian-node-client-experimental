// Offline unit tests for lib/registry.mjs against a throwaway package directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage, resourceKey } from '../lib/registry.mjs';

const dir = mkdtempSync(join(os.tmpdir(), 'uxc-registry-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, 'uxopian-project.json'),
  JSON.stringify({ format: 'uxopian-package/1', name: 'Test Project', code: 'ct' }, null, 2) + '\n',
);

const pkg = openPackage(dir);

test('openPackage: manifest loaded; empty registry/state defaults; non-package dir refused', () => {
  assert.equal(pkg.manifest.code, 'ct');
  assert.deepEqual(pkg.registry, { resources: [] });
  assert.deepEqual(pkg.state, { targets: {} });
  assert.throws(() => openPackage(os.tmpdir()), /not a uxopian package/);
});

test('addEntry + entry + resolve forms', () => {
  pkg.addEntry({ kind: 'fd.tagclass', id: 'CtX', path: 'fd/tagclasses/CtX.json', policy: 'managed' });
  pkg.addEntry({ kind: 'ai.prompt', id: 'ctX', path: 'ai/prompts/ctX.json', policy: 'managed' });
  pkg.addEntry({ kind: 'fd.handler', id: 'CtIngest_onCreate', path: 'fd/handlers/CtIngest_onCreate', policy: 'managed' });

  const e = pkg.entry('fd.tagclass', 'CtX');
  assert.ok(e);
  assert.equal(e.path, 'fd/tagclasses/CtX.json');
  assert.equal(pkg.entry('fd.tagclass', 'Nope'), null);

  // kind/id form always works
  assert.equal(pkg.resolve('fd.tagclass/CtX'), e);
  // bare id works while unique
  assert.equal(pkg.resolve('CtX'), e);
  // unknown -> null
  assert.equal(pkg.resolve('Missing'), null);

  // deployed handler id resolves via _vN strip
  const h = pkg.entry('fd.handler', 'CtIngest_onCreate');
  assert.equal(pkg.resolve('CtIngest_onCreate_v3'), h);

  // registry.json persisted
  const onDisk = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'));
  assert.equal(onDisk.resources.length, 3);
});

test('resolve: bare id ambiguous across two kinds -> error listing candidates', () => {
  pkg.addEntry({ kind: 'fd.documentclass', id: 'CtX', path: 'fd/classes/CtX.json', policy: 'managed' });
  assert.throws(() => pkg.resolve('CtX'), /ambiguous id "CtX".*fd\.documentclass\/CtX.*fd\.tagclass\/CtX/s);
  // kind/id form still unambiguous
  assert.equal(pkg.resolve('fd.tagclass/CtX').kind, 'fd.tagclass');
});

test('setResState / resState round-trip, patch merge, and null deletion', () => {
  assert.equal(pkg.resState('iris', 'fd.tagclass', 'CtX'), null);
  pkg.setResState('iris', 'fd.tagclass', 'CtX', { syncedHash: 'sha256:abc' });
  const st = pkg.resState('iris', 'fd.tagclass', 'CtX');
  assert.equal(st.syncedHash, 'sha256:abc');
  assert.ok(st.syncedAt); // stamped automatically

  // patch merges into existing state
  pkg.setResState('iris', 'fd.tagclass', 'CtX', { deployedId: 'CtX_v2' });
  const st2 = pkg.resState('iris', 'fd.tagclass', 'CtX');
  assert.equal(st2.syncedHash, 'sha256:abc');
  assert.equal(st2.deployedId, 'CtX_v2');

  // persisted to .uxc/state.json under the resource key
  assert.ok(existsSync(join(dir, '.uxc', 'state.json')));
  const disk = JSON.parse(readFileSync(join(dir, '.uxc', 'state.json'), 'utf8'));
  assert.equal(disk.targets.iris.resources[resourceKey('fd.tagclass', 'CtX')].syncedHash, 'sha256:abc');

  // null clears the entry
  pkg.setResState('iris', 'fd.tagclass', 'CtX', null);
  assert.equal(pkg.resState('iris', 'fd.tagclass', 'CtX'), null);
});

test('untracked: stray file reported; registered paths, sibling content files, handlers/shared not reported', () => {
  // registered json path -> NOT reported
  mkdirSync(join(dir, 'fd', 'tagclasses'), { recursive: true });
  writeFileSync(join(dir, 'fd', 'tagclasses', 'CtX.json'), '{}\n');
  // stray file -> reported
  writeFileSync(join(dir, 'fd', 'tagclasses', 'Stray.json'), '{}\n');
  // sibling content file next to a registered meta json -> NOT reported
  mkdirSync(join(dir, 'ai', 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'ai', 'prompts', 'ctX.json'), '{}\n');
  writeFileSync(join(dir, 'ai', 'prompts', 'ctX.content.md'), 'You are…\n');
  // file inside a directory-style resource path -> NOT reported
  mkdirSync(join(dir, 'fd', 'handlers', 'CtIngest_onCreate'), { recursive: true });
  writeFileSync(join(dir, 'fd', 'handlers', 'CtIngest_onCreate', 'meta.json'), '{}\n');
  // shared handler sources -> NOT reported (referenced from metas by convention)
  mkdirSync(join(dir, 'fd', 'handlers', 'shared'), { recursive: true });
  writeFileSync(join(dir, 'fd', 'handlers', 'shared', 'x.js'), '// shared\n');

  assert.deepEqual(pkg.untracked(), ['fd/tagclasses/Stray.json']);
});
