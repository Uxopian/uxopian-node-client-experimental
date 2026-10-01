// #110 — an unpinned package never silently WRITES to the global default target; verify --offline
// creates no client; doctor's default run is read-only; unknown flags are warned about.
// Hermetic: HOME/UXC_HOME are tmp dirs, every target points at a CLOSED port, and no test needs a
// server — a refusal is proven by its text and its exit code, before any request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { firstContactGuard } from '../lib/agent.mjs';
import { hasTargetState } from '../lib/session.mjs';
import { LOCK_MODES, doctorLockMode, unknownFlags, flagsReadBy, flagsInHelp, applyFlagAliases } from '../lib/cli-meta.mjs';
import { openPackage } from '../lib/registry.mjs';
import verify from '../lib/commands/verify.mjs';
import doctor from '../lib/commands/doctor.mjs';
import { FLAGS as COMPLETION_FLAGS } from '../lib/commands/completion.mjs';

const UXC = resolve('bin/uxc.mjs');
const DEAD = 'http://127.0.0.1:1';

/** A tmp HOME with a targets.json whose DEFAULT is "globalbox", and a package dir inside it. */
function sandbox({ manifest = {}, files = {}, targetsDefault = 'globalbox' } = {}) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-110-'));
  const dir = join(home, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'po', name: 'P', ...manifest }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const t = { url: DEAD, scope: 'S', user: 'u', password: 'p' };
  mkdirSync(join(home, '.uxopian'), { recursive: true });
  writeFileSync(join(home, '.uxopian', 'targets.json'), JSON.stringify({ default: targetsDefault, targets: { globalbox: t, other: t } }));
  return { home, dir };
}

function run(sb, args, env = {}) {
  const r = spawnSync(process.execPath, [UXC, ...args], {
    cwd: sb.dir,
    env: {
      ...process.env, UXC_AGENT: '0', UXC_HOME: sb.home, HOME: sb.home, USERPROFILE: sb.home,
      UXC_TARGET: '', UXC_URL: '', UXC_CORE_URL: '', UXC_AI_URL: '', UXC_GUI_URL: '',
      UXC_SCOPE: '', UXC_USER: '', UXC_PASSWORD: '', ...env,
    },
    encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function withSandbox(opts, fn) {
  const sb = sandbox(opts);
  const clean = () => rmSync(sb.home, { recursive: true, force: true });
  let r;
  try { r = fn(sb); } catch (e) { clean(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(clean);
  clean();
  return r;
}

// ---- 1. first-contact guard ----

test('firstContactGuard: refuses only an unpinned, stateless, global-default WRITE; notes the READ', () => {
  const base = { inPackage: true, pin: null, source: 'global', target: 'globalbox', hasState: false };
  const w = firstContactGuard({ ...base, mode: 'write' });
  assert.match(w.refuse, /pins no target and has never been used with "globalbox"/);
  assert.match(w.refuse, /--target globalbox/);
  assert.match(w.refuse, /\.uxc\/target/);
  const r = firstContactGuard({ ...base, mode: 'read' });
  assert.equal(r.refuse, null);
  assert.match(r.note, /"globalbox" from the global default/);
  assert.deepEqual(firstContactGuard({ ...base, mode: 'none' }), { refuse: null, note: null });
  for (const pass of [{ pin: 'x' }, { source: 'flag' }, { source: 'env' }, { hasState: true }, { inPackage: false }, { target: null }]) {
    assert.deepEqual(firstContactGuard({ ...base, ...pass, mode: 'write' }), { refuse: null, note: null }, JSON.stringify(pass));
  }
});

test('hasTargetState reads .uxc/state.json targets[name], leniently', () => {
  withSandbox({ files: { '.uxc/state.json': JSON.stringify({ targets: { globalbox: { resources: {} } } }) } }, (sb) => {
    assert.equal(hasTargetState(sb.dir, 'globalbox'), true);
    assert.equal(hasTargetState(sb.dir, 'other'), false);
  });
  withSandbox({ files: { '.uxc/state.json': '{not json' } }, (sb) => assert.equal(hasTargetState(sb.dir, 'globalbox'), false));
  withSandbox({}, (sb) => assert.equal(hasTargetState(sb.dir, 'globalbox'), false));
});

test('a WRITE in an unpinned, stateless package is refused before any request (global default)', () => {
  withSandbox({}, (sb) => {
    const r = run(sb, ['push', '--all']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refused: this package pins no target and has never been used with "globalbox"/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed|unreachable/i, 'refused BEFORE any request');
    // --no-lock skips the lock, never the guard
    assert.match(run(sb, ['push', '--all', '--no-lock']).stderr, /refused: this package pins no target/);
  });
});

test('the guard passes: explicit --target, env target, a pin, or recorded state for that target', () => {
  withSandbox({}, (sb) => {
    assert.doesNotMatch(run(sb, ['push', '--all', '--target', 'globalbox']).stderr, /pins no target/);
    assert.doesNotMatch(run(sb, ['push', '--all'], { UXC_TARGET: 'other' }).stderr, /pins no target/);
  });
  // a URL-defined instance with NO global default to merge onto is an explicit, per-shell choice
  // (with a default, partial URL env merges onto it and stays guarded — see the next test)
  withSandbox({}, (sb) => {
    writeFileSync(join(sb.home, '.uxopian', 'targets.json'), JSON.stringify({ targets: {} }));
    assert.doesNotMatch(run(sb, ['push', '--all'], { UXC_URL: DEAD, UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p' }).stderr, /pins no target/);
  });
  withSandbox({ files: { '.uxc/target': 'globalbox\n' } }, (sb) => assert.doesNotMatch(run(sb, ['push', '--all']).stderr, /pins no target/));
  withSandbox({ manifest: { agent: { target: 'globalbox' } } }, (sb) => assert.doesNotMatch(run(sb, ['push', '--all']).stderr, /pins no target/));
  withSandbox({ files: { '.uxc/state.json': JSON.stringify({ targets: { globalbox: { resources: {} } } }) } },
    (sb) => assert.doesNotMatch(run(sb, ['push', '--all']).stderr, /pins no target/));
  // outside a package: unchanged
  withSandbox({}, (sb) => {
    const r = run({ ...sb, dir: sb.home }, ['cache-clear']);
    assert.doesNotMatch(r.stderr, /pins no target/);
  });
});

test('a READ in an unpinned package runs, with ONE stderr note (stdout untouched, JSON mode too)', () => {
  withSandbox({}, (sb) => {
    const r = run(sb, ['status', '--json']);
    assert.doesNotMatch(r.stderr, /refused/);
    assert.equal(r.stderr.match(/from the global default/g)?.length, 1, r.stderr);
    assert.doesNotMatch(r.stdout, /global default/);
  });
});

// ---- 2. verify --offline ----

test('verify --offline: lock none (and --static is its alias); online verify stays a read', () => {
  assert.equal(verify.lock({ offline: true }), 'none');
  assert.equal(verify.lock(applyFlagAliases('verify', { static: true })), 'none');
  assert.equal(verify.lock({}), 'read');
});

test('verify --offline runs the offline lints and never connects', async () => {
  await withSandbox({
    manifest: { dependencies: { 'case-management': '^1.0.0' } },
  }, async (sb) => {
    const pkg = openPackage(sb.dir);
    let connects = 0;
    const lines = [];
    const prev = process.exitCode;
    const ctx = {
      args: [], flags: { offline: true }, pkg,
      requirePkg: () => pkg,
      connect() { connects++; throw new Error('connect() must not be called offline'); },
      get clients() { throw new Error('no client exists offline'); },
      out: { line: (m) => lines.push(m), warn: () => {}, note: () => {}, result: (r) => lines.push(r), json: false },
    };
    try {
      await verify.run(ctx);
    } finally { process.exitCode = prev; }
    assert.equal(connects, 0);
    assert.ok(lines.some((l) => typeof l === 'string' && /verify --offline: .*offline lints only/.test(l)), lines.join('\n'));
    assert.equal(lines.find((l) => typeof l === 'object').offline, true);
  });
});

test('uxc verify --offline needs no target at all (subprocess, no targets.json default)', () => {
  withSandbox({ targetsDefault: null }, (sb) => {
    const r = run(sb, ['verify', '--offline']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verify --offline: 0 resources/);
    const online = run(sb, ['verify']);
    assert.equal(online.status, 2);
    assert.match(online.stderr, /uxc verify --offline/, 'no target: the offline mode is suggested');
  });
});

// ---- 3. doctor ----

test('doctor lock mode: read by default, write only with a probe that changes the instance', () => {
  assert.equal(LOCK_MODES.doctor, doctorLockMode);
  assert.equal(doctorLockMode({}), 'read');
  assert.equal(doctorLockMode({ ready: true, dups: true, f2: true }), 'read');
  for (const f of ['write-probes', 'roundtrip', 'sandbox', 'ai-smoke']) assert.equal(doctorLockMode({ [f]: true }), 'write', f);
  assert.match(doctor.help, /--write-probes/);
});

async function doctorCalls(flags) {
  const calls = [];
  const res = { status: 200, text: '' };
  const clients = {
    auth: async () => {},
    gateway: { get: async () => [] },
    core: { get: async () => [], getOne: async () => null },
    gui: { raw: async (m, p) => { calls.push(`${m} ${p}`); return res; } },
  };
  const ctx = {
    args: [], flags, clients, target: { user: 'u', scope: 'S', core: DEAD, gateway: DEAD, name: 'fake' },
    connect() { return clients; },
    out: { line: () => {}, warn: () => {}, note: () => {}, result: () => {}, json: false },
  };
  const prev = process.exitCode;
  try { await doctor.run(ctx); } finally { process.exitCode = prev; }
  return calls;
}

test('doctor: the default run never sends DELETE /gui/rest/caches; --write-probes does', async () => {
  const def = await doctorCalls({});
  assert.ok(def.includes('GET /rest/caches'));
  assert.ok(!def.some((c) => c.startsWith('DELETE')), def.join(', '));
  const w = await doctorCalls({ 'write-probes': true });
  assert.ok(w.includes('DELETE /rest/caches'));
});

// ---- 4. unknown flags ----

const LIB = resolve('lib');
const helper = () => {
  const s = new Set();
  for (const sub of ['', 'kinds']) {
    for (const n of readdirSync(join(LIB, sub)).filter((x) => x.endsWith('.mjs'))) for (const f of flagsReadBy(readFileSync(join(LIB, sub, n), 'utf8'))) s.add(f);
  }
  return s;
};

test('unknownFlags: names a flag the command does not read; globals, help, aliases, --ignore-* pass', () => {
  const src = flagsReadBy(readFileSync(join(LIB, 'commands', 'doctor.mjs'), 'utf8'));
  assert.deepEqual(unknownFlags('doctor', doctor, { offline: true, json: true, target: 'x' }, { srcFlags: src, helperFlags: helper }), ['offline']);
  assert.deepEqual(unknownFlags('verify', verify, { offline: true, full: true, 'no-lock': true }, { srcFlags: new Set() }), []);
  assert.deepEqual(unknownFlags('push', { summary: '', help: 'uxc push [--ignore-*]' }, { 'ignore-dependencies': true }), []);
  assert.deepEqual(flagsInHelp('a --x [--ignore-*]').prefixes, ['ignore-']);
});

test('every flag shell completion offers is known to its command (no false warnings)', async () => {
  const h = helper();
  const problems = [];
  for (const [cmd, list] of Object.entries(COMPLETION_FLAGS)) {
    const mn = cmd.replace(' ', '-');
    const mod = (await import(`../lib/commands/${mn}.mjs`)).default;
    const flags = Object.fromEntries(list.filter((f) => f.startsWith('--')).map((f) => [f.slice(2), true]));
    const u = unknownFlags(mn, mod, flags, { srcFlags: flagsReadBy(readFileSync(join(LIB, 'commands', `${mn}.mjs`), 'utf8')), helperFlags: () => h });
    if (u.length) problems.push(`${cmd}: ${u.join(' ')}`);
  }
  assert.deepEqual(problems, []);
});

test('uxc doctor --offline warns "unknown flag --offline for doctor" on stderr (never a silent drop)', () => {
  withSandbox({ targetsDefault: null }, (sb) => {
    const r = run({ ...sb, dir: sb.home }, ['doctor', '--offline'], { UXC_URL: DEAD, UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p' });
    assert.match(r.stderr, /unknown flag --offline for doctor/);
    assert.doesNotMatch(r.stdout, /unknown flag/);
    const ok = run(sb, ['verify', '--offline', '--full']);
    assert.doesNotMatch(ok.stderr, /unknown flag/);
  });
});

test('a PARTIAL env (UXC_URL / UXC_CORE_URL without UXC_TARGET) over a global default is still the default: writes refused (0.24.1 review)', () => {
  for (const env of [{ UXC_URL: 'http://127.0.0.1:2' }, { UXC_CORE_URL: 'http://127.0.0.1:2/core' }]) {
    withSandbox({}, (sb) => {
      const r = run(sb, ['cache-clear'], env);
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.match(r.stderr + r.stdout, /pins no target and has never been used with "globalbox"/, JSON.stringify(env));
    });
  }
  // UXC_TARGET names the target explicitly: the caller chose it, the guard does not apply
  withSandbox({}, (sb) => {
    const r = run(sb, ['cache-clear'], { UXC_TARGET: 'globalbox' });
    assert.doesNotMatch(r.stderr + r.stdout, /pins no target/);
  });
});
