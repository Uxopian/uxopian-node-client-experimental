// FAST-5874 review fix (REVIEW feat/fast2 #4, + #3 in the long-running loops): every fast2 poll
// loop — `f2 status --watch`, `f2 run`, the `f2 lib push` worker wait — surfaces an auth or
// cooldown error at once and exits 2, instead of retrying it or replacing it with the cooldown
// text. A token the broker drops mid-loop is renewed once (a successful login starts no cooldown).
// A transport blip during the jar swap is still tolerated. Offline: a local stub broker, uxc run
// as a subprocess with UXC_HOME in a tmp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION', 'UXC_F2_OPENSEARCH'];
const COOLDOWN_TEXT = /refusing to re-authenticate|failed logins|after the last attempt/;

function uxc(args, { cwd, home, env = {} }) {
  return new Promise((done) => {
    const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
    const t0 = Date.now();
    const child = spawn(process.execPath, [UXC, ...args], {
      cwd,
      env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', CLAUDECODE: '', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr, all: stdout + stderr, ms: Date.now() - t0 }));
  });
}

/**
 * rc5-shaped stub. `on(event)` hooks let a test drop every token (`revoke()`), make every later
 * login fail (`state.loginStatus`), or cut one socket (`state.dropNextWorkers`).
 */
async function stubBroker({ statuses = ['Started', 'Started', 'Started', 'Finished'] } = {}) {
  const state = {
    logins: 0, valid: new Set(), loginStatus: 200, polls: 0, workerPolls: 0, swapped: false,
    revokeAtPoll: null, revokeAfterUpload: false, dropNextWorkers: 0, hooks: {},
  };
  const revoke = () => { state.valid.clear(); };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (path === '/api/auth/login') {
        state.logins += 1;
        if (state.loginStatus !== 200) return json(res, state.loginStatus, { status: 'INVALID', message: 'Bad credentials' });
        const t = `T${state.logins}`;
        state.valid.add(t);
        return json(res, 200, { accessToken: t, refreshToken: 'R', tokenType: 'BEARER' });
      }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.valid.has(token)) return json(res, 401, { status: 'INVALID', message: 'Invalid compact JWT string' });
      if (path === '/api/maps/summary/search-by-pattern') {
        return json(res, 200, { total: 1, collection: [{ id: { mapId: 'm-1' }, name: 'ZzMap', versionNumber: 1 }] });
      }
      if (path === '/api/maps/m-1') return json(res, 200, { id: 'm-1', name: 'ZzMap', steps: [{ id: 's1', name: '1. Read' }] });
      if (/^\/api\/campaigns\/[^/]+\/start$/.test(path)) return json(res, 200, 'ZzMap_Run1');
      if (path === '/api/campaigns/search-by-pattern') return json(res, 200, { total: 0, collection: [] });
      if (path === '/api/campaigns/ZzMap_Run1/status') {
        state.polls += 1;
        state.hooks.poll?.(state.polls, revoke);
        return json(res, 200, statuses[Math.min(state.polls, statuses.length) - 1]);
      }
      if (path === '/api/campaigns/ZzMap_Run1/stats') {
        return json(res, 200, { campaign: 'ZzMap_Run1', taskFlowMapRef: { mapId: 'm-1' }, taskStepStat: { s1: { stats: { ProcessedOK: { total: 2 } } } } });
      }
      if (path === '/api/workers') {
        if (state.swapped) state.workerPolls += 1;
        if (state.swapped && state.dropNextWorkers > 0) { state.dropNextWorkers -= 1; return req.socket.destroy(); }
        const w = state.swapped ? { workerId: 'w2', pid: 200, lastSeen: 300 } : { workerId: 'w1', pid: 100, lastSeen: 300 };
        return json(res, 200, { total: 1, collection: [w] });
      }
      if (path === '/api/workers/libraries') {
        const all = state.swapped ? [{ jarName: 'fast2-zz-1.0.jar' }] : [];
        return json(res, 200, { total: all.length, collection: all });
      }
      if (path === '/api/workers/upload-library') {
        state.swapped = true;
        state.hooks.upload?.(revoke);
        res.writeHead(200); return res.end();
      }
      return json(res, 404, { error: 'Not Found', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    env: { UXC_F2_URL: base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

async function withBroker(opts, fn) {
  const b = await stubBroker(opts);
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2poll-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const jar = join(dir, 'fast2-zz-1.0.jar');
  writeFileSync(jar, Buffer.from('PK\x03\x04 fake jar payload'));
  try {
    return await fn(b, (args) => uxc(args, { cwd: dir, home, env: b.env }), jar);
  } finally { b.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ---- f2 status --watch -------------------------------------------------------------------------

test('watch: the broker drops the token mid-watch -> one re-login, the watch goes on to Finished (exit 0)', async () => {
  await withBroker({}, async (b, run) => {
    b.state.hooks.poll = (n, revoke) => { if (n === 2) revoke(); };
    const r = await run(['f2', 'status', 'ZzMap_Run1', '--watch', '--interval', '0.05']);
    assert.equal(r.status, 0, r.all);
    assert.doesNotMatch(r.all, COOLDOWN_TEXT);
    assert.equal(b.state.logins, 2);
  });
});

test('watch: the re-login fails mid-watch -> the login failure is surfaced at once, exit 2', async () => {
  await withBroker({ statuses: ['Started'] }, async (b, run) => {
    b.state.hooks.poll = (n, revoke) => { if (n === 2) { revoke(); b.state.loginStatus = 401; } };
    const r = await run(['f2', 'status', 'ZzMap_Run1', '--watch', '--interval', '0.05', '--timeout', '30']);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /\/api\/auth\/login -> 401.*Bad credentials/);
    assert.match(r.stderr, /fast2 login failed/);
    assert.equal(b.state.logins, 2, 'the failed login is never retried');
    assert.ok(b.state.polls <= 3, `the loop stopped (${b.state.polls} polls)`);
  });
});

// ---- f2 run ------------------------------------------------------------------------------------

test('f2 run: an auth failure during the wait is surfaced, exit 2 — never polled to --wait', async () => {
  await withBroker({ statuses: ['Started'] }, async (b, run) => {
    b.state.hooks.poll = (n, revoke) => { if (n === 1) { revoke(); b.state.loginStatus = 401; } };
    const r = await run(['f2', 'run', 'ZzMap', '--wait', '60']);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /fast2 login failed/);
    assert.doesNotMatch(r.all, COOLDOWN_TEXT);
    assert.ok(r.ms < 20_000, `exited in ${r.ms} ms`);
  });
});

// ---- f2 lib push: the worker wait --------------------------------------------------------------

test('lib push: an auth failure in the worker wait is surfaced at once, exit 2 (not swallowed until --timeout)', async () => {
  await withBroker({}, async (b, run, jar) => {
    b.state.hooks.upload = (revoke) => { revoke(); b.state.loginStatus = 401; };
    const r = await run(['f2', 'lib', 'push', jar, '--yes', '--timeout', '20']);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /fast2 login failed/);
    assert.doesNotMatch(r.all, /no worker came back/);
    assert.equal(b.state.logins, 2, 'one re-login attempt, never retried');
    assert.ok(r.ms < 15_000, `exited in ${r.ms} ms`);
  });
});

test('lib push: a transport blip during the swap is still tolerated', async () => {
  await withBroker({}, async (b, run, jar) => {
    b.state.dropNextWorkers = 1;
    const r = await run(['f2', 'lib', 'push', jar, '--yes', '--timeout', '20']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /worker\s+w2 back after/);
    assert.ok(b.state.workerPolls >= 2);
  });
});
