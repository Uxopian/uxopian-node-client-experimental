// Offline tests for uxopian-ai 2026.0.0-ft5 support (AI learnings §A11-§A14): versioned prompt
// writes, goals removed (dialect gate -> 'unsupported'), ai.agent / ai.plan kinds, plan runs, and
// the same package still deploying on an ft4 gateway. The fake gateway below encodes the
// mechanics verified live on fd.demo (2026-09-16) — not guesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { HttpError } from '../lib/http.mjs';
import { openPackage } from '../lib/registry.mjs';
import { pushResources, statusAll, pullResources } from '../lib/sync.mjs';
import { canonicalize, hashResource } from '../lib/canonical.mjs';
import { goalEntryId } from '../lib/kinds/ai-goal.mjs';
import prompt, { upsertPrompt } from '../lib/kinds/ai-prompt.mjs';
import agent from '../lib/kinds/ai-agent.mjs';
import plan, { planErrors, findCycle } from '../lib/kinds/ai-plan.mjs';
import application from '../lib/kinds/ai-application.mjs';
import { runPrompt, runPlan } from '../lib/run.mjs';
import { lintAgentic, lintPromptVariables } from '../lib/lint.mjs';
import { explainError } from '../lib/explain.mjs';

// ---------------------------------------------------------------------------
// fake gateway — ft5 or ft4 behavior
// ---------------------------------------------------------------------------

const err = (status, message, path, method) => new HttpError(status, { message, status }, `gw${path}`, method);
const DS_ECHO = (ds) => (ds ? { aiReferenceInfo: false, categoryId: null, description: null, displayConditions: null, label: null, priority: 0, ...ds } : null);

function fakeGateway({ ft5 = true } = {}) {
  const prompts = new Map(); // id -> [versions]
  const agents = new Map();
  const plans = new Map();
  const apps = new Map();
  const goals = [];
  const stopped = [];
  const tools = [{ name: 'searchDocuments', tags: ['flowerdocs'], params: [] }, { name: 'getDocumentContent', tags: ['flowerdocs', 'files'], params: [] }];
  const execs = new Map();
  const calls = [];
  const served = (id) => prompts.get(id).filter((v) => !v.draft).at(-1);
  const snapshot = (body, version, draft) => {
    const { id, draft: _d, version: _v, usage: _u, ...rest } = body;
    return { ...rest, role: String(body.role ?? '').toLowerCase(), displaySettings: DS_ECHO(body.displaySettings), version, ...(draft !== undefined ? { draft } : {}) };
  };
  // agent / plan echoes project every unset field as null and add defaults (verified)
  const agentEcho = (a) => ({
    createdAt: 't', createdBy: null, updatedAt: null, updatedBy: null, description: null, successCriteria: null, secrets: null,
    ...a,
    permissions: { allowAllMcpServers: false, allowAllTools: false, allowedMcpServers: null, allowedSubPlans: null, allowedToolTags: null, allowedTools: null, deniedTools: null, ...(a.permissions ?? {}) },
    ...(a.secrets ? { secrets: Object.fromEntries(Object.entries(a.secrets).map(([k, s]) => [k, { ...s, value: '********' }])) } : {}),
  });
  const planEcho = (p) => ({
    createdAt: 't', createdBy: 'u', updatedAt: 't', updatedBy: 'u', description: null, exposeAsTool: false, toolDescription: null, toolInputParameters: null,
    ...p,
    nodes: (p.nodes ?? []).map((n) => ({ agentConfId: null, dependencies: [], description: null, listKey: null, maxParallelElements: null, persistOutput: false, subPlanId: null, toolArgumentBindings: null, toolName: null, ...n })),
  });

  const route = (method, path, body) => {
    calls.push([method, path.replace(/\?.*$/, ''), body]);
    let m;
    if (path === '/api/v1/admin/prompts') {
      if (method === 'GET') {
        return [...prompts.keys()].map((id) => ({ id, ...served(id), ...(ft5 ? { usage: { deletable: true, basePrompt: false, referencedBy: [] } } : {}) }))
          .map((p) => (ft5 ? p : (({ version, draft, ...rest }) => rest)(p)));
      }
      if (method === 'POST') {
        if (prompts.has(body.id)) throw err(409, `Prompt with id '${body.id}' already exists`, path, method);
        prompts.set(body.id, [snapshot(body, 0)]);
        return { ...body };
      }
      if (method === 'PUT') {
        if (ft5) throw err(500, 'An unexpected error occurred', path, method); // the bare PUT is gone
        prompts.set(body.id, [snapshot(body, 0)]);
        return {};
      }
    }
    if (path === '/api/v1/prompts' && method === 'GET') return [...prompts.keys()].map((id) => ({ id, content: served(id).content }));
    if ((m = /^\/api\/v1\/admin\/prompts\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      const refs = [...apps.values()].filter((a) => a.prompt === id).map((a) => a.name).concat(fake.ghostRefs?.[id]?.length ? fake.ghostRefs[id].splice(0, 1) : []);
      if (refs.length) throw err(409, `Prompt '${id}' is referenced by application(s): [${refs.join(', ')}]`, path, method);
      prompts.delete(id);
      return null;
    }
    if (path === '/api/v1/admin/tools' && method === 'GET') {
      if (!ft5) throw err(404, 'RESOURCE_NOT_FOUND', path, method);
      return tools;
    }
    if ((m = /^\/api\/v1\/conversations\/([^/]+)\/stop$/.exec(path)) && method === 'POST') { stopped.push(m[1]); return null; }
    if (path.startsWith('/api/v1/admin/application/application-conf')) {
      if (!ft5) throw err(404, 'RESOURCE_NOT_FOUND', path, method);
      const base = '/api/v1/admin/application/application-conf';
      const id = path.length > base.length ? decodeURIComponent(path.slice(base.length + 1)) : null;
      const echo = (a) => ({ createdAt: 't', createdBy: 'u', updatedAt: 't', updatedBy: 'u', defaultLlmModel: null, defaultLlmProvider: null, description: null, maxToolCycles: null, prompt: null, provider: null,
        ...a, permissions: { allowAllMcpServers: false, allowAllTools: false, allowedMcpServers: null, allowedSubPlans: null, allowedToolTags: null, allowedTools: null, deniedTools: null, ...(a.permissions ?? {}) } });
      if (!id && method === 'GET') return [...apps.values()].map(echo);
      if (!id && method === 'POST') {
        // the id is DERIVED from the name — a client id is ignored (verified)
        if (apps.has(body.name)) throw err(409, `Application already exists for name: ${body.name}`, path, method);
        apps.set(body.name, { ...structuredClone(body), id: body.name });
        return null;
      }
      if (!apps.has(id)) throw err(404, `Application '${id}' not found.`, path, method);
      if (method === 'GET') return echo(apps.get(id));
      if (method === 'PUT') { apps.set(id, { ...structuredClone(body), id }); return null; }
      if (method === 'DELETE') { apps.delete(id); return null; }
    }
    if ((m = /^\/api\/v1\/admin\/prompts\/([^/]+)\/versions(?:\/(\d+))?$/.exec(path))) {
      if (!ft5) throw err(404, 'RESOURCE_NOT_FOUND', path, method);
      const id = decodeURIComponent(m[1]);
      const vs = prompts.get(id);
      if (!vs) throw err(404, `Prompt not found with id: ${id}`, path, method);
      if (m[2] == null && method === 'GET') return vs.map((v) => ({ ...v, id }));
      if (m[2] == null && method === 'POST') {
        if (vs.some((v) => v.draft)) throw err(409, `A draft already exists for prompt '${id}'`, path, method);
        if (!body.role) throw err(400, 'Prompt role is empty', path, method);
        const d = snapshot(body, vs.at(-1).version + 1, true);
        vs.push(d);
        return { ...d, id };
      }
      const n = Number(m[2]);
      const i = vs.findIndex((v) => v.version === n);
      if (i === -1) throw err(404, `Version ${n} not found for prompt: ${id}`, path, method);
      if (method === 'GET') return { ...vs[i], id };
      if (method === 'PUT') {
        if (!vs[i].draft) throw err(409, `Version ${n} of prompt '${id}' is published and read-only`, path, method);
        vs[i] = snapshot(body, n, body.draft === false ? false : true);
        return { ...vs[i], id };
      }
    }
    if (path === '/api/v1/admin/goals') {
      if (ft5) throw err(404, 'The requested resource was not found at path: api/v1/admin/goals', path, method);
      if (method === 'GET') return goals;
      if (method === 'POST') { const row = { ...body, id: `g${goals.length + 1}` }; goals.push(row); return row; }
    }
    for (const [base, store, echo, label] of [
      ['/api/v1/admin/agent/agent-conf', agents, agentEcho, 'Agent configuration'],
      ['/api/v1/admin/plans', plans, planEcho, 'Agent plan'],
    ]) {
      if (!path.startsWith(base)) continue;
      if (!ft5) throw err(404, 'RESOURCE_NOT_FOUND', path, method);
      const id = path.length > base.length ? decodeURIComponent(path.slice(base.length + 1)) : null;
      if (!id && method === 'GET') return [...store.values()].map(echo);
      if (!id && method === 'POST') {
        if (store.has(body.id)) throw err(400, `${label} already exists for id: ${body.id}`, path, method);
        store.set(body.id, structuredClone(body));
        return null; // 201, empty body
      }
      if (id && !store.has(id)) throw err(404, `${label} not found with id: ${id}`, path, method);
      if (method === 'GET') return echo(store.get(id));
      if (method === 'PUT') {
        const prev = store.get(id);
        const next = structuredClone(body); // FULL replace; a masked secret keeps the stored value
        for (const [k, s] of Object.entries(next.secrets ?? {})) if (/^\*{8,}$/.test(s.value)) s.value = prev.secrets?.[k]?.value;
        store.set(id, next);
        return null;
      }
      if (method === 'DELETE') { store.delete(id); return null; }
    }
    if (path === '/api/v1/admin/plan-executions/run' && method === 'POST') {
      if (!plans.has(body.planId)) throw err(404, `Agent plan not found with id: ${body.planId}`, path, method);
      const p = plans.get(body.planId);
      const declared = new Set((p.toolInputParameters ?? []).map((x) => x.name));
      if (body.inputPayload?.word && !declared.has('word')) throw err(400, "Plan is not executable: Node 'ask': prompt references variable 'word' which is not provided by any dependency.", path, method);
      const exec = {
        id: `ex${execs.size + 1}`, planId: body.planId, status: 'RUNNING', polls: 0,
        nodeExecutions: p.nodes.map((n) => ({ nodeId: n.id, type: n.type, status: 'RUNNING', outputKey: n.outputKey, dependencies: n.dependencies ?? [], outputData: null })),
        inputPayload: body.inputPayload,
      };
      execs.set(exec.id, exec);
      return structuredClone(exec);
    }
    if ((m = /^\/api\/v1\/admin\/plan-executions\/([^/]+)(\/stop)?$/.exec(path))) {
      const exec = execs.get(m[1]);
      if (m[2]) { exec.status = 'CANCELLED'; exec.stopped = true; return null; }
      if (exec.hang) return structuredClone(exec);
      if (++exec.polls >= 2) {
        exec.status = 'COMPLETED';
        for (const n of exec.nodeExecutions) { n.status = 'COMPLETED'; n.outputData = `PONG ${exec.inputPayload?.word ?? ''} from ${n.nodeId}`.trim(); }
      }
      return structuredClone(exec);
    }
    throw err(404, `no fake route ${method} ${path}`, path, method);
  };

  const fake = { ghostRefs: {} };
  const gateway = {
    get: async (p) => route('GET', p),
    tryGet: async (p) => { try { return route('GET', p); } catch (e) { if (e.status === 404) return null; throw e; } },
    post: async (p, b, opts) => { if (opts?.headers) calls.push(['HEADERS', p, opts.headers]); return route('POST', p, b); },
    put: async (p, b) => route('PUT', p, b),
    del: async (p) => route('DELETE', p),
    req: async (method, p, b, opts) => {
      calls.push([method, p.replace(/\?.*$/, ''), b, opts?.headers]);
      if (fake.hangStream) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      return { text: 'data: {"content":"PONG"}\n' };
    },
  };
  return Object.assign(fake, { gateway, prompts, agents, plans, apps, goals, execs, calls, stopped });
}

// ---------------------------------------------------------------------------
// package scaffold
// ---------------------------------------------------------------------------

const GOAL_ROW = { goalName: 'summarize', promptId: 'tpHello', filter: null, index: 0 };

function scaffold() {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-ft5-'));
  const w = (rel, data) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  w('uxopian-project.json', { code: 'tp', name: 'tp', format: 'uxopian-package/1', version: '1.0.0', products: ['uxopian-ai'] });
  w('registry.json', { resources: [
    { kind: 'ai.prompt', id: 'tpHello', path: 'ai/prompts/tpHello.json', policy: 'managed' },
    { kind: 'ai.goal', id: goalEntryId(GOAL_ROW), path: 'ai/goals/goals.json', policy: 'managed' },
    { kind: 'ai.agent', id: 'tpHelloAgent', path: 'ai/agents/tpHelloAgent.json', policy: 'managed' },
    { kind: 'ai.plan', id: 'tpHelloPlan', path: 'ai/plans/tpHelloPlan.json', policy: 'managed' },
    { kind: 'ai.application', id: 'tpPortal', path: 'ai/applications/tpPortal.json', policy: 'managed' },
  ] });
  w('ai/prompts/tpHello.json', { id: 'tpHello', role: 'USER', defaultLlmProvider: 'openai', defaultLlmModel: 'gpt-4o', temperature: 0, reasoningDisabled: true, timeSaved: 1, displaySettings: { enabled: false } });
  w('ai/prompts/tpHello.content.md', 'Reply PONG and [[${word}]]');
  w('ai/goals/goals.json', [GOAL_ROW]);
  w('ai/agents/tpHelloAgent.json', { id: 'tpHelloAgent', description: 'says pong', objective: 'tpHello' });
  w('ai/applications/tpPortal.json', { id: 'tpPortal', name: 'tpPortal', provider: 'FlowerDocsProvider', prompt: 'tpHello', defaultLlmProvider: 'openai', defaultLlmModel: 'gpt-4o-mini', permissions: { allowedToolTags: ['flowerdocs'] } });
  w('ai/plans/tpHelloPlan.json', {
    id: 'tpHelloPlan',
    nodes: [{ id: 'ask', name: 'ask', type: 'AGENT', agentConfId: 'tpHelloAgent', outputKey: 'answer' }],
    toolInputParameters: [{ name: 'word', description: 'the word', required: true }],
  });
  return dir;
}

function ctxFor(dir, fake, flags = {}) {
  const warns = [];
  const ctx = {
    flags, args: [],
    target: { name: 'fake' },
    clients: { gateway: fake.gateway },
    out: { warn: (m) => warns.push(m), note: () => {}, line: () => {} },
    pkg: null,
    requirePkg() { ctx.pkg ??= openPackage(dir); return ctx.pkg; },
    connect() {},
  };
  return { ctx, warns };
}

const actions = (res) => Object.fromEntries(res.map((r) => [r.kind, r.action]));

// ---------------------------------------------------------------------------
// end to end: one package, two gateway generations
// ---------------------------------------------------------------------------

test('ft5: push deploys prompt/agent/plan, reports the goal UNSUPPORTED (not a failure), status is clean', async () => {
  const dir = scaffold();
  try {
    const fake = fakeGateway({ ft5: true });
    const { ctx } = ctxFor(dir, fake);
    const pkg = ctx.requirePkg();
    const res = await pushResources(ctx, pkg.entries());
    assert.deepEqual(actions(res), { 'ai.prompt': 'created', 'ai.goal': 'unsupported', 'ai.agent': 'created', 'ai.plan': 'created', 'ai.application': 'created' });
    assert.match(res.find((r) => r.kind === 'ai.goal').detail, /removed goals/);
    assert.ok(!fake.calls.some(([, p]) => p === '/api/v1/admin/goals'), 'no goal write is attempted');
    // the verbose ft5 echoes hash like the terse local files -> insync
    const { ctx: c2 } = ctxFor(dir, fake);
    const { rows } = await statusAll(c2, { remote: true });
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.kind, r.state])),
      { 'ai.prompt': 'insync', 'ai.goal': 'unsupported', 'ai.agent': 'insync', 'ai.plan': 'insync', 'ai.application': 'insync' });
    // pull skips the goal too
    const { ctx: c3 } = ctxFor(dir, fake);
    const pulled = await pullResources(c3, c3.requirePkg().entries());
    assert.equal(pulled.find((r) => r.kind === 'ai.goal').action, 'unsupported');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ft4: the SAME package deploys prompt + goal and reports agent/plan unsupported', async () => {
  const dir = scaffold();
  try {
    const fake = fakeGateway({ ft5: false });
    const { ctx } = ctxFor(dir, fake);
    const res = await pushResources(ctx, ctx.requirePkg().entries());
    assert.deepEqual(actions(res), { 'ai.prompt': 'created', 'ai.goal': 'created', 'ai.agent': 'unsupported', 'ai.plan': 'unsupported', 'ai.application': 'unsupported' });
    assert.match(res.find((r) => r.kind === 'ai.plan').detail, /2026\.0\.0-ft5\+/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ft5: a prompt edit publishes a NEW version via draft -> publish (never the removed bare PUT)', async () => {
  const dir = scaffold();
  try {
    const fake = fakeGateway({ ft5: true });
    const { ctx } = ctxFor(dir, fake);
    await pushResources(ctx, ctx.requirePkg().entries());
    writeFileSync(join(dir, 'ai/prompts/tpHello.content.md'), 'Reply PONG, PONG and [[${word}]]');
    fake.calls.length = 0;
    const { ctx: c2 } = ctxFor(dir, fake);
    const res = await pushResources(c2, [c2.requirePkg().entry('ai.prompt', 'tpHello')]);
    assert.equal(res[0].action, 'updated');
    const writes = fake.calls.filter(([m]) => m !== 'GET').map(([m, p, b]) => [m, p, b?.draft]);
    assert.deepEqual(writes, [
      ['POST', '/api/v1/admin/prompts/tpHello/versions', undefined],
      ['PUT', '/api/v1/admin/prompts/tpHello/versions/1', false],
    ]);
    const vs = fake.prompts.get('tpHello');
    assert.deepEqual(vs.map((v) => [v.version, !!v.draft]), [[0, false], [1, false]]);
    assert.equal(vs[1].content, 'Reply PONG, PONG and [[${word}]]');
    // no server-owned bookkeeping in the snapshot body
    const body = fake.calls.find(([m, p]) => m === 'POST' && p.endsWith('/versions'))[2];
    for (const f of ['version', 'draft', 'usage']) assert.ok(!(f in body), `${f} must not be sent`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ft5: an open draft that matches the package (half-done push) is REUSED; a foreign one is refused unless --force', async () => {
  const dir = scaffold();
  try {
    const fake = fakeGateway({ ft5: true });
    const { ctx } = ctxFor(dir, fake);
    await pushResources(ctx, ctx.requirePkg().entries());
    const next = 'Reply PONG twice and [[${word}]]';
    writeFileSync(join(dir, 'ai/prompts/tpHello.content.md'), next);

    // someone is editing in the admin UI: a draft with OTHER content
    const local = { id: 'tpHello', role: 'user', content: 'admin UI work in progress', defaultLlmProvider: 'openai', defaultLlmModel: 'gpt-4o', temperature: '0', reasoningDisabled: true, timeSaved: 1, displaySettings: { enabled: false } };
    await fake.gateway.post('/api/v1/admin/prompts/tpHello/versions', local);
    const { ctx: c2 } = ctxFor(dir, fake);
    await assert.rejects(pushResources(c2, [c2.requirePkg().entry('ai.prompt', 'tpHello')]), /unpublished draft v1/);
    assert.equal(fake.prompts.get('tpHello')[1].draft, true, 'the foreign draft is untouched');

    const { ctx: c3 } = ctxFor(dir, fake, { force: true });
    await pushResources(c3, [c3.requirePkg().entry('ai.prompt', 'tpHello')], { force: true });
    assert.deepEqual(fake.prompts.get('tpHello').map((v) => [v.version, !!v.draft, v.content]).at(-1), [1, false, next]);

    // a draft identical to what we publish (earlier push died between POST and PUT) is reused
    const again = 'Reply PONG thrice and [[${word}]]';
    writeFileSync(join(dir, 'ai/prompts/tpHello.content.md'), again);
    await fake.gateway.post('/api/v1/admin/prompts/tpHello/versions', { ...local, content: again });
    fake.calls.length = 0;
    const { ctx: c4 } = ctxFor(dir, fake);
    await pushResources(c4, [c4.requirePkg().entry('ai.prompt', 'tpHello')]);
    assert.ok(!fake.calls.some(([m, p]) => m === 'POST' && p.endsWith('/versions')), 'no second draft is opened');
    assert.deepEqual(fake.prompts.get('tpHello').map((v) => [v.version, !!v.draft]).at(-1), [2, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upsertPrompt (receipts) goes through the dialect strategy on both generations', async () => {
  for (const ft5 of [true, false]) {
    const fake = fakeGateway({ ft5 });
    const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
    const body = { id: 'uxcPkgTp', role: 'system', content: '{"v":1}', timeSaved: 0, displaySettings: { enabled: false } };
    await upsertPrompt(ctx, body);
    await upsertPrompt(ctx, { ...body, content: '{"v":2}' });
    const writes = fake.calls.filter(([m]) => m !== 'GET').map(([m, p]) => `${m} ${p}`);
    assert.deepEqual(writes, ft5
      ? ['POST /api/v1/admin/prompts', 'POST /api/v1/admin/prompts/uxcPkgTp/versions', 'PUT /api/v1/admin/prompts/uxcPkgTp/versions/1']
      : ['POST /api/v1/admin/prompts', 'PUT /api/v1/admin/prompts']);
  }
});

// ---------------------------------------------------------------------------
// ai.agent / ai.plan adapters
// ---------------------------------------------------------------------------

test('ai.agent secrets: echoed ******** stored as __masked__, a push keeps the live secret', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await agent.create(ctx, { obj: { id: 'tpA', objective: 'tpHello', secrets: { API: { value: 'real-key', description: 'k' } } } });
  const echo = await agent.readServer(ctx, 'tpA');
  assert.equal(echo.obj.secrets.API.value, '__masked__');
  await agent.update(ctx, 'tpA', { obj: { ...echo.obj, description: 'renamed' } });
  assert.equal(fake.agents.get('tpA').secrets.API.value, 'real-key', 'a masked placeholder never overwrites the stored secret');
  await assert.rejects(agent.create(ctx, { obj: { id: 'tpB', objective: 'x', secrets: { API: { value: '__masked__' } } } }), /ai\.agent\/tpB: masked secret/);
});

test('agentic kinds: create on an existing id (400 "already exists") falls back to a full replace', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await plan.create(ctx, { obj: { id: 'tpP', nodes: [{ id: 'a', type: 'AGENT', agentConfId: 'x' }] } });
  await plan.create(ctx, { obj: { id: 'tpP', description: 'v2', nodes: [{ id: 'a', type: 'AGENT', agentConfId: 'x' }] } });
  assert.equal(fake.plans.get('tpP').description, 'v2');
  await plan.remove(ctx, 'tpP');
  await plan.remove(ctx, 'tpP'); // already gone: not an error
});

test('canonical: ft5 agent/plan/prompt echoes hash like terse hand-written files', () => {
  const fake = fakeGateway({ ft5: true });
  const h = (kind, o) => hashResource(kind, o);
  // plan
  const localPlan = { id: 'p', nodes: [{ id: 'a', name: 'a', type: 'AGENT', agentConfId: 'x', outputKey: 'o' }] };
  assert.equal(h('ai.plan', localPlan), h('ai.plan', { createdAt: 't', updatedBy: 'u', description: null, exposeAsTool: false, toolInputParameters: null, id: 'p',
    nodes: [{ id: 'a', name: 'a', type: 'AGENT', agentConfId: 'x', outputKey: 'o', dependencies: [], persistOutput: false, listKey: null, toolName: null }] }));
  // meaningful values survive
  assert.notEqual(h('ai.plan', localPlan), h('ai.plan', { ...localPlan, exposeAsTool: true }));
  assert.notEqual(h('ai.agent', { id: 'a', objective: 'p' }), h('ai.agent', { id: 'a', objective: 'p', permissions: { allowedTools: [] } }));
  // agent
  assert.equal(h('ai.agent', { id: 'a', objective: 'p' }), h('ai.agent', { id: 'a', objective: 'p', secrets: null, createdBy: null,
    permissions: { allowAllMcpServers: false, allowAllTools: false, allowedTools: null, deniedTools: null } }));
  // prompt: ft5 admin-list bookkeeping is not content
  const p = { id: 'x', role: 'user', content: 'c', temperature: '0' };
  assert.equal(h('ai.prompt', p), h('ai.prompt', { ...p, version: 4, draft: false, usage: { deletable: true, basePrompt: false, referencedBy: [] } }));
  assert.ok(fake); // keep the fake in scope for readers comparing shapes
});

test('ai.plan validate: structure, dangling deps, cycles, tool exposure, illegal ids', () => {
  const entry = { id: 'tpP' };
  const ok = { id: 'tpP', nodes: [{ id: 'a', type: 'AGENT', agentConfId: 'x' }, { id: 'b', type: 'DIRECT_TOOL', toolName: 't', dependencies: ['a'] }] };
  assert.deepEqual(plan.validate(null, entry, { obj: ok }), []);
  const bad = plan.validate(null, entry, { obj: { id: 'tpP', exposeAsTool: true, nodes: [
    { id: 'a', type: 'AGENT', dependencies: ['b'] },
    { id: 'b', type: 'SUBPLAN', subPlanId: 's', dependencies: ['a', 'ghost'] },
    { id: 'b', type: 'NOPE' },
  ] } });
  for (const re of [/AGENT nodes need agentConfId/, /duplicate node id/, /type must be one of/, /dependency "ghost"/, /circular dependency a -> b -> a/, /needs a toolDescription/]) {
    assert.ok(bad.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(bad)}`);
  }
  assert.ok(plan.validate(null, { id: 'tp plan' }, { obj: { nodes: ok.nodes } }).some((e) => /whitespace/.test(e)));
  assert.equal(findCycle([{ id: 'a', dependencies: ['a'] }]).join(), 'a,a');
  assert.deepEqual(planErrors({ nodes: 'x' }), ['nodes must be an array of plan nodes']);
  assert.ok(agent.validate(null, { id: 'tpA' }, { obj: { id: 'tpA' } }).some((e) => /objective is required/.test(e)));
});

test('lintAgentic: dangling references + node variables no upstream provides', () => {
  const dir = scaffold();
  try {
    const pkg = openPackage(dir);
    assert.deepEqual(lintAgentic(pkg), [], 'the scaffold declares word in toolInputParameters');
    // an agent objective prompt is called by the plan engine: no "no caller" noise for it
    assert.ok(!lintPromptVariables(pkg).some((f) => f.prompt === 'tpHello'));

    writeFileSync(join(dir, 'ai/plans/tpHelloPlan.json'), JSON.stringify({ id: 'tpHelloPlan', nodes: [
      { id: 'ask', type: 'AGENT', agentConfId: 'tpHelloAgent', outputKey: 'answer' },
      { id: 'more', type: 'AGENT', agentConfId: 'tpGhostAgent', dependencies: ['ask'] },
      { id: 'sub', type: 'SUBPLAN', subPlanId: 'tpGhostPlan' },
    ] }));
    writeFileSync(join(dir, 'ai/agents/tpHelloAgent.json'), JSON.stringify({ id: 'tpHelloAgent', objective: 'tpHello', permissions: { allowedSubPlans: ['tpNope'] } }));
    const f = openPackage(dir) && lintAgentic(openPackage(dir));
    const msgs = f.map((x) => x.message).join('\n');
    assert.match(msgs, /node "ask" runs tpHelloAgent whose prompt tpHello reads \$\{word\}/);
    assert.match(msgs, /agentConfId "tpGhostAgent" is not a ai\.agent/);
    assert.match(msgs, /subPlanId "tpGhostPlan"/);
    assert.match(msgs, /allowedSubPlans "tpNope"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

test('runPrompt on ft5: --goal refused up front; a version pin is checked, then sent as content.version', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await fake.gateway.post('/api/v1/admin/prompts', { id: 'tpHello', role: 'user', content: 'x' });
  await assert.rejects(runPrompt(ctx, 'summarize', { goal: true }), /removed in uxopian-ai 2026\.0\.0-ft5/);
  await assert.rejects(runPrompt(ctx, 'tpHello', { version: 7 }), /has no version 7/);
  await assert.rejects(runPrompt(ctx, 'tpHello', { version: true }), /non-negative integer/); // bare --prompt-version
  fake.gateway.post = async (p) => (p === '/api/v1/conversations' ? { id: 'c1' } : null);
  const res = await runPrompt(ctx, 'tpHello', { version: 0 });
  assert.equal(res.answer, 'PONG');
  const sent = fake.calls.find(([m, p]) => m === 'POST' && p === '/api/v1/requests/stream')[2];
  assert.equal(sent.inputs[0].content[0].version, 0);
});

test('runPrompt: a version pin on a pre-ft5 gateway is refused', async () => {
  const fake = fakeGateway({ ft5: false });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await fake.gateway.post('/api/v1/admin/prompts', { id: 'tpHello', role: 'user', content: 'x' });
  await assert.rejects(runPrompt(ctx, 'tpHello', { version: 1 }), /needs prompt versioning/);
});

test('runPlan: polls to COMPLETED, answer = final nodes, expect over every output', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  fake.plans.set('tpP', { id: 'tpP', toolInputParameters: [{ name: 'word' }], nodes: [
    { id: 'a', type: 'AGENT', agentConfId: 'x', outputKey: 'o1' },
    { id: 'b', type: 'AGENT', agentConfId: 'x', outputKey: 'o2', dependencies: ['a'] },
  ] });
  const progress = [];
  const res = await runPlan(ctx, 'tpP', { payload: { word: 'zebra' }, pollMs: 1, expect: /from a/, onProgress: (p) => progress.push(p) });
  assert.equal(res.status, 'COMPLETED');
  assert.equal(res.answer, 'PONG zebra from b'); // only the final node
  assert.equal(res.pass, true);                  // expect matched an intermediate node's output
  assert.equal(res.error, undefined);
  assert.deepEqual(res.nodes.map((n) => [n.id, n.status]), [['a', 'COMPLETED'], ['b', 'COMPLETED']]);
  assert.ok(progress.length >= 1);
});

test('runPlan: submit-time refusal is REJECTED (not thrown); a hung run is STOPPED at the timeout', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  fake.plans.set('tpP', { id: 'tpP', nodes: [{ id: 'a', type: 'AGENT', agentConfId: 'x' }] });
  const rej = await runPlan(ctx, 'tpP', { payload: { word: 'undeclared' }, pollMs: 1, expect: /x/ });
  assert.equal(rej.status, 'REJECTED');
  assert.match(rej.error, /Plan is not executable/);
  assert.equal(rej.pass, false);
  assert.ok(explainError(rej.error), 'the error KB explains it');

  const missing = await runPlan(ctx, 'tpNope', { pollMs: 1 });
  assert.equal(missing.status, 'REJECTED');

  const origPost = fake.gateway.post;
  fake.gateway.post = async (p, b) => {
    const r = await origPost(p, b);
    if (p.endsWith('/run')) fake.execs.get(r.id).hang = true;
    return r;
  };
  const hung = await runPlan(ctx, 'tpP', { pollMs: 1, timeoutMs: 20 });
  assert.equal(hung.status, 'TIMEOUT');
  assert.match(hung.error, /execution stopped/);
  assert.ok([...fake.execs.values()].some((e) => e.stopped), 'the run was stopped server-side');
});

test('runPlan on a pre-ft5 gateway is refused with the version it needs', async () => {
  const fake = fakeGateway({ ft5: false });
  await fake.gateway.post('/api/v1/admin/prompts', { id: 'x', role: 'user', content: 'x' });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await assert.rejects(runPlan(ctx, 'tpP'), /2026\.0\.0-ft5\+/);
});

test('export scrubs agent secret values (placeholders and masks kept)', async () => {
  const dir = scaffold();
  try {
    writeFileSync(join(dir, 'ai/agents/tpHelloAgent.json'), JSON.stringify({
      id: 'tpHelloAgent', objective: 'tpHello',
      secrets: { REAL: { value: 'sk-live-123' }, VAR: { value: '{{uxc:apiKey}}' }, MASKED: { value: '__masked__' } },
    }));
    const { exportPackage } = await import('../lib/packageio.mjs');
    const { unzipTo } = await import('../lib/zip.mjs');
    const out = join(os.tmpdir(), `uxc-ft5-${process.pid}.uxpkg`);
    const pkg = openPackage(dir);
    await exportPackage({ requirePkg: () => pkg, pkg, flags: {}, out: { warn: () => {}, note: () => {}, line: () => {} } }, { output: out, allowDirty: true });
    const bytes = readFileSync(out);
    assert.ok(!bytes.includes(Buffer.from('sk-live-123')), 'the real secret never ships');
    const into = mkdtempSync(join(os.tmpdir(), 'uxc-ft5-unzip-'));
    try {
      await unzipTo(out, into);
      const a = JSON.parse(readFileSync(join(into, 'ai/agents/tpHelloAgent.json'), 'utf8'));
      assert.deepEqual([a.secrets.REAL.value, a.secrets.VAR.value, a.secrets.MASKED.value], ['__masked__', '{{uxc:apiKey}}', '__masked__']);
    } finally { rmSync(into, { recursive: true, force: true }); rmSync(out, { force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prompt adapter template/canonical unchanged for authors: role/temperature normalization still applies', () => {
  const c = canonicalize('ai.prompt', { id: 'x', role: 'USER', temperature: 0, version: 2, usage: {} });
  assert.deepEqual(c, { id: 'x', role: 'user', temperature: '0' });
  assert.equal(prompt.kind, 'ai.prompt');
});

// ---------------------------------------------------------------------------
// Applications, tools, stop (ft5 extras, AI learnings §A15)
// ---------------------------------------------------------------------------

test('ai.application: id = name, 409 on an existing name falls back to a full replace, validate enforces name === id', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await application.create(ctx, { obj: { id: 'tpPortal', provider: 'FlowerDocsProvider' } }); // name filled from the id
  assert.ok(fake.apps.has('tpPortal'));
  await application.create(ctx, { obj: { id: 'tpPortal', name: 'tpPortal', description: 'v2' } });
  assert.equal(fake.apps.get('tpPortal').description, 'v2');
  const echo = await application.readServer(ctx, 'tpPortal');
  assert.equal(hashResource('ai.application', echo.obj), hashResource('ai.application', { id: 'tpPortal', name: 'tpPortal', description: 'v2' }));
  assert.ok(application.validate(null, { id: 'tpPortal' }, { obj: { id: 'tpPortal', name: 'Portal' } }).some((e) => /derives an application's id from its name/.test(e)));
  assert.ok(application.validate(null, { id: 'tpPortal' }, { obj: { maxToolCycles: 0 } }).some((e) => /maxToolCycles/.test(e)));
});

test('ai.prompt remove: a stale application reference (409) is retried; a live one surfaces with guidance', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  const saved = { ...prompt.referenceRetry };
  prompt.referenceRetry.delayMs = 1;
  try {
    await fake.gateway.post('/api/v1/admin/prompts', { id: 'tpHello', role: 'user', content: 'x' });
    fake.ghostRefs.tpHello = ['tpGone']; // the application was just deleted: one stale 409
    await prompt.remove(ctx, 'tpHello');
    assert.ok(!fake.prompts.has('tpHello'));

    await fake.gateway.post('/api/v1/admin/prompts', { id: 'tpHello', role: 'user', content: 'x' });
    fake.apps.set('tpPortal', { id: 'tpPortal', name: 'tpPortal', prompt: 'tpHello' });
    await assert.rejects(prompt.remove(ctx, 'tpHello'), (e) => /referenced by application/.test(e.message) && /repoint the application/.test(e.explanation));
  } finally { Object.assign(prompt.referenceRetry, saved); }
});

test('tool lint: unknown tool names / tags warn (agents, plans, applications); unknown endpoint skips', async () => {
  const fake = fakeGateway({ ft5: true });
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  const w1 = await agent.lintHelpers(ctx, { obj: { permissions: { allowedTools: ['searchDocuments', 'serchDocuments'], allowedToolTags: ['flowerdocs', 'alfrsco'] } } });
  assert.deepEqual(w1.length, 2);
  assert.match(w1.join('\n'), /"serchDocuments" is not a native tool/);
  assert.match(w1.join('\n'), /tool tag "alfrsco"/);
  const w2 = await plan.lintHelpers(ctx, { obj: { nodes: [{ id: 'a', type: 'DIRECT_TOOL', toolName: 'nope' }, { id: 'b', type: 'AGENT', agentConfId: 'x' }] } });
  assert.match(w2.join(), /"nope"/);
  assert.deepEqual(await application.lintHelpers(ctx, { obj: { permissions: { allowedToolTags: ['files'] } } }), []);
  const old = fakeGateway({ ft5: false });
  assert.deepEqual(await agent.lintHelpers({ clients: { gateway: old.gateway } }, { obj: { permissions: { allowedTools: ['x'] } } }), []);
});

test('runPrompt: --application rides as X-Application-Id on the conversation and the stream', async () => {
  const fake = fakeGateway({ ft5: true });
  fake.gateway.post = (orig => async (p, b, opts) => (p === '/api/v1/conversations' ? (fake.calls.push(['HEADERS', p, opts?.headers]), { id: 'c1' }) : orig(p, b, opts)))(fake.gateway.post);
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await runPrompt(ctx, 'tpHello', { application: 'tpPortal' });
  assert.deepEqual(fake.calls.find(([k, p]) => k === 'HEADERS' && p === '/api/v1/conversations')[2], { 'X-Application-Id': 'tpPortal' });
  assert.deepEqual(fake.calls.find(([m, p]) => m === 'POST' && p === '/api/v1/requests/stream')[3], { 'X-Application-Id': 'tpPortal' });
});

test('runPrompt: a stream timeout stops the conversation server-side, then rethrows', async () => {
  const fake = fakeGateway({ ft5: true });
  const post = fake.gateway.post;
  fake.gateway.post = async (p, b, opts) => (p === '/api/v1/conversations' ? { id: 'c9' } : post(p, b, opts));
  fake.hangStream = true;
  const ctx = { flags: {}, target: {}, clients: { gateway: fake.gateway } };
  await assert.rejects(runPrompt(ctx, 'tpHello', { timeoutMs: 5 }), /aborted due to timeout/);
  assert.deepEqual(fake.stopped, ['c9']);
});

test('lintAgentic: an application naming a prompt outside the package warns', () => {
  const dir = scaffold();
  try {
    writeFileSync(join(dir, 'ai/applications/tpPortal.json'), JSON.stringify({ id: 'tpPortal', name: 'tpPortal', prompt: 'tpElsewhere' }));
    assert.match(lintAgentic(openPackage(dir)).map((f) => f.message).join('\n'), /ai\.application\/tpPortal: prompt "tpElsewhere"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uxc versions: served/draft/published rows, = local marker, per-version + aggregate stats', async () => {
  const dir = scaffold();
  try {
    const fake = fakeGateway({ ft5: true });
    const { ctx } = ctxFor(dir, fake);
    await pushResources(ctx, [ctx.requirePkg().entry('ai.prompt', 'tpHello')]);
    const local = JSON.parse(readFileSync(join(dir, 'ai/prompts/tpHello.json'), 'utf8'));
    await fake.gateway.post('/api/v1/admin/prompts/tpHello/versions', { ...local, content: 'draft in the admin UI' });
    fake.gateway.get = (orig => async (p) => (/statistics$/.test(p) ? { nbUsage: 3, goodFeedback: 1, badFeedback: 0, timeSavedInSeconds: 7200 } : orig(p)))(fake.gateway.get);
    fake.gateway.tryGet = (orig => async (p) => (/statistics$/.test(p) ? { nbUsage: 3, goodFeedback: 1, badFeedback: 0, timeSavedInSeconds: 7200 } : orig(p)))(fake.gateway.tryGet);
    const { default: cmd } = await import('../lib/commands/versions.mjs');
    const results = [];
    const lines = [];
    const run = async (gw, flags) => cmd.run({
      args: ['tpHello'], flags: { dir, ...flags }, target: { name: 'fake' }, clients: { gateway: gw }, connect() {},
      out: { json: !!flags.json, result: (r) => results.push(r), table: (rows) => lines.push(rows), line: (l) => lines.push(l), note: (l) => lines.push(l), warn: () => {} },
    });
    await run(fake.gateway, { json: true, stats: true });
    const r = results.at(-1);
    assert.equal(r.served, 0);
    assert.deepEqual(r.versions.map((v) => [v.version, v.state, v.local]), [[1, 'draft', ''], [0, 'served', '= local']]);
    assert.equal(r.versions[1].uses, 3);
    assert.equal(r.versions[1]['saved (h)'], 2);
    assert.equal(r.statistics.nbUsage, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
