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
import workflow from '../lib/kinds/fd-workflow.mjs';
import acl from '../lib/kinds/fd-acl.mjs';
import prompt from '../lib/kinds/ai-prompt.mjs';
import aiLlm, { maskNormalize as llmMask, resolveMasks as llmResolve, canonical as llmCanonical } from '../lib/kinds/ai-llm.mjs';
import aiMcp, { maskNormalize as mcpMask } from '../lib/kinds/ai-mcp.mjs';
import { KINDS, PUSH_ORDER } from '../lib/kinds/index.mjs';
import { canonicalize, hashResource } from '../lib/canonical.mjs';

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
// fd.workflow + fd.acl — full write support. get-ALL 500s live (T00303 / T01006), so these read
// BY ID only (no list/scan), like fd.vfinstance. DTOs carry no data block.
// ---------------------------------------------------------------------------

/** A ctx whose core client records calls and returns `getReturn` from get/getOne. */
function recCtx(getReturn = null) {
  const calls = [];
  const core = {
    get: async (p) => { calls.push(['GET', p]); return getReturn; },
    getOne: async (p) => { calls.push(['GETONE', p]); return getReturn; },
    post: async (p, b) => { calls.push(['POST', p, b]); return b; },
    del: async (p) => { calls.push(['DEL', p]); return {}; },
  };
  return { ctx: { clients: { core } }, calls };
}

test('fd.workflow: managed, registered, no working list; pushes after taskclass', () => {
  assert.equal(workflow.kind, 'fd.workflow');
  assert.equal(workflow.restPath, 'workflow');
  assert.equal(workflow.defaultPolicy, 'managed');       // was external/read-only — now writable
  assert.equal(KINDS['fd.workflow'], workflow);
  assert.ok(PUSH_ORDER.indexOf('fd.workflow') > PUSH_ORDER.indexOf('fd.taskclass')); // lists taskClasses
  assert.ok(PUSH_ORDER.indexOf('fd.workflow') < PUSH_ORDER.indexOf('fd.vfclass'));
});

test('fd.workflow: get-all disabled (list/scan empty — T00303); reads/writes are by-id', async () => {
  assert.deepEqual(await workflow.list(), []);            // GET /rest/workflow 500s — never called
  assert.deepEqual(await workflow.scan(), []);
  const c = recCtx();
  await workflow.create(c.ctx, { obj: { id: 'CtWf', startTaskClass: 'CtA', taskClasses: ['CtA'] } });
  await workflow.update(c.ctx, 'CtWf', { obj: { id: 'CtWf', startTaskClass: 'CtA', taskClasses: ['CtA', 'CtB'] } });
  await workflow.remove(c.ctx, 'CtWf');
  await workflow.get(c.ctx, 'CtWf');
  assert.deepEqual(c.calls, [
    ['POST', '/rest/workflow', [{ id: 'CtWf', startTaskClass: 'CtA', taskClasses: ['CtA'] }]],       // create: array body, no /{id}
    ['POST', '/rest/workflow/CtWf', [{ id: 'CtWf', startTaskClass: 'CtA', taskClasses: ['CtA', 'CtB'] }]], // update: id in path
    ['DEL', '/rest/workflow/CtWf'],
    ['GETONE', '/rest/workflow/CtWf'],
  ]);
});

test('fd.workflow template + validate', () => {
  const t = workflow.template({}, 'CtApproval', { steps: 'CtStep1, CtStep2', start: 'CtStep0' }).obj;
  assert.equal(t.startTaskClass, 'CtStep0');
  assert.deepEqual(t.taskClasses, ['CtStep0', 'CtStep1', 'CtStep2']); // start prepended when absent
  assert.equal(workflow.validate({}, { id: 'CtApproval' }, { obj: t }).length, 0);
  // missing startTaskClass / empty taskClasses / start not in taskClasses all rejected
  assert.ok(workflow.validate({}, { id: 'W' }, { obj: { taskClasses: ['A'] } }).length);
  assert.ok(workflow.validate({}, { id: 'W' }, { obj: { startTaskClass: 'A', taskClasses: [] } }).length);
  assert.ok(workflow.validate({}, { id: 'W' }, { obj: { startTaskClass: 'A', taskClasses: ['B'] } }).length);
});

test('fd.acl: managed, registered, pushed before the classes that reference it', () => {
  assert.equal(acl.kind, 'fd.acl');
  assert.equal(acl.restPath, 'acl');
  assert.equal(acl.defaultPolicy, 'managed');
  assert.equal(KINDS['fd.acl'], acl);
  assert.ok(PUSH_ORDER.indexOf('fd.acl') < PUSH_ORDER.indexOf('fd.documentclass')); // classes' data.ACL refs it
});

test('fd.acl: get-all disabled (T01006); by-id CRUD with array bodies, no data block', async () => {
  assert.deepEqual(await acl.list(), []);
  const c = recCtx();
  const body = { id: 'CtAcl', name: 'x', entries: [{ principal: '*', permission: 'READ', grant: 'ALLOW' }] };
  await acl.create(c.ctx, { obj: body });
  await acl.update(c.ctx, 'CtAcl', { obj: body });
  await acl.remove(c.ctx, 'CtAcl');
  assert.deepEqual(c.calls[0], ['POST', '/rest/acl', [body]]);           // create at collection, array
  assert.deepEqual(c.calls[1], ['POST', '/rest/acl/CtAcl', [body]]);     // update id-in-path
  assert.deepEqual(c.calls[2], ['DEL', '/rest/acl/CtAcl']);
});

test('fd.acl template + validate; canonicalize keeps entries, strips nothing spurious', () => {
  const def = acl.template({}, 'CtAcl', {}).obj;
  assert.deepEqual(def.entries, [{ principal: '*', permission: 'READ', grant: 'ALLOW' }]); // default entry
  const t = acl.template({}, 'CtAcl', { entries: '*:UPDATE_CONTENT:allow, role_x:READ:deny', title: 'Ct ACL' }).obj;
  assert.equal(t.name, 'Ct ACL');
  assert.deepEqual(t.entries, [
    { principal: '*', permission: 'UPDATE_CONTENT', grant: 'ALLOW' }, // grant upper-cased
    { principal: 'role_x', permission: 'READ', grant: 'DENY' },
  ]);
  assert.equal(acl.validate({}, { id: 'CtAcl' }, { obj: t }).length, 0);
  assert.ok(acl.validate({}, { id: 'CtAcl' }, { obj: { entries: [] } }).length);            // empty rejected
  assert.ok(acl.validate({}, { id: 'CtAcl' }, { obj: { entries: [{ principal: '*', permission: 'R', grant: 'MAYBE' }] } }).length); // bad grant
  // local-authored == server echo hashes identically (no data block, key order irrelevant)
  const server = { name: 'Ct ACL', id: 'CtAcl', entries: [{ grant: 'ALLOW', permission: 'UPDATE_CONTENT', principal: '*' }, { principal: 'role_x', permission: 'READ', grant: 'DENY' }] };
  assert.equal(hashResource('fd.acl', t), hashResource('fd.acl', server));
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

// ---------------------------------------------------------------------------
// ai.llm — LLM provider configs. Secret masking (server '********' -> '__masked__'), audit-field
// strip, id<->provider; a FRESH keyless install pushes an EMPTY secret (vs ai.mcp which hard-errors).
// ---------------------------------------------------------------------------

test('ai.llm: registered, managed, and pushed before ai.prompt (prompts reference a provider)', () => {
  assert.equal(aiLlm.kind, 'ai.llm');
  assert.equal(aiLlm.defaultPolicy, 'managed');
  assert.equal(KINDS['ai.llm'], aiLlm);
  assert.ok(PUSH_ORDER.indexOf('ai.llm') < PUSH_ORDER.indexOf('ai.prompt'));
});

test('ai.llm maskNormalize: server asterisk runs -> __masked__; other values untouched', () => {
  const out = llmMask({ globalConf: { apiSecret: '********', timeout: 60000 }, name: 'OpenAI', llModelConfs: [{ model: 'gpt-4o' }] });
  assert.equal(out.globalConf.apiSecret, '__masked__'); // masked (8+ asterisks)
  assert.equal(out.globalConf.timeout, 60000);          // non-string untouched
  assert.equal(out.name, 'OpenAI');                     // non-asterisk string untouched
  assert.equal(out.llModelConfs[0].model, 'gpt-4o');    // nested untouched
});

test('ai.llm canonical: id derived from provider, audit fields stripped, secret masked', () => {
  const c = llmCanonical({
    provider: 'openai', globalConf: { apiSecret: '********' }, llModelConfs: [],
    createdAt: 'x', createdBy: 'a', updatedAt: 'y', updatedBy: 'b',
  });
  assert.equal(c.id, 'openai');                         // id <- provider
  assert.equal(c.globalConf.apiSecret, '__masked__');
  for (const f of ['createdAt', 'createdBy', 'updatedAt', 'updatedBy']) assert.equal(f in c, false);
});

test('ai.llm resolveMasks: __masked__ -> live value; no live -> EMPTY (keyless fresh install)', () => {
  const local = { id: 'openai', globalConf: { apiSecret: '__masked__' } };
  const live = { id: 'openai', globalConf: { apiSecret: 'sk-REAL' } };
  assert.equal(llmResolve(local, live).globalConf.apiSecret, 'sk-REAL');  // resolved from the live server
  assert.equal(llmResolve(local, null).globalConf.apiSecret, '');         // fresh: empty, operator sets it
  assert.equal(llmResolve({ globalConf: { apiSecret: 'sk-typed' } }, null).globalConf.apiSecret, 'sk-typed'); // real value passes through
});

test('ai.llm validate: id mismatch / missing provider / empty models all rejected', () => {
  const ok = { id: 'openai', provider: 'openai', llModelConfs: [{ model: 'gpt-4o' }] };
  assert.equal(aiLlm.validate({}, { id: 'openai' }, { obj: ok }).length, 0);
  assert.ok(aiLlm.validate({}, { id: 'openai' }, { obj: { ...ok, provider: undefined } }).length);
  assert.ok(aiLlm.validate({}, { id: 'openai' }, { obj: { ...ok, llModelConfs: [] } }).length);
  assert.ok(aiLlm.validate({}, { id: 'other' }, { obj: ok }).length); // id "openai" != registry "other"
});

test('ai.llm template: keyless provider scaffold', () => {
  const t = aiLlm.template({}, 'openai', { provider: 'openai' }).obj;
  assert.equal(t.provider, 'openai');
  assert.equal(t.globalConf.apiSecret, ''); // never a key in the scaffold
  assert.deepEqual(t.llModelConfs, []);
});

// ---- ai.mcp backfill: its masking was previously untested ----

test('ai.mcp maskNormalize: asterisk runs -> __masked__ (backfill)', () => {
  const out = mcpMask({ headers: { Authorization: '********', 'X-Env': 'prod' } });
  assert.equal(out.headers.Authorization, '__masked__');
  assert.equal(out.headers['X-Env'], 'prod');
});

test('ai.mcp: create with a masked secret and NO live conf HARD-ERRORS (the ai.llm divergence)', async () => {
  const ctx = { clients: { gateway: {
    tryGet: async () => null, get: async () => [],
    post: async () => { throw new Error('must not POST a placeholder secret'); },
  } } };
  await assert.rejects(
    aiMcp.create(ctx, { obj: { id: 'ctTools', headers: { Authorization: '__masked__' } } }),
    /masked secret/i,
  );
});

// ---------------------------------------------------------------------------
// fd.vfinstance create: dual-version endpoint — FD 2026 no-slash, fall back to FD 2025 slash on 404.
// ---------------------------------------------------------------------------

test('fd.vfinstance create: no-slash first; falls back to the slash form on 404 (dual FD 2025/2026)', async () => {
  const mk = (failNoSlashWith) => {
    const calls = [];
    return { calls, ctx: { target: { user: 'u' }, clients: { core: {
      post: async (p, b) => {
        calls.push(p);
        if (failNoSlashWith && p === '/rest/virtualFolder') { const e = new Error('x'); e.status = failNoSlashWith; throw e; }
        return b;
      },
    } } } };
  };
  const obj = { id: 'CtRev', data: { classId: 'CtReview' } };
  // FD 2026: no-slash succeeds -> single call, no fallback
  const a = mk(null);
  await vfinstance.create(a.ctx, { obj });
  assert.deepEqual(a.calls, ['/rest/virtualFolder']);
  // FD 2025: no-slash 404s -> retry the slash form
  const b = mk(404);
  await vfinstance.create(b.ctx, { obj });
  assert.deepEqual(b.calls, ['/rest/virtualFolder', '/rest/virtualFolder/']);
  // 405 also falls back
  const c = mk(405);
  await vfinstance.create(c.ctx, { obj });
  assert.deepEqual(c.calls, ['/rest/virtualFolder', '/rest/virtualFolder/']);
  // a genuine error (not 404/405) propagates, NO retry
  const d = mk(500);
  await assert.rejects(vfinstance.create(d.ctx, { obj }));
  assert.deepEqual(d.calls, ['/rest/virtualFolder']);
});
