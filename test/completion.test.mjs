// Offline unit tests for the `uxc completion` generator (lib/commands/completion.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bashCompletion, zshCompletion, subcommandsFrom, kindList,
} from '../lib/commands/completion.mjs';

const ARGS = () => ({
  commands: ['init', 'push', 'add', 'target', 'completion', 'help'],
  twoWord: ['target', 'mp'],
  subcommands: { target: ['add', 'ls', 'use'], mp: ['ls', 'publish'] },
  kinds: ['ai.prompt', 'fd.script'],
});

test('subcommandsFrom: derives <cmd>-<sub> from filenames, sorted, strips .mjs', () => {
  const files = ['target-add.mjs', 'target-use.mjs', 'target-ls.mjs', 'mp-ls.mjs', 'help.mjs', 'README.md'];
  const subs = subcommandsFrom(files, ['target', 'mp']);
  assert.deepEqual(subs.target, ['add', 'ls', 'use']);
  assert.deepEqual(subs.mp, ['ls']);
});

test('kindList: real adapters incl. ai.llm (not the retired ai.llmconf), sorted & unique', () => {
  const ks = kindList();
  assert.ok(ks.includes('fd.script'));
  assert.ok(ks.includes('ai.prompt'));
  assert.ok(ks.includes('ai.llm'));           // now a real adapter
  assert.ok(!ks.includes('ai.llmconf'));      // inspect-only stub retired
  assert.deepEqual(ks, [...ks].sort());
  assert.equal(ks.length, new Set(ks).size);
});

test('bashCompletion: registers the function and the complete binding', () => {
  const s = bashCompletion(ARGS());
  assert.match(s, /_uxc\(\)/);
  assert.match(s, /complete -F _uxc uxc/);
});

test('bashCompletion: top-level command list and kinds are baked in', () => {
  const s = bashCompletion(ARGS());
  assert.match(s, /TOPCMDS='init push add target completion help'/);
  assert.match(s, /KINDS='ai\.prompt fd\.script'/);
});

test('bashCompletion: two-word subcommands become case arms', () => {
  const s = bashCompletion(ARGS());
  assert.match(s, /target\) COMPREPLY=\( \$\(compgen -W 'add ls use'/);
  assert.match(s, /mp\) COMPREPLY=\( \$\(compgen -W 'ls publish'/);
});

test('bashCompletion: kind- and id-aware argument completion present', () => {
  const s = bashCompletion(ARGS());
  assert.match(s, /add\|adopt\|ls\|schema\)/);          // kind commands
  assert.match(s, /_uxc_registry_ids/);                  // id commands read registry.json
  assert.match(s, /get\) COMPREPLY=\( \$\(compgen -W "\$KINDS doc"/);
});

test('bashCompletion: per-command flags include globals + curated set', () => {
  const s = bashCompletion(ARGS());
  assert.match(s, /__uxc_flags='--target --json --dir --help'/);
  assert.match(s, /"push"\) __uxc_flags="\$__uxc_flags --changed --all --force --settle --recreate --revive"/);
  assert.match(s, /"target add"\) __uxc_flags=/); // two-word flag key
});

test('zshCompletion: wraps bash output with bashcompinit', () => {
  const s = zshCompletion(ARGS());
  assert.match(s, /bashcompinit/);
  assert.match(s, /complete -F _uxc uxc/);
});
