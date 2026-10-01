// FAST-5877: `uxc add f2.map <Name> --from-xml <file>` — the BROKER converts the XML (FAST2-DESIGN
// §7): refuse an existing name, upload under a throwaway `ZzUxcConv<rand>`, read the map from the
// 201 body (§F25, no follow-up search), delete the throwaway in a `finally` (§F29), write
// f2/maps/<Name>.json with credentials masked + variable-ized exactly like `add --from`.
// Offline: a local stub broker, uxc run as a subprocess with UXC_HOME in a tmp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { conversionName, findLeakedSecrets, importXml } from '../lib/kinds/f2-map.mjs';
import { f2Surface } from '../lib/http.mjs';

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION'];

const S1 = 'ad3d7098-f170-4c56-838e-376aa588d1ad';
const S2 = '4462c534-1003-4199-9df4-e4ea42c217ba';
const S3 = '7c1e9a52-0b6d-4f0e-9d3a-2a5b8e6f1c40';

/** The designer XML (shape of the shipped Random.map.xml, plus a conditioned link + a connection). */
const XML = `<com.fast2.model.taskflow.design.TaskFlowMap>
  <id><id>6aa213c2-1316-409a-8c22-fea064e32510</id></id>
  <name>Random</name>
  <steps>
    <com.fast2.model.taskflow.design.TaskStep>
      <id><id>${S1}</id></id><name>RandomPunnetList</name><queue><id>Default</id></queue>
      <objectConfiguration class="com.arondor.common.reflection.bean.config.ObjectConfigurationBean">
        <className>com.fast2.task.std.random.RandomPunnetList</className>
      </objectConfiguration>
      <graphic><image>com.fast2.task.std.random.RandomPunnetList</image><x>200</x><y>200</y></graphic>
      <outboundTaskLinks>
        <com.fast2.model.taskflow.design.TaskLink><name>Success</name><target><id>${S2}</id></target>
          <taskLinkCondition class="com.arondor.common.reflection.bean.config.ObjectConfigurationBean">
            <className>com.fast2.taskflow.conditions.Otherwise</className><fields/><singleton>false</singleton><fullyConfigured>true</fullyConfigured>
          </taskLinkCondition></com.fast2.model.taskflow.design.TaskLink>
      </outboundTaskLinks>
      <taskType>Source</taskType>
    </com.fast2.model.taskflow.design.TaskStep>
  </steps>
  <sharedObjectConfigurations/>
  <taskFlowSubMaps/>
</com.fast2.model.taskflow.design.TaskFlowMap>
`;

/** What the broker answers for that XML: the full map JSON, identity block included (§F25/§F28). */
const echo = (name, id) => ({
  id,
  name,
  isReadOnly: false,
  mapVersionsSerieId: `serie-${id}`,
  mapVersion: { versionNumber: '1', displayName: 'v1', lastModificationDate: { value: '2026-10-01T00:00:00Z', type: 'date', format: 'iso' } },
  mapDescription: { content: 'Random sample', graphic: { x: 100, y: 600, image: '' }, isExpanded: true, height: 300, width: 372 },
  steps: [
    {
      id: S1, name: 'RandomPunnetList', queue: 'Default', taskType: 'Source',
      graphic: { x: 200, y: 200, image: 'com.fast2.task.std.random.RandomPunnetList' },
      objectConfiguration: { className: 'com.fast2.task.std.random.RandomPunnetList', singleton: false, fullyConfigured: true, fields: [{ name: 'maxPunnetNumber', primitiveConfiguration: { value: '10' } }] },
      links: [
        { name: 'Success', target: S2, condition: { objectConfiguration: { className: 'com.fast2.taskflow.conditions.Otherwise', singleton: false, fullyConfigured: true, fields: [] } } },
        { name: 'Fail', target: S3, condition: { objectConfiguration: { className: 'com.fast2.taskflow.conditions.PunnetInException', singleton: false, fullyConfigured: true, fields: [] } } },
      ],
    },
    {
      id: S2, name: 'FlowerInjector', queue: 'Default', taskType: 'Task',
      graphic: { x: 599, y: 323, image: 'com.fast2.flowerdocs.FlowerInjector' },
      objectConfiguration: {
        className: 'com.fast2.flowerdocs.FlowerInjector', singleton: false, fullyConfigured: true,
        fields: [{
          name: 'connection',
          objectConfiguration: {
            className: 'com.fast2.flowerdocs.FlowerDocsConnectionProvider', singleton: false, fullyConfigured: true,
            fields: [
              { name: 'endPoint', primitiveConfiguration: { value: 'https://fd.example.invalid/core/services' } },
              { name: 'login', primitiveConfiguration: { value: 'svc-ingest' } },
              { name: 'password', primitiveConfiguration: { value: 'xr1c/AAAAexampleObfuscated==' } },
            ],
          },
        }],
      },
      links: [],
    },
    {
      id: S3, name: 'Noop', queue: 'Default', taskType: 'Task',
      graphic: { x: 599, y: 480, image: 'com.fast2.task.std.Noop' },
      objectConfiguration: { className: 'com.fast2.task.std.Noop', singleton: false, fullyConfigured: true, fields: [] },
      links: [],
    },
  ],
  sharedObjectConfigurations: { Conn: { className: 'com.fast2.flowerdocs.FlowerDocsConnectionProvider', singleton: true, fields: [{ name: 'scope', primitiveConfiguration: { value: 'ACME' } }] } },
});

/**
 * A stub rc5 broker holding `state.maps` (name -> map). `mode` drives the upload:
 *   ok        201 + the full map (§F25)
 *   reject400 400 + the broker's JSON message, nothing created
 *   fail500   the map IS created, then 500 (the sweep must remove it)
 * `holdMs` delays the 201 after the map is created (Infinity: never answers); `onUpload()` fires
 * as soon as the upload is received — the moment a user would press Ctrl-C.
 */
async function stubBroker({ mode = 'ok', existing = [], holdMs = 0, onUpload = null } = {}) {
  const state = { maps: new Map(), calls: [], uploads: [], n: 0 };
  for (const [name, body] of existing) state.maps.set(name, { ...body, name, id: `live-${name}` });
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (path === '/api/auth/login') return json(res, 200, { accessToken: 'T1', refreshToken: 'R', tokenType: 'BEARER' });
      state.calls.push(`${req.method} ${path}`);
      if (req.headers.authorization !== 'Bearer T1') return json(res, 403, { status: 403, error: 'Forbidden', path });
      if (path === '/api/maps/summary/search-by-pattern') {
        const collection = [...state.maps.values()].map((m) => ({ id: { mapId: m.id }, name: m.name, versionNumber: 1 }));
        return json(res, 200, { total: collection.length, collection });
      }
      const up = path.match(/^\/api\/maps\/upload\/(.+)$/);
      if (up && req.method === 'POST') {
        const name = decodeURIComponent(up[1]);
        state.uploads.push({ name, contentType: req.headers['content-type'], raw });
        if (mode === 'reject400') {
          return json(res, 400, { status: 400, error: 'Bad Request', message: "No such field com.fast2.task.std.Noop.fooBar" });
        }
        state.n += 1;
        const map = echo(name, `tmp-${state.n}`);
        state.maps.set(name, map);
        if (mode === 'fail500') return json(res, 500, { status: 500, error: 'Internal Server Error', message: 'boom while indexing' });
        onUpload?.();
        if (holdMs === Infinity) return undefined;
        if (holdMs) return setTimeout(() => json(res, 201, map), holdMs);
        return json(res, 201, map);
      }
      const one = path.match(/^\/api\/maps\/([^/]+)$/);
      if (one) {
        const hit = [...state.maps.values()].find((m) => m.id === decodeURIComponent(one[1]));
        if (!hit) return json(res, 404, { error: 'Not Found' });
        if (req.method === 'DELETE') { state.maps.delete(hit.name); res.writeHead(200); return res.end(); }
        if (req.method === 'GET') return json(res, 200, hit);
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

/** A fresh package (init --code zz) + the XML fixture on disk. */
async function workspace(env) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2xml-'));
  const home = join(dir, 'home');
  const pkg = join(dir, 'pkg');
  mkdirSync(home);
  mkdirSync(pkg);
  const xml = join(dir, 'random.map.xml');
  writeFileSync(xml, XML);
  const init = await uxc(['init', '--name', 'Zz', '--code', 'zz'], { cwd: pkg, home, env });
  assert.equal(init.status, 0, init.all);
  return {
    dir, home, pkg, xml,
    run: (args) => uxc(args, { cwd: pkg, home, env }),
    mapFile: (n) => join(pkg, 'f2', 'maps', `${n}.json`),
    registered: (n) => JSON.parse(readFileSync(join(pkg, 'registry.json'), 'utf8')).resources.some((r) => r.kind === 'f2.map' && r.id === n),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const THROWAWAY = /^ZzUxcConv[a-z0-9]+$/;

test('conversionName: a fresh ZzUxcConv<rand> each call, valid as a map name', () => {
  const a = conversionName();
  const b = conversionName();
  assert.match(a, THROWAWAY);
  assert.match(a, /^[A-Za-z0-9 _-]+$/);
  assert.notEqual(a, b);
});

test('valid XML: upload under ZzUxcConv<rand>, map read from the 201 body, file written + registered, throwaway deleted', async () => {
  const b = await stubBroker();
  const w = await workspace(b.env);
  try {
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.equal(r.status, 0, r.all);
    assert.equal(b.state.uploads.length, 1);
    const up = b.state.uploads[0];
    assert.match(up.name, THROWAWAY);
    assert.match(up.contentType, /^multipart\/form-data/);
    assert.match(up.raw, /name="file"; filename="random\.map\.xml"/);
    assert.ok(up.raw.includes('<com.fast2.model.taskflow.design.TaskFlowMap>'), 'the XML bytes are the upload');
    // exactly: pre-check, upload, delete — no follow-up search or GET after the 201 (§F25)
    assert.deepEqual(b.state.calls, [
      'GET /api/maps/summary/search-by-pattern',
      `POST /api/maps/upload/${up.name}`,
      'DELETE /api/maps/tmp-1',
    ]);
    assert.equal(b.state.maps.size, 0, 'no throwaway left on the broker');
    const obj = JSON.parse(readFileSync(w.mapFile('ZzFoo'), 'utf8'));
    assert.equal(obj.name, 'ZzFoo');
    for (const k of ['id', 'mapVersion', 'mapVersionsSerieId', 'isReadOnly']) assert.ok(!(k in obj), `${k} stripped`);
    assert.ok(w.registered('ZzFoo'));
    assert.match(r.all, /converted by the broker as ZzUxcConv\w+ \(tmp-1\), deleted/);
    assert.match(r.all, /imported from .*random\.map\.xml/);

    const j = await w.run(['add', 'f2.map', 'ZzBar', '--from-xml', w.xml, '--json']);
    assert.equal(j.status, 0, j.all);
    const out = JSON.parse(j.stdout);
    assert.equal(out.fromXml.throwaway.deleted, true, j.stdout);
    assert.match(out.fromXml.throwaway.name, THROWAWAY);
    assert.equal(out.path, 'f2/maps/ZzBar.json');
  } finally { b.close(); w.cleanup(); }
});

test('upload rejected (400 unknown field): the broker message verbatim, nothing written, nothing left', async () => {
  const b = await stubBroker({ mode: 'reject400' });
  const w = await workspace(b.env);
  try {
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fast2 rejected the XML \(HTTP 400\): No such field com\.fast2\.task\.std\.Noop\.fooBar/);
    assert.ok(!existsSync(w.mapFile('ZzFoo')), 'no local file');
    assert.ok(!w.registered('ZzFoo'), 'not registered');
    assert.equal(b.state.maps.size, 0);
  } finally { b.close(); w.cleanup(); }
});

test('upload fails with 500 after the broker created the map: the throwaway is swept, message verbatim', async () => {
  const b = await stubBroker({ mode: 'fail500' });
  const w = await workspace(b.env);
  try {
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fast2 rejected the XML \(HTTP 500\): boom while indexing/);
    assert.doesNotMatch(r.stderr, /could not be removed/);
    assert.ok(b.state.calls.includes('DELETE /api/maps/tmp-1'), b.state.calls.join(', '));
    assert.equal(b.state.maps.size, 0, 'no throwaway left behind');
    assert.ok(!existsSync(w.mapFile('ZzFoo')));
    assert.ok(!w.registered('ZzFoo'));
  } finally { b.close(); w.cleanup(); }
});

test('the local write fails after the upload: the throwaway is still deleted', async () => {
  const b = await stubBroker();
  const w = await workspace(b.env);
  try {
    writeFileSync(join(w.pkg, 'f2'), 'not a directory'); // f2/maps/ cannot be created
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.notEqual(r.status, 0, r.all);
    assert.equal(b.state.uploads.length, 1);
    assert.ok(b.state.calls.includes('DELETE /api/maps/tmp-1'));
    assert.equal(b.state.maps.size, 0);
  } finally { b.close(); w.cleanup(); }
});

test('round-trip: steps, step ids, graphic x/y, link conditions and shared objects are preserved', async () => {
  const b = await stubBroker();
  const w = await workspace(b.env);
  try {
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.equal(r.status, 0, r.all);
    const obj = JSON.parse(readFileSync(w.mapFile('ZzFoo'), 'utf8'));
    const want = echo('x', 'y');
    assert.deepEqual(obj.steps.map((s) => s.id), [S1, S2, S3]);
    assert.deepEqual(obj.steps.map((s) => s.name), want.steps.map((s) => s.name));
    assert.deepEqual(obj.steps.map((s) => s.graphic), want.steps.map((s) => s.graphic));
    assert.deepEqual(obj.steps[0].links.map((l) => [l.name, l.target, l.condition.objectConfiguration.className]), [
      ['Success', S2, 'com.fast2.taskflow.conditions.Otherwise'],
      ['Fail', S3, 'com.fast2.taskflow.conditions.PunnetInException'],
    ]);
    assert.deepEqual(obj.steps[0].objectConfiguration, want.steps[0].objectConfiguration);
    assert.deepEqual(obj.sharedObjectConfigurations, want.sharedObjectConfigurations);
    assert.deepEqual(obj.mapDescription, want.mapDescription, 'the XML description is kept');
  } finally { b.close(); w.cleanup(); }
});

test('a name that already exists on the broker is refused BEFORE any upload (no _new1)', async () => {
  const b = await stubBroker({ existing: [['ZzFoo', echo('ZzFoo', 'x')]] });
  const w = await workspace(b.env);
  try {
    const r = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fast2 map "ZzFoo" exists on target \S+; use `uxc pull f2\.map\/ZzFoo` or a new name/);
    assert.equal(b.state.uploads.length, 0, 'never uploaded');
    assert.deepEqual([...b.state.maps.keys()], ['ZzFoo'], 'the live map is untouched');
    assert.ok(!existsSync(w.mapFile('ZzFoo')));
  } finally { b.close(); w.cleanup(); }
});

test('credentials in the XML are masked + variable-ized exactly like add --from', async () => {
  const b = await stubBroker({ existing: [['ZzLive', echo('ZzLive', 'x')]] });
  const w = await workspace(b.env);
  try {
    const x = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml]);
    assert.equal(x.status, 0, x.all);
    const c = await w.run(['add', 'f2.map', 'ZzClone', '--from', 'ZzLive']);
    assert.equal(c.status, 0, c.all);
    const fromXml = JSON.parse(readFileSync(w.mapFile('ZzFoo'), 'utf8'));
    const fromLive = JSON.parse(readFileSync(w.mapFile('ZzClone'), 'utf8'));
    assert.deepEqual(fromXml.steps, fromLive.steps, 'same masking + variables as add --from');
    const text = readFileSync(w.mapFile('ZzFoo'), 'utf8');
    assert.ok(!text.includes('xr1c/'), 'no obfuscated password on disk');
    assert.ok(!text.includes('svc-ingest') && !text.includes('fd.example.invalid'));
    assert.deepEqual(findLeakedSecrets(fromXml), []);
    const conn = fromXml.steps[1].objectConfiguration.fields[0].objectConfiguration.fields;
    assert.deepEqual(conn.map((f) => f.primitiveConfiguration.value), ['{{uxc:f2Endpoint}}', '{{uxc:f2Login}}', '{{uxc:f2Password}}']);
    assert.match(x.all, /declare these in uxopian-project\.json "variables".*f2Password/);
  } finally { b.close(); w.cleanup(); }
});

test('--from-xml: refused offline for another kind, a missing file, or a non-XML file', async () => {
  const b = await stubBroker();
  const w = await workspace(b.env);
  try {
    const other = await w.run(['add', 'fd.handler', 'ZzDoc_onCreate', '--from-xml', w.xml]);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /--from-xml is not supported for fd\.handler/);
    const missing = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', join(w.dir, 'nope.map.xml')]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot read/);
    const notXml = join(w.dir, 'x.json');
    writeFileSync(notXml, '{"name":"x"}');
    const bad = await w.run(['add', 'f2.map', 'ZzFoo', '--from-xml', notXml]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /does not look like a \.map\.xml/);
    assert.equal(b.state.calls.length, 0, 'no network call');
  } finally { b.close(); w.cleanup(); }
});

test('importXml (library): a caller-chosen throwaway name is honoured and still deleted', async () => {
  const b = await stubBroker();
  try {
    const target = { name: 'zz', f2: b.env.UXC_F2_URL, f2User: b.env.UXC_F2_USER, f2Password: b.env.UXC_F2_PASSWORD };
    const ctx = { clients: { f2: f2Surface(target) }, target };
    const res = await importXml(ctx, 'ZzFoo', Buffer.from(XML), { tmpName: 'ZzProbe_1' });
    assert.equal(b.state.uploads[0].name, 'ZzProbe_1');
    assert.deepEqual(res.throwaway, { name: 'ZzProbe_1', mapId: 'tmp-1', deleted: true });
    assert.equal(res.local.obj.name, 'ZzFoo');
    assert.equal(b.state.maps.size, 0);
  } finally { b.close(); }
});

// #5 (review P2): Ctrl-C during the conversion left the ZzUxcConv* throwaway on the broker — Node's
// default SIGINT exit never runs the `finally`. Now: the delete command is printed, the throwaway is
// deleted (by id once the in-flight upload lands, else by name), exit 130.
function spawnUxc(args, { cwd, home, env }) {
  const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
  const child = spawn(process.execPath, [UXC, ...args], {
    cwd, env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', ...env },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((r) => child.on('close', (status, signal) => r({ status, signal, stdout, stderr, all: stdout + stderr })));
  return { child, done };
}

for (const [label, holdMs, sig] of [['the upload lands after the signal', 800, 'SIGINT'], ['the upload never answers', Infinity, 'SIGTERM']]) {
  test(`#5 ${sig} during add --from-xml (${label}): the throwaway is deleted, its delete command printed, exit 130`, async () => {
    let child = null;
    const b = await stubBroker({ holdMs, onUpload: () => setTimeout(() => child?.kill(sig), 100) });
    const w = await workspace(b.env);
    try {
      const p = spawnUxc(['add', 'f2.map', 'ZzFoo', '--from-xml', w.xml], { cwd: w.pkg, home: w.home, env: b.env });
      child = p.child;
      const r = await p.done;
      assert.equal(r.status, 130, r.all);
      assert.match(r.stderr, new RegExp(`${sig}: interrupted during the XML conversion — removing the throwaway map ZzUxcConv\\w+`));
      assert.match(r.stderr, /uxc api DELETE \/api\/maps\/\S+ --surface f2 --yes/);
      assert.match(r.stderr, /deleted the throwaway map ZzUxcConv\w+/);
      assert.equal(b.state.maps.size, 0, `left on the broker: ${[...b.state.maps.keys()].join(', ')}`);
      assert.ok(b.state.calls.includes('DELETE /api/maps/tmp-1'), b.state.calls.join(', '));
      assert.ok(!existsSync(w.mapFile('ZzFoo')), 'nothing written');
    } finally { b.close(); w.cleanup(); }
  });
}

test('#5 the signal handlers are removed once the import returns (library caller)', async () => {
  const b = await stubBroker();
  try {
    const target = { name: 'zz', f2: b.env.UXC_F2_URL, f2User: b.env.UXC_F2_USER, f2Password: b.env.UXC_F2_PASSWORD };
    const ctx = { clients: { f2: f2Surface(target) }, target };
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await importXml(ctx, 'ZzFoo', Buffer.from(XML));
    assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
  } finally { b.close(); }
});
