// FAST-5874 review fixes (REVIEW feat/fast2 #1, #3, #6, #10): the fast2 client's login state.
//   - login() returns the token in hand while it is fresh; { force: true } logs in again.
//   - the anti-lockout cooldown counts FAILED logins only (the broker locks after 3 failures).
//   - a 401 the client cannot re-log-in for (cooldown after a failure, or a token that was itself
//     just refused) surfaces the BROKER's 401 and says the re-login was skipped.
//   - a 403 on a token the broker already accepted is a real refusal, whatever its body shape.
//   - one process, one f2 client: f2 ls -> f2 status -> doctor --f2 = one login, no cooldown error
//     (the live rc5 repro).
//   - a named Fast2-only target stays Fast2-only whatever FlowerDocs env vars are exported.
// Offline: a local HTTP stub, commands run in-process on one shared client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { f2Surface, createClients } from '../lib/http.mjs';
import { resolveTarget } from '../lib/config.mjs';
import f2Ls from '../lib/commands/f2-ls.mjs';
import f2Status from '../lib/commands/f2-status.mjs';
import doctor from '../lib/commands/doctor.mjs';

const INVALID = { status: 'INVALID', message: 'Invalid compact JWT string' };
const GENERIC = { timestamp: '2026-10-01T00:00:00Z', status: 403, error: 'Forbidden', path: '/x' };
const COOLDOWN_TEXT = /refusing to re-authenticate|failed logins|after the last attempt/;

/** 403 bodies of every shape a role refusal may take (Spring hides `message` by default). */
const SHAPES = [
  ['json', GENERIC],
  ['json', { ...GENERIC, message: 'Access Denied' }],
  ['json', { ...GENERIC, message: '' }],
  ['json', {}],
  ['json', []],
  ['json', null],
  ['text', ''],
  ['text', 'Forbidden'],
  ['text', 'An unexpected error occurred. Please retry'],
];

/**
 * A stub broker. Login mints T1, T2, … and accepts them unless `acceptNew` is false;
 * `loginStatus` != 200 makes logins fail. `valid` holds the tokens the broker currently accepts.
 */
async function stubBroker() {
  const state = { logins: 0, hits: {}, valid: new Set(), loginStatus: 200, acceptNew: true, statusPolls: 0 };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const text = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(body); };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    state.hits[req.url] = (state.hits[req.url] ?? 0) + 1;
    if (path === '/api/auth/is-authentication-required') return json(res, 200, true);
    if (path === '/api/auth/login') {
      state.logins += 1;
      if (state.loginStatus !== 200) return json(res, state.loginStatus, { status: 'INVALID', message: 'Bad credentials' });
      const t = `T${state.logins}`;
      if (state.acceptNew) state.valid.add(t);
      return json(res, 200, { accessToken: t, refreshToken: 'R', tokenType: 'BEARER' });
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!token) return json(res, 403, { ...GENERIC, path });
    if (!state.valid.has(token)) return json(res, 401, INVALID);
    if (path === '/api/role-403') {
      const [kind, body] = SHAPES[Number(u.searchParams.get('shape'))];
      return kind === 'json' ? json(res, 403, body) : text(res, 403, body);
    }
    if (path === '/api/ok') return json(res, 200, { ok: token });
    if (path === '/actuator/info') return json(res, 200, { build: { version: '2026.0.0-rc5', artifact: 'fast2-broker-rest-server' } });
    if (path === '/api/maps/summary/search-by-pattern') {
      return json(res, 200, { total: 1, collection: [{ id: { mapId: 'm-1' }, name: 'ZzMap', versionNumber: 1 }] });
    }
    if (path === '/api/maps/m-1') return json(res, 200, { id: 'm-1', name: 'ZzMap', steps: [{ id: 's1', name: '1. Read' }] });
    if (path === '/api/campaigns/search-by-pattern') return json(res, 200, { total: 1, collection: ['ZzMap_Run1'] });
    if (path === '/api/campaigns/ZzMap_Run1/status') { state.statusPolls += 1; return json(res, 200, 'Finished'); }
    if (path === '/api/campaigns/ZzMap_Run1/stats') {
      return json(res, 200, {
        campaign: 'ZzMap_Run1', taskFlowMapRef: { mapId: 'm-1' }, startDate: '2026-10-01T10:00:00Z', finishDate: '2026-10-01T10:00:05Z',
        taskStepStat: { s1: { stats: { ProcessedOK: { total: 3, speed: 1 } } } },
      });
    }
    if (path === '/api/workers') return json(res, 200, { total: 1, collection: [{ workerId: 'w1', hostname: 'h', lastSeen: 900 }] });
    if (path === '/api/catalog') return json(res, 200, [{ name: 'com.fast2.filesystem.LocalSource' }]);
    return json(res, 404, { error: 'Not Found', path });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const target = {
    name: 'zz', url: null, scope: null, user: null, password: null, core: null, gui: null, gateway: null, ai: null,
    fd: false, f2: base, f2User: 'ops@example.invalid', f2Password: 'p',
  };
  return { state, base, target, close: () => { server.closeAllConnections?.(); server.close(); } };
}

// ---- #1 / S5: login() reuses a fresh token; the cooldown counts failed logins only -----------

test('login() returns the token in hand while it is fresh; { force: true } logs in again, no cooldown error', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target); // the real 30 s cooldown
    assert.equal(await f2.login(), 'T1');
    assert.equal(await f2.login(), 'T1', 'a second login() is a no-op while the token is fresh');
    assert.deepEqual(await f2.get('/api/ok'), { ok: 'T1' });
    assert.equal(b.state.logins, 1);
    assert.equal(await f2.login({ force: true }), 'T2', 'a successful login does not start the cooldown');
    assert.equal(b.state.logins, 2);
  } finally { b.close(); }
});

test('a FAILED login starts the cooldown: the next attempt inside it never reaches the broker', async () => {
  const b = await stubBroker();
  try {
    b.state.loginStatus = 401;
    const f2 = f2Surface(b.target);
    await assert.rejects(f2.login(), (e) => e.status === 401 && /login failed/.test(e.explanation));
    await assert.rejects(f2.login({ force: true }), (e) => {
      assert.match(e.message, /refusing to re-authenticate to fast2: the last fast2 login for this broker \+ user failed \d+s ago — retry in \d+s \(at \d\d:\d\d:\d\d\)/);
      assert.equal(e.code, 'UXC_F2_COOLDOWN');
      return true;
    });
    assert.equal(b.state.logins, 1, 'one attempt reached the broker');
  } finally { b.close(); }
});

// ---- #3: a 401 inside the cooldown shows the broker's 401 -------------------------------------

test('a 401 right after a SUCCESSFUL login re-logs-in (no cooldown) and replays once', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target); // the real 30 s cooldown
    assert.deepEqual(await f2.get('/api/ok'), { ok: 'T1' });
    b.state.valid.delete('T1'); // the broker restarted with a new key pair (§F22)
    assert.deepEqual(await f2.get('/api/ok'), { ok: 'T2' });
    assert.equal(b.state.logins, 2);
  } finally { b.close(); }
});

test('a 401 inside the failed-login cooldown surfaces the broker\'s 401 and says the re-login was skipped', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target);
    await f2.get('/api/ok');
    b.state.valid.clear();
    b.state.loginStatus = 401; // the account was disabled mid-run
    await assert.rejects(f2.get('/api/ok'), (e) => e.status === 401 && /\/api\/auth\/login/.test(e.url));
    await assert.rejects(f2.get('/api/ok'), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.url, /\/api\/ok$/);
      assert.match(e.message, /Invalid compact JWT string/, 'the broker body is kept');
      assert.match(e.explanation, /re-login skipped/);
      assert.match(e.explanation, /failed login/);
      assert.doesNotMatch(e.message, COOLDOWN_TEXT);
      return true;
    });
    assert.equal(b.state.logins, 2, 'the initial login + the one failed re-login, nothing inside the cooldown');
  } finally { b.close(); }
});

test('a 401 that survives a freshly minted token: one re-login, then the 401 is surfaced (no login storm)', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 });
    await f2.get('/api/ok');
    b.state.valid.clear();
    b.state.acceptNew = false; // every new token is refused too (clock skew, wrong key)
    for (let i = 0; i < 3; i++) {
      await assert.rejects(f2.get('/api/ok'), (e) => e.status === 401 && /Invalid compact JWT/.test(e.message));
    }
    assert.equal(b.state.logins, 2, 'one initial login + one re-login, never more');
    const err = await f2.get('/api/ok').catch((e) => e);
    assert.match(err.explanation, /re-login skipped/);
  } finally { b.close(); }
});

// ---- REVIEW N3: forced 401 re-logins are bounded in time, not per token forever --------------

test('N3: a token refused right after its re-login is retried once the re-login interval has passed (liveness)', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0, reloginIntervalMs: 50 });
    await f2.get('/api/ok');
    b.state.valid.clear();
    b.state.acceptNew = false; // a restart in progress: the first fresh token is refused too
    await assert.rejects(f2.get('/api/ok'), (e) => e.status === 401);
    assert.equal(b.state.logins, 2);
    b.state.acceptNew = true; // the broker is back
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(await f2.get('/api/ok'), { ok: 'T3' }, 'a new re-login after the interval, not stuck on the refused token');
    assert.equal(b.state.logins, 3);
  } finally { b.close(); }
});

test('N3: a broker that 401s every other call (flapping keys) costs at most one re-login per interval', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 }); // default 30 s interval
    await f2.get('/api/ok');
    let surfaced = 0;
    for (let i = 0; i < 5; i++) {
      b.state.valid.clear(); // the "other node" refuses whatever token we hold
      const r = await f2.raw('GET', '/api/ok');
      if (r.status === 401) { surfaced += 1; assert.match(r.reloginSkipped, /at most one per 30s|refused too/); }
    }
    assert.equal(b.state.logins, 2, 'the initial login + one re-login, not one per call');
    assert.equal(surfaced, 4);
  } finally { b.close(); }
});

// ---- #6: a 403 on an accepted token is real, whatever its body ------------------------------

test('after a successful call, a 403 of ANY body shape is a real refusal: no login, no replay', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 }); // no cooldown to hide behind
    await f2.get('/api/ok');
    for (let i = 0; i < SHAPES.length; i++) {
      await assert.rejects(f2.get(`/api/role-403?shape=${i}`), (e) => {
        assert.equal(e.status, 403, `shape ${i}`);
        assert.doesNotMatch(e.message, COOLDOWN_TEXT);
        return true;
      });
      assert.equal(b.state.hits[`/api/role-403?shape=${i}`], 1, `shape ${i} is not replayed`);
    }
    assert.equal(b.state.logins, 1, 'never a re-login for a 403 on an accepted token');
  } finally { b.close(); }
});

// ---- #1: the live repro — one process, one client, f2 ls -> f2 status -> doctor --f2 -------

/** A minimal in-process ctx on a SHARED client set, as a library driver (connect()) holds it. */
function ctxOn(clients, target, { args = [], flags = {} } = {}) {
  const logs = [];
  const rec = (k) => (...a) => logs.push(`${k} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
  const ctx = {
    args, flags, logs, pkg: null,
    out: { json: false, compact: false, result: rec('result'), line: rec('line'), note: rec('note'), warn: rec('warn'), table: rec('table'), diff: rec('diff') },
    requirePkg() { throw new Error('no uxopian package here'); },
    connect() { ctx.target = target; ctx.clients = clients; return clients; },
  };
  return ctx;
}

/** createClients() caches the f2 token under UXC_HOME (FAST-5884): never under the real home. */
async function isolatedHome(fn) {
  const saved = process.env.UXC_HOME;
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2state-home-'));
  process.env.UXC_HOME = dir;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.UXC_HOME; else process.env.UXC_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('regression (live rc5): one client runs f2 ls, f2 status, then doctor --f2 — one login, no cooldown error', () => isolatedHome(async () => {
  const b = await stubBroker();
  const saved = { exitCode: process.exitCode, v: process.env.UXC_F2_VERSION, os: process.env.UXC_F2_OPENSEARCH };
  delete process.env.UXC_F2_VERSION;
  delete process.env.UXC_F2_OPENSEARCH;
  try {
    const clients = createClients(b.target); // the default 30 s cooldown, as on a real run
    const ls = ctxOn(clients, b.target);
    await f2Ls.run(ls);
    assert.ok(ls.logs.some((l) => /1 map\(s\)/.test(l)), ls.logs.join('\n'));

    const st = ctxOn(clients, b.target, { args: ['ZzMap_Run1'] });
    await f2Status.run(st);
    assert.ok(st.logs.some((l) => /ZzMap_Run1\s+Finished/.test(l)), st.logs.join('\n'));

    process.exitCode = undefined;
    const doc = ctxOn(clients, b.target, { flags: { f2: true } });
    await doctor.run(doc);
    const all = doc.logs.join('\n');
    assert.doesNotMatch(all, COOLDOWN_TEXT);
    assert.doesNotMatch(all, /FAIL/);
    assert.match(all, /ok\s+f2 auth\s+ops@example\.invalid/);
    assert.match(all, /ok\s+f2 maps/);
    assert.match(all, /ok\s+f2 workers/);
    assert.notEqual(process.exitCode, 1, all);
    assert.equal(b.state.logins, 1, 'the three commands share ONE login');
  } finally {
    process.exitCode = saved.exitCode;
    if (saved.v !== undefined) process.env.UXC_F2_VERSION = saved.v;
    if (saved.os !== undefined) process.env.UXC_F2_OPENSEARCH = saved.os;
    b.close();
  }
}));

test('doctor --f2 on a client whose token the broker no longer accepts: re-logs-in once and passes', () => isolatedHome(async () => {
  const b = await stubBroker();
  const saved = process.exitCode;
  try {
    const clients = createClients(b.target);
    await clients.f2.get('/api/ok');
    b.state.valid.clear(); // the broker restarted
    const doc = ctxOn(clients, b.target, { flags: { f2: true } });
    await doctor.run(doc);
    const all = doc.logs.join('\n');
    assert.match(all, /ok\s+f2 auth/);
    assert.doesNotMatch(all, /FAIL|refusing/);
    assert.equal(b.state.logins, 2);
  } finally { process.exitCode = saved; b.close(); }
}));

// ---- #10: FlowerDocs env vars never turn a named Fast2-only target into an FD target ---------

const ENV_KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_HOME'];

function withHome(targets, vars, fn) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2prec-'));
  mkdirSync(join(dir, '.uxopian'));
  writeFileSync(join(dir, '.uxopian', 'targets.json'), JSON.stringify({ default: null, targets }));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { UXC_HOME: dir, ...vars });
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
}

const F2_ONLY = { f2: 'http://127.0.0.1:1', f2User: 'ops@example.invalid', f2Password: 'p' };

test('a NAMED Fast2-only target stays Fast2-only when UXC_SCOPE / UXC_USER / UXC_PASSWORD are exported', () => {
  withHome({ zf: F2_ONLY }, { UXC_SCOPE: 'OTHER', UXC_USER: 'someone', UXC_PASSWORD: 'x', UXC_CORE_URL: 'https://h.example/core' }, () => {
    const t = resolveTarget('zf');
    assert.equal(t.fd, false);
    assert.equal(t.core, null);
    assert.equal(t.scope, null);
    assert.equal(t.user, null);
    assert.equal(t.f2, 'http://127.0.0.1:1');
  });
});

test('env FlowerDocs vars still complete a stored FlowerDocs target, and env still drives an env-only target', () => {
  const fdStored = { core: 'https://h.example/core', ai: 'https://h.example/gui/plugins/S/gateway/uxopian-ai', scope: 'S', user: 'u', ...F2_ONLY };
  withHome({ fd: fdStored }, { UXC_PASSWORD: 'from-env' }, () => {
    const t = resolveTarget('fd');
    assert.equal(t.fd, true);
    assert.equal(t.password, 'from-env');
  });
  // env-only (no stored entry): one FD env var still makes it an FD target, and the error names it
  withHome({}, { UXC_F2_URL: 'http://127.0.0.1:1', UXC_F2_USER: 'a@example.invalid', UXC_F2_PASSWORD: 'p', UXC_SCOPE: 'S' }, () => {
    assert.throws(() => resolveTarget('zzz-nonexistent'), (e) => /incomplete/.test(e.message) && /UXC_SCOPE/.test(e.message));
  });
});
