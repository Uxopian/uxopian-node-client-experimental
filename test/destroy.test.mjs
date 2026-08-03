// Offline tests for `uxc destroy` — the createOnly delete gate (issue #61):
// destroy must honor the same gate rm --server / prune honor (§14 taskclass hazard):
// createOnly entries are KEPT (and printed) unless --force. Dry-run only — no server needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import cmd from '../lib/commands/destroy.mjs';

function scaffold(resources) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-destroy-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({
    code: 'tp', name: 'test pkg', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'],
  }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources }));
  return dir;
}

function ctxFor(dir, flags) {
  const rec = { lines: [], warns: [], results: [] };
  const ctx = {
    args: [], flags,
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
    connect() { throw new Error('dry-run must not connect'); },
  };
  return { ctx, rec };
}

const RESOURCES = [
  { kind: 'fd.script', id: 'tp-widgets', path: 'scripts/tp-widgets.js', policy: 'managed' },
  { kind: 'fd.taskclass', id: 'TpApproval', path: 'classes/TpApproval.json', policy: 'createOnly' },
  { kind: 'fd.acl', id: 'TpShared', path: 'acl/TpShared.json', policy: 'external' },
];

test('destroy --dry-run keeps createOnly entries (printed as kept) and skips external', async () => {
  const dir = scaffold(RESOURCES);
  try {
    const { ctx, rec } = ctxFor(dir, { 'dry-run': true });
    await cmd.run(ctx);
    const steps = rec.results[0];
    assert.ok(steps.some((s) => s.op === 'delete' && s.id === 'tp-widgets'), 'managed resource is in the kill list');
    assert.ok(!steps.some((s) => s.id === 'TpApproval'), 'createOnly resource is NOT in the kill list');
    assert.ok(!steps.some((s) => s.id === 'TpShared'), 'external resource is NOT in the kill list');
    assert.ok(rec.lines.some((l) => /kept\s+fd\.taskclass\/TpApproval/.test(l)), 'kept line names the gated resource');
    assert.ok(rec.lines.some((l) => /--force/.test(l)), 'output mentions the --force override');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('destroy --dry-run --force includes createOnly entries (external still excluded)', async () => {
  const dir = scaffold(RESOURCES);
  try {
    const { ctx, rec } = ctxFor(dir, { 'dry-run': true, force: true });
    await cmd.run(ctx);
    const steps = rec.results[0];
    assert.ok(steps.some((s) => s.op === 'delete' && s.id === 'TpApproval'), 'createOnly deleted with --force');
    assert.ok(!steps.some((s) => s.id === 'TpShared'), 'external never deleted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('destroy with ONLY createOnly resources left: says so and touches nothing', async () => {
  const dir = scaffold([RESOURCES[1]]);
  try {
    const { ctx, rec } = ctxFor(dir, { 'dry-run': true });
    await cmd.run(ctx);
    assert.deepEqual(rec.results[0], []);
    assert.ok(rec.lines.some((l) => /only createOnly-gated resources remain/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
