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
import folderclass from '../lib/kinds/fd-folderclass.mjs';
import vfinstance from '../lib/kinds/fd-vfinstance.mjs';
import prompt from '../lib/kinds/ai-prompt.mjs';
import { KINDS, PUSH_ORDER } from '../lib/kinds/index.mjs';
import { canonicalize } from '../lib/canonical.mjs';

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
// fd.folderclass — physical FOLDER-category class (parent-child containment). Adapter mirrors
// documentclass (managed, full-replace) + a `children[]` {category,id} constraint list.
// ---------------------------------------------------------------------------

test('fd.folderclass: adapter shape + registration + push order', () => {
  assert.equal(folderclass.kind, 'fd.folderclass');
  assert.equal(folderclass.restPath, 'folderclass');       // category is closure-captured (applied in
  assert.equal(folderclass.dir, 'fd/folderclasses');       // create/update), not an adapter property
  assert.equal(folderclass.defaultPolicy, 'managed');
  assert.equal(folderclass.inPlaceUpdate, false);           // managed already updates in place
  assert.equal(KINDS['fd.folderclass'], folderclass);       // registered in the kind map
  // pushed after the document/task classes it may reference as children, before VF classes:
  assert.ok(PUSH_ORDER.indexOf('fd.folderclass') > PUSH_ORDER.indexOf('fd.documentclass'));
  assert.ok(PUSH_ORDER.indexOf('fd.folderclass') < PUSH_ORDER.indexOf('fd.vfclass'));
});

test('fd.folderclass template: FOLDER + acl-folder + children; default child = any DOCUMENT', () => {
  const def = folderclass.template({}, 'PoOrder', {}).obj;
  assert.equal(def.category, 'FOLDER');
  assert.equal(def.active, true);
  assert.equal(def.data.ACL, 'acl-folder');                 // base folder ACL, not acl-readonly
  assert.deepEqual(def.children, [{ category: 'DOCUMENT', id: '*' }]);

  const t = folderclass.template({}, 'PoOrder', {
    children: 'DOCUMENT:PoEmail, FOLDER:*, virtual_folder', // mixed case + spaces + bare category
    tags: 'PoStatus:mandatory, PoCustomerNo',
  }).obj;
  assert.deepEqual(t.children, [
    { category: 'DOCUMENT', id: 'PoEmail' },
    { category: 'FOLDER', id: '*' },
    { category: 'VIRTUAL_FOLDER', id: '*' },                // category upper-cased, id defaults to '*'
  ]);
  assert.deepEqual(t.tagReferences.map((r) => [r.tagName, r.mandatory]),
    [['PoStatus', true], ['PoCustomerNo', false]]);
});

test('fd.folderclass canonicalize: strips volatile data + empty arrays, keeps children', () => {
  const server = {
    id: 'PoOrder', category: 'FOLDER', active: true,
    data: { ACL: 'acl-folder', owner: 'system', creationDate: 'x', lastUpdateDate: 'y', version: 3 },
    children: [{ category: 'DOCUMENT', id: '*' }],
    tagReferences: [], tagCategories: [],                   // server echo omits empty arrays
  };
  const c = canonicalize('fd.folderclass', server);
  assert.deepEqual(c.data, { ACL: 'acl-folder' });          // volatile fields stripped
  assert.equal('tagReferences' in c, false);                // empty arrays dropped (hash like absent)
  assert.equal('tagCategories' in c, false);
  assert.deepEqual(c.children, [{ category: 'DOCUMENT', id: '*' }]); // containment preserved
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
