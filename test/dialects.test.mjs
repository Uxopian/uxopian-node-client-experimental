// Offline unit tests for lib/dialects.mjs — version detection + capability resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, rangeForVersion, DIALECTS } from '../lib/dialects.mjs';

function ctxWith({ actuator = null, adminList = null, target = {} } = {}) {
  const calls = [];
  return {
    calls,
    target,
    out: { warn: (m) => calls.push(['warn', m]) },
    clients: {
      core: {
        raw: async (m, p) => {
          calls.push(['core.raw', p]);
          if (p === '/actuator/info' && actuator) return { status: 200, json: actuator };
          return { status: 404, json: null };
        },
      },
      gateway: {
        tryGet: async (p) => {
          calls.push(['gw.tryGet', p]);
          if (p === '/api/v1/admin/prompts') {
            if (adminList === 'error') throw new Error('500');
            return adminList;
          }
          return null;
        },
      },
    },
  };
}

test('rangeForVersion: ordered ranges, exclusive max, newest open-ended, oldest guarded', () => {
  assert.equal(rangeForVersion('flowerdocs', '2025.4').name, 'fd-2025');
  assert.equal(rangeForVersion('flowerdocs', '2026.0.0').name, 'fd-2026');
  assert.equal(rangeForVersion('flowerdocs', '2031.9').name, 'fd-2026'); // newest catches future
  assert.throws(() => rangeForVersion('flowerdocs', '2024.9'), /older than the oldest dialect/);
});

test('flowerdocs: actuator/info version -> fd-2026 caps; detection cached per ctx', async () => {
  const ctx = ctxWith({ actuator: { version: '2026.0.0', build: '260612-142837' } });
  const d = await capabilities(ctx, 'flowerdocs');
  assert.equal(d.version, '2026.0.0');
  assert.equal(d.source, 'actuator');
  assert.equal(d.dialect, 'fd-2026');
  assert.equal(d.caps.vfInstanceCreatePath, '/rest/virtualFolder');
  await capabilities(ctx, 'flowerdocs'); // second call: cached
  assert.equal(ctx.calls.filter(([k]) => k === 'core.raw').length, 1);
});

test('flowerdocs: fdVersion override wins over the actuator and picks fd-2025', async () => {
  const ctx = ctxWith({ actuator: { version: '2026.0.0' }, target: { fdVersion: '2025.4' } });
  const d = await capabilities(ctx, 'flowerdocs');
  assert.equal(d.source, 'override');
  assert.equal(d.dialect, 'fd-2025');
  assert.equal(d.caps.vfInstanceCreatePath, '/rest/virtualFolder/'); // trailing-slash form first
  assert.equal(ctx.calls.filter(([k]) => k === 'core.raw').length, 0); // no probe
});

test('flowerdocs: undetectable -> newest dialect + loud warning', async () => {
  const ctx = ctxWith({}); // actuator 404s
  const d = await capabilities(ctx, 'flowerdocs');
  assert.equal(d.version, null);
  assert.equal(d.dialect, 'fd-2026');
  assert.ok(ctx.calls.some(([k, m]) => k === 'warn' && /undetectable/.test(m)));
});

test('uxopian-ai: admin-list fingerprint 200-array -> ai-2026-07 (adminPromptList: true)', async () => {
  const ctx = ctxWith({ adminList: [{ id: 'x' }] });
  const d = await capabilities(ctx, 'uxopian-ai');
  assert.equal(d.source, 'probe');
  assert.equal(d.dialect, 'ai-2026-07');
  assert.equal(d.caps.adminPromptList, true);
  assert.equal(d.caps.promptVersioning, false); // reserved flag stays off until the release lands
});

test('uxopian-ai: admin list erroring (2025-era 500) -> ai-2025 (adminPromptList: false)', async () => {
  const ctx = ctxWith({ adminList: 'error' });
  const d = await capabilities(ctx, 'uxopian-ai');
  assert.equal(d.dialect, 'ai-2025');
  assert.equal(d.caps.adminPromptList, false);
});

test('uxopian-ai: aiVersion override maps through the version ranges (no probe)', async () => {
  const ctx = ctxWith({ target: { aiVersion: '2026.08' } });
  const d = await capabilities(ctx, 'uxopian-ai');
  assert.equal(d.source, 'override');
  assert.equal(d.dialect, 'ai-2026-07'); // 2026.08 falls in the open-ended newest range
  assert.equal(ctx.calls.filter(([k]) => k === 'gw.tryGet').length, 0);
});

test('unknown product throws with the known-product list', async () => {
  await assert.rejects(capabilities(ctxWith({}), 'nope'), /known: flowerdocs, uxopian-ai, fast2/);
});

test('registry hygiene: every product has ordered ranges ending open-ended (or empty future slot)', () => {
  for (const [product, p] of Object.entries(DIALECTS)) {
    if (!p.ranges.length) continue; // fast2 future slot
    for (const r of p.ranges.slice(0, -1)) assert.ok(r.max, `${product}: only the last range may be open-ended`);
    assert.equal(p.ranges[p.ranges.length - 1].max, null, `${product}: last range must be open-ended`);
  }
});
