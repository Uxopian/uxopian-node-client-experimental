// FAST-5879: `uxc f2 exceptions <campaign…> [--out file]` — mapId derived from each campaign's
// stats.taskFlowMapRef, ONE `download-exceptions?campaigns=&mapIds=` call with same-length lists
// paired in order, the file saved (--out, default exceptions_<c>.<ext>; a CSV for one campaign, a
// ZIP of one CSV per campaign for several, as rc5 answers), the rows and the top 5
// (step, exception class) pairs counted client-side, the --json shape. The CSV fixtures follow the
// rc5 export shape recorded in FAST2-LEARNINGS §F35 (synthetic values). Offline: a local stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseCsv, countExceptions, exceptionsPath } from '../lib/f2/campaign.mjs';
import { zipDir, unzipTo } from '../lib/zip.mjs';

/** entries {name: text} -> zip bytes, through the repo's own zip writer. */
async function zipOf(entries) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2zip-'));
  try {
    mkdirSync(join(dir, 'in'));
    for (const [n, t] of Object.entries(entries)) writeFileSync(join(dir, 'in', n), t);
    await zipDir(join(dir, 'in'), join(dir, 'x.zip'));
    return readFileSync(join(dir, 'x.zip'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION'];

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

const HEADER = '"Campaign","Step","TraceId","Status","ExceptionType","Message","Punnet Id","Document Id","punnet.data.x.value"';
const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const row = (campaign, step, cls, msg = 'boom', i = 0) =>
  [campaign, step, `trace-${i}`, 'ProcessedException', cls, msg, `p${i}#1`, `d${i}`, ''].map(q).join(',');

/** `pairs` = [[step, class, count], …] -> an rc5-shaped CSV (LF, every field quoted). */
function csvOf(campaign, pairs) {
  const lines = [HEADER];
  let i = 0;
  for (const [step, cls, n] of pairs) for (let k = 0; k < n; k++) lines.push(row(campaign, step, cls, 'a, "quoted"\nmulti-line message', i++));
  return `${lines.join('\n')}\n`;
}

async function stubBroker(campaigns) {
  // rc5: several campaigns -> ONE zip of `<campaign>_exceptions.csv` (FAST2-LEARNINGS §F35)
  const zipFor = async (cs) => zipOf(Object.fromEntries(cs.map((c) => [`${c}_exceptions.csv`, campaigns[c].csv])));
  const state = { logins: 0, downloads: [] };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const path = url.pathname;
    if (path === '/api/auth/login') {
      state.logins += 1;
      return json(res, 200, { accessToken: `T${state.logins}`, refreshToken: 'R', tokenType: 'BEARER' });
    }
    if (!/^Bearer T\d+$/.test(req.headers.authorization ?? '')) return json(res, 403, { status: 403, error: 'Forbidden', path });
    if (path === '/actuator/info') return json(res, 200, { build: { version: '2026.0.0-rc5' } });
    if (path === '/api/campaigns/download-exceptions') {
      const cs = url.searchParams.get('campaigns').split(',');
      const ms = url.searchParams.get('mapIds').split(',');
      state.downloads.push({ campaigns: cs, mapIds: ms });
      if (cs.length !== ms.length) return json(res, 400, { message: 'lists must have the same length' });
      if (cs.some((c, k) => campaigns[c]?.mapId !== ms[k])) return json(res, 400, { message: 'mapIds not paired with campaigns' });
      const one = cs.length === 1;
      const name = one ? `${cs[0]}_exceptions.csv` : `${cs.join('_')}_exceptions.zip`;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename=${name}` });
      return res.end(one ? campaigns[cs[0]].csv : await zipFor(cs));
    }
    const m = /^\/api\/campaigns\/([^/]+)\/stats$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const c = campaigns[name];
      if (!c) { res.writeHead(400, { 'Content-Type': 'text/plain;charset=UTF-8' }); return res.end(`Could not find campaign with name ${name}`); }
      return json(res, 200, { campaign: name, taskFlowMapRef: { mapId: c.mapId }, campaignStatus: 'Finished', taskStepStat: {} });
    }
    return json(res, 404, { error: 'Not Found', path });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    env: { UXC_F2_URL: base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

const tmp = () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2exc-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const ONE = {
  ZZA_Run1: {
    mapId: 'm-a',
    csv: csvOf('ZZA_Run1', [
      ['5. Inject', 'com.fast2.model.task.exception.TaskProcessException', 4],
      ['3. Convert', 'java.io.IOException', 3],
      ['5. Inject', 'java.lang.IllegalStateException', 2],
      ['2. Read', 'java.lang.NullPointerException', 2],
      ['4. Map', 'java.lang.RuntimeException', 1],
      ['1. Source', 'java.lang.Exception', 1],
    ]),
  },
};

test('parseCsv: quoted commas, "" escapes, embedded newlines, CRLF, BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('h1,h2\n'), [['h1', 'h2']]);
});

test('countExceptions: rows, byStep, and the top 5 (step, class) pairs by count', () => {
  const c = countExceptions(ONE.ZZA_Run1.csv);
  assert.equal(c.rows, 13);
  assert.deepEqual(c.byStep['5. Inject'], {
    'com.fast2.model.task.exception.TaskProcessException': 4, 'java.lang.IllegalStateException': 2,
  });
  assert.equal(c.top.length, 5);
  assert.deepEqual(c.top[0], { step: '5. Inject', exception: 'com.fast2.model.task.exception.TaskProcessException', count: 4 });
  assert.deepEqual(c.top.map((t) => t.count), [4, 3, 2, 2, 1]);
  assert.equal(countExceptions(`${HEADER}\n`).rows, 0, 'a header-only export is 0 rows');
});

test('exceptionsPath: same-length lists, paired in order; unequal lists refused', () => {
  assert.equal(exceptionsPath(['a b', 'c'], ['m1', 'm2']), '/api/campaigns/download-exceptions?campaigns=a%20b,c&mapIds=m1,m2');
  assert.throws(() => exceptionsPath(['a'], []), /as many mapIds as campaigns/);
});

test('f2 exceptions <c>: mapId from stats.taskFlowMapRef, one download, saved to the default name; count + top 5 printed', async () => {
  const b = await stubBroker(ONE);
  const w = tmp();
  try {
    const r = await uxc(['f2', 'exceptions', 'ZZA_Run1'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(b.state.downloads, [{ campaigns: ['ZZA_Run1'], mapIds: ['m-a'] }]);
    const file = join(w.dir, 'exceptions_ZZA_Run1.csv');
    assert.ok(existsSync(file), r.all);
    assert.equal(countExceptions(readFileSync(file, 'utf8')).rows, 13, 'the saved file is the export');
    assert.match(r.stdout, /13 exception row\(s\) for ZZA_Run1/);
    assert.match(r.stdout, /4\s+5\. Inject\s+com\.fast2\.model\.task\.exception\.TaskProcessException/);
    assert.match(r.stdout, /3\s+3\. Convert\s+java\.io\.IOException/);
    assert.doesNotMatch(r.stdout, /4\. Map/, 'only the top 5 pairs (ties broken by step name)');
    assert.equal(b.state.logins, 1);
  } finally { b.close(); w.cleanup(); }
});

test('f2 exceptions --out: saved where asked', async () => {
  const b = await stubBroker(ONE);
  const w = tmp();
  try {
    const r = await uxc(['f2', 'exceptions', 'ZZA_Run1', '--out', 'sub-exc.csv'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    assert.ok(existsSync(join(w.dir, 'sub-exc.csv')));
    assert.ok(!existsSync(join(w.dir, 'exceptions_ZZA_Run1.csv')));
  } finally { b.close(); w.cleanup(); }
});

test('f2 exceptions c1 c2: lists paired in order, ONE call, ONE file (the zip); --json is {campaigns, path, rows, byStep}', async () => {
  const two = {
    ...ONE,
    ZZB_Run2: { mapId: 'm-b', csv: csvOf('ZZB_Run2', [['9. Write', 'java.io.IOException', 2]]) },
  };
  const b = await stubBroker(two);
  const w = tmp();
  try {
    const r = await uxc(['f2', 'exceptions', 'ZZB_Run2', 'ZZA_Run1', '--json'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(b.state.downloads, [{ campaigns: ['ZZB_Run2', 'ZZA_Run1'], mapIds: ['m-b', 'm-a'] }]);
    const j = JSON.parse(r.stdout);
    for (const k of ['campaigns', 'path', 'rows', 'byStep']) assert.ok(Object.hasOwn(j, k), `--json has ${k}`);
    assert.deepEqual(j.campaigns, ['ZZB_Run2', 'ZZA_Run1']);
    assert.deepEqual(j.mapIds, ['m-b', 'm-a']);
    assert.equal(j.rows, 15);
    assert.deepEqual(j.byStep['9. Write'], { 'java.io.IOException': 2 });
    assert.equal(j.path, join(realpathSync(w.dir), 'exceptions_ZZB_Run2_ZZA_Run1.zip'));
    assert.deepEqual(j.top[0], { step: '5. Inject', exception: 'com.fast2.model.task.exception.TaskProcessException', count: 4 });
    // one file for both, saved byte for byte (a UTF-8 decode would corrupt the zip)
    const out = join(w.dir, 'unz');
    assert.equal((await unzipTo(j.path, out)).entries, 2);
    assert.equal(countExceptions(readFileSync(join(out, 'ZZB_Run2_exceptions.csv'), 'utf8')).rows, 2);
    assert.match(r.stdout, /^\{/, 'JSON only on stdout');
  } finally { b.close(); w.cleanup(); }
});

test('f2 exceptions <unknown>: the broker\'s "Could not find campaign", exit 2, nothing downloaded', async () => {
  const b = await stubBroker(ONE);
  const w = tmp();
  try {
    const r = await uxc(['f2', 'exceptions', 'ZZA_Run1', 'ZzNope'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /Could not find campaign with name ZzNope/);
    assert.deepEqual(b.state.downloads, []);
  } finally { b.close(); w.cleanup(); }
});
