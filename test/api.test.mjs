// uxc api <METHOD> <path> (#96): pure helpers + subprocess runs against a LOCAL http server that
// plays Core/GUI/gateway. Hermetic: UXC_HOME is a tmp dir, the target is env-only, nothing real
// is contacted. The CLI runs with spawn (not spawnSync) so this process can answer its requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import {
  resolveSurface, withQuery, parseHeaders, redactHeaders, readRequestBody, explainResponse,
  apiLockMode, isReadMethod, isReadCall, responseHeaderSubset,
} from '../lib/commands/api.mjs';
import { LOCK_MODES, COMMANDS } from '../lib/cli-meta.mjs';

const UXC = resolve('bin/uxc.mjs');
const TOKEN = 'SECRET-JWT-do-not-print-4242';

// ---------------------------------------------------------------- pure helpers

test('a POST to a FlowerDocs /rest/<x>/search is a read: no --yes, read lock; other POSTs stay writes', () => {
  for (const path of ['/rest/documents/search', '/core/rest/tasks/search', '/rest/virtualFolder/search/', '/rest/documents/search?max=5']) {
    assert.equal(isReadCall('POST', path), true, path);
    assert.equal(apiLockMode({}, ['POST', path]), 'read', path);
  }
  for (const path of ['/rest/documents', '/rest/documents/search/x', '/rest/tagclass/Foo', '/api/v1/search']) {
    assert.equal(isReadCall('POST', path), false, path);
    assert.equal(apiLockMode({}, ['POST', path]), 'none', path);
  }
  assert.equal(isReadCall('DELETE', '/rest/documents/search'), false);
});

test('lock mode is a function of the method: reads read, writes need --yes to take the write lock', () => {
  for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(apiLockMode({}, [m, '/x']), 'read');
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(apiLockMode({ yes: true }, [m, '/x']), 'write');
    assert.equal(apiLockMode({}, [m, '/x']), 'none'); // refused before any call: never queue for it
  }
  assert.equal(apiLockMode({}, []), 'none');
  assert.equal(apiLockMode({ yes: true }, ['/rest/x']), 'none'); // malformed: usage error
  assert.equal(LOCK_MODES.api, apiLockMode);                    // audited in the one table
  assert.ok(COMMANDS.includes('api'));
  assert.equal(isReadMethod('post'), false);
});

test('surface inference: prefixes pick the surface and are stripped to the client base', () => {
  assert.deepEqual(resolveSurface('/core/rest/documents/X'), { surface: 'core', path: '/rest/documents/X', inferred: true });
  assert.deepEqual(resolveSurface('/gui/rest/caches'), { surface: 'gui', path: '/rest/caches', inferred: true });
  assert.deepEqual(resolveSurface('/api/v1/admin/prompts'), { surface: 'ai', path: '/api/v1/admin/prompts', inferred: true });
  assert.deepEqual(resolveSurface('/gui/plugins/IRIS/gateway/uxopian-ai/api/v1/prompts'), { surface: 'ai', path: '/api/v1/prompts', inferred: true });
  assert.deepEqual(resolveSurface('/uxopian-ai/api/v1/x'), { surface: 'ai', path: '/api/v1/x', inferred: true });
  assert.deepEqual(resolveSurface('/api/maps/summary'), { surface: 'f2', path: '/api/maps/summary', inferred: true });
  assert.deepEqual(resolveSurface('/rest/tasks/T1'), { surface: 'core', path: '/rest/tasks/T1', inferred: true });
  assert.deepEqual(resolveSurface('rest/tasks/T1'), { surface: 'core', path: '/rest/tasks/T1', inferred: true });
  // --surface wins; a matching prefix is still stripped
  assert.deepEqual(resolveSurface('/core/rest/x', { surface: 'core' }), { surface: 'core', path: '/rest/x', inferred: false });
  assert.deepEqual(resolveSurface('/api/v1/x', { surface: 'f2' }), { surface: 'f2', path: '/api/v1/x', inferred: false });
  assert.throws(() => resolveSurface('/x', { surface: 'nope' }), /unknown --surface/);
  // a full URL pasted from a browser: matched against the target's bases, longest first
  const target = { name: 't', core: 'https://h/core', gui: 'https://h/gui', gateway: 'https://h/gui/plugins/S/gateway/uxopian-ai' };
  assert.deepEqual(resolveSurface('https://h/gui/plugins/S/gateway/uxopian-ai/api/v1/p', { target }), { surface: 'ai', path: '/api/v1/p', inferred: true });
  assert.deepEqual(resolveSurface('https://h/core/rest/x?a=1', { target }), { surface: 'core', path: '/rest/x?a=1', inferred: true });
  assert.throws(() => resolveSurface('https://other/core/rest/x', { target }), /not under any base/);
});

test('query and header pairs; credentials are redacted in anything printable', () => {
  assert.equal(withQuery('/rest/x', ['a=1', 'b=x y']), '/rest/x?a=1&b=x+y');
  assert.equal(withQuery('/rest/x?z=0', ['a=1']), '/rest/x?z=0&a=1');
  assert.throws(() => withQuery('/x', ['novalue']), /bad --query/);
  assert.deepEqual(parseHeaders(['X-A=1', 'Accept: text/plain']), { 'X-A': '1', Accept: 'text/plain' });
  assert.deepEqual(
    redactHeaders({ Authorization: 'Bearer abc', token: 'abc', Cookie: 'c', Accept: 'x' }),
    { Authorization: '<redacted>', token: '<redacted>', Cookie: '<redacted>', Accept: 'x' },
  );
  const h = new Headers({ 'content-type': 'application/json', 'set-cookie': 'SESSION=1', location: '/y' });
  assert.deepEqual(responseHeaderSubset(h), { 'content-type': 'application/json', location: '/y' });
});

test('request body: --data, --body <file>, --body - (stdin); JSON is detected', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-api-body-'));
  try {
    writeFileSync(join(dir, 'b.json'), '[{"id":"X"}]');
    assert.deepEqual(readRequestBody({ data: '{"a":1}' }), { text: '{"a":1}', json: true });
    assert.deepEqual(readRequestBody({ body: join(dir, 'b.json') }), { text: '[{"id":"X"}]', json: true });
    assert.deepEqual(readRequestBody({ body: '-' }, { readStdin: () => '<xml/>' }), { text: '<xml/>', json: false });
    assert.equal(readRequestBody({}), null);
    assert.throws(() => readRequestBody({ data: '{}', body: 'f' }), /not both/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an error body is explained from its FlowerDocs code', () => {
  assert.match(explainResponse(500, { code: 'F00903', message: 'exists' }, ''), /already exists/);
  assert.match(explainResponse(500, undefined, 'boom T00104 search'), /Search engine/);
  assert.equal(explainResponse(418, undefined, 'teapot'), null);
});

// ---------------------------------------------------------------- the CLI against a local server

/** A fake instance: Core auth + a few routes. Records every request (headers + body). */
async function fakeInstance() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/core/rest/authentication') return json(200, { value: TOKEN });
      if (req.headers.token !== TOKEN) return json(401, { message: 'no token' });
      if (req.url.startsWith('/core/rest/documentclass/PoOrder')) return json(200, [{ id: 'PoOrder', echoedToken: false }]);
      if (req.url === '/core/rest/documentclass') return json(500, { code: 'F00903', message: 'Class PoOrder already exists' });
      if (req.url.startsWith('/core/rest/echo')) return json(200, { method: req.method, url: req.url, body, ct: req.headers['content-type'] ?? null, x: req.headers['x-probe'] ?? null });
      if (req.url === '/uxopian-ai/api/v1/admin/prompts') return json(200, [{ id: 'p1' }]);
      if (req.url === '/gui/rest/text') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('plain words'); }
      return json(404, { message: 'nope' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { seen, base, close: () => new Promise((r) => server.close(r)) };
}

/** Run uxc asynchronously (the fake server lives in THIS process). */
function uxc(args, { base, stdin, cwd, env = {} }) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-api-'));
  return new Promise((done) => {
    const child = spawn(process.execPath, [UXC, ...args], {
      cwd: cwd ?? home,
      env: {
        ...process.env, UXC_HOME: home, HOME: home, USERPROFILE: home,
        UXC_TARGET: '', UXC_URL: '',
        UXC_CORE_URL: `${base}/core`, UXC_AI_URL: `${base}/uxopian-ai`, UXC_GUI_URL: `${base}/gui`,
        UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p', UXC_MAX_RPS: '0',
        UXC_AGENT: '0', // these tests read the human output; agent mode is covered below
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.end(stdin ?? '');
    child.on('close', (status) => {
      rmSync(home, { recursive: true, force: true });
      done({ status, stdout, stderr });
    });
  });
}

test('GET: authenticated with the target token, pretty JSON on stdout, status on stderr, token never printed', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'GET', '/core/rest/documentclass/PoOrder', '--verbose'], { base: fi.base });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [{ id: 'PoOrder', echoedToken: false }]);
    assert.match(r.stdout, /\n {2}\{/); // pretty-printed
    assert.match(r.stderr, /HTTP 200 OK {2}GET http:\/\/127\.0\.0\.1:\d+\/core\/rest\/documentclass\/PoOrder/);
    assert.match(r.stderr, /> token: <redacted>/);
    const call = fi.seen.find((s) => s.url === '/core/rest/documentclass/PoOrder');
    assert.equal(call.headers.token, TOKEN); // the client's auth reached the server
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  } finally { await fi.close(); }
});

test('surface inference end to end: /api/v1 goes to the gateway; --json wraps status/headers/body', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'GET', '/api/v1/admin/prompts', '--json'], { base: fi.base });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 200);
    assert.equal(j.surface, 'ai');
    assert.equal(j.headers['content-type'], 'application/json');
    assert.deepEqual(j.body, [{ id: 'p1' }]);
    assert.ok(fi.seen.some((s) => s.url === '/uxopian-ai/api/v1/admin/prompts' && s.headers.token === TOKEN));
  } finally { await fi.close(); }
});

test('a non-JSON response prints as raw text', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'GET', '/gui/rest/text'], { base: fi.base });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'plain words\n');
  } finally { await fi.close(); }
});

test('a write without --yes is refused before any request is sent', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'DELETE', '/core/rest/documents/X'], { base: fi.base });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refused: DELETE is a write/);
    assert.match(r.stderr, /--yes/);
    assert.equal(fi.seen.length, 0);
  } finally { await fi.close(); }
});

test('write with --yes: body from --data, --body <file> and --body - (stdin), plus --query/--header', async () => {
  const fi = await fakeInstance();
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-api-f-'));
  try {
    writeFileSync(join(dir, 'b.json'), '[{"id":"F"}]');
    let r = await uxc(['api', 'POST', '/core/rest/echo', '--data', '{"a":1}', '--yes', '--query', 'k=v', '--query', 'n=2', '--header', 'X-Probe=yes'], { base: fi.base });
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.deepEqual([j.method, j.url, j.body, j.ct, j.x], ['POST', '/core/rest/echo?k=v&n=2', '{"a":1}', 'application/json', 'yes']);

    r = await uxc(['api', 'PUT', '/rest/echo', '--body', join(dir, 'b.json'), '--yes'], { base: fi.base });
    assert.equal(r.status, 0, r.stderr);
    j = JSON.parse(r.stdout);
    assert.deepEqual([j.method, j.body], ['PUT', '[{"id":"F"}]']);

    r = await uxc(['api', 'POST', '/core/rest/echo', '--body', '-', '--yes'], { base: fi.base, stdin: '{"from":"stdin"}' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).body, '{"from":"stdin"}');
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  } finally { await fi.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a 4xx/5xx with a FlowerDocs code: status, body excerpt and the explanation; exit 1', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'POST', '/core/rest/documentclass', '--data', '[{"id":"PoOrder"}]', '--yes'], { base: fi.base });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /HTTP 500 Internal Server Error/);
    assert.match(r.stderr, /F00903/);
    assert.match(r.stderr, /↳ Resource already exists — create is NOT an upsert/);
    assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
  } finally { await fi.close(); }
});

test('a pinned package refuses an api WRITE on a differing ambient target, like push; reads still run', async () => {
  const fi = await fakeInstance();
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-api-pkg-'));
  try {
    writeFileSync(join(home, 'uxopian-project.json'), JSON.stringify({ code: 'po', name: 'P', agent: { target: 'gfdefault' } }));
    writeFileSync(join(home, 'registry.json'), JSON.stringify({ resources: [] }));
    mkdirSync(join(home, '.uxc'), { recursive: true });
    const env = { UXC_TARGET: 'ambient' };
    const w = await uxc(['api', 'DELETE', '/core/rest/documents/X', '--yes'], { base: fi.base, cwd: home, env });
    assert.equal(w.status, 2);
    assert.match(w.stderr, /pinned to target "gfdefault"/);
    assert.match(w.stderr, /Confirm with: --target gfdefault/);
    assert.ok(!fi.seen.some((s) => s.method === 'DELETE'));
    const g = await uxc(['api', 'GET', '/core/rest/documentclass/PoOrder'], { base: fi.base, cwd: home, env });
    assert.doesNotMatch(g.stderr, /refused/);
    assert.match(g.stderr, /using the pinned target "gfdefault"/);
  } finally { await fi.close(); rmSync(home, { recursive: true, force: true }); }
});

test('agent mode (UXC_AGENT=1): one compact JSON line carrying the status, never the token', async () => {
  const fi = await fakeInstance();
  try {
    const r = await uxc(['api', 'GET', '/gui/rest/text'], { base: fi.base, env: { UXC_AGENT: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 200);
    assert.equal(j.body, 'plain words');
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  } finally { await fi.close(); }
});
