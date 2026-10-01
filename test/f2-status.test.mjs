// FAST-5878: `uxc f2 status <campaign> [--watch]` — status, elapsed time, per-step punnet counts
// with step NAMES (resolved through stats.taskFlowMapRef.mapId), totals; --watch polls to a
// terminal state on one login; the Starting-wedge explanation once; the shared JSON shape that
// `f2 run` reuses; the broker's "Could not find campaign" + exit 2. Offline: a local stub broker,
// uxc run as a subprocess with UXC_HOME in a tmp dir (as test/f2-only-target.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { summarize, unquote } from '../lib/f2/campaign.mjs';

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

const STEP_A = '0a1b-0001';
const STEP_B = '0a1b-0002';
const stat = (total, speed = 0) => ({ total, speed, timeframe: 5000 });

/**
 * rc5-shaped stub. `campaigns[name] = { statuses: [...], stats: (n) => body }`: each status call
 * pops the next status (the last one repeats); stats receives how many status calls were made.
 */
async function stubBroker(campaigns) {
  const state = { logins: 0, hits: {}, polls: {} };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const text = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain;charset=UTF-8' }); res.end(body); };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    state.hits[path] = (state.hits[path] ?? 0) + 1;
    if (path === '/api/auth/login') {
      state.logins += 1;
      return json(res, 200, { accessToken: `T${state.logins}`, refreshToken: 'R', tokenType: 'BEARER' });
    }
    if (!/^Bearer T\d+$/.test(req.headers.authorization ?? '')) return json(res, 403, { status: 403, error: 'Forbidden', path });
    if (path === '/actuator/info') return json(res, 200, { build: { version: '2026.0.0-rc5' } });
    if (path === '/api/maps/m-1') {
      return json(res, 200, { id: 'm-1', name: 'ZzMap', steps: [{ id: STEP_A, name: '1. Read source' }, { id: STEP_B, name: '2. Inject' }] });
    }
    if (path === '/api/maps/summary/search-by-pattern') {
      return json(res, 200, { total: 1, collection: [{ id: { mapId: 'm-1' }, name: 'ZzMap', versionNumber: 1 }] });
    }
    let m = /^\/api\/campaigns\/([^/]+)\/start$/.exec(path);
    if (m && req.method === 'POST') return json(res, 200, 'ZzMap_Run7'); // the authoritative name (§F9)
    m = /^\/api\/campaigns\/([^/]+)\/(status|stats)$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const c = campaigns[name];
      if (!c) return text(res, 400, `Could not find campaign with name ${name}`);
      if (m[2] === 'status') {
        const n = state.polls[name] = (state.polls[name] ?? 0) + 1;
        const s = c.statuses[Math.min(n, c.statuses.length) - 1];
        if (s === 500) return text(res, 500, 'An unexpected error occurred');
        return json(res, 200, s);
      }
      return json(res, 200, c.stats(state.polls[name] ?? 0));
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

const statsBody = (name, { status = 'Finished', ok = 3, ko = 0, queued = 0, processing = 0, start, finish } = {}) => ({
  campaign: name,
  taskFlowMapRef: { mapId: 'm-1' },
  campaignStatus: status,
  startDate: start ?? '2026-09-15T12:50:31.767Z',
  finishDate: finish === undefined ? '2026-09-15T12:50:38.385Z' : finish,
  stopDate: null,
  taskStepStat: {
    [STEP_A]: { paused: false, stats: { ProcessedOK: stat(ok, 4) } },
    [STEP_B]: {
      paused: false,
      stats: {
        ProcessedOK: stat(ok, 2), ProcessedException: stat(ko, 1), Queued: stat(queued), Processing: stat(processing),
      },
    },
  },
  tenantId: 'default',
});

const tmp = () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2status-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  return { dir, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const SHAPE = ['campaign', 'mapId', 'status', 'elapsedSec', 'ok', 'exception', 'queued', 'processing', 'steps'].sort();
const STEP_SHAPE = ['step', 'ok', 'exception', 'queued', 'processing', 'speed'].sort();

test('summarize: counts, totals, speed, names and elapsed from the stats dates', () => {
  const s = summarize({
    campaign: 'C', status: 'Finished', stats: statsBody('C', { ok: 3, ko: 1, queued: 2, processing: 1 }),
    names: new Map([[STEP_A, 'A'], [STEP_B, 'B']]),
  });
  assert.equal(s.mapId, 'm-1');
  assert.equal(s.elapsedSec, 6.6);
  assert.deepEqual([s.ok, s.exception, s.queued, s.processing], [6, 1, 2, 1]);
  assert.deepEqual(s.steps[1], { step: 'B', ok: 3, exception: 1, queued: 2, processing: 1, speed: 3 });
  assert.equal(summarize({ campaign: 'C', status: 'Starting', stats: null }).elapsedSec, null);
  assert.equal(unquote('"Finished"'), 'Finished');
});

test('f2 status <c>: status, elapsed, a per-step table with the four counts + speed, totals, step NAMES', async () => {
  const b = await stubBroker({ ZzC_Run1: { statuses: ['Finished'], stats: () => statsBody('ZzC_Run1', { ok: 3, ko: 1 }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzC_Run1'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /ZzC_Run1\s+Finished\s+6\.6s/);
    assert.match(r.stdout, /step\s+Queued\s+Processing\s+ProcessedOK\s+ProcessedException\s+speed/);
    assert.match(r.stdout, /1\. Read source\s+0\s+0\s+3\s+0\s+4/);
    assert.match(r.stdout, /2\. Inject\s+0\s+0\s+3\s+1\s+3/);
    assert.match(r.stdout, /totals: 6 ok · 1 exception · 0 queued · 0 processing/);
    assert.doesNotMatch(r.stdout, new RegExp(STEP_A), 'ids are mapped to names');
    assert.equal(b.state.hits['/api/maps/m-1'], 1, 'names come from the map in stats.taskFlowMapRef.mapId');
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --json: exactly the shared shape', async () => {
  const b = await stubBroker({ ZzC_Run1: { statuses: ['Finished'], stats: () => statsBody('ZzC_Run1', { ok: 3, ko: 1 }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzC_Run1', '--json'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), SHAPE);
    for (const s of j.steps) assert.deepEqual(Object.keys(s).sort(), STEP_SHAPE);
    assert.deepEqual([j.campaign, j.mapId, j.status, j.ok, j.exception], ['ZzC_Run1', 'm-1', 'Finished', 6, 1]);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: polls to Finished with 0 exceptions -> exit 0, on ONE login', async () => {
  const b = await stubBroker({
    ZzW_Run1: {
      statuses: ['Starting', 'Started', 'Started', 'Finished'],
      // started just now: a Starting first poll is normal, not a wedge
      stats: (n) => statsBody('ZzW_Run1', n < 4 ? { status: 'Started', ok: n, queued: 4 - n, processing: 1, start: new Date().toISOString(), finish: null } : { ok: 4 }),
    },
  });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzW_Run1', '--watch', '--interval', '0.05', '--timeout', '20'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    assert.equal(b.state.polls.ZzW_Run1, 4, 'polled until the terminal state, then stopped');
    assert.equal(b.state.hits['/api/campaigns/ZzW_Run1/stats'], 4, 'status AND stats on every poll');
    assert.equal(b.state.logins, 1, 'one login for the whole watch — never one per poll');
    assert.equal(b.state.hits['/api/maps/m-1'], 1, 'the map is read once');
    assert.match(r.stdout, /Starting\s+\d+(\.\d)?s\s+ok 2 · exception 0 · queued 3 · processing 1/); // a progress line per poll
    assert.match(r.stdout, /totals: 8 ok · 0 exception/);
    assert.doesNotMatch(r.all, /Starting.*OpenSearch/, 'no wedge warning for a short Starting');
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: Finished WITH exceptions -> exit 1 and the exceptions hint', async () => {
  const b = await stubBroker({ ZzX_Run1: { statuses: ['Started', 'Finished'], stats: () => statsBody('ZzX_Run1', { ok: 2, ko: 1 }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzX_Run1', '--watch', '--interval', '0.05'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /1 punnet\(s\) ended in exception — uxc f2 exceptions ZzX_Run1/);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: Stopped is terminal but not a success -> exit 1', async () => {
  const b = await stubBroker({ ZzS_Run1: { statuses: ['Stopped'], stats: () => statsBody('ZzS_Run1', { ok: 1 }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzS_Run1', '--watch', '--interval', '0.05'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 1, r.all);
    assert.equal(b.state.polls.ZzS_Run1, 1);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: timeout -> exit 1, still on one login', async () => {
  const b = await stubBroker({ ZzT_Run1: { statuses: ['Started'], stats: () => statsBody('ZzT_Run1', { status: 'Started', ok: 1, queued: 9, finish: null }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzT_Run1', '--watch', '--interval', '0.1', '--timeout', '0.5'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /still Started after 0\.5s/);
    assert.ok(b.state.polls.ZzT_Run1 >= 3, `polled several times (${b.state.polls.ZzT_Run1})`);
    assert.equal(b.state.logins, 1);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: an error mid-watch -> exit 2', async () => {
  const b = await stubBroker({ ZzE_Run1: { statuses: ['Started', 500], stats: () => statsBody('ZzE_Run1', { status: 'Started', finish: null }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzE_Run1', '--watch', '--interval', '0.05'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /500/);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status --watch: Starting for more than 60 s prints the §F8/§F10 explanation ONCE', async () => {
  const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
  const b = await stubBroker({
    ZzStuck_Run1: { statuses: ['Starting'], stats: () => statsBody('ZzStuck_Run1', { status: 'Starting', ok: 0, start: twoMinAgo, finish: null }) },
  });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzStuck_Run1', '--watch', '--interval', '0.1', '--timeout', '0.6'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 1, r.all);
    assert.ok(b.state.polls.ZzStuck_Run1 >= 3);
    const hits = r.stderr.match(/cluster\.blocks\.create_index/g) ?? [];
    assert.equal(hits.length, 1, `explained once, not per poll:\n${r.stderr}`);
    assert.match(r.stderr, /§F8\/§F10/);
  } finally { b.close(); w.cleanup(); }
});

test('f2 status <unknown>: the broker\'s "Could not find campaign" is shown, exit 2 (and the JSON envelope)', async () => {
  const b = await stubBroker({});
  const w = tmp();
  try {
    const r = await uxc(['f2', 'status', 'ZzNope'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /Could not find campaign with name ZzNope/);
    const j = await uxc(['f2', 'status', 'ZzNope', '--json'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(j.status, 2);
    const env = JSON.parse(j.stdout);
    assert.equal(env.ok, false);
    assert.match(env.error, /Could not find campaign with name ZzNope/);
  } finally { b.close(); w.cleanup(); }
});

test('f2 run reuses the f2 status shape (+ map); --no-wait suggests the real follow-up command', async () => {
  const b = await stubBroker({ ZzMap_Run7: { statuses: ['Finished'], stats: () => statsBody('ZzMap_Run7', { ok: 3 }) } });
  const w = tmp();
  try {
    const r = await uxc(['f2', 'run', 'ZzMap', '--json'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j).sort(), [...SHAPE, 'map'].sort());
    for (const s of j.steps) assert.deepEqual(Object.keys(s).sort(), STEP_SHAPE);
    assert.equal(j.campaign, 'ZzMap_Run7');
    assert.equal(j.steps[0].step, '1. Read source');

    const nw = await uxc(['f2', 'run', 'ZzMap', '--no-wait'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(nw.status, 0, nw.all);
    // the suggested command is the RETURNED name, and it is one that exists
    assert.match(nw.stdout, /uxc f2 status ZzMap_Run7 --watch/);
    const follow = await uxc(['f2', 'status', 'ZzMap_Run7', '--watch', '--interval', '0.05'], { cwd: w.dir, home: w.home, env: b.env });
    assert.equal(follow.status, 0, follow.all);
  } finally { b.close(); w.cleanup(); }
});
