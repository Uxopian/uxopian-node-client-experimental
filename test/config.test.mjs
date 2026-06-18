// Offline unit tests for resolveTarget — the two-base (core + uxopian-ai) model and the legacy
// host shorthand. Driven purely by env (an unknown target name => empty base => no file mutation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../lib/config.mjs';

const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER', 'UXC_PASSWORD'];
const NOPE = 'zzz-nonexistent-target'; // unknown name => base {} => resolution is pure-env

function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('explicit core + ai: used verbatim (trimmed); host + gui derived from core', () => {
  withEnv({
    UXC_CORE_URL: 'https://h.example/core',
    UXC_AI_URL: 'https://h.example/gui/plugins/X/gateway/uxopian-ai/',
    UXC_SCOPE: 'X', UXC_USER: 'u', UXC_PASSWORD: 'p',
  }, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.core, 'https://h.example/core');
    assert.equal(t.gateway, 'https://h.example/gui/plugins/X/gateway/uxopian-ai'); // trailing slash trimmed
    assert.equal(t.ai, t.gateway);
    assert.equal(t.url, 'https://h.example');     // host = core minus /core
    assert.equal(t.gui, 'https://h.example/gui'); // derived from host
  });
});

test('legacy --url host derives core, gui, gateway from url + scope', () => {
  withEnv({ UXC_URL: 'https://h.example/', UXC_SCOPE: 'IRIS', UXC_USER: 'system', UXC_PASSWORD: 'p' }, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.core, 'https://h.example/core');
    assert.equal(t.gui, 'https://h.example/gui');
    assert.equal(t.gateway, 'https://h.example/gui/plugins/IRIS/gateway/uxopian-ai');
  });
});

test('core-only + scope: gateway + gui derived from the host implied by core', () => {
  withEnv({ UXC_CORE_URL: 'https://h.example/core', UXC_SCOPE: 'IRIS', UXC_USER: 'u', UXC_PASSWORD: 'p' }, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.gateway, 'https://h.example/gui/plugins/IRIS/gateway/uxopian-ai');
    assert.equal(t.gui, 'https://h.example/gui');
  });
});

test('explicit ai overrides derivation; explicit gui honored', () => {
  withEnv({
    UXC_URL: 'https://h.example', UXC_AI_URL: 'https://ai.example/uxopian-ai',
    UXC_GUI_URL: 'https://gui.example', UXC_SCOPE: 'X', UXC_USER: 'u', UXC_PASSWORD: 'p',
  }, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.gateway, 'https://ai.example/uxopian-ai');
    assert.equal(t.gui, 'https://gui.example');
    assert.equal(t.core, 'https://h.example/core');
  });
});

test('incomplete target throws with guidance', () => {
  withEnv({ UXC_SCOPE: 'X', UXC_USER: 'u', UXC_PASSWORD: 'p' }, () => {
    assert.throws(() => resolveTarget(NOPE), /incomplete[\s\S]*core URL[\s\S]*uxopian-ai URL/);
  });
});
