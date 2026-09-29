// #71 — the two Windows defects found on the first run of uxc on that platform.
//
// 1. TEST ISOLATION. Every suite that needed a throwaway ~/.uxopian set `process.env.HOME`.
//    `os.homedir()` ignores HOME on Windows (it reads USERPROFILE), so the isolation silently did
//    nothing there: the lock suite wrote fixture locks into the developer's real home, and the CLI
//    suite wrote a fixture `targets.json` OVER the real one — the credentials of every registered
//    instance. uxc now resolves its home through `uxcHome()`, which UXC_HOME overrides on EVERY
//    platform. These tests pin that, and they are meaningful on posix too: they fail if anything
//    goes back to reading the OS home directly.
//
// 2. PACKAGE-RELATIVE PATHS. `path.relative()` yields `fd\handlers\a.js` on Windows. Those strings
//    are compared against registry.json paths AND baked into deployed bytes (the uxc:include
//    markers), so a native separator means phantom drift and an untracked listing that flags every
//    file. `toPosix()` normalises at the boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { uxcHome, uxcDir } from '../lib/home.mjs';
import { toPosix } from '../lib/util.mjs';

/** Set the uxc home to a fresh tmp dir for the duration of `fn`, restoring every knob after.
 *  ASYNC and awaited: a sync `finally` would restore the env before an async body ever ran, which
 *  is how the original HOME redirection looked like it worked while isolating nothing. */
async function withUxcHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'uxc-home-'));
  const prev = { UXC_HOME: process.env.UXC_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.UXC_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await fn(home); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('UXC_HOME overrides the OS home on every platform', async () => {
  const real = homedir();
  await withUxcHome((home) => {
    assert.equal(uxcHome(), home);
    assert.notEqual(uxcHome(), real);
    assert.equal(uxcDir('targets.json'), join(home, '.uxopian', 'targets.json'));
    assert.equal(uxcDir('locks'), join(home, '.uxopian', 'locks'));
  });
  // and it is restored: no test may leave the process pointing at a deleted directory
  assert.equal(uxcHome(), real);
});

test('an unset/blank UXC_HOME falls back to os.homedir()', () => {
  const prev = process.env.UXC_HOME;
  try {
    delete process.env.UXC_HOME;
    assert.equal(uxcHome(), homedir());
    process.env.UXC_HOME = '   ';
    assert.equal(uxcHome(), homedir(), 'a blank override must not point uxc at ""');
  } finally {
    if (prev === undefined) delete process.env.UXC_HOME; else process.env.UXC_HOME = prev;
  }
});

test('targets.json is written under UXC_HOME, never the real home (the #71 data-loss hazard)', async () => {
  const realTargets = join(homedir(), '.uxopian', 'targets.json');
  const before = existsSync(realTargets) ? readFileSync(realTargets, 'utf8') : null;

  await withUxcHome(async (home) => {
    // fresh module instance: prove the path is resolved per CALL, not captured at import
    const cfg = await import(`../lib/config.mjs?home=${encodeURIComponent(home)}`);
    cfg.saveTargets({ default: 't1', targets: { t1: { user: 'u', password: 'p', scope: 'S', url: 'http://x' } } });

    const isolated = join(home, '.uxopian', 'targets.json');
    assert.ok(existsSync(isolated), 'the fixture must land under UXC_HOME');
    assert.equal(cfg.loadTargets().default, 't1');
  });

  const after = existsSync(realTargets) ? readFileSync(realTargets, 'utf8') : null;
  assert.equal(after, before, 'the developer\'s real targets.json must be byte-identical after the run');
});

test('the lock root follows UXC_HOME, so lock fixtures never touch the real ~/.uxopian/locks', async () => {
  const realLocks = join(homedir(), '.uxopian', 'locks');
  const before = existsSync(realLocks);

  await withUxcHome(async (home) => {
    const L = await import(`../lib/lock.mjs?home=${encodeURIComponent(home)}`);
    assert.equal(L.lockRoot(), join(home, '.uxopian', 'locks'));
    const lock = await L.acquire('t-home', { mode: 'write', cmd: 'uxc test' });
    assert.equal(lock.held, true);
    assert.ok(existsSync(join(home, '.uxopian', 'locks', 't-home.lock')));
    lock.release();
  });

  assert.equal(existsSync(realLocks), before, 'the real locks dir must not be created by the suite');
});

test('toPosix: backslashes become slashes; posix paths pass through untouched', () => {
  assert.equal(toPosix('fd\\handlers\\A\\handler.js'), 'fd/handlers/A/handler.js');
  assert.equal(toPosix('fd/handlers/A/handler.js'), 'fd/handlers/A/handler.js');
  assert.equal(toPosix('handler.js'), 'handler.js');
  assert.equal(toPosix(''), '');
});

test('include markers and the untracked listing emit posix paths, whatever the platform', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uxc-posix-'));
  try {
    mkdirSync(join(dir, 'fd', 'handlers', 'shared'), { recursive: true });
    writeFileSync(join(dir, 'fd', 'handlers', 'shared', 'util.js'), 'function helper() { return 1; }\n');
    writeFileSync(join(dir, 'fd', 'handlers', 'main.js'), '// @include shared/util.js\nhelper();\n');

    const { includeDirectiveFiles, expandIncludes } = await import('../lib/include.mjs');

    const listed = includeDirectiveFiles(dir);
    assert.deepEqual(listed, ['fd/handlers/main.js']);
    for (const p of listed) assert.ok(!p.includes('\\'), `listed path must be posix: ${p}`);

    const src = join(dir, 'fd', 'handlers', 'main.js');
    const out = String(expandIncludes(readFileSync(src), src, dir));
    // the marker label is DEPLOYED content — a backslash here would change the content hash
    // between a Windows and a macOS build of the same package
    assert.match(out, /^\/\/ >>> uxc:include fd\/handlers\/shared\/util\.js /m);
    assert.match(out, /^\/\/ <<< uxc:include fd\/handlers\/shared\/util\.js$/m);
    assert.ok(!out.includes('\\'), 'no backslash may reach the deployed bytes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
