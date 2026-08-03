// Offline tests for lib/run.mjs — gateway failure surfacing (issue #61):
// upstream failures arrive as 200 bodies; an EMPTY answer is a failure too (§A5) and both
// get exactly one cold-start retry before being reported as res.error (never as the answer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrompt } from '../lib/run.mjs';

/** Gateway stub: pops one canned stream body per request, records req options. */
function gatewayStub(bodies) {
  const rec = { posts: 0, reqs: [] };
  const gateway = {
    post: async () => { rec.posts++; return { id: 42 }; },
    req: async (method, path, body, opts) => {
      rec.reqs.push({ method, path, opts });
      return { text: bodies.shift() ?? '' };
    },
  };
  return { gateway, rec };
}

const ctxWith = (gateway) => ({ clients: { gateway } });

test('empty answer: retried once, then surfaced as res.error with the §A5 hint (never as the answer)', async () => {
  const { gateway, rec } = gatewayStub(['', '']);
  const res = await runPrompt(ctxWith(gateway), 'ctSummary');
  assert.equal(rec.reqs.length, 2); // one retry, no more
  assert.match(res.error, /empty answer/);
  assert.match(res.error, /ai-smoke|§A5/);
  assert.equal(res.answer, '');
});

test('empty first answer, good retry: no error', async () => {
  const { gateway } = gatewayStub(['', 'data: {"content":"OK fine"}\n']);
  const res = await runPrompt(ctxWith(gateway), 'ctSummary', { expect: /ok/i });
  assert.equal(res.error, undefined);
  assert.equal(res.answer, 'OK fine');
  assert.equal(res.pass, true);
});

test('200-body error signature: retried once, then reported as res.error', async () => {
  const { gateway, rec } = gatewayStub(['Error: java.lang.RuntimeException', 'HttpTimeout after 60s']);
  const res = await runPrompt(ctxWith(gateway), 'ctSummary');
  assert.equal(rec.reqs.length, 2);
  assert.match(res.error, /HttpTimeout/);
});

test('--timeout: timeoutMs opt reaches the gateway request (default 300s otherwise)', async () => {
  {
    const { gateway, rec } = gatewayStub(['data: {"content":"hi"}\n']);
    await runPrompt(ctxWith(gateway), 'ctSummary', { timeoutMs: 60_000 });
    assert.equal(rec.reqs[0].opts.timeout, 60_000);
  }
  {
    const { gateway, rec } = gatewayStub(['data: {"content":"hi"}\n']);
    await runPrompt(ctxWith(gateway), 'ctSummary');
    assert.equal(rec.reqs[0].opts.timeout, 300_000);
  }
});
