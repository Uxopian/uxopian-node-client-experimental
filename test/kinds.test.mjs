// Offline unit tests for adapter policy wiring — specifically the `inPlaceUpdate` flag that lets a
// `createOnly` kind (fd.taskclass) be UPDATED in place while its server-delete stays gated (§14/§20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { classKindAdapter } from '../lib/kinds/base.mjs';
import taskclass from '../lib/kinds/fd-taskclass.mjs';
import documentclass from '../lib/kinds/fd-documentclass.mjs';
import vfinstance from '../lib/kinds/fd-vfinstance.mjs';
import prompt from '../lib/kinds/ai-prompt.mjs';

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

// ---------------------------------------------------------------------------
// ai.prompt readServer: a LOSSY read endpoint must never reduce a prompt's config
// (regression: push echo-leg was clobbering local meta down to id + content).
// ---------------------------------------------------------------------------

/** Build a ctx whose pkg points at `dir` and whose gateway.get('/api/v1/prompts') returns `list`. */
function promptCtx(dir, list) {
  return {
    pkg: {
      dir,
      entry: (k, id) => (k === 'ai.prompt' ? { kind: k, id, path: `ai/prompts/${id}.json` } : null),
    },
    clients: { gateway: { get: async () => list } },
  };
}

function writePrompt(dir, id, meta, content) {
  mkdirSync(join(dir, 'ai/prompts'), { recursive: true });
  writeFileSync(join(dir, `ai/prompts/${id}.json`), JSON.stringify(meta));
  writeFileSync(join(dir, `ai/prompts/${id}.content.md`), content);
}

test('ai.prompt readServer: a reduced server projection does NOT drop authored config', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-prompt-'));
  try {
    writePrompt(dir, 'ctX', {
      id: 'ctX', role: 'user', defaultLlmProvider: 'openai', defaultLlmModel: 'gpt-4o',
      temperature: '0', reasoningDisabled: true, requiresFunctionCallingModel: false,
      requiresMultiModalModel: false, timeSaved: 60,
    }, 'Summarize this.');
    // the gateway returns ONLY id + content — the lossy projection that caused the bug
    const ctx = promptCtx(dir, [{ id: 'ctX', content: 'SERVER CONTENT' }]);
    const { obj } = await prompt.readServer(ctx, 'ctX');
    assert.equal(obj.role, 'user');                  // backfilled from local
    assert.equal(obj.defaultLlmProvider, 'openai');  // backfilled from local
    assert.equal(obj.defaultLlmModel, 'gpt-4o');     // backfilled from local
    assert.equal(obj.temperature, '0');              // backfilled from local
    assert.equal(obj.reasoningDisabled, true);       // backfilled from local
    assert.equal(obj.content, 'SERVER CONTENT');     // server-present key wins
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ai.prompt readServer: server-present fields stay authoritative (drift still detectable)', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-prompt-'));
  try {
    writePrompt(dir, 'ctX', { id: 'ctX', role: 'user', defaultLlmProvider: 'openai' }, 'hi');
    // server reports a DIFFERENT provider — the overlay must surface it (not mask it)
    const ctx = promptCtx(dir, [{ id: 'ctX', content: 'hi', defaultLlmProvider: 'anthropic' }]);
    const { obj } = await prompt.readServer(ctx, 'ctX');
    assert.equal(obj.defaultLlmProvider, 'anthropic'); // server present -> wins (drift visible)
    assert.equal(obj.role, 'user');                    // server omitted -> local kept
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ai.prompt readServer: no local file -> raw echo; absent on server -> null', async () => {
  const noLocal = { pkg: { dir: '/nonexistent', entry: () => null }, clients: { gateway: { get: async () => [{ id: 'ctY', content: 'c' }] } } };
  assert.deepEqual((await prompt.readServer(noLocal, 'ctY')).obj, { id: 'ctY', content: 'c' });
  const absent = { pkg: { entry: () => null }, clients: { gateway: { get: async () => [] } } };
  assert.equal(await prompt.readServer(absent, 'nope'), null);
});
