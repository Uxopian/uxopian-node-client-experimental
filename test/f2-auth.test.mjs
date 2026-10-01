// FAST-5874: the fast2 client re-authenticates on 401, and on a 403 only when it is the broker's
// generic "no credentials" envelope (once per token). A real 403 — a path outside the storage
// root, an endpoint the role cannot read — is surfaced verbatim, with no login and never the
// anti-lockout cooldown message (FAST2-LEARNINGS §F22/§F23). Offline: a local HTTP stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { f2Surface, isGenericF2Forbidden } from '../lib/http.mjs';

const GENERIC = { timestamp: '2026-10-01T00:00:00Z', status: 403, error: 'Forbidden', path: '/x' };
const OUTSIDE = 'Access denied: Attempt to access file outside storage root (/)';

/** A stub broker: login mints T1, T2, …; each route decides by the token it receives. */
async function stubBroker() {
  const state = { logins: 0, hits: {} };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/api/auth/login') {
      state.logins += 1;
      return json(res, 200, { accessToken: `T${state.logins}`, refreshToken: 'R', tokenType: 'BEARER' });
    }
    state.hits[path] = (state.hits[path] ?? 0) + 1;
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    switch (path) {
      case '/api/broker/contents': // a real refusal, text/plain like the broker
        res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end(OUTSIDE);
      case '/api/role-denied': // a real refusal with a JSON message
        return json(res, 403, { ...GENERIC, message: 'Access is denied for this role' });
      case '/api/broker/health': // the authed 403 body is UNRECORDED (A0 §b, §F23): assume the worst
        // case — Spring's default envelope with no message, byte-identical to the "no token" answer
        return json(res, 403, GENERIC);
      case '/api/ok':
        return json(res, 200, { ok: token });
      case '/api/generic-once': // the first token is unknown to the broker, the next one is fine
        return token === 'T1' ? json(res, 403, GENERIC) : json(res, 200, { ok: token });
      case '/api/generic-always':
        return json(res, 403, GENERIC);
      case '/api/expiring': // T1 is expired: 401 + the INVALID envelope (rc5, §F22)
        return token === 'T1'
          ? json(res, 401, { status: 'INVALID', message: 'Invalid compact JWT string' })
          : json(res, 200, { ok: token });
      default:
        return json(res, 404, { error: 'Not Found' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const target = { name: 'zz', f2: base, f2User: 'ops@example.invalid', f2Password: 'p' };
  const close = () => { server.closeAllConnections?.(); server.close(); };
  return { state, target, close };
}

test('isGenericF2Forbidden: the Spring envelope and the rc4 text are generic; a 403 with a message is not', () => {
  assert.equal(isGenericF2Forbidden({ status: 403, json: GENERIC, text: JSON.stringify(GENERIC) }), true);
  assert.equal(isGenericF2Forbidden({ status: 403, text: 'An unexpected error occurred. Please retry' }), true);
  assert.equal(isGenericF2Forbidden({ status: 403, text: '' }), true);
  assert.equal(isGenericF2Forbidden({ status: 403, json: { ...GENERIC, message: 'Access is denied' } }), false);
  assert.equal(isGenericF2Forbidden({ status: 403, text: OUTSIDE }), false);
  assert.equal(isGenericF2Forbidden({ status: 401, json: GENERIC }), false);
  assert.equal(isGenericF2Forbidden({ status: 200, json: GENERIC }), false);
});

test('a specific 403 is surfaced verbatim: no new login, the broker body is in the error', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target);
    await assert.rejects(f2.get('/api/broker/contents?path=/'), (e) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /outside storage root/);
      assert.doesNotMatch(e.message, /re-authenticate/);
      return true;
    });
    await assert.rejects(f2.get('/api/role-denied'), (e) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /Access is denied for this role/);
      return true;
    });
    assert.equal(b.state.logins, 1, 'only the initial login — a real 403 never triggers another');
    assert.equal(b.state.hits['/api/broker/contents'], 1, 'and the call is not replayed');
  } finally { b.close(); }
});

test('a generic 403 re-authenticates once and replays the call once', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 });
    assert.deepEqual(await f2.get('/api/generic-once'), { ok: 'T2' });
    assert.equal(b.state.logins, 2);
    assert.equal(b.state.hits['/api/generic-once'], 2);
  } finally { b.close(); }
});

test('a generic 403 that survives a fresh token is real: at most one re-auth, then surfaced', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(f2.get('/api/generic-always'), (e) => e.status === 403 && /Forbidden/.test(e.message));
    }
    assert.equal(b.state.logins, 2, 'one initial login + one re-auth, never more');
    assert.equal(b.state.hits['/api/generic-always'], 4, 'first call replayed once, the next two not replayed');
  } finally { b.close(); }
});

test('a generic 403 right after a successful login is surfaced, never the cooldown error', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target); // the real 30 s cooldown
    await assert.rejects(f2.get('/api/generic-always'), (e) => {
      assert.equal(e.status, 403);
      assert.doesNotMatch(e.message, /refusing to re-authenticate/);
      return true;
    });
    assert.equal(b.state.logins, 1);
  } finally { b.close(); }
});

test('a 401 re-authenticates once and replays the call once (unchanged)', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 });
    assert.deepEqual(await f2.get('/api/expiring'), { ok: 'T2' });
    assert.equal(b.state.logins, 2);
    assert.equal(b.state.hits['/api/expiring'], 2);
  } finally { b.close(); }
});

test('two legitimate 403s within 30 s: no cooldown error, because no login was attempted', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target); // default 30 s cooldown, both calls well inside it
    for (const path of ['/api/broker/contents?path=/', '/api/broker/contents?path=/']) {
      await assert.rejects(f2.get(path), (e) => {
        assert.equal(e.status, 403);
        assert.match(e.message, /outside storage root/);
        assert.doesNotMatch(e.message, /refusing to re-authenticate|failed logins/);
        return true;
      });
    }
    assert.equal(b.state.logins, 1);
  } finally { b.close(); }
});

test('/api/broker/health 403 with NO message (the unrecorded rc5 body), on an accepted token: no login, no replay', async () => {
  const b = await stubBroker();
  try {
    const f2 = f2Surface(b.target, { loginCooldownMs: 0 }); // nothing to hide behind: no cooldown
    await f2.get('/api/ok');
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f2.get('/api/broker/health'), (e) => e.status === 403 && /Forbidden/.test(e.message));
    }
    assert.equal(b.state.logins, 1, 'the token was already accepted: a 403 is the broker\'s real answer');
    assert.equal(b.state.hits['/api/broker/health'], 2, 'never replayed');
  } finally { b.close(); }
});
