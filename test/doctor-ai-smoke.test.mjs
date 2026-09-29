// #71 finding 3 — `doctor --ai-smoke` used to blame the API key for every failure, including the
// one outcome that PROVES the key works. The reported case:
//
//   ! FAIL ai smoke  no usable answer (I'm sorry, but I can't comply with that request. How may I
//     assist you today?) - provider/key/model problem (uxc ls ai.llm; set the key in the admin panel)
//
// That string is a model REFUSAL. Something came back, so gateway -> provider -> OpenAI -> back all
// succeeded. The advice pointed the operator at the one component the evidence had just cleared,
// immediately after they had set it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiSmokeVerdict } from '../lib/commands/doctor.mjs';

test('a passing smoke reports the key works end to end', () => {
  const v = aiSmokeVerdict({ pass: true, answer: 'OK', elapsedMs: 2400 });
  assert.equal(v.ok, true);
  assert.match(v.message, /provider \+ API key work end-to-end/);
  assert.match(v.message, /2s/);
});

test('an EMPTY answer is a provider/key problem, and still says so', () => {
  const v = aiSmokeVerdict({ pass: false, answer: '', elapsedMs: 900 });
  assert.equal(v.ok, false);
  assert.match(v.message, /provider\/key\/model problem/);
  assert.match(v.message, /set the key in the admin panel/);
});

test('whitespace is not an answer', () => {
  const v = aiSmokeVerdict({ pass: false, answer: '   \n  ', elapsedMs: 900 });
  assert.match(v.message, /provider\/key\/model problem/);
});

test('a gateway error is a provider/key problem', () => {
  const v = aiSmokeVerdict({ pass: false, error: 'empty answer from the gateway', answer: '', elapsedMs: 300 });
  assert.match(v.message, /no answer \(empty answer from the gateway\)/);
  assert.match(v.message, /provider\/key\/model problem/);
});

test('a model REFUSAL never blames the key — the round trip demonstrably worked', () => {
  const refusal = "I'm sorry, but I can't comply with that request. How may I assist you today?";
  const v = aiSmokeVerdict({ pass: false, answer: refusal, elapsedMs: 3100 });

  assert.equal(v.ok, false, 'it is still a failure: the smoke expectation was not met');
  assert.doesNotMatch(v.message, /set the key/, 'the key is the one thing this outcome proves right');
  assert.doesNotMatch(v.message, /provider\/key\/model problem/);
  assert.match(v.message, /the model ANSWERED/);
  assert.match(v.message, /model or prompt problem/);
  assert.match(v.message, /the provider, key and model all work/);
  assert.ok(v.message.includes("I'm sorry, but I can't comply"), 'it must quote what came back');
});

test('a long chatty answer is quoted, flattened and capped', () => {
  const answer = `Sure!\n\nHere is what I think about that:\n${'blah '.repeat(200)}`;
  const v = aiSmokeVerdict({ pass: false, answer, elapsedMs: 5000 });
  assert.match(v.message, /the model ANSWERED/);
  assert.doesNotMatch(v.message, /\n.*blah/, 'newlines are flattened so the FAIL line stays one line');
  const quoted = v.message.slice(v.message.indexOf('Answer: "') + 9, -1);
  assert.ok(quoted.length <= 120, `quote must be capped, got ${quoted.length}`);
});
