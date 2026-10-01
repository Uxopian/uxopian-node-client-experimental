// FAST-5875: a Fast2-only target — a broker and no FlowerDocs instance. No FlowerDocs / Uxopian AI
// field is required (config, `target add`, http); `uxc f2 …` and `doctor --f2` work and attempt no
// FlowerDocs check; a FlowerDocs / AI command refuses before any network call through ONE guard
// (lib/http.mjs noSurface); FD+AI(+F2) targets behave exactly as before. Offline: a local stub
// broker, uxc run as a subprocess with UXC_HOME in a tmp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { resolveTarget } from '../lib/config.mjs';
import { createClients } from '../lib/http.mjs';

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION'];
const NOPE = 'zzz-nonexistent-target'; // unknown name => base {} => resolution is pure-env
const F2_ENV = { UXC_F2_URL: 'http://127.0.0.1:1/', UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' };
const NO_SURFACE = /target \S+ has no FlowerDocs surface/;

function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/** Run uxc asynchronously (the stub broker lives in THIS process, so spawnSync would deadlock). */
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

/** A minimal rc5-shaped broker: login, version, maps, catalog, campaigns. Records every path. */
async function stubBroker() {
  const seen = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    seen.push(path);
    if (path === '/api/auth/login') return json(res, 200, { accessToken: 'T1', refreshToken: 'R', tokenType: 'BEARER' });
    if (req.headers.authorization !== 'Bearer T1') return json(res, 403, { status: 403, error: 'Forbidden', path });
    if (path === '/actuator/info') return json(res, 200, { build: { version: '2026.0.0-rc5', artifact: 'fast2-broker-rest-server' } });
    if (path === '/api/maps/summary/search-by-pattern') {
      return json(res, 200, { total: 1, collection: [{ id: { mapId: 'm-1' }, name: 'ZzMap', versionNumber: 1 }] });
    }
    if (path === '/api/catalog') return json(res, 200, [{ name: 'com.fast2.filesystem.LocalSource' }]);
    if (path === '/api/campaigns/search-by-pattern') return json(res, 200, { total: 0, collection: [] });
    return json(res, 404, { error: 'Not Found', path });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

const tmp = () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2only-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// --- config ------------------------------------------------------------------------------------

test('resolveTarget: f2 only (env) -> valid, core/gateway/gui null, fd false', () => {
  withEnv(F2_ENV, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.fd, false);
    assert.equal(t.core, null);
    assert.equal(t.gateway, null);
    assert.equal(t.ai, null);
    assert.equal(t.gui, null);
    assert.equal(t.f2, 'http://127.0.0.1:1'); // trimmed
    assert.equal(t.f2User, 'ops@example.invalid');
  });
});

test('resolveTarget: f2 plus SOME FlowerDocs field is still a FlowerDocs target and must be complete', () => {
  withEnv({ ...F2_ENV, UXC_SCOPE: 'S' }, () => {
    assert.throws(() => resolveTarget(NOPE), /incomplete \(missing: core URL, uxopian-ai URL, user, password\)/);
  });
});

test('resolveTarget: no f2 and no FlowerDocs field -> the incomplete error, which names the Fast2-only form', () => {
  withEnv({}, () => {
    assert.throws(() => resolveTarget(NOPE), (e) => /incomplete/.test(e.message) && /Fast2-only target needs only: --f2/.test(e.message));
  });
});

test('regression: an FD + AI + F2 target resolves exactly as before (fd true, every base set)', () => {
  withEnv({
    UXC_CORE_URL: 'https://h.example/core', UXC_AI_URL: 'https://h.example/gui/plugins/X/gateway/uxopian-ai',
    UXC_SCOPE: 'X', UXC_USER: 'u', UXC_PASSWORD: 'p', ...F2_ENV,
  }, () => {
    const t = resolveTarget(NOPE);
    assert.equal(t.fd, true);
    assert.equal(t.core, 'https://h.example/core');
    assert.equal(t.gateway, 'https://h.example/gui/plugins/X/gateway/uxopian-ai');
    assert.equal(t.gui, 'https://h.example/gui');
    assert.equal(t.f2, 'http://127.0.0.1:1');
    assert.equal(t.scope, 'X');
  });
});

// --- http: the one shared guard -----------------------------------------------------------------

test('createClients on a Fast2-only target: every FD / AI use goes through one guard, before any request', async () => {
  const t = withEnv(F2_ENV, () => resolveTarget(NOPE));
  const c = createClients(t);
  assert.ok(c.f2, 'the fast2 client exists');
  for (const [label, use] of [
    ['core.get', () => c.core.get('/rest/tagclass')],
    ['core.search', () => c.core.search({ classId: 'X' })],
    ['core.base', () => c.core.base],
    ['gateway.get', () => c.gateway.get('/api/v1/prompts')],
    ['gui.raw', () => c.gui.raw('GET', '/rest/caches')],
  ]) {
    assert.throws(use, (e) => e.code === 'UXC_NO_SURFACE' && NO_SURFACE.test(e.message), label);
  }
  await assert.rejects(c.auth(), (e) => e.code === 'UXC_NO_SURFACE');
  await assert.rejects(c.cacheClear(), (e) => e.code === 'UXC_NO_SURFACE');
});

test('createClients on an FD target is unchanged: real surfaces with their bases', () => {
  const c = createClients({ name: 't', core: 'https://h.example/core', gateway: 'https://h.example/g/uxopian-ai', gui: 'https://h.example/gui', scope: 'S', user: 'u', password: 'p', fd: true });
  assert.equal(c.core.base, 'https://h.example/core');
  assert.equal(c.gateway.base, 'https://h.example/g/uxopian-ai');
  assert.equal(c.gui.base, 'https://h.example/gui');
  assert.equal(c.f2, null);
});

// --- CLI ---------------------------------------------------------------------------------------

test('target add with only the --f2 flags saves a Fast2-only target (null FD bases); target ls shows it', async () => {
  const w = tmp();
  try {
    const add = await uxc(['target', 'add', 'zf', '--f2', 'http://127.0.0.1:1/', '--f2-user', 'ops@example.invalid',
      '--f2-password', 'p', '--json'], { cwd: w.dir, home: w.home });
    assert.equal(add.status, 0, add.all);
    const r = JSON.parse(add.stdout);
    const result = r.result ?? r;
    assert.equal(result.name, 'zf');
    assert.equal(result.core, null);
    assert.equal(result.ai, null);
    assert.equal(result.gui, null);
    assert.equal(result.f2, 'http://127.0.0.1:1');
    assert.doesNotMatch(add.all, /DERIVED/, 'no derived-base warnings: there is no FD base at all');

    const ls = await uxc(['target', 'ls'], { cwd: w.dir, home: w.home });
    assert.equal(ls.status, 0, ls.all);
    assert.match(ls.stdout, /zf\s+\(none\)\s+\(none\)/);
    assert.match(ls.stdout, /http:\/\/127\.0\.0\.1:1/);

    const half = await uxc(['target', 'add', 'zh', '--f2', 'http://127.0.0.1:1', '--f2-user', 'a@example.invalid',
      '--f2-password', 'p', '--scope', 'S'], { cwd: w.dir, home: w.home });
    assert.notEqual(half.status, 0, 'one FD flag makes it an FD target, which must be complete');
    assert.match(half.all, /missing: --core \(or legacy --url\) --user --password/);

    const noCreds = await uxc(['target', 'add', 'zn', '--f2', 'http://127.0.0.1:1'], { cwd: w.dir, home: w.home });
    assert.notEqual(noCreds.status, 0);
    assert.match(noCreds.all, /missing: --f2-user --f2-password/);
  } finally { w.cleanup(); }
});

test('regression: target add with FD + AI + F2 flags prints and returns the same as before', async () => {
  const w = tmp();
  try {
    const add = await uxc(['target', 'add', 't1', '--core', 'http://h:8080/core', '--gui', 'http://h:8080/gui',
      '--ai', 'http://h:8080/gui/plugins/S/gateway/uxopian-ai', '--scope', 'S', '--user', 'u', '--password', 'p',
      '--f2', 'http://h:1789', '--f2-user', 'a@example.invalid', '--f2-password', 'q', '--json'], { cwd: w.dir, home: w.home });
    assert.equal(add.status, 0, add.all);
    const r = JSON.parse(add.stdout);
    assert.deepEqual(r.result ?? r, {
      name: 't1', core: 'http://h:8080/core', ai: 'http://h:8080/gui/plugins/S/gateway/uxopian-ai',
      gui: 'http://h:8080/gui', f2: 'http://h:1789', scope: 'S', default: true,
    });
  } finally { w.cleanup(); }
});

test('doctor --f2 and f2 ls work on an env-only Fast2-only target; no FlowerDocs check is attempted', async () => {
  const b = await stubBroker();
  const w = tmp();
  try {
    const env = { UXC_F2_URL: b.base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' };
    const doc = await uxc(['doctor', '--f2'], { cwd: w.dir, home: w.home, env });
    assert.equal(doc.status, 0, doc.all);
    assert.doesNotMatch(doc.all, /FAIL/);
    assert.doesNotMatch(doc.all, /core auth|gateway JWT|dialect flowerdocs|dialect uxopian-ai|gui caches|\/rest\//);
    assert.match(doc.all, /Fast2-only/);
    assert.match(doc.all, /ok\s+f2 auth/);
    assert.match(doc.all, /dialect fast2\s+2026\.0\.0-rc5/);
    assert.match(doc.all, /ok\s+f2 maps\s+1 map\(s\)/);

    const ls = await uxc(['f2', 'ls'], { cwd: w.dir, home: w.home, env });
    assert.equal(ls.status, 0, ls.all);
    assert.match(ls.stdout, /ZzMap\s+1\s+m-1/);
    assert.ok(b.seen.every((p) => p.startsWith('/api/') || p === '/actuator/info'), `only broker paths: ${b.seen.join(', ')}`);
  } finally { b.close(); w.cleanup(); }
});

test('a FlowerDocs / AI command on a Fast2-only target refuses before any network call', async () => {
  const b = await stubBroker();
  const w = tmp();
  try {
    const env = { UXC_F2_URL: b.base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' };
    const pkg = join(w.dir, 'pkg');
    mkdirSync(pkg);
    assert.equal((await uxc(['init', '--name', 'Zz', '--code', 'zz'], { cwd: pkg, home: w.home, env })).status, 0);
    assert.equal((await uxc(['add', 'fd.handler', 'ZzDoc_onCreate'], { cwd: pkg, home: w.home, env })).status, 0);

    const st = await uxc(['status', 'fd.handler', '--remote'], { cwd: pkg, home: w.home, env });
    assert.notEqual(st.status, 0);
    assert.match(st.all, NO_SURFACE);

    const search = await uxc(['search', 'ZzClass'], { cwd: pkg, home: w.home, env });
    assert.notEqual(search.status, 0);
    assert.match(search.all, NO_SURFACE);

    const doc = await uxc(['doctor', '--ready'], { cwd: pkg, home: w.home, env });
    assert.match(doc.all, /FAIL flowerdocs surface\s+--ready: target \S+ has no FlowerDocs surface/);

    assert.deepEqual(b.seen.filter((p) => !p.startsWith('/api/') && p !== '/actuator/info'), [], 'nothing FlowerDocs-shaped was requested');
  } finally { b.close(); w.cleanup(); }
});
