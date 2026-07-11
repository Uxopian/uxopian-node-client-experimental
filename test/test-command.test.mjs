// Offline tests for `uxc test` (lib/commands/test.mjs): discovery order, name filters, skip on
// unmet requires, timeout, teardown-always, green-run receipt stamp, exit code, safety gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import cmd from '../lib/commands/test.mjs';

function scaffold({ tests = {} } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-testcmd-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({
    code: 'tp', name: 'test pkg', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'],
  }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const [file, body] of Object.entries(tests)) writeFileSync(join(dir, 'tests', file), body);
  return dir;
}

function cmdCtx(dir, { args = [], flags = {}, docs = {} } = {}) {
  const rec = { lines: [], warns: [], results: [], deleted: [] };
  const core = {
    getDoc: async (id) => docs[id] ?? null,
    getOne: async () => null,
    upsertDoc: async (doc) => ({ action: 'created', id: doc.id }),
    del: async (path) => { rec.deleted.push(path); return {}; },
    put: async () => ({}),
    post: async () => ({}),
    search: async () => ({ found: 0, results: [] }),
  };
  const clients = { core, gateway: { get: async () => [] }, gui: {} };
  const ctx = {
    args, flags,
    out: {
      json: !!flags.json,
      line: (...p) => rec.lines.push(p.join(' ')),
      note: (m) => rec.lines.push(m),
      warn: (m) => rec.warns.push(m),
      table: () => {},
      result: (o) => rec.results.push(o),
    },
    pkg: null,
    requirePkg() { ctx.pkg ??= openPackage(dir); return ctx.pkg; },
    target: null, clients: null,
    connect() { ctx.target = { name: 'mock', scope: 'S', allowTests: true }; ctx.clients = clients; return clients; },
  };
  return { ctx, rec };
}

const PASS = `export default { name: 'alpha works', run: async (t) => {
  const d = await t.doc.create({ classId: 'X' });
  t.expect(d.id.startsWith('ZZTEST_TP_'), 'namespaced');
} };\n`;
const SKIPPED = `export default { name: 'needs config doc', requires: { docs: ['NOPE_CFG'] }, run: async () => {} };\n`;
const FAILS = `export default { name: 'beta breaks', run: async (t) => { t.doc.create; t.fail('deliberate'); } };\n`;
const HANGS = `export default { name: 'gamma hangs', timeoutMs: 150, run: () => new Promise(() => {}) };\n`;
const TRACKS_THEN_FAILS = `export default { name: 'delta tracked', run: async (t) => {
  await t.doc.create({ classId: 'X', name: 'fixture' });
  t.fail('after create');
} };\n`;

test('runner: filename order, skip with reason, green stamp attempt, json result', async () => {
  const dir = scaffold({ tests: { '20-skip.test.mjs': SKIPPED, '10-pass.test.mjs': PASS } });
  const { ctx, rec } = cmdCtx(dir, { flags: { json: true, yes: true } });
  try {
    await cmd.run(ctx);
    const res = rec.results[0];
    assert.deepEqual(res.tests.map((t) => t.file), ['10-pass.test.mjs', '20-skip.test.mjs']); // filename order
    assert.equal(res.tests[0].status, 'pass');
    assert.equal(res.tests[1].status, 'skip');
    assert.match(res.tests[1].detail, /NOPE_CFG/);
    assert.equal(res.passed, 1);
    assert.equal(res.failed, 0);
    // green run -> stamp attempted; no receipts on the mock -> both surfaces report ok:false
    assert.ok(Array.isArray(res.stamped));
    assert.ok(res.stamped.every((s) => s.ok === false));
    assert.equal(process.exitCode ?? 0, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; }
});

test('runner: failure + timeout set exit code 1; teardown runs even after a failure', async () => {
  const dir = scaffold({ tests: { '10-fail.test.mjs': FAILS, '20-hang.test.mjs': HANGS, '30-tracked.test.mjs': TRACKS_THEN_FAILS } });
  const { ctx, rec } = cmdCtx(dir, { flags: { json: true, yes: true } });
  try {
    await cmd.run(ctx);
    const res = rec.results[0];
    assert.equal(res.failed, 3);
    assert.match(res.tests[0].detail, /deliberate/);
    assert.match(res.tests[1].detail, /timeout after/);
    assert.equal(process.exitCode, 1);
    // the fixture created before the deliberate failure was still deleted
    assert.ok(rec.deleted.some((p) => p.includes('ZZTEST_TP_')), `teardown ran: ${rec.deleted}`);
    // no green stamp on a red run
    assert.equal(res.stamped, null);
  } finally { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; }
});

test('runner: name filters select by substring; --list needs no gate/connect; load error = failure', async () => {
  const dir = scaffold({ tests: { '10-pass.test.mjs': PASS, '20-broken.test.mjs': 'export default { nope: true };\n', '30-syntax.test.mjs': 'this is not js (' } });
  {
    const { ctx, rec } = cmdCtx(dir, { args: ['alpha'], flags: { json: true, yes: true } });
    await cmd.run(ctx);
    assert.deepEqual(rec.results[0].tests.map((t) => t.file), ['10-pass.test.mjs']);
  }
  {
    const { ctx, rec } = cmdCtx(dir, { flags: { json: true, list: true } });
    await cmd.run(ctx); // no connect() needed for --list
    assert.equal(ctx.target, null);
    assert.equal(rec.results[0].tests.length, 3);
    assert.match(rec.results[0].tests[1].loadError, /must default-export/);
    assert.match(rec.results[0].tests[2].loadError, /does not load/);
  }
  {
    const { ctx, rec } = cmdCtx(dir, { flags: { json: true, yes: true } });
    try {
      await cmd.run(ctx);
      assert.equal(rec.results[0].failed, 2); // both broken files are failures, not silence
    } finally { process.exitCode = 0; }
  }
  rmSync(dir, { recursive: true, force: true });
});

test('safety gate: refuses without allowTests/--yes (subprocess: exit 2, message names the opt-ins)', () => {
  const dir = scaffold({ tests: { '10-pass.test.mjs': PASS } });
  const uxc = resolve('bin/uxc.mjs');
  try {
    execFileSync(process.execPath, [uxc, 'test', '--dir', dir], {
      env: {
        ...process.env,
        UXC_URL: 'http://127.0.0.1:1', UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p',
        UXC_ALLOW_TESTS: '', UXC_TARGET: '',
      },
      stdio: 'pipe',
    });
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.equal(e.status, 2);
    assert.match(String(e.stderr), /allowTests|--yes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
