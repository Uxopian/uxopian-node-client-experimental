// Rate limits (2026-09-17): a 429 is retried after the delay the server asks for, and requests are paced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { retryDelayMs, createClients, maxRpsFrom, replayable429 } from '../lib/http.mjs';

test('retryDelayMs honours Retry-After in seconds, caps it, and backs off without it', () => {
  assert.equal(retryDelayMs('2', 0), 2000);
  assert.equal(retryDelayMs('0', 0), 250);
  assert.equal(retryDelayMs('120', 0), 30_000);
  assert.equal(retryDelayMs(null, 0), 500);
  assert.equal(retryDelayMs(null, 3), 4000);
  assert.equal(retryDelayMs(null, 10), 8000);
});

test('a request refused with 429 is retried and succeeds', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/rest/authentication')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value: 'tok' })); return; }
    calls++;
    if (calls <= 2) { res.writeHead(429, { 'Retry-After': '0' }); res.end('slow down'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { core } = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const out = await core.get('/rest/thing');
    assert.deepEqual(out, { ok: true });
    assert.equal(calls, 3);
  } finally {
    server.closeAllConnections?.(); // Node 18: close() alone waits on keep-alive sockets (#76)
    server.close();
  }
});

// ---- #76 follow-ups ----

test('UXC_MAX_RPS: empty, junk or negative keeps the default; "0" disables; a number is honoured', () => {
  assert.equal(maxRpsFrom(undefined), 20);
  assert.equal(maxRpsFrom(''), 20);
  assert.equal(maxRpsFrom('  '), 20);
  assert.equal(maxRpsFrom('fast'), 20);
  assert.equal(maxRpsFrom('-3'), 20);
  assert.equal(maxRpsFrom('0'), 0);
  assert.equal(maxRpsFrom('7.5'), 7.5);
});

test('replayable429: reads always; FlowerDocs search POST always; other writes only on a limiter surface', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(replayable429(m, 'http://h/gateway/api/v1/x', false), true, m);
  assert.equal(replayable429('POST', 'http://h/core/rest/documents/search', false), true);
  assert.equal(replayable429('POST', 'http://h/core/rest/virtualFolder/search?x=1', false), true);
  assert.equal(replayable429('POST', 'http://h/core/rest/documents/search/extra', false), false);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(replayable429(m, 'http://h/gateway/api/v1/admin/plan-executions/run', false), false, `${m} gateway`);
    assert.equal(replayable429(m, 'http://h/core/rest/documents', true), true, `${m} core`);
  }
});

/** One server for every surface: auth OK, then `handler` decides. Records method+url per call. */
async function limiterServer(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/rest/authentication')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value: 'tok' })); return; }
    calls.push(`${req.method} ${req.url}`);
    handler(req, res, calls);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    calls, clients: createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' }),
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}
const tooMany = (res) => { res.writeHead(429, { 'Retry-After': '0' }); res.end('{"error":"rate limited upstream"}'); };
const ok = (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); };

test('a gateway POST refused with 429 is NOT replayed (it may have run tools already)', async () => {
  const s = await limiterServer((req, res) => tooMany(res));
  try {
    const e = await s.clients.gateway.post('/api/v1/admin/plan-executions/run', { planId: 'p' }).then(() => null, (err) => err);
    assert.equal(e?.status, 429, 'the 429 reaches the caller as an HttpError');
    assert.deepEqual(s.calls, ['POST /api/v1/admin/plan-executions/run'], 'exactly one attempt');
  } finally { s.close(); }
});

test('a Core write and a gateway GET refused with 429 ARE replayed', async () => {
  const s = await limiterServer((req, res, calls) => (calls.length % 2 ? tooMany(res) : ok(res)));
  try {
    assert.deepEqual(await s.clients.core.post('/rest/documents', { a: 1 }), { ok: true });
    assert.deepEqual(await s.clients.gateway.get('/api/v1/admin/prompts'), { ok: true });
    assert.deepEqual(s.calls, ['POST /rest/documents', 'POST /rest/documents', 'GET /api/v1/admin/prompts', 'GET /api/v1/admin/prompts']);
  } finally { s.close(); }
});
