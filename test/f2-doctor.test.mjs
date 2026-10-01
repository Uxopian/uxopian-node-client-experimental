// FAST-5876: `uxc doctor --f2` answers "can I work on this broker now?" in one read-only call —
// the rc5 probe order (anonymous auth-required -> login -> authed /actuator/info -> maps ->
// campaigns -> workers -> catalog gate; never /api/broker/health), deploy readiness from the
// running campaigns, worker liveness from `lastSeen`, `uxc f2 lib push` advice for a missing
// connector jar, a `--json` summary, and "store down" told apart from bad credentials
// (FAST2-LEARNINGS §F21–§F24, §F32/§F33). Offline: a local stub broker, uxc as a subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { ageText, workersText, LIB_PUSH_ADVICE } from '../lib/commands/doctor.mjs';

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION', 'UXC_F2_OPENSEARCH'];

function uxc(args, { cwd, home, env = {} }) {
  return new Promise((done) => {
    const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
    const child = spawn(process.execPath, [UXC, ...args], {
      cwd,
      env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr, all: stdout + stderr }));
  });
}

/**
 * An rc5-shaped broker. `campaigns` = {name: status}; `workers` = the /api/workers collection;
 * `loginStatus` != 200 makes every login fail with that status. Records every request in order.
 */
async function stubBroker({ campaigns = {}, workers = [{ workerId: '256e611f-aaaa', hostname: 'w', lastSeen: 2667 }],
  catalog = [{ name: 'com.fast2.filesystem.LocalSource' }], loginStatus = 200 } = {}) {
  const seen = [];
  let logins = 0;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const authed = req.headers.authorization === 'Bearer T1';
    seen.push({ method: req.method, path, authed });
    if (path === '/api/auth/is-authentication-required') return json(res, 200, true); // public
    if (path === '/api/auth/login') {
      logins += 1;
      if (loginStatus !== 200) return json(res, loginStatus, { status: loginStatus, error: 'boom', message: 'store' });
      return json(res, 200, { accessToken: 'T1', refreshToken: 'R', tokenType: 'BEARER' });
    }
    if (!authed) return json(res, 403, { status: 403, error: 'Forbidden', path });
    if (path === '/actuator/info') return json(res, 200, { build: { version: '2026.0.0-rc5', artifact: 'fast2-broker-rest-server' } });
    if (path === '/api/broker/health') return json(res, 403, { status: 403, error: 'Forbidden', path });
    if (path === '/api/maps/summary/search-by-pattern') {
      return json(res, 200, { total: 1, collection: [{ id: { mapId: 'm-1' }, name: 'ZzMap', versionNumber: 1 }] });
    }
    if (path === '/api/campaigns/search-by-pattern') {
      const names = Object.keys(campaigns);
      return json(res, 200, { total: names.length, collection: names });
    }
    const st = path.match(/^\/api\/campaigns\/(.+)\/status$/);
    if (st && campaigns[st[1]]) return json(res, 200, campaigns[st[1]]); // a bare JSON string (§F33)
    if (path === '/api/workers') return json(res, 200, { total: workers.length, collection: workers });
    if (path === '/api/catalog') return json(res, 200, catalog);
    return json(res, 404, { error: 'Not Found', path });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    seen,
    logins: () => logins,
    env: { UXC_F2_URL: base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

const tmp = () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2doc-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Run doctor against a stub with the given options; always cleans up. */
async function doctor(opts, args = ['doctor', '--f2'], { inPkg = false } = {}) {
  const b = await stubBroker(opts);
  const w = tmp();
  try {
    let cwd = w.dir;
    if (inPkg) {
      cwd = join(w.dir, 'pkg');
      mkdirSync(cwd);
      assert.equal((await uxc(['init', '--name', 'Zz', '--code', 'zz'], { cwd, home: w.home, env: b.env })).status, 0);
      const add = await uxc(['add', 'f2.map', 'ZzMap'], { cwd, home: w.home, env: b.env });
      assert.equal(add.status, 0, add.all);
      b.seen.length = 0; // only doctor's requests count
    }
    const r = await uxc(args, { cwd, home: w.home, env: b.env });
    return { ...r, seen: b.seen, logins: b.logins() };
  } finally { b.close(); w.cleanup(); }
}

test('ageText / workersText: lastSeen is an age in ms', () => {
  assert.equal(ageText(950), '<1s');
  assert.equal(ageText(2667), '2.7s');
  assert.equal(ageText(42_000), '42s');
  assert.equal(ageText(125_000), '2m');
  assert.equal(ageText(7_200_000), '2h');
  assert.equal(ageText(undefined), '?');
  assert.equal(workersText([{ workerId: '256e611f-aaaa', lastSeen: 2667 }]), '1 worker(s): 256e611f lastSeen 2.7s ago');
  assert.equal(workersText([]), '0 worker(s)');
});

test('Fast2-only target: only Fast2 checks, in the rc5 probe order; /api/broker/health is never called', async () => {
  const r = await doctor({ campaigns: { ZzDone_Run1: 'Finished' } });
  assert.equal(r.status, 0, r.all);
  assert.doesNotMatch(r.all, /core auth|gateway JWT|dialect flowerdocs|gui caches|\/rest\//);
  assert.ok(!r.seen.some((s) => s.path === '/api/broker/health'), 'broker/health is not a probe on rc5');
  const first = (pred) => r.seen.findIndex(pred);
  const order = [
    first((s) => s.path === '/api/auth/is-authentication-required'),
    first((s) => s.path === '/api/auth/login'),
    first((s) => s.path === '/actuator/info'),
    first((s) => s.path === '/api/maps/summary/search-by-pattern'),
    first((s) => s.path === '/api/campaigns/search-by-pattern'),
    first((s) => s.path === '/api/workers'),
    first((s) => s.path === '/api/catalog'),
  ];
  assert.ok(order.every((i) => i >= 0), `every probe ran: ${r.seen.map((s) => s.path).join(', ')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `probe order: ${r.seen.map((s) => s.path).join(' -> ')}`);
  assert.equal(order[0], 0, 'the anonymous probe comes first');
  assert.equal(r.seen[0].authed, false, 'it carries no token');
  const info = r.seen.find((s) => s.path === '/actuator/info');
  assert.equal(info.authed, true, '/actuator/info is called with the token');
  assert.equal(r.logins, 1, 'one login');
  assert.ok(r.seen.every((s) => s.method === 'GET' || s.path === '/api/auth/login'), 'read-only: only GETs besides the login');
  assert.match(r.all, /ok\s+f2 auth required\s+yes/);
});

test('a campaign in Started -> deploy-safe: NO (campaign <name> running) — lib push would be refused, exit 1', async () => {
  const r = await doctor({ campaigns: { ZzDone_Run1: 'Finished', ZzLive_Run2: 'Started' } });
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /deploy-safe: NO \(campaign ZzLive_Run2 running\) — lib push would be refused/);
  assert.doesNotMatch(r.all, /deploy-safe: yes/);
});

test('a campaign in Starting also makes it not deploy-safe', async () => {
  const r = await doctor({ campaigns: { ZzBoot_Run1: 'Starting' } });
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /deploy-safe: NO \(campaign ZzBoot_Run1 running\) — lib push would be refused/);
});

test('no running campaign -> deploy-safe: yes with the worker count and their lastSeen age', async () => {
  const r = await doctor({
    campaigns: { ZzDone_Run1: 'Finished', ZzHalt_Run1: 'Stopped' },
    workers: [{ workerId: '256e611f-aaaa', lastSeen: 2667 }, { workerId: '9f00aa11-bbbb', lastSeen: 42_000 }],
  });
  assert.equal(r.status, 0, r.all);
  assert.match(r.all, /deploy-safe: yes — 2 worker\(s\): 256e611f lastSeen 2\.7s ago, 9f00aa11 lastSeen 42s ago/);
  assert.match(r.all, /ok\s+f2 workers\s+2 worker\(s\)/);
});

test('f2.map package + a class missing from the catalog -> `uxc f2 lib push <jar>` advice, not "restart the worker"', async () => {
  const r = await doctor({}, ['doctor', '--f2'], { inPkg: true });
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /FAIL f2 connector jars\s+.*com\.fast2\.flowerdocs\.FlowerInjector.*NOT in the worker catalog/);
  assert.ok(r.all.includes('`uxc f2 lib push <jar>` (refused while a campaign runs; the broker restarts the workers itself)'), r.all);
  assert.ok(r.all.includes(LIB_PUSH_ADVICE));
  assert.doesNotMatch(r.all, /restart the worker/);
});

test('--json carries {auth, version, dialect, maps, campaigns:{total, running}, workers, deploySafe}', async () => {
  const r = await doctor({ campaigns: { ZzDone_Run1: 'Finished', ZzLive_Run2: 'Started' } }, ['doctor', '--f2', '--json']);
  assert.equal(r.status, 1, r.all);
  const out = JSON.parse(r.stdout);
  const j = out.result ?? out;
  for (const k of ['auth', 'version', 'dialect', 'maps', 'campaigns', 'workers', 'deploySafe']) assert.ok(k in j, `has ${k}`);
  assert.deepEqual(j.auth, { required: true, ok: true, user: 'ops@example.invalid' });
  assert.equal(j.version, '2026.0.0-rc5');
  assert.equal(j.dialect, 'f2-2026');
  assert.deepEqual(j.maps, { total: 1, duplicates: [] });
  assert.deepEqual(j.campaigns, { total: 2, running: [{ name: 'ZzLive_Run2', status: 'Started' }] });
  assert.equal(j.workers.total, 1);
  assert.deepEqual(j.workers.collection[0], { workerId: '256e611f-aaaa', hostname: 'w', lastSeenMs: 2667 });
  assert.equal(j.deploySafe, false);
  assert.ok(j.report.some((x) => x.check === 'f2 deploy-safe' && x.ok === false));
});

test('a 5xx on login reads as "store down" (broker restart), not bad credentials; one login, no retry', async () => {
  const r = await doctor({ loginStatus: 500 });
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /FAIL f2 auth\s+.*-> 500.*store \(OpenSearch\) is down.*NOT a credentials problem.*broker restart/);
  assert.doesNotMatch(r.all, /check --f2-user/);
  assert.equal(r.logins, 1);
  assert.ok(!r.seen.some((s) => s.path !== '/api/auth/is-authentication-required' && s.path !== '/api/auth/login'), 'nothing else after a failed login');
});

test('a 401 on login still reads as bad credentials (not the store)', async () => {
  const r = await doctor({ loginStatus: 401 });
  assert.equal(r.status, 1, r.all);
  assert.match(r.all, /FAIL f2 auth\s+.*check --f2-user\/--f2-password/);
  assert.doesNotMatch(r.all, /store \(OpenSearch\)/);
  assert.equal(r.logins, 1);
});
