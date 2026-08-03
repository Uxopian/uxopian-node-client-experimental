// Subprocess tests for the bin/uxc.mjs dispatcher (issue #61) — hermetic (HOME=tmpdir,
// env-only target pointing at a CLOSED port so nothing real is ever contacted):
//  - per-command --help never runs the command (works outside any package/target, exit 0)
//  - a package-requiring command outside a package still errors with the same message + exit 2
//  - doctor --ready outside a package must NOT die with exit 2 (the requirePkg hard-exit bug):
//    it runs the checklist and exits 1 on check failures
//  - target add warns when gui/ai bases are DERIVED from the core host (split-port hazard)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';

const UXC = resolve('bin/uxc.mjs');

/** Run uxc in a hermetic tmp dir; returns { status, stdout, stderr } (stderr also on success). */
function uxc(args, { env = {} } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-cli-'));
  try {
    const r = spawnSync(process.execPath, [UXC, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir, // never read the developer's real ~/.uxopian/targets.json
        UXC_TARGET: '', UXC_URL: '', UXC_CORE_URL: '', UXC_AI_URL: '', UXC_GUI_URL: '',
        UXC_SCOPE: '', UXC_USER: '', UXC_PASSWORD: '',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// env-only target on a CLOSED port: resolves, every request fails instantly (nothing contacted)
const DEAD_TARGET = {
  UXC_URL: 'http://127.0.0.1:1', UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p',
};

test('uxc <cmd> --help prints usage without running the command (no package, no target; exit 0)', () => {
  for (const args of [['push', '--help'], ['status', '--help'], ['doctor', '--help'], ['run', '-h']]) {
    const r = uxc(args);
    assert.equal(r.status, 0, `${args.join(' ')} -> ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`uxc ${args[0]}`), `${args.join(' ')} shows its usage`);
  }
});

test('uxc <two-word> --help prints the family usage line (exit 0)', () => {
  const r = uxc(['target', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /uxc target <subcommand>/);
});

test('package-requiring command outside a package: same message, exit 2 (requirePkg now throws)', () => {
  const r = uxc(['push', 'someid'], { env: DEAD_TARGET });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no uxopian package here/);
});

test('doctor --ready outside a package: runs the checklist, exits 1 on failures — NEVER 2', () => {
  const r = uxc(['doctor', '--ready'], { env: DEAD_TARGET });
  assert.equal(r.status, 1, `stderr: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /no uxopian package here/);
  assert.match(r.stdout, /READINESS/);
});

test('target add warns when gui/ai are DERIVED from the core host; silent when explicit', () => {
  const base = ['target', 'add', 't1', '--core', 'http://h:8080/core', '--scope', 'S', '--user', 'u', '--password', 'p'];
  const derived = uxc(base);
  assert.equal(derived.status, 0);
  assert.match(derived.stderr, /gui .* DERIVED/);
  assert.match(derived.stderr, /ai gateway .* DERIVED/);

  const explicit = uxc([...base, '--gui', 'http://h:9090/gui', '--ai', 'http://h:9091/gateway/uxopian-ai']);
  assert.equal(explicit.status, 0);
  assert.doesNotMatch(explicit.stderr, /DERIVED/);
});
