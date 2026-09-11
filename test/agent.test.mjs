// Offline unit tests for lib/agent.mjs — the package operating policy (BACKLOG-AGENTIC #3/#12):
// pinned target, protected resources, never-pull, forbidden command shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPolicy, globMatch, matchesEntry, resolvePinnedTarget, forbiddenBy, partitionProtected } from '../lib/agent.mjs';

const pkgDir = (manifest, pinFile) => {
  const d = mkdtempSync(join(tmpdir(), 'uxc-agent-'));
  writeFileSync(join(d, 'uxopian-project.json'), JSON.stringify(manifest));
  if (pinFile) {
    mkdirSync(join(d, '.uxc'), { recursive: true });
    writeFileSync(join(d, '.uxc', 'target'), pinFile);
  }
  return d;
};

test('globMatch is anchored and only understands *', () => {
  assert.equal(globMatch('ai.prompt/po*', 'ai.prompt/poFoo'), true);
  assert.equal(globMatch('ai.prompt/po*', 'ai.prompt/ctFoo'), false);
  assert.equal(globMatch('po*', 'poFoo'), true);
  assert.equal(globMatch('poFoo', 'poFooBar'), false, 'anchored: no accidental prefix match');
  assert.equal(globMatch('a.b', 'aXb'), false, "'.' is literal, not a wildcard");
});

test('matchesEntry accepts kind/id and bare id forms', () => {
  const e = { kind: 'fd.handler', id: 'PoEmail_onCreate' };
  assert.equal(matchesEntry('fd.handler/PoEmail_onCreate', e), true);
  assert.equal(matchesEntry('PoEmail_onCreate', e), true);
  assert.equal(matchesEntry('fd.handler/*', e), true);
  assert.equal(matchesEntry('ai.prompt/*', e), false);
});

test('agentPolicy reads the manifest block; .uxc/target overrides the manifest pin', () => {
  const d = pkgDir({ agent: { target: 'gfdefault', protect: ['fd.handler/X'], forbid: ['push --changed'] } });
  const p = agentPolicy(d);
  assert.equal(p.target, 'gfdefault');
  assert.equal(p.targetFrom, 'uxopian-project.json agent.target');
  assert.deepEqual(p.protect, ['fd.handler/X']);
  assert.equal(p.empty, false);
  rmSync(d, { recursive: true, force: true });

  const d2 = pkgDir({ agent: { target: 'gfdefault' } }, 'localsandbox\n');
  const p2 = agentPolicy(d2);
  assert.equal(p2.target, 'localsandbox', 'the per-checkout pin wins');
  assert.equal(p2.targetFrom, '.uxc/target');
  rmSync(d2, { recursive: true, force: true });
});

test('a package with no agent block is empty policy (uxc must work unchanged)', () => {
  const d = pkgDir({ code: 'zz' });
  const p = agentPolicy(d);
  assert.equal(p.target, null);
  assert.equal(p.empty, true);
  assert.deepEqual([p.protect, p.neverPull, p.forbid], [[], [], []]);
  rmSync(d, { recursive: true, force: true });
});

test('no pin: the ambient/requested target is used untouched', () => {
  const r = resolvePinnedTarget({ pin: null, requested: null, ambient: 'iris', write: true });
  assert.deepEqual([r.use, r.refuse, r.warn], ['iris', null, null]);
});

test('--target may CONFIRM the pin, never redirect it (the wrong-instance push)', () => {
  const base = { pin: 'gfdefault', pinFrom: 'agent.target', ambient: 'gfdefault' };
  const ok = resolvePinnedTarget({ ...base, requested: 'gfdefault', write: true });
  assert.deepEqual([ok.use, ok.refuse], ['gfdefault', null]);

  const bad = resolvePinnedTarget({ ...base, requested: 'iris', write: true });
  assert.equal(bad.use, 'gfdefault');
  assert.match(bad.refuse, /pinned to target "gfdefault".*--target "iris"/s);

  const forced = resolvePinnedTarget({ ...base, requested: 'iris', write: true, override: true });
  assert.deepEqual([forced.use, forced.refuse], ['iris', null]);
  assert.match(forced.warn, /overridden/);
});

test('a differing ambient default blocks WRITES and only warns READS', () => {
  const base = { pin: 'gfdefault', pinFrom: 'agent.target', requested: null, ambient: 'iris' };
  const w = resolvePinnedTarget({ ...base, write: true });
  assert.equal(w.use, 'gfdefault');
  assert.match(w.refuse, /Confirm with: --target gfdefault/);

  const r = resolvePinnedTarget({ ...base, write: false });
  assert.equal(r.use, 'gfdefault', 'reads still go to the pinned instance');
  assert.equal(r.refuse, null, 'reads must stay usable');
  assert.match(r.warn, /"iris" is NOT this package's instance/);
});

test('forbid matches command + flags + positional globs, one-word and two-word', () => {
  const p = { forbid: ['push --changed', 'rm --server', 'pull ai.prompt/*', 'destroy', 'data push'] };
  const hit = (command, args, flags) => forbiddenBy(p, { command, args, flags }).length;

  assert.equal(hit('push', [], { changed: true }), 1);
  assert.equal(hit('push', [], { all: true }), 0, '--all is a different shape');
  assert.equal(hit('push', ['PoFoo'], {}), 0);
  assert.equal(hit('rm', ['X'], { server: true }), 1);
  assert.equal(hit('rm', ['X'], { local: true }), 0);
  assert.equal(hit('pull', ['ai.prompt/poX'], {}), 1);
  assert.equal(hit('pull', ['fd.handler/X'], {}), 0);
  assert.equal(hit('destroy', [], {}), 1, 'a bare command name forbids it outright');
  assert.equal(hit('data push', [], {}), 1);
  assert.equal(hit('data pull', [], {}), 0);
});

test('forbid with several conditions requires ALL of them', () => {
  const p = { forbid: ['push --changed --force'] };
  assert.equal(forbiddenBy(p, { command: 'push', args: [], flags: { changed: true } }).length, 0);
  assert.equal(forbiddenBy(p, { command: 'push', args: [], flags: { changed: true, force: true } }).length, 1);
});

test('a false-valued flag does not trigger a forbid', () => {
  const p = { forbid: ['push --changed'] };
  assert.equal(forbiddenBy(p, { command: 'push', args: [], flags: { changed: false } }).length, 0);
});

test('partitionProtected splits entries and names the pattern that caught each', () => {
  const entries = [
    { kind: 'fd.handler', id: 'PoEmail_onCreate' },
    { kind: 'ai.prompt', id: 'poDraft' },
    { kind: 'ai.prompt', id: 'ctDraft' },
  ];
  const { allowed, blocked } = partitionProtected(['fd.handler/PoEmail_onCreate', 'ai.prompt/po*'], entries);
  assert.deepEqual(allowed.map((e) => e.id), ['ctDraft']);
  assert.deepEqual(blocked.map((b) => [b.entry.id, b.pattern]), [
    ['PoEmail_onCreate', 'fd.handler/PoEmail_onCreate'],
    ['poDraft', 'ai.prompt/po*'],
  ]);
});

test('an empty protection list blocks nothing', () => {
  const entries = [{ kind: 'fd.handler', id: 'X' }];
  assert.deepEqual(partitionProtected([], entries).allowed.length, 1);
  assert.deepEqual(partitionProtected(undefined, entries).blocked.length, 0);
});
