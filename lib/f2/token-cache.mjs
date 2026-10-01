// FAST-5884 — the fast2 broker token, shared across `uxc` processes.
//
// Without it every `uxc` process logs in again (A0 friction #5: 5 logins for 5 commands) although
// the access JWT lives 4 h (§F21). One file per (broker URL, user, tenant) under
// ~/.uxopian/f2-tokens/ (UXC_HOME moves it, as for targets.json):
//   - directory 0700, file 0600, written to a temp file in the same directory then rename()d, so a
//     concurrent reader sees the old file or the new one, never half of one (POSIX rename is atomic;
//     two writers racing = last one wins, both tokens are valid);
//   - holds the access token, the refresh token and the expiry — NEVER the password;
//   - the expiry is the JWT `exp` claim when the payload decodes (no signature check: it only says
//     when to stop using the token, the broker remains the judge), else login time + 3.5 h;
//   - a file another user could read (group/other bits) or another uid owns is ignored and removed;
//     the directory itself must be a real directory (not a symlink) owned by us, else the cache is
//     refused (it only costs a login); a file is opened O_NOFOLLOW|O_NONBLOCK and must be a regular
//     file (a FIFO planted under our name cannot hang the read);
//   - on Windows none of the POSIX checks apply: the profile's inherited ACL is the only protection.
// Disabled by UXC_F2_TOKEN_CACHE=0 (or `--no-token-cache`): no token read, no token written.
// `uxc target logout` removes entries; a failed login or a 401 on the cached token removes its entry.
// Beside the entry, `<key>.failed.json` {v, broker, user, failedAt} records the last FAILED login so
// the anti-lockout cooldown holds across processes (FAST-5874 / A04). It carries no secret and is
// kept even when the token cache is off (lockout protection stays on); a successful login removes it.
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, lstatSync, readdirSync,
  openSync, fstatSync, closeSync, constants as FS,
} from 'node:fs';
import { join } from 'node:path';
import { uxcDir } from '../home.mjs';

/** Used when the JWT carries no readable `exp`: the access token lives 4 h, stop using it before. */
export const FALLBACK_TTL_MS = 3.5 * 60 * 60_000;
/** Inside this margin before `exp` the token is refreshed (or re-logged-in) instead of reused. */
export const REFRESH_MARGIN_MS = 10 * 60_000;
/** A decoded `exp` further than this from the login is not believed (bogus or a unit slip): TTL fallback. */
export const MAX_TTL_MS = 24 * 60 * 60_000;
/** An entry whose access AND refresh tokens died this long ago is an orphan: swept on the next write. */
export const ORPHAN_AFTER_MS = 60 * 60_000;
/** A login lock older than this is a crashed holder's: taken over. */
export const LOCK_STALE_MS = 10_000;

const FORMAT = 1;
const POSIX = process.platform !== 'win32';

/** The cache directory (resolved per call, so a test that moves UXC_HOME is obeyed). */
export const tokenCacheDir = () => uxcDir('f2-tokens');

/** Is the cache switched off by the environment? (`--no-token-cache` is passed in by the CLI.) */
export function tokenCacheDisabledByEnv(env = process.env) {
  const v = String(env.UXC_F2_TOKEN_CACHE ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/** Broker URL normalised the way f2Surface builds its base (no trailing slash; scheme/host lowercased). */
export function normBroker(url) {
  const s = String(url ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(s); // URL already lowercases the scheme and host and drops a default port
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return s; }
}

/** The cache file name for one identity: a hash, so neither the URL nor the email is in a path. */
export function cacheKey({ broker, user, tenant = null }) {
  const id = [normBroker(broker), String(user ?? '').trim().toLowerCase(), tenant ?? ''].join('\n');
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

/**
 * The JWT `exp` claim in ms, or null when the token is not a decodable JWT. No signature check:
 * this only decides when uxc stops REUSING the token; the broker still validates every call.
 */
export function jwtExpMs(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const exp = payload?.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
    return exp >= 1e12 ? exp : exp * 1000; // >= 1e12 is already ms (1e12 s = year 33'658): a unit slip
  } catch { return null; }
}

/** A decoded expiry believed only when it is at most MAX_TTL_MS after `at` -> ms | null. */
const sane = (exp, at) => (exp && exp - at <= MAX_TTL_MS ? exp : null);

/** When to stop using an access token obtained at `at`: its `exp` (clamped), else at + 3.5 h. */
export function expiryOf(token, at = Date.now()) {
  const exp = sane(jwtExpMs(token), at);
  return exp ? { expiresAt: exp, expSource: 'jwt' } : { expiresAt: at + FALLBACK_TTL_MS, expSource: 'ttl' };
}

/** The refresh token's expiry: its `exp`; an unbelievable one -> at + 3.5 h; none -> null (unknown). */
function refreshExpiryOf(rt, at) {
  const exp = jwtExpMs(rt);
  if (!exp) return null;
  return sane(exp, at) ?? at + FALLBACK_TTL_MS;
}

const myUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/** The cache directory as it is now: a real directory we own, or absent -> true/false; else throws. */
function dirOk(dir) {
  let st;
  try { st = lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!POSIX) return true;
  if (st.isSymbolicLink() || !st.isDirectory() || (myUid() !== null && st.uid !== myUid())) {
    const e = new Error(`the fast2 token cache directory ${dir} is not a directory owned by this user: cache refused`);
    e.code = 'UXC_F2_CACHE_DIR';
    throw e;
  }
  return true;
}

function ensureDir() {
  const dir = tokenCacheDir();
  if (!dirOk(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    dirOk(dir); // whoever created it, it must be ours and real
  }
  if (POSIX) chmodSync(dir, 0o700); // an older/looser directory is tightened, never trusted as is
  return dir;
}

const NOFOLLOW = (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);

/**
 * Read one cache file without following a symlink or blocking on a FIFO -> { text } when it is a
 * regular file we own with no group/other bits, { untrusted: true } when it is there but not ours
 * to trust, null when absent (or the directory is not ours).
 */
function readOwn(file) {
  try { if (!dirOk(tokenCacheDir())) return null; } catch { return null; }
  let fd;
  try { fd = openSync(file, FS.O_RDONLY | NOFOLLOW); } catch (e) {
    return e.code === 'ENOENT' ? null : { untrusted: true }; // ELOOP: a symlink under our name
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { untrusted: true };
    if (POSIX && ((st.mode & 0o077) !== 0 || (myUid() !== null && st.uid !== myUid()))) return { untrusted: true };
    return { text: readFileSync(fd, 'utf8') };
  } catch { return { untrusted: true }; } finally { closeSync(fd); }
}

/** Write `obj` to `file` atomically (0600 temp in the same directory, then rename). */
function writeAtomic(dir, key, file, obj) {
  const tmp = join(dir, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600, flag: 'wx' });
    if (POSIX) chmodSync(tmp, 0o600); // umask cannot widen it, but be explicit
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Unlink a cache path, only inside a directory we own (never through a planted symlinked dir). */
function unlinkOwn(file) {
  try { if (!dirOk(tokenCacheDir())) return false; rmSync(file, { force: true }); return true; } catch { return false; }
}

/**
 * P3-5: entries whose tokens are all long dead (a broker URL or user that is no longer used),
 * failed-login markers past any cooldown, and temp files a crash left behind. Best effort.
 */
function sweepOrphans(dir, keep, now = Date.now()) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = join(dir, name);
    if (name === keep) continue;
    try {
      if (name.endsWith('.tmp') || name.endsWith('.lock')) {
        const st = lstatSync(file);
        if (now - st.mtimeMs > ORPHAN_AFTER_MS) rmSync(file, { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const got = readOwn(file);
      if (!got?.text) continue;
      const e = JSON.parse(got.text);
      const dead = name.endsWith('.failed.json')
        ? Number.isFinite(e?.failedAt) && now - e.failedAt > ORPHAN_AFTER_MS
        : Number.isFinite(e?.expiresAt) && now - e.expiresAt > ORPHAN_AFTER_MS
          && (e.refreshExpiresAt == null || (Number.isFinite(e.refreshExpiresAt) && now - e.refreshExpiresAt > ORPHAN_AFTER_MS));
      if (dead) rmSync(file, { force: true });
    } catch { /* not ours to judge */ }
  }
}

/**
 * The cache for ONE identity. `read()` -> entry | null, `write(fields)`, `drop()`,
 * `dropIf(accessToken)` (only when the file still holds that token: another process may already
 * have stored a newer one), `failedAt()` / `markFailed(at)` / `clearFailed()` (the cross-process
 * failed-login marker), `lock()` -> release fn | null when another process holds the login lock.
 */
export function tokenCache({ broker, user, tenant = null }) {
  const key = cacheKey({ broker, user, tenant });
  const file = () => join(tokenCacheDir(), `${key}.json`);
  const failedFile = () => join(tokenCacheDir(), `${key}.failed.json`);
  const lockFile = () => join(tokenCacheDir(), `${key}.lock`);
  const nb = normBroker(broker);
  const nu = String(user ?? '').trim().toLowerCase();

  function read() {
    const got = readOwn(file());
    if (!got) return null;
    if (got.untrusted) { drop(); return null; }
    let e;
    try { e = JSON.parse(got.text); } catch { drop(); return null; }
    // a stray or foreign file under our name (or a future format) is ignored, not trusted
    if (!e || e.v !== FORMAT || typeof e.accessToken !== 'string' || !e.accessToken
      || normBroker(e.broker) !== nb || String(e.user ?? '').toLowerCase() !== nu
      || !Number.isFinite(e.expiresAt)) return null;
    return e;
  }

  function write({ accessToken, refreshToken = null, at = Date.now() }) {
    const dir = ensureDir();
    const { expiresAt, expSource } = expiryOf(accessToken, at);
    const entry = {
      v: FORMAT, broker: nb, user: nu, tenant,
      accessToken, refreshToken: refreshToken || null,
      refreshExpiresAt: refreshToken ? refreshExpiryOf(refreshToken, at) : null,
      expiresAt, expSource, savedAt: at,
    };
    writeAtomic(dir, key, file(), entry);
    sweepOrphans(dir, `${key}.json`, at);
    return entry;
  }

  const drop = () => unlinkOwn(file());

  function dropIf(accessToken) {
    const e = read();
    if (e && e.accessToken === accessToken) drop();
  }

  /** When the last failed login of this identity happened (any process) -> ms | null. */
  function failedAt() {
    const got = readOwn(failedFile());
    if (!got) return null;
    if (got.untrusted) { unlinkOwn(failedFile()); return null; }
    try {
      const m = JSON.parse(got.text);
      if (m?.v !== FORMAT || normBroker(m.broker) !== nb || String(m.user ?? '').toLowerCase() !== nu) return null;
      return Number.isFinite(m.failedAt) ? m.failedAt : null;
    } catch { return null; }
  }

  function markFailed(at = Date.now()) {
    writeAtomic(ensureDir(), key, failedFile(), { v: FORMAT, broker: nb, user: nu, failedAt: at });
  }

  const clearFailed = () => unlinkOwn(failedFile());

  /**
   * The login lock (P3-3): an O_EXCL file, so after a broker restart one process logs in and its
   * siblings wait for the token it stores. -> release fn, or null when another process holds it.
   * A lock older than LOCK_STALE_MS (a crashed holder) is taken over. Throws on an fs failure.
   */
  function lock() {
    ensureDir();
    const f = lockFile();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        closeSync(openSync(f, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | (FS.O_NOFOLLOW ?? 0), 0o600));
        return () => unlinkOwn(f);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let st;
        try { st = lstatSync(f); } catch { continue; } // released meanwhile: try again
        if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null;
        rmSync(f, { force: true });
      }
    }
    return null;
  }

  return { key, file, read, write, drop, dropIf, failedAt, markFailed, clearFailed, lock };
}

/** Remove the entry of one identity -> true when a file was there. */
export function dropToken(identity) {
  const c = tokenCache(identity);
  let had = false;
  try { statSync(c.file()); had = true; } catch { /* absent */ }
  c.drop();
  return had;
}

/** Remove every cached token (and stray temp files) -> how many entries were removed. */
export function dropAllTokens() {
  let n = 0;
  let names = [];
  try { if (!dirOk(tokenCacheDir())) return 0; names = readdirSync(tokenCacheDir()); } catch { return 0; }
  for (const name of names) {
    if (!/\.(json|tmp|lock)$/.test(name)) continue;
    rmSync(join(tokenCacheDir(), name), { force: true });
    if (name.endsWith('.json') && !name.endsWith('.failed.json')) n++;
  }
  return n;
}
