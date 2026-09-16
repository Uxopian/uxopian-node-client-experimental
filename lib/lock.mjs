// Cross-process advisory lock on a TARGET (BACKLOG-AGENTIC #2/#4).
//
// The contended resource is the INSTANCE, not the checkout: two agents in two clones pushing to
// the same server collide exactly like two agents in one. So the lock key is the target NAME and
// the lock lives in ~/.uxopian/locks/, not in the package.
//
// Two modes, and the asymmetry is the whole point:
//   - 'write'  EXCLUSIVE. mkdir() is the atomic test-and-set (works on every filesystem we care
//              about, unlike O_EXCL on some network mounts). Waits, with progress, up to a timeout.
//   - 'read'   NEVER WAITS. A `uxc status` that queues four minutes behind a `test --yes` campaign
//              is what made the POC wrap uxc in a shell script. Reads take no lock at all; when a
//              writer holds one they print WHO holds it, so a surprising read is self-explaining.
//
// Orphan recovery: the owner file carries {pid, host, cmd, at}. A lock owned by a dead pid on THIS
// host is stolen immediately; one older than maxAgeMs is stolen with a warning (that is the only
// recovery available for a lock left by another host, which we cannot probe).
//
// The handler blind window (~45 s, LEARNINGS §36) outlives the lock: a rotation that lost events
// does so AFTER push exits. So it is recorded in a SEPARATE file that survives release, and the
// next handler push waits it out instead of doubling the window.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';

export const LOCK_ROOT = join(homedir(), '.uxopian', 'locks');
const DEFAULT_TIMEOUT_MS = 600_000;   // 10 min: longer than a settle-through push, shorter than a wedged agent
const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const POLL_MS = 200;
const REPORT_EVERY_MS = 5_000;

const safe = (s) => String(s ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_');
const lockDirOf = (key) => join(LOCK_ROOT, `${safe(key)}.lock`);
const ownerFileOf = (key) => join(lockDirOf(key), 'owner.json');
const windowFileOf = (key) => join(LOCK_ROOT, `${safe(key)}.window.json`);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is `pid` alive on THIS host? signal 0 probes without delivering. EPERM = alive but foreign. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Who holds the lock right now — {pid, host, cmd, at, ageMs} — or null. */
export function lockOwner(key) {
  if (!existsSync(lockDirOf(key))) return null;
  const meta = readJson(ownerFileOf(key));
  // a lock dir with no readable owner file is a half-written or hand-made lock: report it as
  // unknown rather than pretending it is free
  const o = meta ?? { pid: null, host: null, cmd: '(unknown)', at: null };
  return { ...o, ageMs: o.at ? Date.now() - Date.parse(o.at) : null };
}

/** True when the lock is provably abandoned (dead local pid, or older than maxAge). */
function isStale(owner, maxAgeMs) {
  if (!owner) return false;
  if (owner.host === hostname() && owner.pid != null && !pidAlive(owner.pid)) return true;
  return owner.ageMs != null && owner.ageMs > maxAgeMs;
}

/**
 * Acquire the lock for `key`.
 *   mode 'read'  -> resolves immediately; { held:false, contendedBy } says whether a writer is in.
 *   mode 'write' -> waits for exclusivity; throws on timeout.
 * Returns { held, mode, contendedBy, release() } — release() is always safe to call.
 */
export async function acquire(key, {
  mode = 'write', cmd = 'uxc', timeoutMs = DEFAULT_TIMEOUT_MS, maxAgeMs = DEFAULT_MAX_AGE_MS,
  onWait = () => {}, onSteal = () => {},
} = {}) {
  if (mode === 'read' || mode === 'none') {
    const owner = mode === 'read' ? lockOwner(key) : null;
    return {
      held: false, mode, contendedBy: owner && !isStale(owner, maxAgeMs) ? owner : null, release() {},
    };
  }

  const dir = lockDirOf(key);
  mkdirSync(LOCK_ROOT, { recursive: true }); // the PARENT is created recursively; the lock dir never is
  const t0 = Date.now();
  let reportedAt = 0;
  for (;;) {
    try {
      mkdirSync(dir, { recursive: false }); // atomic: EEXIST means someone else is in
      writeFileSync(ownerFileOf(key), JSON.stringify({
        pid: process.pid, host: hostname(), cmd, at: new Date().toISOString(),
      }, null, 2));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      };
      return { held: true, mode, contendedBy: null, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = lockOwner(key);
      if (isStale(owner, maxAgeMs)) {
        onSteal(owner);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* raced with the owner */ }
        continue;
      }
      const waited = Date.now() - t0;
      if (waited > timeoutMs) {
        const who = owner ? `${owner.cmd} (pid ${owner.pid}${owner.host && owner.host !== hostname() ? ` on ${owner.host}` : ''}, ${Math.round((owner.ageMs ?? 0) / 1000)}s)` : 'another process';
        const err = new Error(
          `timed out after ${Math.round(waited / 1000)}s waiting for the "${key}" lock held by ${who}`,
        );
        err.explanation = 'another uxc is writing this instance — wait, or pass --no-lock to proceed '
          + 'anyway (concurrent writes to one instance can interleave: handler rotation windows overlap '
          + 'and pushes see each other\'s half-finished state)';
        throw err;
      }
      if (waited - reportedAt >= REPORT_EVERY_MS) {
        reportedAt = waited;
        onWait(owner, waited);
      }
      await sleep(POLL_MS);
    }
  }
}

/** Record a handler blind window that outlives this process (push does this on release). */
export function recordHandlerWindow(key, ms, by = 'uxc push') {
  try {
    mkdirSync(LOCK_ROOT, { recursive: true });
    writeFileSync(windowFileOf(key), JSON.stringify({
      until: new Date(Date.now() + ms).toISOString(), by, pid: process.pid,
    }, null, 2));
  } catch { /* the window hint is an optimisation, never a failure */ }
}

/** Milliseconds still to wait on `key`'s handler window (0 when clear or unset). */
export function handlerWindowLeft(key) {
  const w = readJson(windowFileOf(key));
  if (!w?.until) return 0;
  const left = Date.parse(w.until) - Date.now();
  return Number.isFinite(left) && left > 0 ? left : 0;
}

/** Block until the recorded handler window has elapsed. Reports once through onWait. */
export async function waitHandlerWindow(key, { onWait = () => {} } = {}) {
  const left = handlerWindowLeft(key);
  if (left <= 0) return 0;
  const w = readJson(windowFileOf(key));
  onWait(left, w?.by ?? 'a previous push');
  await sleep(left);
  return left;
}

/** Every lock currently on this machine (uxc doctor / debugging). */
export function listLocks() {
  if (!existsSync(LOCK_ROOT)) return [];
  return readdirSync(LOCK_ROOT)
    .filter((n) => n.endsWith('.lock'))
    .map((n) => {
      const key = n.replace(/\.lock$/, '');
      return { key, ...(lockOwner(key) ?? {}), stale: isStale(lockOwner(key), DEFAULT_MAX_AGE_MS) };
    });
}
