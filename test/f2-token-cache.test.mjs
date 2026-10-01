// FAST-5884 — the fast2 token shared across uxc processes (lib/f2/token-cache.mjs + f2Surface).
// One test (or more) per BDD criterion of the ticket. Offline: a local stub broker that mints
// JWT-shaped tokens (real `exp` claims, a fake signature); in-process tests point UXC_HOME at a tmp
// dir, subprocess tests give uxc a tmp HOME/UXC_HOME. No live call, nothing under the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, chmodSync,
  symlinkSync, lstatSync, utimesSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { f2Surface, createClients } from '../lib/http.mjs';
import {
  tokenCache, tokenCacheDir, jwtExpMs, cacheKey, expiryOf, FALLBACK_TTL_MS, REFRESH_MARGIN_MS, MAX_TTL_MS,
} from '../lib/f2/token-cache.mjs';

const UXC = resolve('bin/uxc.mjs');
const POSIX = process.platform !== 'win32';
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION', 'UXC_F2_OPENSEARCH',
  'UXC_F2_TOKEN_CACHE', 'UXC_HTTP_LOG'];
const USER = 'ops@example.test';
const PASSWORD = 'pw-NEVER-ON-DISK-7f3a';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A JWT-shaped token: real header/payload, a fake signature carrying a grep-able marker. */
const jwt = (n, expSec, kind = 'A') => `${b64u({ alg: 'RS256' })}.${b64u({ sub: USER, tenantId: 'default', iat: Math.floor(Date.now() / 1000), exp: expSec })}.SECRETSIG${kind}${n}x${Math.random().toString(36).slice(2)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * rc5-shaped stub: login mints an access + refresh JWT (4 h), `/api/auth/refresh-token` takes the
 * refresh token as the Bearer (AuthenticationService.refreshToken) and mints a new access token.
 */
async function stubBroker() {
  const state = { logins: 0, refreshes: 0, valid: new Set(), refreshValid: new Set(), loginStatus: 200, refreshStatus: 200, issued: [], accessLife: 4 * 3600, acceptNew: true, loginDelayMs: 0, onLogin: null };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    req.resume();
    req.on('end', () => {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (path === '/api/auth/login') {
        state.logins += 1;
        if (state.onLogin) state.onLogin(state);
        if (state.loginDelayMs) {
          const ms = state.loginDelayMs;
          state.loginDelayMs = 0; // only the first login is slow
          return setTimeout(() => { state.loginDelayMs = 0; answerLogin(); }, ms);
        }
        return answerLogin();
      }
      function answerLogin() {
        if (state.loginStatus !== 200) return json(res, state.loginStatus, { status: 'INVALID', message: 'Bad credentials' });
        const a = jwt(state.logins, nowSec() + state.accessLife, 'A');
        const r = jwt(state.logins, nowSec() + state.accessLife, 'R');
        if (state.acceptNew) state.valid.add(a);
        state.refreshValid.add(r); state.issued.push(a, r);
        return json(res, 200, { accessToken: a, refreshToken: r, tokenType: 'BEARER', tenantId: 'default' });
      }
      if (path === '/api/auth/refresh-token') {
        state.refreshes += 1;
        if (state.refreshStatus !== 200 || !state.refreshValid.has(bearer)) return json(res, 401, { status: 'INVALID', message: 'Invalid token provided' });
        const a = jwt(`r${state.refreshes}`, nowSec() + 4 * 3600, 'A');
        state.valid.add(a); state.issued.push(a);
        return json(res, 200, { accessToken: a, refreshToken: bearer, tokenType: 'BEARER' });
      }
      if (!bearer) return json(res, 403, { status: 403, error: 'Forbidden', path });
      if (!state.valid.has(bearer)) return json(res, 401, { status: 'INVALID', message: 'Invalid compact JWT string' });
      if (path === '/api/ok') return json(res, 200, { ok: true });
      return json(res, 404, { error: 'Not Found', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, close: () => new Promise((r) => server.close(r)) };
}

/** In-process: UXC_HOME (and HOME) on a tmp dir for the duration of `fn`. */
async function withHome(fn) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-f2tok-'));
  const saved = Object.fromEntries(['UXC_HOME', 'HOME', 'UXC_F2_TOKEN_CACHE'].map((k) => [k, process.env[k]]));
  process.env.UXC_HOME = home; process.env.HOME = home; delete process.env.UXC_F2_TOKEN_CACHE;
  try { return await fn(home); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
}

const target = (url) => ({ name: 'b', f2: url, f2User: USER, f2Password: PASSWORD });
const client = (url, opts = {}) => f2Surface(target(url), { loginCooldownMs: 0, tokenCache: true, ...opts });
const cacheFiles = () => { try { return readdirSync(tokenCacheDir()); } catch { return []; } };

/** Subprocess: a stored Fast2-only target "b" in a fresh home, then uxc <args>. */
function setupHome(url) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-f2tok-cli-'));
  mkdirSync(join(home, '.uxopian'), { recursive: true });
  writeFileSync(join(home, '.uxopian', 'targets.json'), JSON.stringify({ default: 'b', targets: { b: { f2: url, f2User: USER, f2Password: PASSWORD } } }));
  return home;
}
function uxc(args, { home, env = {} }) {
  return new Promise((done) => {
    const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
    const child = spawn(process.execPath, [UXC, ...args], {
      cwd: home,
      env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', CLAUDECODE: '', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr, all: stdout + stderr }));
  });
}

// --- BDD 1: what is stored, where, how -------------------------------------------------------

test('FAST-5884 BDD1: a login stores access + refresh token and the JWT exp in ~/.uxopian/f2-tokens, 0600 in a 0700 dir, never the password', async () => {
  const b = await stubBroker();
  try {
    await withHome(async (home) => {
      const f2 = client(b.url);
      await f2.get('/api/ok');
      const files = cacheFiles();
      assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
      assert.equal(files.length, 1);
      assert.match(files[0], /^[0-9a-f]{32}\.json$/, 'file named by a hash: no URL or email in the path');
      const file = join(tokenCacheDir(), files[0]);
      assert.ok(file.startsWith(join(home, '.uxopian', 'f2-tokens')));
      if (POSIX) {
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(tokenCacheDir()).mode & 0o777, 0o700);
      }
      const raw = readFileSync(file, 'utf8');
      assert.ok(!raw.includes(PASSWORD), 'the password is never stored');
      const e = JSON.parse(raw);
      assert.equal(e.v, 1);
      assert.equal(e.accessToken, b.state.issued[0]);
      assert.equal(e.refreshToken, b.state.issued[1]);
      assert.equal(e.expSource, 'jwt');
      assert.equal(e.expiresAt, jwtExpMs(e.accessToken));
      assert.equal(e.user, USER);
      assert.equal(e.broker, b.url);
      assert.deepEqual(Object.keys(e).sort(), ['accessToken', 'broker', 'expSource', 'expiresAt', 'refreshExpiresAt', 'refreshToken', 'savedAt', 'tenant', 'user', 'v']);
    });
  } finally { await b.close(); }
});

test('FAST-5884 BDD1: keyed by broker URL + user (+ tenant): another user or broker gets another file', () => {
  const k = cacheKey({ broker: 'http://h:1789', user: USER });
  assert.equal(cacheKey({ broker: 'HTTP://H:1789/', user: USER.toUpperCase() }), k, 'normalised');
  assert.notEqual(cacheKey({ broker: 'http://h:1789', user: 'other@example.test' }), k);
  assert.notEqual(cacheKey({ broker: 'http://h:1790', user: USER }), k);
  assert.notEqual(cacheKey({ broker: 'http://h:1789', user: USER, tenant: 't2' }), k);
});

test('FAST-5884 BDD1: no JWT exp -> 3.5 h after the login; an exp in the past is respected even if the login is recent', async () => {
  await withHome(async () => {
    const c = tokenCache({ broker: 'http://h:1', user: USER });
    const at = Date.now();
    const e = c.write({ accessToken: 'opaque-token', refreshToken: null, at });
    assert.equal(e.expSource, 'ttl');
    assert.equal(e.expiresAt, at + FALLBACK_TTL_MS);
    const past = c.write({ accessToken: jwt(1, nowSec() - 60) });
    assert.equal(past.expSource, 'jwt');
    assert.ok(past.expiresAt < Date.now());
  });
});

test('FAST-5884 BDD1: concurrent writers (4 processes) leave one parseable file and no temp file', async () => {
  await withHome(async (home) => {
    const mod = resolve('lib/f2/token-cache.mjs');
    const script = `import { tokenCache } from ${JSON.stringify('file://' + mod.replace(/\\/g, '/'))};
      const c = tokenCache({ broker: 'http://h:1', user: 'u' });
      for (let i = 0; i < 50; i++) c.write({ accessToken: 'tok-' + process.pid + '-' + i + '-' + 'x'.repeat(4000) });`;
    await Promise.all([1, 2, 3, 4].map(() => new Promise((done, fail) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, UXC_HOME: home } });
      p.on('close', (code) => (code === 0 ? done() : fail(new Error(`writer exit ${code}`))));
    })));
    const files = cacheFiles();
    assert.equal(files.length, 1, `one file, no .tmp left: ${files}`);
    const e = JSON.parse(readFileSync(join(tokenCacheDir(), files[0]), 'utf8'));
    assert.match(e.accessToken, /^tok-\d+-49-x{4000}$/, 'a whole entry from one writer, never a mix');
  });
});

test('FAST-5884 BDD1: a cache file readable by group/other is not trusted: ignored, removed, and a login replaces it', { skip: !POSIX }, async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      const file = join(tokenCacheDir(), cacheFiles()[0]);
      chmodSync(file, 0o644);
      await client(b.url).get('/api/ok');
      assert.equal(b.state.logins, 2, 'the loose file was not reused');
      assert.equal(statSync(join(tokenCacheDir(), cacheFiles()[0])).mode & 0o777, 0o600);
    });
  } finally { await b.close(); }
});

// --- BDD 2: a new process with a cached token spends no login --------------------------------

test('FAST-5884 BDD2: a second client (= a new process) reuses the cached token: no POST /auth/login', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      const second = client(b.url);
      await second.get('/api/ok');
      await second.get('/api/ok');
      assert.equal(b.state.logins, 1);
      assert.equal(second.tokenSource(), 'cache');
    });
  } finally { await b.close(); }
});

test('FAST-5884 BDD2: two consecutive `uxc` processes spend ONE login (subprocess)', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  try {
    const r1 = await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    assert.equal(r1.status, 0, r1.all);
    const r2 = await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    assert.equal(r2.status, 0, r2.all);
    assert.equal(b.state.logins, 1, 'the second process reused the first one\'s token');
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
});

test('FAST-5884 BDD2: a bare f2Surface() (library default) neither reads nor writes the cache', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await f2Surface(target(b.url), { loginCooldownMs: 0 }).get('/api/ok');
      assert.deepEqual(cacheFiles(), []);
    });
  } finally { await b.close(); }
});

// --- BDD 3: refresh inside the last 10 min -----------------------------------------------------

test('FAST-5884 BDD3: a cached token within 10 min of exp is refreshed (no login) and the new token is stored', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      b.state.accessLife = 5 * 60; // the broker hands out tokens with 5 min left
      await client(b.url).get('/api/ok');
      assert.equal(b.state.logins, 1);
      const f2 = client(b.url);
      await f2.get('/api/ok');
      assert.equal(b.state.logins, 1, 'no second login');
      assert.equal(b.state.refreshes, 1);
      assert.equal(f2.tokenSource(), 'refresh');
      const e = tokenCache({ broker: b.url, user: USER }).read();
      assert.match(e.accessToken, /SECRETSIGAr1/, 'the refreshed token is stored');
      assert.ok(e.expiresAt - Date.now() > REFRESH_MARGIN_MS, 'with its own, later exp');
      assert.equal(e.refreshToken, b.state.issued[1], 'the broker keeps the original refresh token');
    });
  } finally { await b.close(); }
});

test('FAST-5884 BDD3: a failed refresh falls back to exactly one login', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      b.state.accessLife = 5 * 60;
      await client(b.url).get('/api/ok');
      b.state.refreshStatus = 401;
      b.state.accessLife = 4 * 3600;
      const f2 = client(b.url);
      assert.deepEqual(await f2.get('/api/ok'), { ok: true });
      assert.equal(b.state.refreshes, 1);
      assert.equal(b.state.logins, 2);
      assert.equal(f2.tokenSource(), 'login');
    });
  } finally { await b.close(); }
});

// --- BDD 4: a 401 on the cached token ----------------------------------------------------------

test('FAST-5884 BDD4: a cached token the broker rejects with 401 -> entry dropped, one login, one replay', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      const stale = tokenCache({ broker: b.url, user: USER }).read().accessToken;
      b.state.valid.clear(); // broker restarted: every token is gone
      const f2 = client(b.url);
      assert.deepEqual(await f2.get('/api/ok'), { ok: true });
      assert.equal(b.state.logins, 2, 'exactly one more login');
      const e = tokenCache({ broker: b.url, user: USER }).read();
      assert.notEqual(e.accessToken, stale, 'the refused token is gone from the cache');
      assert.equal(e.accessToken, b.state.issued[2]);
    });
  } finally { await b.close(); }
});

test('FAST-5884 BDD4: a token the re-login minted and the broker refuses too is not left in the cache', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      b.state.valid.clear();
      b.state.acceptNew = false; // a broker that does not accept its own fresh tokens (restart, skew)
      const r = await client(b.url).raw('GET', '/api/ok');
      assert.equal(r.status, 401);
      assert.ok(r.reloginSkipped);
      assert.equal(b.state.logins, 2, 'one re-login, no more');
      assert.deepEqual(cacheFiles(), [], 'neither the stale nor the refused fresh token is offered to the next process');
    });
  } finally { await b.close(); }
});

// --- BDD 5: a failed login removes the entry ---------------------------------------------------

test('FAST-5884 BDD5: a failed login removes the cache entry of that broker + user', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      assert.equal(cacheFiles().length, 1);
      b.state.loginStatus = 401;
      await assert.rejects(() => client(b.url).login({ force: true }), (e) => e.code === 'UXC_F2_LOGIN');
      assert.deepEqual(cacheFiles(), []);
    });
  } finally { await b.close(); }
});

// --- BDD 6: switched off -----------------------------------------------------------------------

for (const [label, opts] of [['UXC_F2_TOKEN_CACHE=0', { env: { UXC_F2_TOKEN_CACHE: '0' } }], ['--no-token-cache', { flag: true }]]) {
  test(`FAST-5884 BDD6: ${label} -> the cache is neither read nor written (two processes = two logins)`, async () => {
    const b = await stubBroker();
    const home = setupHome(b.url);
    try {
      // a valid entry is already there: it must not be read either
      await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
      assert.equal(b.state.logins, 1);
      const dir = join(home, '.uxopian', 'f2-tokens');
      const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8'));
      const args = ['api', 'GET', '/api/ok', '--surface', 'f2', ...(opts.flag ? ['--no-token-cache'] : [])];
      for (let i = 0; i < 2; i++) {
        const r = await uxc(args, { home, env: opts.env ?? {} });
        assert.equal(r.status, 0, r.all);
      }
      assert.equal(b.state.logins, 3, 'one login per process: the cached token was not read');
      assert.deepEqual(readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')), before, 'nothing written');
    } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('FAST-5884 BDD6: UXC_F2_TOKEN_CACHE=0 also wins over createClients() (library connect)', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      process.env.UXC_F2_TOKEN_CACHE = '0';
      await createClients({ ...target(b.url), fd: false }).f2.get('/api/ok');
      assert.deepEqual(cacheFiles(), []);
    });
  } finally { await b.close(); }
});

// --- BDD 7: target logout / target add ---------------------------------------------------------

test('FAST-5884 BDD7: `uxc target logout` removes the entry (next process logs in again); --all removes every one', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  try {
    await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    const dir = join(home, '.uxopian', 'f2-tokens');
    assert.equal(readdirSync(dir).length, 1);
    const out = await uxc(['target', 'logout', 'b', '--json'], { home });
    assert.equal(out.status, 0, out.all);
    assert.deepEqual(JSON.parse(out.stdout), { target: 'b', f2: b.url, removed: true });
    assert.deepEqual(readdirSync(dir), []);
    const again = await uxc(['target', 'logout', '--json'], { home }); // default target, idempotent
    assert.equal(JSON.parse(again.stdout).removed, false);
    await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    assert.equal(b.state.logins, 2);
    // a second identity, then --all
    writeFileSync(join(dir, `${'0'.repeat(32)}.json`), '{}', { mode: 0o600 });
    const all = await uxc(['target', 'logout', '--all', '--json'], { home });
    assert.deepEqual(JSON.parse(all.stdout), { all: true, removed: 2 });
    assert.deepEqual(readdirSync(dir), []);
    const help = await uxc(['help'], { home });
    assert.match(help.stdout, /target logout/);
    assert.match(help.stdout, /--no-token-cache/);
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
});

test('FAST-5884 BDD7: re-registering a target with `target add` (new password) removes its cached token', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  try {
    await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    const dir = join(home, '.uxopian', 'f2-tokens');
    assert.equal(readdirSync(dir).length, 1);
    const r = await uxc(['target', 'add', 'b', '--f2', b.url, '--f2-user', USER, '--f2-password', 'a-new-one'], { home });
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(readdirSync(dir), []);
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
});

// --- BDD 8: no token in any output -------------------------------------------------------------

test('FAST-5884 BDD8: no token value in stdout/stderr (human, --json, --verbose), the UXC_HTTP_LOG journal, or target ls', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  const journal = join(home, 'http.log');
  try {
    b.state.accessLife = 5 * 60; // also go through the refresh path
    const runs = [];
    for (const args of [
      ['api', 'GET', '/api/ok', '--surface', 'f2', '--verbose'],
      ['api', 'GET', '/api/ok', '--surface', 'f2', '--json'],
      ['api', 'GET', '/api/missing', '--surface', 'f2', '--verbose'],
      ['target', 'ls', '--json'],
      ['target', 'logout', '--json'],
    ]) runs.push(await uxc(args, { home, env: { UXC_HTTP_LOG: journal } }));
    b.state.valid.clear(); // the 401 -> re-login path too
    runs.push(await uxc(['api', 'GET', '/api/ok', '--surface', 'f2', '--verbose'], { home, env: { UXC_HTTP_LOG: journal } }));
    assert.ok(b.state.issued.length >= 4, 'tokens were issued');
    const text = runs.map((r) => r.all).join('\n') + readFileSync(journal, 'utf8');
    assert.match(readFileSync(journal, 'utf8'), /\/api\/auth\/login/, 'the journal did record the calls');
    for (const t of b.state.issued) {
      assert.ok(!text.includes(t), 'a token was printed');
      assert.ok(!text.includes(t.split('.')[2]), 'a token signature was printed');
    }
    assert.ok(!/SECRETSIG/.test(text));
    assert.ok(!text.includes(PASSWORD));
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
});

// --- housekeeping: nothing in the package / cwd ------------------------------------------------

test('FAST-5884 BDD1: nothing is written in the working directory (the package)', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  const pkg = mkdtempSync(join(os.tmpdir(), 'uxc-f2tok-pkg-'));
  try {
    await new Promise((done) => {
      const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
      spawn(process.execPath, [UXC, 'api', 'GET', '/api/ok', '--surface', 'f2'], {
        cwd: pkg, env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', CLAUDECODE: '' },
      }).on('close', done);
    });
    assert.equal(b.state.logins, 1);
    assert.deepEqual(readdirSync(pkg), []);
    assert.ok(existsSync(join(home, '.uxopian', 'f2-tokens')));
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); rmSync(pkg, { recursive: true, force: true }); }
});

// --- REVIEW @0e4a0c0: cross-process failed-login cooldown (P2-1, FAST-5874 / A04) -----------------

const markerFiles = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.failed.json')); } catch { return []; } };

for (const [label, env] of [['token cache on', {}], ['UXC_F2_TOKEN_CACHE=0 (lockout protection stays on)', { UXC_F2_TOKEN_CACHE: '0' }]]) {
  test(`P2-1: three consecutive \`uxc\` processes with a wrong password spend ONE failed login; the 2nd and 3rd are refused locally with a retry time (${label})`, async () => {
    const b = await stubBroker();
    const home = setupHome(b.url);
    try {
      b.state.loginStatus = 401; // wrong / rotated password
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home, env }));
      assert.equal(b.state.logins, 1, 'exactly one POST /api/auth/login reached the broker');
      assert.notEqual(runs[0].status, 0);
      assert.match(runs[0].all, /fast2 login failed/);
      for (const r of runs.slice(1)) {
        assert.equal(r.status, 2, r.all);
        assert.match(r.all, /refusing to re-authenticate to fast2: the last fast2 login for this broker \+ user failed \d+s ago \(in another uxc process\) — retry in \d+s \(at \d\d:\d\d:\d\d\)/);
        assert.match(r.all, /remaining-attempts/);
      }
      const dir = join(home, '.uxopian', 'f2-tokens');
      const markers = markerFiles(dir);
      assert.equal(markers.length, 1, 'one <key>.failed.json');
      const raw = readFileSync(join(dir, markers[0]), 'utf8');
      assert.ok(!raw.includes(PASSWORD), 'the marker never holds the password');
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['broker', 'failedAt', 'user', 'v']);
      if (POSIX) assert.equal(statSync(join(dir, markers[0])).mode & 0o777, 0o600);
      const json = await uxc(['api', 'GET', '/api/ok', '--surface', 'f2', '--json'], { home, env });
      assert.match(json.stdout, /"code": ?"UXC_F2_COOLDOWN"/);
      assert.equal(b.state.logins, 1);
    } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('P2-1: the marker is written atomically 0600 on a failed login, read by a sibling client, and removed by the next successful login', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      b.state.loginStatus = 401;
      await assert.rejects(() => client(b.url, { loginCooldownMs: 300 }).login(), (e) => e.code === 'UXC_F2_LOGIN');
      assert.equal(markerFiles(tokenCacheDir()).length, 1);
      assert.deepEqual(cacheFiles().filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
      const sibling = client(b.url, { loginCooldownMs: 300 });
      await assert.rejects(() => sibling.login(), (e) => e.code === 'UXC_F2_COOLDOWN' && /another uxc process/.test(e.message));
      assert.equal(b.state.logins, 1);
      await new Promise((ok) => setTimeout(ok, 350));
      b.state.loginStatus = 200;
      await sibling.login();
      assert.equal(b.state.logins, 2);
      assert.deepEqual(markerFiles(tokenCacheDir()), [], 'a successful login clears the marker');
      assert.equal(tokenCache({ broker: b.url, user: USER }).failedAt(), null);
    });
  } finally { await b.close(); }
});

test('P2-1: a login that never reached the broker (connection refused) writes no marker; a bare f2Surface() never writes one', async () => {
  const gone = await stubBroker();
  await gone.close(); // a port nothing listens on any more: ECONNREFUSED
  await withHome(async () => {
    const dead = f2Surface({ name: 'd', f2: gone.url, f2User: USER, f2Password: PASSWORD }, { tokenCache: true });
    await assert.rejects(() => dead.login(), (e) => /ECONNREFUSED/.test(e.code));
    assert.deepEqual(markerFiles(tokenCacheDir()), []);
  });
  const b = await stubBroker();
  try {
    await withHome(async () => {
      b.state.loginStatus = 401;
      await assert.rejects(() => f2Surface(target(b.url)).login(), (e) => e.code === 'UXC_F2_LOGIN');
      assert.deepEqual(cacheFiles(), [], 'library default: nothing on disk');
    });
  } finally { await b.close(); }
});

// --- REVIEW @0e4a0c0 P3-1: the directory and the file are not trusted by path ------------------

test('P3-1: a symlinked f2-tokens directory is refused: not chmod-ed, nothing written through it, each process logs in', { skip: !POSIX }, async () => {
  const b = await stubBroker();
  const elsewhere = mkdtempSync(join(os.tmpdir(), 'uxc-f2tok-elsewhere-'));
  try {
    chmodSync(elsewhere, 0o755);
    await withHome(async (home) => {
      mkdirSync(join(home, '.uxopian'), { recursive: true });
      symlinkSync(elsewhere, join(home, '.uxopian', 'f2-tokens'));
      await client(b.url).get('/api/ok');
      await client(b.url).get('/api/ok');
      assert.equal(b.state.logins, 2, 'the cache was refused, not used');
      assert.deepEqual(readdirSync(elsewhere), [], 'no token written through the link');
      assert.equal(statSync(elsewhere).mode & 0o777, 0o755, 'the link target was not chmod-ed');
    });
  } finally { await b.close(); rmSync(elsewhere, { recursive: true, force: true }); }
});

test('P3-1: a FIFO under the entry name cannot hang the read: ignored, removed, replaced by a login', { skip: !POSIX }, async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      const c = tokenCache({ broker: b.url, user: USER });
      mkdirSync(tokenCacheDir(), { recursive: true, mode: 0o700 });
      execFileSync('mkfifo', ['-m', '600', c.file()]);
      const t0 = Date.now();
      await client(b.url).get('/api/ok');
      assert.ok(Date.now() - t0 < 5_000, 'did not block');
      assert.equal(b.state.logins, 1);
      assert.ok(lstatSync(c.file()).isFile(), 'the FIFO was replaced by a regular entry');
    });
  } finally { await b.close(); }
});

test('P3-1: a symlink under the entry name is not followed (its target is neither read nor touched)', { skip: !POSIX }, async () => {
  const b = await stubBroker();
  const outside = mkdtempSync(join(os.tmpdir(), 'uxc-f2tok-out-'));
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok'); // a valid entry exists
      const c = tokenCache({ broker: b.url, user: USER });
      const real = join(outside, 'entry.json');
      writeFileSync(real, readFileSync(c.file()), { mode: 0o600 });
      rmSync(c.file());
      symlinkSync(real, c.file());
      assert.equal(c.read(), null, 'a symlinked entry is never read');
      assert.ok(existsSync(real), 'its target is untouched');
      await client(b.url).get('/api/ok');
      assert.equal(b.state.logins, 2);
      assert.ok(lstatSync(c.file()).isFile());
    });
  } finally { await b.close(); rmSync(outside, { recursive: true, force: true }); }
});

// --- REVIEW @0e4a0c0 P3-2: compare-and-delete, never a sibling's fresh entry ---------------------

test('P3-2: a failed login removes the entry it started from, never one a sibling stored during the request', async () => {
  const b = await stubBroker();
  try {
    await withHome(async () => {
      await client(b.url).get('/api/ok');
      b.state.loginStatus = 500; // user store down (FAST-5804)
      b.state.onLogin = () => tokenCache({ broker: b.url, user: USER }).write({ accessToken: 'sibling-fresh-token' });
      await assert.rejects(() => client(b.url).login({ force: true }), (e) => e.code === 'UXC_F2_LOGIN');
      assert.equal(tokenCache({ broker: b.url, user: USER }).read()?.accessToken, 'sibling-fresh-token');
    });
  } finally { await b.close(); }
});

test('P3-2: a spent entry is dropped by compare-and-delete (dropIf), so a newer one stored meanwhile survives', async () => {
  await withHome(async () => {
    const c = tokenCache({ broker: 'http://h:1', user: USER });
    c.write({ accessToken: 'old' });
    c.dropIf('not-the-one');
    assert.equal(c.read().accessToken, 'old');
    c.dropIf('old');
    assert.equal(c.read(), null);
  });
});

// --- REVIEW @0e4a0c0 P3-3: N parallel processes after a broker restart ------------------------

test('P3-3: three parallel `uxc` processes after a broker restart spend ONE re-login (the others wait for its token)', async () => {
  const b = await stubBroker();
  const home = setupHome(b.url);
  try {
    const first = await uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home });
    assert.equal(first.status, 0, first.all);
    assert.equal(b.state.logins, 1);
    b.state.valid.clear(); // broker restarted: the cached token is refused
    b.state.loginDelayMs = 400; // the re-login takes a while: the siblings 401 meanwhile
    const runs = await Promise.all([1, 2, 3].map(() => uxc(['api', 'GET', '/api/ok', '--surface', 'f2'], { home })));
    for (const r of runs) assert.equal(r.status, 0, r.all);
    assert.equal(b.state.logins, 2, 'one re-login for the three processes');
    assert.deepEqual(readdirSync(join(home, '.uxopian', 'f2-tokens')).filter((f) => !f.endsWith('.json')), [], 'no lock or temp file left');
  } finally { await b.close(); rmSync(home, { recursive: true, force: true }); }
});

test('P3-3: a stale login lock (crashed holder) is taken over', async () => {
  await withHome(async () => {
    const c = tokenCache({ broker: 'http://h:1', user: USER });
    const release = c.lock();
    assert.equal(typeof release, 'function');
    assert.equal(c.lock(), null, 'held');
    const lockPath = join(tokenCacheDir(), `${c.key}.lock`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, old, old);
    const again = c.lock();
    assert.equal(typeof again, 'function', 'a lock older than LOCK_STALE_MS is taken over');
    again();
    assert.ok(!existsSync(lockPath));
  });
});

// --- REVIEW @0e4a0c0 P3-4: the decoded exp is clamped -----------------------------------------

test('P3-4: an exp in milliseconds is read as ms; an exp beyond 24 h (or 1e300) falls back to the 3.5 h TTL', async () => {
  const at = Date.now();
  const inOneHourMs = at + 3_600_000;
  assert.equal(jwtExpMs(jwt(1, inOneHourMs)), inOneHourMs, 'ms-unit exp');
  assert.deepEqual(expiryOf(jwt(1, inOneHourMs), at), { expiresAt: inOneHourMs, expSource: 'jwt' });
  assert.deepEqual(expiryOf(jwt(1, 1e300), at), { expiresAt: at + FALLBACK_TTL_MS, expSource: 'ttl' });
  assert.deepEqual(expiryOf(jwt(1, nowSec() + 30 * 24 * 3600), at), { expiresAt: at + FALLBACK_TTL_MS, expSource: 'ttl' });
  const inside = nowSec() + 23 * 3600;
  assert.equal(expiryOf(jwt(1, inside), at).expSource, 'jwt', '<= 24 h is believed');
  assert.ok(MAX_TTL_MS === 24 * 3600_000);
  await withHome(async () => {
    const e = tokenCache({ broker: 'http://h:1', user: USER }).write({ accessToken: jwt(1, 1e300), refreshToken: jwt(1, 1e300, 'R'), at });
    assert.equal(e.expSource, 'ttl');
    assert.equal(e.refreshExpiresAt, at + FALLBACK_TTL_MS, 'the refresh expiry is clamped too');
  });
});

// --- REVIEW @0e4a0c0 P3-5: orphan entries expire ----------------------------------------------

test('P3-5: a write sweeps entries whose tokens died over an hour ago, stale markers and temp files; live ones stay', async () => {
  await withHome(async () => {
    const long = Date.now() - 3 * 3600_000;
    const orphan = tokenCache({ broker: 'http://old-host:1789', user: USER });
    orphan.write({ accessToken: jwt(1, Math.floor(long / 1000)), refreshToken: jwt(1, Math.floor(long / 1000), 'R'), at: long - 60_000 });
    orphan.markFailed(long);
    const live = tokenCache({ broker: 'http://other:1789', user: USER });
    live.write({ accessToken: jwt(2, nowSec() + 3600) });
    const tmp = join(tokenCacheDir(), '.deadbeef.1.abc.tmp');
    writeFileSync(tmp, '{}', { mode: 0o600 });
    utimesSync(tmp, long / 1000, long / 1000);
    tokenCache({ broker: 'http://h:1', user: USER }).write({ accessToken: jwt(3, nowSec() + 3600) });
    assert.equal(orphan.read(), null, 'orphan entry swept');
    assert.equal(orphan.failedAt(), null, 'stale marker swept');
    assert.ok(!existsSync(tmp), 'stale temp swept');
    assert.ok(live.read(), 'a live entry of another identity stays');
  });
});
