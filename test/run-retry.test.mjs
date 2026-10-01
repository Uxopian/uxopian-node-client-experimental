// uxc run --plan … --retry (#122) and the --expect JSON tolerance on runs. Offline: a fake
// gateway answers plan-executions/run + polling; each run's per-node outcome is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import runCmd from '../lib/commands/run.mjs';
import {
  runPlan, runPrompt, runsDir, planRunRecord, recordPlanRun, listPlanRuns, findPlanRun, comparePlanRuns,
} from '../lib/run.mjs';

/** ft5-looking gateway; `outcomes` = one {nodeId: {status, out?, err?}} map per submitted run. */
function fakeGateway(outcomes = []) {
  const calls = [];
  const execs = new Map();
  const nodes = [{ id: 'read', type: 'DIRECT_TOOL' }, { id: 'judge', type: 'AGENT', deps: ['read'] }];
  const gateway = {
    tryGet: async (p) => (p === '/api/v1/admin/prompts' ? [{ id: 'x', version: 1 }] : null),
    get: async (p) => {
      calls.push(['GET', p]);
      const ex = execs.get(p.split('/').pop());
      const plan = outcomes[ex.n] ?? {};
      ex.status = Object.values(plan).some((o) => o.status !== 'COMPLETED') ? 'FAILED' : 'COMPLETED';
      for (const ne of ex.nodeExecutions) {
        const o = plan[ne.nodeId] ?? { status: 'COMPLETED', out: `${ne.nodeId} ok` };
        Object.assign(ne, { status: o.status, outputData: o.out ?? null, ...(o.err ? { errorMessage: o.err } : {}) });
      }
      return structuredClone(ex);
    },
    post: async (p, body) => {
      calls.push(['POST', p, body]);
      if (p.endsWith('/run')) {
        const ex = {
          id: `ex${execs.size + 1}`, n: execs.size, status: 'RUNNING',
          nodeExecutions: nodes.map((n) => ({ nodeId: n.id, type: n.type, status: 'RUNNING', dependencies: n.deps ?? [], outputData: null })),
        };
        execs.set(ex.id, ex);
        return structuredClone(ex);
      }
      return null;
    },
  };
  return { gateway, calls };
}

function harness({ flags = {}, pkgDir = null, outcomes = [], gw = null } = {}) {
  const fake = gw ?? fakeGateway(outcomes);
  const lines = [];
  const notes = [];
  const warns = [];
  const results = [];
  const json = !!flags.json;
  const ctx = {
    flags: { ...flags }, args: [],
    target: { name: 'fake' },
    clients: { gateway: fake.gateway },
    connect() {},
    pkg: pkgDir ? { dir: pkgDir } : null,
    out: {
      json,
      line: (...a) => lines.push(a.join(' ')), note: (m) => notes.push(m), warn: (m) => warns.push(m),
      result: (o) => results.push(o),
    },
  };
  return { ctx, fake, lines, notes, warns, results };
}

const tmp = () => mkdtempSync(join(os.tmpdir(), 'uxc-retry-'));

// runPlan's default poll is 2 s; the command does not expose it, so shrink time for the command tests
async function quick(fn) {
  const { setTimeout: orig } = globalThis;
  globalThis.setTimeout = (cb, _ms, ...a) => orig(cb, 0, ...a);
  try { return await fn(); } finally { globalThis.setTimeout = orig; }
}

async function runCommand(h) {
  const prevExit = process.exitCode;
  try {
    await quick(() => runCmd.run(h.ctx));
    return process.exitCode;
  } finally { process.exitCode = prevExit; }
}

test('every --plan run is recorded: planId, executionId, target, payload, per-node outcome', async () => {
  const pkgDir = tmp();
  try {
    const h = harness({ pkgDir, flags: { plan: 'pP', 'payload-json': writeJson(pkgDir, { word: 'zebra', ids: ['a', 'b'] }) } });
    await runCommand(h);
    const recs = listPlanRuns(runsDir(pkgDir));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].path.startsWith(join(pkgDir, '.uxc', 'runs')), true);
    assert.equal(recs[0].planId, 'pP');
    assert.equal(recs[0].executionId, 'ex1');
    assert.equal(recs[0].target, 'fake');
    assert.deepEqual(recs[0].payload, { word: 'zebra', ids: ['a', 'b'] });
    assert.deepEqual(recs[0].nodes.map((n) => [n.id, n.status]), [['read', 'COMPLETED'], ['judge', 'COMPLETED']]);
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

function writeJson(dir, obj) {
  const p = join(dir, 'payload.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('--retry re-runs with the SAME payload as the last run and prints both runs node by node', async () => {
  const pkgDir = tmp();
  try {
    const outcomes = [
      { judge: { status: 'FAILED', err: 'java.lang.reflect.UndeclaredThrowableException' } },
      { judge: { status: 'COMPLETED', out: 'verdict OK' } },
    ];
    const fake = fakeGateway(outcomes);
    const first = harness({ gw: fake, pkgDir, flags: { plan: 'pP', 'payload-json': writeJson(pkgDir, { classId: 'CtContract', n: 15 }) } });
    assert.equal(await runCommand(first), 1, 'the failed first run exits 1');

    const h = harness({ gw: fake, pkgDir, flags: { plan: 'pP', retry: true } });
    assert.notEqual(await runCommand(h), 1);
    const submits = fake.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/run'));
    assert.equal(submits.length, 2);
    assert.deepEqual(submits[1][2], { planId: 'pP', inputPayload: { classId: 'CtContract', n: 15 } }, 'same payload replayed');
    assert.ok(h.notes.some((n) => /retry of execution ex1 .*FULL re-run.*no per-node re-run/.test(n)), h.notes.join('\n'));
    const row = h.lines.find((l) => /^\s+judge\s/.test(l));
    assert.match(row, /judge\s+AGENT\s+FAILED\s+COMPLETED\s+verdict OK/);
    assert.ok(h.lines.some((l) => /previous: FAILED \(ex1\)\s+->\s+this run: COMPLETED/.test(l)));

    const recs = listPlanRuns(runsDir(pkgDir), { planId: 'pP' });
    assert.equal(recs.length, 2);
    assert.equal(recs[1].retryOf, 'ex1');
    assert.deepEqual(recs[1].payload, recs[0].payload);
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

test('--retry <executionId> picks that run; --json carries the side-by-side comparison', async () => {
  const pkgDir = tmp();
  try {
    const fake = fakeGateway([{}, {}, {}]);
    await runCommand(harness({ gw: fake, pkgDir, flags: { plan: 'pP', 'payload-json': writeJson(pkgDir, { k: 'one' }) } }));
    await runCommand(harness({ gw: fake, pkgDir, flags: { plan: 'pP', 'payload-json': writeJson(pkgDir, { k: 'two' }) } }));
    const h = harness({ gw: fake, pkgDir, flags: { plan: 'pP', retry: 'ex1', json: true } });
    await runCommand(h);
    const last = fake.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/run')).at(-1);
    assert.deepEqual(last[2].inputPayload, { k: 'one' }, 'the named execution, not the newest');
    const r = h.results[0];
    assert.equal(r.retry.of, 'ex1');
    assert.equal(r.retry.mode, 'full-rerun');
    assert.deepEqual(r.retry.nodes.map((n) => [n.id, n.before.status, n.after.status]), [['read', 'COMPLETED', 'COMPLETED'], ['judge', 'COMPLETED', 'COMPLETED']]);
    assert.ok(r.recorded && r.recorded.includes(join('.uxc', 'runs')));
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

test('outside a package the records go under UXC_HOME (~/.uxopian/runs)', async () => {
  const home = tmp();
  const prev = process.env.UXC_HOME;
  process.env.UXC_HOME = home;
  try {
    assert.equal(runsDir(), join(home, '.uxopian', 'runs'));
    const h = harness({ flags: { plan: 'pH', dir: join(home, 'no-such-package') } });
    await runCommand(h);
    assert.equal(readdirSync(join(home, '.uxopian', 'runs')).length, 1);
  } finally {
    if (prev === undefined) delete process.env.UXC_HOME; else process.env.UXC_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

/** fail() exits the process: trap it and keep the message. */
async function expectFail(h, re) {
  const origExit = process.exit;
  const origErr = console.error;
  const errs = [];
  process.exit = (c) => { throw new Error(`exit ${c}`); };
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await assert.rejects(quick(() => runCmd.run(h.ctx)), /exit 2/);
  } finally { process.exit = origExit; console.error = origErr; }
  assert.match(errs.join('\n'), re);
}

test('--retry with no recorded run is a clear error, before anything is submitted', async () => {
  const pkgDir = tmp();
  try {
    const h = harness({ pkgDir, flags: { plan: 'pNever', retry: true } });
    await expectFail(h, /no previous run of plan pNever on target fake recorded in .*\.uxc[/\\]runs — run it once first: uxc run --plan pNever/);
    assert.equal(h.fake.calls.length, 0);
    const h2 = harness({ pkgDir, flags: { plan: 'pNever', retry: 'ex404' } });
    await expectFail(h2, /no recorded run with execution id ex404/);
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

test('--retry refuses a new payload, and is a --plan flag only', async () => {
  const pkgDir = tmp();
  try {
    await expectFail(harness({ pkgDir, flags: { plan: 'pP', retry: true, 'payload-json': 'x.json' } }), /--retry replays the recorded payload/);
    const h = harness({ pkgDir, flags: { retry: true } });
    h.ctx.args = ['somePrompt'];
    await expectFail(h, /--retry applies to a plan run/);
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

test('findPlanRun: newest per plan+target, other targets named; execution of another plan refused', () => {
  const dir = tmp();
  try {
    const mk = (planId, executionId, target, iso) => recordPlanRun(dir, planRunRecord(planId, { executionId, status: 'COMPLETED', nodes: [] }, { payload: { executionId }, target, now: new Date(iso) }));
    mk('pA', 'e1', 't1', '2026-10-01T10:00:00Z');
    mk('pA', 'e2', 't1', '2026-10-01T11:00:00Z');
    mk('pA', 'e3', 't2', '2026-10-01T12:00:00Z');
    mk('pB', 'e4', 't1', '2026-10-01T13:00:00Z');
    assert.equal(findPlanRun(dir, 'pA', { target: 't1' }).executionId, 'e2');
    assert.equal(findPlanRun(dir, 'pA', { target: 't2' }).executionId, 'e3');
    assert.throws(() => findPlanRun(dir, 'pA', { target: 't9' }), /on other targets: t1, t2/);
    assert.throws(() => findPlanRun(dir, 'pA', { executionId: 'e4' }), /is a run of plan pB, not pA/);
    // two records in the same millisecond do not overwrite each other
    mk('pA', 'e2', 't1', '2026-10-01T11:00:00Z');
    assert.equal(listPlanRuns(dir, { planId: 'pA' }).length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('comparePlanRuns: union of nodes, next order first, missing side = null', () => {
  const rows = comparePlanRuns(
    { nodes: [{ id: 'a', status: 'COMPLETED', output: 'x' }, { id: 'gone', status: 'FAILED', error: 'boom' }] },
    { nodes: [{ id: 'new', status: 'COMPLETED', output: 'n' }, { id: 'a', status: 'COMPLETED', output: 'y' }] },
  );
  assert.deepEqual(rows.map((r) => [r.id, r.before?.status ?? null, r.after?.status ?? null]), [['new', null, 'COMPLETED'], ['a', 'COMPLETED', 'COMPLETED'], ['gone', 'FAILED', null]]);
  assert.equal(rows[2].before.error, 'boom');
});

test('--expect on a plan: a fenced/single-quoted node output passes a JSON content check, and says it was repaired', async () => {
  const fake = fakeGateway([{ judge: { status: 'COMPLETED', out: "Here is the verdict:\n```json\n{'risk': 'HIGH', 'ids': ['d1',],}\n```" } }]);
  const res = await runPlan({ clients: { gateway: fake.gateway } }, 'pP', { pollMs: 1, expect: /"risk":"HIGH"/ });
  assert.equal(res.pass, true);
  assert.equal(res.expectVia, 'json-repaired');
  assert.equal(res.expectNode, 'judge');
  assert.ok(res.repaired.includes('unwrapped a ```json fenced block'));
  // content still decides: a wrong value fails
  const fake2 = fakeGateway([{ judge: { status: 'COMPLETED', out: "```json\n{'risk': 'LOW'}\n```" } }]);
  const bad = await runPlan({ clients: { gateway: fake2.gateway } }, 'pP', { pollMs: 1, expect: /"risk":"HIGH"/ });
  assert.equal(bad.pass, false);
  assert.equal(bad.expectVia, undefined);
});

test('--expect on a plan via the command prints PASS and the repair note', async () => {
  const pkgDir = tmp();
  try {
    const h = harness({ pkgDir, outcomes: [{ judge: { status: 'COMPLETED', out: 'Sure! {"risk": "HIGH",}' } }], flags: { plan: 'pP', expect: '"risk":"HIGH"' } });
    assert.notEqual(await runCommand(h), 1);
    assert.ok(h.lines.includes('PASS'));
    assert.ok(h.notes.some((n) => /matched after repairing the JSON \(node judge\): .*trailing commas/.test(n)), h.notes.join('\n'));
  } finally { rmSync(pkgDir, { recursive: true, force: true }); }
});

test('--expect on a prompt run: fenced output passes; a raw-text match stays plain', async () => {
  const gw = (text) => ({
    post: async () => ({ id: 1 }),
    req: async () => ({ text }),
  });
  const fenced = await runPrompt({ clients: { gateway: gw('data: {"content":"```json\\n{\\u201Cscore\\u201D: 7}\\n```"}\n') } }, 'p', { expect: /"score":7/ });
  assert.equal(fenced.pass, true);
  assert.equal(fenced.expectVia, 'json-repaired');
  assert.ok(fenced.repaired.includes('smart quotes as string delimiters'));
  const plain = await runPrompt({ clients: { gateway: gw('data: {"content":"score 7"}\n') } }, 'p', { expect: /score 7/ });
  assert.equal(plain.pass, true);
  assert.equal(plain.expectVia, undefined);
});

test('record keeps outputs short (the trace can be megabytes)', () => {
  const rec = planRunRecord('p', { executionId: 'e', status: 'COMPLETED', nodes: [{ id: 'a', status: 'COMPLETED', output: 'x'.repeat(5000) }] }, { payload: {} });
  assert.ok(rec.nodes[0].output.length <= 501);

});
