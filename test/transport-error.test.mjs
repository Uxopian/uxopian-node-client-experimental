// #71 finding 1 — a transport failure must NEVER be printable as content.
//
// A prompt whose content calls an unwired helper bean makes the gateway close the TCP socket.
// `fetch` rejected with a bare `TypeError: terminated`, and `uxc run` printed that single word
// exactly where the model's answer goes — so it read as a result, and the field report reasoned
// from it as if it were a gateway response body. Every one of these now arrives as a NetworkError
// that says it is transport, names the endpoint, and carries the next move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClients, NetworkError } from '../lib/http.mjs';
import { runPrompt } from '../lib/run.mjs';

/** A server that authenticates, then destroys the socket on any other route — the §29 signature. */
async function socketKiller({ killOn = () => true } = {}) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/rest/authentication')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'tok' }));
      return;
    }
    if (killOn(req)) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'conv-1' }));
  });
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('a socket closed mid-request becomes a NetworkError, not a bare "terminated"', async () => {
  const { server, base } = await socketKiller();
  try {
    const { core } = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const e = await core.get('/rest/thing').then(() => null, (err) => err);

    assert.ok(e instanceof NetworkError, `expected a NetworkError, got ${e?.name}: ${e?.message}`);
    assert.notEqual(e.message, 'terminated', 'the bare undici message must never survive');
    assert.match(e.message, /^transport failure:/, 'it must announce itself as transport');
    assert.match(e.message, /closed the connection/);
    assert.match(e.message, /GET .*\/rest\/thing/, 'it must name the endpoint');
    assert.ok(e.explanation, 'a uxc error carries its next move');
    assert.match(e.explanation, /§29/);
  } finally { server.close(); }
});

test('connection refused is reported as such, with the target to check', async () => {
  // bind then close, so the port is genuinely free (port 1 is a BLOCKED port, a different error)
  const probe = createServer(() => {});
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((r) => probe.close(r));

  const { core } = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
  const e = await core.get('/rest/thing').then(() => null, (err) => err);

  assert.ok(e instanceof NetworkError, `expected a NetworkError, got ${e?.name}: ${e?.message}`);
  assert.match(e.message, /transport failure: nothing is listening there/);
  assert.match(e.explanation, /uxc target ls/);
});

test('runPrompt names the prompt and the §29 isolation step when the gateway drops the stream', async () => {
  // the conversation is created fine; the STREAM is what dies — exactly what the field report hit
  const { server, base } = await socketKiller({ killOn: (req) => req.url.includes('/requests/stream') });
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const e = await runPrompt({ clients }, 'summarizeDocumentText', { payload: { documentId: 'd1' } })
      .then(() => null, (err) => err);

    assert.ok(e instanceof NetworkError, `expected a NetworkError, got ${e?.name}: ${e?.message}`);
    assert.match(e.message, /transport failure running ai\.prompt\/summarizeDocumentText/);
    assert.match(e.message, /NOT an answer/, 'the whole point: it must not read as a result');
    assert.match(e.explanation, /calls NO bean/, 'it must give the isolation step');
    assert.match(e.explanation, /uxc get ai\.prompt\/summarizeDocumentText/);
  } finally { server.close(); }
});

test('a NetworkError is never mistaken for an HTTP failure (it has no status)', async () => {
  const { server, base } = await socketKiller();
  try {
    const { core } = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const e = await core.get('/rest/thing').then(() => null, (err) => err);
    assert.equal(e.status, undefined, 'a request that never got a response has no status code');
    assert.equal(e.name, 'NetworkError');
    assert.ok(e.cause, 'the original undici error stays attached for debugging');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// #71 finding C — an IMAGE content item rides the bytes inline (ft5, §A19)
// ---------------------------------------------------------------------------
// Verified live by the field report (fd.demo, ft5, gpt-4o, 2026-09-22): a real 344 KiB PNG went in
// and was described correctly. The trap is that a BARE base64 value does not answer 400 — it closes
// the socket, so the caller gets finding 1's transport error and no clue why. uxc refuses it first.

/** A gateway that records the request bodies it is sent and answers a plain-text stream. */
async function recordingGateway(answer = 'described') {
  const bodies = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/rest/authentication')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'tok' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url.includes('/conversations')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'conv-1' }));
        return;
      }
      bodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(answer);
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, bodies, base: `http://127.0.0.1:${server.address().port}` };
}

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('an image rides as an IMAGE content item alongside the PROMPT', async () => {
  const { server, bodies, base } = await recordingGateway('a cat on a mat');
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    // ft5 is asserted by the dialect probe; pin it so the test stays offline
    const ctx = { clients, _caps: null, flags: {}, target: { aiVersion: '2026.0.0-ft5' } };
    const res = await runPrompt(ctx, 'describeImage', { images: [PNG_DATA_URI] });

    assert.equal(res.answer, 'a cat on a mat');
    const [content] = bodies.map((b) => b.inputs[0].content);
    assert.equal(content.length, 2, 'the prompt item plus one image item');
    assert.equal(content[0].type, 'PROMPT');
    assert.equal(content[0].value, 'describeImage');
    assert.equal(content[1].type, 'IMAGE');
    assert.equal(content[1].value, PNG_DATA_URI);
  } finally { server.close(); }
});

test('bare base64 is refused BEFORE the request — it would close the socket, not 400', async () => {
  const { server, bodies, base } = await recordingGateway();
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const ctx = { clients, flags: {}, target: { aiVersion: '2026.0.0-ft5' } };
    const e = await runPrompt(ctx, 'describeImage', { images: ['iVBORw0KGgoAAAANSUhEUg=='] })
      .then(() => null, (err) => err);

    assert.ok(e, 'it must not be sent');
    assert.match(e.message, /must be a data URI/);
    assert.match(e.message, /data:<mime>;base64,/);
    assert.match(e.message, /closes the socket/, 'say WHY it is refused here rather than by the server');
    assert.equal(bodies.length, 0, 'nothing may reach the gateway');
  } finally { server.close(); }
});

test('several images are all carried, in order', async () => {
  const { server, bodies, base } = await recordingGateway();
  const second = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const ctx = { clients, flags: {}, target: { aiVersion: '2026.0.0-ft5' } };
    await runPrompt(ctx, 'compare', { images: [PNG_DATA_URI, second] });
    const [content] = bodies.map((b) => b.inputs[0].content);
    assert.deepEqual(content.map((c) => c.type), ['PROMPT', 'IMAGE', 'IMAGE']);
    assert.equal(content[2].value, second);
  } finally { server.close(); }
});

test('a run with no images keeps the exact single-content body it always had', async () => {
  const { server, bodies, base } = await recordingGateway();
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    await runPrompt({ clients }, 'plain', { payload: { a: 1 } });
    const [content] = bodies.map((b) => b.inputs[0].content);
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: 'PROMPT', value: 'plain', payload: { a: 1 } });
  } finally { server.close(); }
});

test('an older gateway refuses inline images with the version that added them', async () => {
  const { server, bodies, base } = await recordingGateway();
  try {
    const clients = createClients({ core: base, gateway: base, gui: base, user: 'u', password: 'p', scope: 's' });
    const ctx = { clients, flags: {}, target: { aiVersion: '2026.0.0-ft4' } };
    const e = await runPrompt(ctx, 'describeImage', { images: [PNG_DATA_URI] }).then(() => null, (err) => err);

    assert.ok(e, 'a pre-ft5 gateway has no IMAGE content type');
    assert.match(e.message, /inline images need uxopian-ai 2026\.0\.0-ft5\+/);
    assert.equal(bodies.length, 0);
  } finally { server.close(); }
});
