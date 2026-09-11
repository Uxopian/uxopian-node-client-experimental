// Subprocess tests for the command preamble (lib/session.mjs + lib/agent.mjs): target pin and
// forbidden command shapes (BACKLOG-AGENTIC #3/#12). Hermetic: HOME is a tmp dir and the target
// points at a CLOSED port, so a refusal is proven by the refusal TEXT, never by a network result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';

const UXC = resolve('bin/uxc.mjs');

/** A package dir with the given manifest, run uxc inside it. */
function inPkg(manifest, args, { env = {}, files = {} } = {}) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-session-'));
  const dir = join(home, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'po', name: 'P', ...manifest }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try {
    const r = spawnSync(process.execPath, [UXC, ...args], {
      cwd: dir,
      env: {
        ...process.env, HOME: home,
        UXC_URL: 'http://127.0.0.1:1', UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p',
        UXC_TARGET: 'ambient',
        ...env,
      },
      encoding: 'utf8', timeout: 60_000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('agent.forbid refuses the listed command shape before anything runs', () => {
  const r = inPkg({ agent: { forbid: ['push --changed'] } }, ['push', '--changed']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: "push --changed" is listed in uxopian-project\.json agent\.forbid/);
});

test('a forbid entry does not affect a DIFFERENT shape of the same command', () => {
  const r = inPkg({ agent: { forbid: ['push --changed'] } }, ['push', '--all']);
  assert.doesNotMatch(r.stderr, /agent\.forbid/);
});

test('a pinned target refuses a --target that names another instance', () => {
  const r = inPkg({ agent: { target: 'gfdefault' } }, ['status', '--target', 'iris']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pinned to target "gfdefault"/);
  assert.match(r.stderr, /--target may only CONFIRM the pin/);
});

test('--allow-target-mismatch is the deliberate way out', () => {
  const r = inPkg({ agent: { target: 'gfdefault' } }, ['status', '--target', 'iris', '--allow-target-mismatch']);
  assert.doesNotMatch(r.stderr, /refused/);
  assert.match(r.stderr, /target pin overridden/);
});

test('a WRITE with a differing ambient default is refused and told how to confirm', () => {
  const r = inPkg({ agent: { target: 'gfdefault' } }, ['push', '--all']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the CLI default is "ambient"/);
  assert.match(r.stderr, /Confirm with: --target gfdefault/);
});

test('a READ with a differing ambient default still runs, on the pinned target, with a warning', () => {
  const r = inPkg({ agent: { target: 'gfdefault' } }, ['status']);
  assert.doesNotMatch(r.stderr, /refused/);
  assert.match(r.stderr, /using the pinned target "gfdefault"/);
});

test('.uxc/target pins a single checkout without touching the tracked manifest', () => {
  const r = inPkg({}, ['status', '--target', 'iris'], { files: { '.uxc/target': 'localbox\n' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pinned to target "localbox" \(\.uxc\/target\)/);
});

test('a package with no agent block behaves exactly as before', () => {
  const r = inPkg({}, ['status']);
  assert.doesNotMatch(r.stderr, /refused|pinned/);
});

test('--no-lock is accepted and does not change a local command', () => {
  const r = inPkg({}, ['context', '--no-lock']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^po — P/m);
});

test('uxc context runs offline and prints the package map', () => {
  const r = inPkg({ version: '1.2.3', registrationOrderBands: { 'fd.handler': [20, 31] } }, ['context']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /po — P v1\.2\.3/);
  assert.match(r.stdout, /prefixes pascal:Po camel:po kebab:po- upper:PO_/);
  assert.match(r.stdout, /registrationOrder bands: fd\.handler \[20,31\]/);
});

test('uxc context surfaces the operating policy so an agent reads it once, up front', () => {
  const r = inPkg({ agent: { target: 'gfdefault', protect: ['fd.handler/PoX'], forbid: ['push --changed'] } }, ['context']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /target PINNED to "gfdefault"/);
  assert.match(r.stdout, /protect fd\.handler\/PoX/);
  assert.match(r.stdout, /forbid "push --changed"/);
});

test('uxc get doc <id> is accepted instead of read as a missing document', () => {
  const r = inPkg({}, ['get', 'doc', 'PoThing_123']);
  assert.match(r.stdout + r.stderr, /the word "doc" is not needed/);
  assert.doesNotMatch(r.stdout + r.stderr, /document doc not found/);
});

test('uxc size reports nothing to measure in an empty package, without failing', () => {
  const r = inPkg({}, ['size']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no content-bearing resources in scope/);
});

test('uxc search rejects an unknown --category by naming the real ones', () => {
  const r = inPkg({}, ['search', 'X', '--category', 'BOGUS']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown --category "BOGUS".*VIRTUAL_FOLDER/s);
});

test('uxc test --offline runs the offline tier with no target and no lock', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-offline-'));
  const dir = join(home, 'pkg');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  mkdirSync(join(dir, 'fd', 'handlers', '_shared'), { recursive: true });
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'zz', name: 'Z' }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  writeFileSync(join(dir, 'fd/handlers/_shared/const.js'), 'var P1 = 4;\n');
  writeFileSync(join(dir, 'fd/handlers/_shared/lib.js'), '// @include ./const.js\nfunction due(p) { return p === "P1" ? P1 : 72; }\n');
  writeFileSync(join(dir, 'tests/00-off.test.mjs'), `export default {
    name: 'sla', offline: true,
    run(t) {
      const lib = t.loadShared('../fd/handlers/_shared/lib.js');
      t.expect(lib.due('P1') === 4, 'P1 -> 4 (through an @include)');
      t.expect(lib.due('P3') === 72, 'P3 -> 72');
    },
  };\n`);
  writeFileSync(join(dir, 'tests/90-live.test.mjs'), "export default { name: 'live', run(t) { t.fail('must not run'); } };\n");
  try {
    // NO target env at all: an offline run must not need one
    const r = spawnSync(process.execPath, [UXC, 'test', '--offline'], {
      cwd: dir,
      env: { ...process.env, HOME: home, UXC_TARGET: '', UXC_URL: '', UXC_SCOPE: '', UXC_USER: '', UXC_PASSWORD: '' },
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /running 1 offline test\(s\) — no server, no lock/);
    assert.match(r.stdout, /1 pass · 0 fail/);
    assert.match(r.stdout, /offline tier — proves logic, not a deploy/);
    assert.match(r.stderr + r.stdout, /1 server-dependent test\(s\) skipped/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
