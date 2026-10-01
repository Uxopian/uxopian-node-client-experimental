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
//   - a file another user could read (group/other bits) or another uid owns is ignored and removed.
// Disabled by UXC_F2_TOKEN_CACHE=0 (or `--no-token-cache`): nothing read, nothing written.
// `uxc target logout` removes entries; a failed login or a 401 on the cached token removes its entry.
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { uxcDir } from '../home.mjs';

/** Used when the JWT carries no readable `exp`: the access token lives 4 h, stop using it before. */
export const FALLBACK_TTL_MS = 3.5 * 60 * 60_000;
/** Inside this margin before `exp` the token is refreshed (or re-logged-in) instead of reused. */
export const REFRESH_MARGIN_MS = 10 * 60_000;

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
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
}

/** When to stop using an access token obtained at `at`: its `exp`, else at + 3.5 h. */
export function expiryOf(token, at = Date.now()) {
  const exp = jwtExpMs(token);
  return exp ? { expiresAt: exp, expSource: 'jwt' } : { expiresAt: at + FALLBACK_TTL_MS, expSource: 'ttl' };
}

function ensureDir() {
  const dir = tokenCacheDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(dir, 0o700); // an older/looser directory is tightened, never trusted as is
  return dir;
}

/** A file anyone but its owner can read, or owned by someone else, is not ours to trust. */
function trusted(file) {
  if (!POSIX) return true;
  const st = statSync(file);
  return (st.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || st.uid === process.getuid());
}

/**
 * The cache for ONE identity. `read()` -> entry | null, `write(fields)`, `drop()`,
 * `dropIf(accessToken)` (only when the file still holds that token: another process may already
 * have stored a newer one).
 */
export function tokenCache({ broker, user, tenant = null }) {
  const key = cacheKey({ broker, user, tenant });
  const file = () => join(tokenCacheDir(), `${key}.json`);
  const nb = normBroker(broker);
  const nu = String(user ?? '').trim().toLowerCase();

  function read() {
    let text;
    try {
      if (!trusted(file())) { drop(); return null; }
      text = readFileSync(file(), 'utf8');
    } catch { return null; }
    let e;
    try { e = JSON.parse(text); } catch { drop(); return null; }
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
      refreshExpiresAt: refreshToken ? jwtExpMs(refreshToken) : null,
      expiresAt, expSource, savedAt: at,
    };
    const tmp = join(dir, `.${key}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(entry) + '\n', { mode: 0o600, flag: 'wx' });
      if (POSIX) chmodSync(tmp, 0o600); // umask cannot widen it, but be explicit
      renameSync(tmp, file());
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return entry;
  }

  function drop() {
    try { rmSync(file(), { force: true }); return true; } catch { return false; }
  }

  function dropIf(accessToken) {
    const e = read();
    if (e && e.accessToken === accessToken) drop();
  }

  return { key, file, read, write, drop, dropIf };
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
  try { names = readdirSync(tokenCacheDir()); } catch { return 0; }
  for (const name of names) {
    if (!/\.(json|tmp)$/.test(name)) continue;
    rmSync(join(tokenCacheDir(), name), { force: true });
    if (name.endsWith('.json')) n++;
  }
  return n;
}
