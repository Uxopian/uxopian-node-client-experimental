// Offline unit tests for lib/lock.mjs — the cross-process target lock (BACKLOG-AGENTIC #2/#4).
// HOME is redirected per test so the developer's real ~/.uxopian/locks is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

/** Fresh HOME + a fresh module instance (LOCK_ROOT is computed at import time). */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'uxc-lock-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await import(`../lib/lock.mjs?home=${encodeURIComponent(home)}`);
    return await fn(mod, home);
  } finally {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test('write lock is exclusive; release makes it available again', async () => {
  await withHome(async (L) => {
    const a = await L.acquire('t1', { mode: 'write', cmd: 'uxc push' });
    assert.equal(a.held, true);
    assert.equal(L.lockOwner('t1').pid, process.pid);

    // a second writer with a short timeout must give up rather than double-write
    await assert.rejects(
      () => L.acquire('t1', { mode: 'write', cmd: 'uxc push 2', timeoutMs: 250 }),
      /timed out .* waiting for the "t1" lock/,
    );
    a.release();
    assert.equal(L.lockOwner('t1'), null);

    const b = await L.acquire('t1', { mode: 'write', cmd: 'uxc push 3' });
    assert.equal(b.held, true);
    b.release();
  });
});

test('reads NEVER wait — they report the writer instead (the four-minute status queue)', async () => {
  await withHome(async (L) => {
    const w = await L.acquire('t2', { mode: 'write', cmd: 'uxc test --yes' });
    const t0 = Date.now();
    const r = await L.acquire('t2', { mode: 'read' });
    assert.ok(Date.now() - t0 < 100, 'a read must not block behind a writer');
    assert.equal(r.held, false);
    assert.equal(r.contendedBy.cmd, 'uxc test --yes');
    r.release(); // never throws, never touches the writer's lock
    assert.equal(L.lockOwner('t2').pid, process.pid, 'a read release must not free the writer');
    w.release();
  });
});

test('a read with no writer reports no contention', async () => {
  await withHome(async (L) => {
    const r = await L.acquire('t3', { mode: 'read' });
    assert.equal(r.contendedBy, null);
  });
});

test('an orphaned lock (dead pid on this host) is stolen, with a report', async () => {
  await withHome(async (L, home) => {
    const dir = join(home, '.uxopian', 'locks', 't4.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({
      pid: 999_999, host: hostname(), cmd: 'uxc push (crashed)', at: new Date().toISOString(),
    }));
    let stolen = null;
    const w = await L.acquire('t4', { mode: 'write', cmd: 'uxc push', timeoutMs: 500, onSteal: (o) => { stolen = o; } });
    assert.equal(w.held, true);
    assert.equal(stolen.pid, 999_999);
    w.release();
  });
});

test('a LIVE foreign pid is never stolen from', async () => {
  await withHome(async (L, home) => {
    const dir = join(home, '.uxopian', 'locks', 't5.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({
      pid: process.pid, host: hostname(), cmd: 'uxc push (alive)', at: new Date().toISOString(),
    }));
    await assert.rejects(() => L.acquire('t5', { mode: 'write', timeoutMs: 250 }), /timed out/);
  });
});

test('a lock older than maxAge is stolen even when we cannot probe its host', async () => {
  await withHome(async (L, home) => {
    const dir = join(home, '.uxopian', 'locks', 't6.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({
      pid: 1, host: 'some-other-machine', cmd: 'uxc push', at: new Date(Date.now() - 3600_000).toISOString(),
    }));
    const w = await L.acquire('t6', { mode: 'write', maxAgeMs: 60_000, timeoutMs: 500 });
    assert.equal(w.held, true);
    w.release();
  });
});

test('handler window: recorded, reported as remaining, and it OUTLIVES the lock', async () => {
  await withHome(async (L) => {
    assert.equal(L.handlerWindowLeft('t7'), 0);
    const w = await L.acquire('t7', { mode: 'write', cmd: 'uxc push' });
    L.recordHandlerWindow('t7', 45_000, 'uxc push (pid 1)');
    w.release(); // the lock is gone…
    const left = L.handlerWindowLeft('t7'); // …but the blind window is not
    assert.ok(left > 40_000 && left <= 45_000, `expected ~45s left, got ${left}`);
  });
});

test('an elapsed handler window does not make anyone wait', async () => {
  await withHome(async (L) => {
    L.recordHandlerWindow('t8', -1000, 'past');
    assert.equal(L.handlerWindowLeft('t8'), 0);
    assert.equal(await L.waitHandlerWindow('t8'), 0);
  });
});

test("mode 'none' takes no lock and reports no contention", async () => {
  await withHome(async (L, home) => {
    const n = await L.acquire('t9', { mode: 'none' });
    assert.equal(n.held, false);
    assert.equal(n.contendedBy, null);
    assert.equal(existsSync(join(home, '.uxopian', 'locks', 't9.lock')), false);
  });
});

test('lock keys are sanitised into safe directory names', async () => {
  await withHome(async (L, home) => {
    const w = await L.acquire('../evil/name', { mode: 'write' });
    const locks = join(home, '.uxopian', 'locks');
    assert.ok(existsSync(join(locks, '.._evil_name.lock')), 'key must not escape the lock root');
    w.release();
  });
});

test('listLocks reports what is held on this machine', async () => {
  await withHome(async (L) => {
    const w = await L.acquire('tA', { mode: 'write', cmd: 'uxc push tA' });
    const rows = L.listLocks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'tA');
    assert.equal(rows[0].cmd, 'uxc push tA');
    assert.equal(rows[0].stale, false);
    w.release();
  });
});
