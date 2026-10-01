// FAST-5881: `uxc f2 lib ls|push|restore` — the worker JAR lifecycle over REST. Offline: a local
// rc5-shaped stub broker (login, campaigns, workers, libraries, upload/restore), uxc run as a
// subprocess with UXC_HOME in a tmp dir. One test (or more) per BDD criterion of UXC-A18.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { seenSince, respawnKind, dateMs, installState, classifyRefusal, versionNames } from '../lib/commands/f2-lib.mjs';

const UXC = resolve('bin/uxc.mjs');
const KEYS = ['UXC_TARGET', 'UXC_URL', 'UXC_CORE_URL', 'UXC_AI_URL', 'UXC_GUI_URL', 'UXC_SCOPE', 'UXC_USER',
  'UXC_PASSWORD', 'UXC_F2_URL', 'UXC_F2_USER', 'UXC_F2_PASSWORD', 'UXC_F2_VERSION'];

function uxc(args, { cwd, home, env = {} }) {
  return new Promise((done) => {
    const blank = Object.fromEntries(KEYS.map((k) => [k, '']));
    const child = spawn(process.execPath, [UXC, ...args], {
      cwd,
      env: { ...process.env, ...blank, UXC_HOME: home, HOME: home, USERPROFILE: home, UXC_AGENT: '0', CLAUDECODE: '', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr, all: stdout + stderr }));
  });
}

/** 250 jars, so a 200-row page size needs two pages. */
const LIBS = Array.from({ length: 250 }, (_, i) => ({
  jarName: `lib-${String(i).padStart(3, '0')}.jar`, groupId: 'g', artifactId: `lib-${i}`, version: `1.${i}`,
  source: 'worker-libs', lastModificationDate: 1_790_000_000_000, creationDate: 1_790_000_000_000, fileSize: 1000 + i,
  versionsLibs: i === 7 ? ['lib-007.jar.old'] : [],
}));

/**
 * opts.campaigns: {name: status} · opts.upload: 'ok' | 409 | 500 | 400 · opts.respawn: 'same'
 * (default: the EMBEDDED worker, same workerId + pid, heard from again within a second) | 'newId' |
 * 'newPid' | 'never' (stops at the swap, never heard from again) · opts.listAfter: whether the
 * pushed jar shows up in libraries afterwards · opts.jarDate: 'now' (default, epoch ms) | 'iso' |
 * 'seconds' (epoch s) | 'old' | 'garbage' · opts.workers: (st) => [status, body] | null — override GET /api/workers ·
 * opts.capSize: the broker caps `size` and ignores `page` · opts.versions: the library-versions body.
 * `lastSeen` is an AGE in ms, as on rc5 (§F32).
 */
async function stubBroker(opts = {}) {
  const st = {
    seen: [], uploads: [], restores: [], swapped: false, swappedAt: null, pages: [], workerCalls: 0,
    campaigns: opts.campaigns ?? {},
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const jarDate = () => ({ now: st.swappedAt, iso: new Date(st.swappedAt).toISOString(), seconds: Math.floor(st.swappedAt / 1000),
    old: 1_700_000_000_000, garbage: 'n/a' })[opts.jarDate ?? 'now'];
  const swap = () => { st.swapped = true; st.swappedAt = Date.now(); };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    st.seen.push(`${req.method} ${path}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (path === '/api/auth/login') return json(res, 200, { accessToken: 'T1', refreshToken: 'R', tokenType: 'BEARER' });
      if (req.headers.authorization !== 'Bearer T1') return json(res, 403, { status: 403, error: 'Forbidden', path });
      if (path === '/api/campaigns/search-by-pattern') {
        const names = Object.keys(st.campaigns);
        return json(res, 200, { total: names.length, collection: names });
      }
      if (path === '/api/maps/summary/search-by-pattern') return json(res, 200, { total: 0, collection: [] });
      const cs = path.match(/^\/api\/campaigns\/([^/]+)\/status$/);
      if (cs) return json(res, 200, st.campaigns[decodeURIComponent(cs[1])] ?? 'Finished');
      if (path === '/api/workers') {
        st.workerCalls += 1;
        const forced = opts.workers?.(st);
        if (forced) return json(res, forced[0], forced[1]);
        let w = { workerId: 'w1', pid: 100, lastSeen: 500, hostname: 'h', embedded: true };
        if (st.swapped) {
          const respawn = opts.respawn ?? 'same';
          if (respawn === 'never') w = { ...w, lastSeen: Date.now() - st.swappedAt + 500 };
          else w = { ...w, lastSeen: 200 };
          if (respawn === 'newId') w = { ...w, workerId: 'w2', pid: 200 };
          if (respawn === 'newPid') w = { ...w, pid: 101 };
        }
        return json(res, 200, { total: 1, collection: [w] });
      }
      if (path === '/api/workers/libraries') {
        const page = opts.ignorePage || opts.capSize ? 0 : Number(u.searchParams.get('page') ?? 0);
        const size = Math.min(Number(u.searchParams.get('size') ?? 20), opts.capSize ?? Infinity);
        st.pages.push(page);
        let all = LIBS;
        if (st.swapped && opts.listAfter !== false) {
          all = [...LIBS, ...st.uploads.map((x) => ({ ...LIBS[0], jarName: x.filename, lastModificationDate: jarDate() }))];
        }
        return json(res, 200, { total: all.length, collection: all.slice(page * size, page * size + size) });
      }
      const lv = path.match(/^\/api\/workers\/library-versions\/(.+)$/);
      if (lv) return json(res, 200, opts.versions ?? (decodeURIComponent(lv[1]) === 'lib-007.jar' ? ['lib-007.jar.old'] : []));
      if (path === '/api/workers/upload-library' && req.method === 'POST') {
        const text = body.toString('latin1');
        const m = text.match(/name="([^"]+)"; filename="([^"]+)"/);
        st.uploads.push({ ctype: req.headers['content-type'], field: m?.[1], filename: m?.[2], text, bytes: body.length });
        const mode = opts.upload ?? 'ok';
        if (mode === 409) return json(res, 409, { code: 'CAMPAIGN_RUNNING', campaigns: ['C_Run1'] });
        if (mode === 500) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('An unexpected error occurred. Please retry'); }
        if (mode === 400) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Invalid file provided'); }
        if (mode === 'huge') { res.writeHead(400, { 'Content-Type': 'text/html' }); return res.end(`<html>${'x'.repeat(10_000)}</html>`); }
        swap();
        res.writeHead(200); return res.end();
      }
      if (path === '/api/workers/restore-library' && req.method === 'POST') {
        st.restores.push(Object.fromEntries(u.searchParams));
        swap();
        res.writeHead(200); return res.end();
      }
      return json(res, 404, { error: 'Not Found', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    st, base,
    env: { UXC_F2_URL: base, UXC_F2_USER: 'ops@example.invalid', UXC_F2_PASSWORD: 'p' },
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

const tmp = () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2lib-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const jar = join(dir, 'fast2-zz-1.0.jar');
  writeFileSync(jar, Buffer.from('PK\x03\x04 fake jar payload 0123456789'));
  return { dir, home, jar, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

async function withBroker(opts, fn) {
  const b = await stubBroker(opts);
  const t = tmp();
  try { return await fn(b, t, (args, env = {}) => uxc(args, { cwd: t.dir, home: t.home, env: { ...b.env, ...env } })); } finally {
    b.close(); t.cleanup();
  }
}

// --- BDD 1: lib ls pages libraries, prints the columns, versionsLibs when present, --filter -------

test('lib ls pages GET /workers/libraries and prints jarName, version, fileSize, lastModificationDate, versionsLibs', async () => {
  await withBroker({}, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'ls']);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(b.st.pages, [0, 1], 'two pages of 200 for 250 jars');
    assert.match(r.stdout, /jarName\s+version\s+fileSize\s+lastModificationDate\s+versionsLibs/);
    assert.match(r.stdout, /lib-249\.jar/);
    assert.match(r.stdout, /lib-007\.jar\s+1\.7\s+1007\s+\S+\s+lib-007\.jar\.old/);
    assert.match(r.stdout, /250 jar\(s\) of 250/);
    assert.ok(!b.st.seen.some((s) => s.startsWith('POST /api/workers')), 'ls never writes');
  });
});

test('lib ls on a broker that ignores `page` (as rc5 did live) falls back to one size=<total> call', async () => {
  await withBroker({ ignorePage: true }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'ls', '--json']);
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.libraries.length, 250);
    assert.equal(new Set(j.libraries.map((l) => l.jarName)).size, 250);
    assert.doesNotMatch(r.stderr, /did not page/);
  });
});

test('lib ls --filter narrows client-side; --json is {action, jar, status, workerBackAfterSec, listed, …}', async () => {
  await withBroker({}, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'ls', '--filter', 'LIB-00', '--json']);
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.action, 'ls');
    assert.equal(j.jar, 'LIB-00');
    assert.equal(j.status, 'ok');
    assert.equal(j.workerBackAfterSec, null);
    assert.equal(j.listed, true);
    assert.equal(j.total, 250);
    assert.equal(j.libraries.length, 10);
    assert.equal(j.libraries.find((l) => l.jarName === 'lib-007.jar').versionsLibs, 'lib-007.jar.old');
  });
});

// --- gate: DESTRUCTIVE, --yes, before any request --------------------------------------------------

test('push/restore without --yes are refused before any request (exit 2)', async () => {
  await withBroker({}, async (b, t, run) => {
    const p = await run(['f2', 'lib', 'push', t.jar]);
    assert.equal(p.status, 2);
    assert.match(p.stderr, /without --yes — the broker STOPS EVERY WORKER/);
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /without --yes/);
    assert.deepEqual(b.st.seen, [], 'no request at all, not even a login');
  });
});

// --- BDD 2: campaign pre-check, --force, multipart `file`, .jar enforced, size printed ------------

test('push refuses with the running campaign name (exit 1) and never uploads', async () => {
  await withBroker({ campaigns: { Done_Run1: 'Finished', Busy_Run3: 'Started' } }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /refusing to push: campaign\(s\) running — Busy_Run3 \(Started\)/);
    assert.doesNotMatch(r.stderr, /Done_Run1/);
    assert.equal(b.st.uploads.length, 0);
    const j = JSON.parse((await run(['f2', 'lib', 'push', t.jar, '--yes', '--json'])).stdout);
    assert.equal(j.status, 'busy');
    assert.deepEqual(j.campaigns, [{ name: 'Busy_Run3', status: 'Started' }]);
  });
});

test('push --force goes past a running campaign', async () => {
  await withBroker({ campaigns: { Wedged: 'Starting' }, respawn: 'newId' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--force']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /--force: 1 campaign\(s\) running/);
    assert.equal(b.st.uploads.length, 1);
  });
});

test('push sends native multipart field "file" with the jar name and bytes, and prints the size', async () => {
  await withBroker({ respawn: 'newId' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes']);
    assert.equal(r.status, 0, r.all);
    const up = b.st.uploads[0];
    assert.match(up.ctype, /^multipart\/form-data; boundary=/);
    assert.equal(up.field, 'file');
    assert.equal(up.filename, 'fast2-zz-1.0.jar');
    assert.match(up.text, /fake jar payload 0123456789/);
    assert.match(r.stdout, /uploading\s+fast2-zz-1\.0\.jar\s+\(32 bytes\)/);
  });
});

test('push enforces the .jar extension and an existing file, before any request', async () => {
  await withBroker({}, async (b, t, run) => {
    const zip = join(t.dir, 'x.zip');
    writeFileSync(zip, 'x');
    const a = await run(['f2', 'lib', 'push', zip, '--yes']);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /is not a \.jar/);
    const m = await run(['f2', 'lib', 'push', join(t.dir, 'missing.jar'), '--yes']);
    assert.equal(m.status, 2);
    assert.match(m.stderr, /no such file/);
    assert.deepEqual(b.st.seen, []);
  });
});

// --- BDD 3: a non-200 from the broker is shown verbatim, exit 1 (room for FAST-5880's 409) ---------

test('a 500 refusal (campaign started after the check) is shown verbatim, exit 1, status refused', async () => {
  await withBroker({ upload: 500 }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--json']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /broker refused the push: HTTP 500/);
    assert.match(r.stderr, /An unexpected error occurred\. Please retry/);
    assert.match(r.stderr, /FAST-5880/);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'refused');
    assert.equal(j.httpStatus, 500);
    assert.equal(j.body, 'An unexpected error occurred. Please retry');
  });
});

test('a 409 CAMPAIGN_RUNNING refusal (FAST-5880 shape) is classified busy, exit 1, body verbatim', async () => {
  await withBroker({ upload: 409 }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--json']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /HTTP 409/);
    assert.match(r.stderr, /"code":"CAMPAIGN_RUNNING"/);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'busy');
    assert.deepEqual(j.body, { code: 'CAMPAIGN_RUNNING', campaigns: ['C_Run1'] });
  });
});

test('classifyRefusal: 409 / CAMPAIGN_RUNNING / a campaign message -> busy; 400 -> invalid-file; else error', () => {
  assert.equal(classifyRefusal({ status: 409, text: '' }), 'campaign-running');
  assert.equal(classifyRefusal({ status: 500, json: { code: 'CAMPAIGN_RUNNING' }, text: '{}' }), 'campaign-running');
  assert.equal(classifyRefusal({ status: 500, text: 'Cannot upload while a campaign is running' }), 'campaign-running');
  assert.equal(classifyRefusal({ status: 400, text: 'Invalid file provided' }), 'invalid-file');
  assert.equal(classifyRefusal({ status: 500, text: 'An unexpected error occurred' }), 'error');
});

// --- BDD 4: wait for the respawn (A17 logic), then confirm the jar is listed ----------------------

test('push waits for a worker to be registered again, then confirms the jar is in lib ls', async () => {
  await withBroker({ respawn: 'newId' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--json']);
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.action, 'push');
    assert.equal(j.jar, 'fast2-zz-1.0.jar');
    assert.equal(j.status, 'ok');
    assert.equal(j.listed, true);
    assert.equal(typeof j.workerBackAfterSec, 'number');
    assert.equal(j.sizeBytes, 32);
    const i = b.st.seen.indexOf('POST /api/workers/upload-library');
    assert.ok(b.st.seen.slice(i).includes('GET /api/workers'), 'workers polled after the upload');
    assert.ok(b.st.seen.slice(i).includes('GET /api/workers/libraries'), 'then libraries read');
  });
});

test('a new pid on the same workerId also counts as back', async () => {
  await withBroker({ respawn: 'newPid' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /worker\s+w1 heard from [\d.]+s after the push \(new-pid\)/);
  });
});

// #2 false negative (review P1): the EMBEDDED worker runs in the broker JVM, keeps its workerId AND
// pid, and is back in well under 10 s — the old workerBack never fired and timed out (exit 1) after
// a successful swap.
test('#2 embedded worker: same workerId + pid, fast respawn -> ok (jar listed with a fresh date)', async () => {
  await withBroker({}, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '8', '--json']);
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'ok');
    assert.equal(j.listed, true);
    assert.deepEqual(j.worker, { workerId: 'w1', pid: 100, respawn: 'same-worker' });
    assert.ok(j.workerBackAfterSec < 5, `back after ${j.workerBackAfterSec}s`);
  });
});

test('#2 the jar date may be an ISO string', async () => {
  await withBroker({ jarDate: 'iso' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '8', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(r.stdout).status, 'ok');
  });
});

// N1: the rc5 library date shape is unrecorded; an epoch in SECONDS must not read as 1970 -> stale.
test('N1 the jar date may be epoch seconds -> ok, not stale', async () => {
  await withBroker({ jarDate: 'seconds' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '8', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(r.stdout).status, 'ok');
  });
});

// #2 false positive (review P1): a failed `before` snapshot was swallowed (`.catch(() => [])`),
// and the first worker seen then counted as "back" before the swap. Now: refuse, nothing uploaded.
test('#2 the pre-push GET /api/workers fails -> exit 2, nothing uploaded (not swallowed)', async () => {
  await withBroker({ workers: (st) => (st.workerCalls === 1 ? [503, { status: 503, error: 'Service Unavailable' }] : null) }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--json']);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /cannot read GET \/api\/workers before the push — not uploading/);
    assert.equal(b.st.uploads.length, 0, 'never uploaded');
  });
});

test('#2 --no-wait needs no worker snapshot', async () => {
  await withBroker({ workers: () => [503, { status: 503 }] }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--no-wait', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(r.stdout).status, 'uploaded');
    assert.equal(b.st.workerCalls, 0);
  });
});

test('#2 a worker fresh but the jar still dated before the push -> stale, exit 1', async () => {
  await withBroker({ jarDate: 'old' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '1', '--json']);
    assert.equal(r.status, 1, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'stale');
    assert.equal(j.listed, true);
    assert.match(r.stderr, /listed but dated .* before the push started/);
  });
});

test('#2 an unreadable jar date -> unverified, exit 0, with a warning', async () => {
  await withBroker({ jarDate: 'garbage' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '1', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(r.stdout).status, 'unverified');
    assert.match(r.stderr, /could not be confirmed by date/);
  });
});

test('no worker heard from before --timeout -> exit 1 with the last snapshot', async () => {
  await withBroker({ respawn: 'never' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '1', '--json']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /no worker was heard from within 1s of the push/);
    assert.match(r.stderr, /IS installed; the next run has no worker/);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'timeout');
    assert.equal(j.workerBackAfterSec, null);
    assert.equal(j.workers[0].workerId, 'w1');
  });
});

test('worker back but the jar not listed -> exit 1, listed:false', async () => {
  await withBroker({ respawn: 'newId', listAfter: false }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '1', '--json']);
    assert.equal(r.status, 1, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'not-listed');
    assert.equal(j.listed, false);
  });
});

// #17 (P3): a broker that caps `size` leaves the jar outside the listing: that is "unverified", not "not listed"
test('#17 the listing is short of total and the jar is not in it -> unverified, exit 0', async () => {
  await withBroker({ capSize: 200 }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '1', '--json']);
    assert.equal(r.status, 0, r.all);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, 'unverified');
    assert.match(r.stderr, /did not return every jar/);
  });
});

// #4 (P2): the wait loop rides out transport errors and 5xx, but not a 4xx (or an auth error)
test('#4 a 5xx during the swap is ridden out; a 4xx in the wait loop stops it at once (exit 2)', async () => {
  await withBroker({ workers: (st) => (st.swapped && st.workerCalls <= 3 ? [502, { status: 502 }] : null) }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '10', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(JSON.parse(r.stdout).status, 'ok');
  });
  await withBroker({ workers: (st) => (st.swapped ? [400, { status: 400, message: 'bad request' }] : null) }, async (b, t, run) => {
    const started = Date.now();
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes', '--timeout', '60']);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /400/);
    assert.ok(Date.now() - started < 15_000, 'not polled for the whole timeout');
    assert.equal(b.st.workerCalls, 2, 'the snapshot + one poll');
  });
});

// #12 (P3): the refusal body goes through out.warn, bounded
test('#12 the refusal body goes through out.warn; a huge one is cut', async () => {
  await withBroker({ upload: 500 }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /^! An unexpected error occurred\. Please retry$/m);
  });
  await withBroker({ upload: 'huge' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'push', t.jar, '--yes']);
    assert.equal(r.status, 1, r.all);
    assert.ok(r.stderr.length < 4_000, `stderr is ${r.stderr.length} chars`);
    assert.match(r.stderr, /… \(\d+ more chars\)/);
  });
});

test('seenSince: a worker heard from after the call returned (lastSeen is an age in ms; an epoch is converted)', () => {
  const now = 2_000_000_000_000;
  const since = now - 3_000; // the call returned 3 s ago
  assert.equal(seenSince([{ workerId: 'w1', lastSeen: 500 }], since, now).workerId, 'w1', 'heard 0.5 s ago');
  assert.equal(seenSince([{ workerId: 'w1', lastSeen: 3_500 }], since, now), null, 'heard BEFORE the call returned');
  assert.equal(seenSince([{ workerId: 'w1', lastSeen: 12_000 }], now - 60_000, now), null, 'stale');
  assert.equal(seenSince([{ workerId: 'w1', lastSeen: now - 200 }], since, now).workerId, 'w1', 'epoch');
  assert.equal(seenSince([{ workerId: 'w1' }, { workerId: 'w2', lastSeen: null }], since, now), null, 'no lastSeen');
  assert.equal(seenSince([{ workerId: 'a', lastSeen: 900 }, { workerId: 'b', lastSeen: 100 }], since, now).workerId, 'b', 'the freshest');
  assert.equal(seenSince([], since, now), null);
});

test('respawnKind / dateMs / installState', () => {
  const before = [{ workerId: 'w1', pid: 1 }];
  assert.equal(respawnKind(before, { workerId: 'w1', pid: 1 }), 'same-worker');
  assert.equal(respawnKind(before, { workerId: 'w1', pid: 2 }), 'new-pid');
  assert.equal(respawnKind(before, { workerId: 'w9', pid: 1 }), 'new-worker');
  assert.equal(dateMs(1_790_000_000_000), 1_790_000_000_000);
  assert.equal(dateMs('1790000000000'), 1_790_000_000_000);
  assert.equal(dateMs('2026-10-01T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(dateMs({ value: '2026-10-01T00:00:00Z', type: 'date' }), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(dateMs('n/a'), null);
  assert.equal(dateMs(null), null);
  const names = new Set(['x.jar']);
  const libs = (d, total = 1) => ({ libraries: [{ jarName: 'x.jar', lastModificationDate: d }], total });
  const T = 1_790_000_000_000;
  assert.equal(installState(libs(T), names, T).state, 'installed');
  assert.equal(installState(libs(T - 20_000), names, T).state, 'installed', 'within the clock-skew allowance');
  assert.equal(installState(libs(T - 60_000), names, T).state, 'stale');
  assert.equal(installState(libs(T / 1000), names, T).state, 'installed', 'N1: epoch seconds');
  assert.equal(installState(libs('?'), names, T).state, 'undated');
  assert.equal(installState(libs(1), names, null).state, 'installed', 'a restore checks no date');
  assert.equal(installState({ libraries: [], total: 0 }, names, 1).state, 'absent');
  assert.equal(installState({ libraries: [], total: 5 }, names, 1).state, 'incomplete');
});

// --- BDD 5: restore — candidates, pre-check, restore-library query, wait --------------------------

test('restore calls restore-library?jarToVersion=&jarToRestore= after the pre-check, then waits', async () => {
  await withBroker({ respawn: 'newId' }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(b.st.restores, [{ jarToVersion: 'lib-007.jar', jarToRestore: 'lib-007.jar.old' }]);
    const order = b.st.seen;
    assert.ok(order.indexOf('GET /api/workers/library-versions/lib-007.jar') < order.indexOf('POST /api/workers/restore-library'));
    assert.ok(order.indexOf('GET /api/campaigns/search-by-pattern') < order.indexOf('POST /api/workers/restore-library'));
    const j = JSON.parse(r.stdout);
    assert.equal(j.action, 'restore');
    assert.equal(j.jar, 'lib-007.jar');
    assert.equal(j.from, 'lib-007.jar.old');
    assert.equal(j.status, 'ok');
    assert.equal(j.listed, true);
    assert.equal(typeof j.workerBackAfterSec, 'number');
  });
});

test('restore refuses while a campaign runs, like push', async () => {
  await withBroker({ campaigns: { Busy_Run1: 'Started' } }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes']);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /refusing to restore: campaign\(s\) running — Busy_Run1/);
    assert.equal(b.st.restores.length, 0);
  });
});

test('restore without --from lists the candidates (read-only); an unknown --from is refused', async () => {
  await withBroker({}, async (b, t, run) => {
    const a = await run(['f2', 'lib', 'restore', 'lib-007.jar']);
    assert.equal(a.status, 2);
    assert.match(a.stdout, /rollback candidates for lib-007\.jar:\s+lib-007\.jar\.old/);
    assert.match(a.stderr, /candidates: lib-007\.jar\.old/);
    const c = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'nope.jar.old', '--yes']);
    assert.equal(c.status, 2);
    assert.match(c.stderr, /"nope\.jar\.old" is not a rollback candidate of lib-007\.jar/);
    assert.equal(b.st.restores.length, 0);
  });
});

// #7 (P2): the library-versions element shape is unverified live; an unknown shape must not block
// the one command meant for an emergency rollback, and --force must skip the candidate check
test('#7 restore: a {version, path} element is read by its path basename', async () => {
  await withBroker({ versions: [{ version: '1.7', path: '/opt/fast2/worker-libs/versions/lib-007.jar.old' }] }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes', '--timeout', '5', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.equal(b.st.restores.length, 1);
    assert.doesNotMatch(r.stderr, /not recognised/);
  });
});

test('#7 restore: an unknown element shape prints the raw element and does not block', async () => {
  await withBroker({ versions: [{ v: 1, file: { n: 'lib-007.jar.old' } }] }, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes', '--timeout', '5', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /element shape not recognised — first element: \{"v":1,"file":\{"n":"lib-007\.jar\.old"\}\}/);
    assert.match(r.stderr, /the broker validates jarToRestore/);
    assert.deepEqual(b.st.restores, [{ jarToVersion: 'lib-007.jar', jarToRestore: 'lib-007.jar.old' }]);
  });
});

test('#7 restore --force skips the candidate check (unknown --from, or an empty list)', async () => {
  await withBroker({}, async (b, t, run) => {
    const r = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'other.jar.old', '--yes', '--force', '--timeout', '5']);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stderr, /--force: "other\.jar\.old" is not a listed rollback candidate/);
    assert.equal(b.st.restores.length, 1);
  });
  await withBroker({ versions: [] }, async (b, t, run) => {
    const refused = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes']);
    assert.equal(refused.status, 2, refused.all);
    assert.match(refused.stderr, /--force skips this check/);
    const forced = await run(['f2', 'lib', 'restore', 'lib-007.jar', '--from', 'lib-007.jar.old', '--yes', '--force', '--timeout', '5']);
    assert.equal(forced.status, 0, forced.all);
    assert.equal(b.st.restores.length, 1);
  });
});

test('N1 dateMs: epoch seconds, epoch ms and ISO all give the same instant', () => {
  const ms = 1_790_000_000_000;
  assert.equal(dateMs(1_790_000_000), ms, 'seconds (number)');
  assert.equal(dateMs('1790000000'), ms, 'seconds (numeric string)');
  assert.equal(dateMs({ value: 1_790_000_000 }), ms, 'seconds in {value}');
  assert.equal(dateMs(ms), ms, 'ms (number)');
  assert.equal(dateMs(String(ms)), ms, 'ms (numeric string)');
  assert.equal(dateMs(new Date(ms).toISOString()), ms, 'ISO');
  assert.equal(dateMs(999_999_999_999), 999_999_999_999_000, 'just below 1e12 -> seconds');
  assert.equal(dateMs(1e12), 1e12, '1e12 and above -> ms');
  assert.equal(dateMs(NaN), null);
});

test('versionNames accepts strings, objects and a {collection} envelope', () => {
  assert.deepEqual(versionNames(['a.jar.old']), ['a.jar.old']);
  assert.deepEqual(versionNames([{ jarName: 'a.jar.old' }, { name: 'b.jar.old' }]), ['a.jar.old', 'b.jar.old']);
  assert.deepEqual(versionNames({ collection: [{ fileName: 'c.jar.old' }] }), ['c.jar.old']);
  assert.deepEqual(versionNames([{ version: '1', path: '/w/versions/d.jar.old' }, { version: '2', path: 'C:\\w\\e.jar.old' }]), ['d.jar.old', 'e.jar.old']);
  assert.deepEqual(versionNames([{ v: 1 }]), [], 'unknown shape -> nothing (the caller shows it raw)');
  assert.deepEqual(versionNames(null), []);
});

// #14: f2 ls --campaigns and f2 lib share one campaign-status loop (campaignStatuses)
test('#14 f2 ls --campaigns lists every campaign with its status and flags a wedged Starting', async () => {
  await withBroker({ campaigns: { Done_Run1: 'Finished', Wedged_Run2: 'Starting' } }, async (b, t, run) => {
    const r = await run(['f2', 'ls', '--campaigns', '--json']);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(JSON.parse(r.stdout).campaigns, ['Done_Run1', 'Wedged_Run2']);
    assert.match(r.stderr, /campaign "Wedged_Run2" is wedged in Starting/);
    assert.doesNotMatch(r.stderr, /Done_Run1/);
  });
});

// --- lock mode: ls reads, a gated write locks only with --yes ------------------------------------

test('lock mode: ls is a read; push/restore are writes only with --yes', async () => {
  const { default: mod } = await import('../lib/commands/f2-lib.mjs');
  assert.equal(mod.lock({}, ['ls']), 'read');
  assert.equal(mod.lock({}, ['push', 'x.jar']), 'none');
  assert.equal(mod.lock({ yes: true }, ['push', 'x.jar']), 'write');
  assert.equal(mod.lock({ yes: true }, ['restore', 'x.jar']), 'write');
});
