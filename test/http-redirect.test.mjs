// Redirects never carry the Core JWT to another origin (0.23.0 review). undici's default
// `redirect: 'follow'` strips Authorization/Cookie on a cross-origin hop but NOT the custom
// `token:` header; lib/http.mjs now follows redirects by hand, same origin only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClients } from '../lib/http.mjs';

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test('a cross-origin redirect is not followed (the token stays home); a same-origin one is', async () => {
  const seenElsewhere = [];
  const other = await listen((req, res) => { seenElsewhere.push(req.headers); res.writeHead(200); res.end('{}'); });
  const target = await listen((req, res) => {
    if (req.url.startsWith('/rest/authentication')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ value: 'SECRETJWT' })); return;
    }
    if (req.url === '/rest/away') { res.writeHead(302, { Location: `${other.base}/steal` }); res.end(); return; }
    if (req.url === '/rest/here') { res.writeHead(307, { Location: '/rest/ok' }); res.end(); return; }
    if (req.url === '/rest/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: req.headers.token === 'SECRETJWT', method: req.method })); return;
    }
    res.writeHead(404); res.end();
  });
  try {
    const { core } = createClients({ core: target.base, gateway: target.base, gui: target.base, user: 'u', password: 'p', scope: 's' });
    for (const method of ['GET', 'POST']) {
      const r = await core.raw(method, '/rest/away', method === 'POST' ? { a: 1 } : undefined);
      assert.equal(r.status, 302, `${method}: the cross-origin 302 comes back as-is`);
    }
    assert.equal(seenElsewhere.length, 0, 'nothing — and no token — reached the other origin');
    const same = await core.raw('POST', '/rest/here', { a: 1 });
    assert.equal(same.status, 200);
    assert.deepEqual(same.json, { token: true, method: 'POST' }, '307 keeps the method and the token on the same origin');
  } finally { target.server.close(); other.server.close(); }
});
