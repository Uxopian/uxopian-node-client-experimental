// Rate limits (2026-09-17): a 429 is retried after the delay the server asks for, and requests are paced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { retryDelayMs, createClients } from '../lib/http.mjs';

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
    server.close();
  }
});
