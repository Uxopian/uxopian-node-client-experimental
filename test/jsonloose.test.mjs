// lib/jsonloose.mjs (#122): the tolerant JSON reader for model output, and the --expect matcher
// built on it (strict paths first, repair last, a repaired pass is reported).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLooseJson, matchLoose } from '../lib/jsonloose.mjs';

const OK = [
  // [label, input, expected value, repair notes that must be present ([] = none at all)]
  ['strict object', '{"a":1,"b":[true,null]}', { a: 1, b: [true, null] }, []],
  ['strict scalar', '  42 ', 42, []],
  ['strict string', '"hi"', 'hi', []],
  ['```json fence', 'Here you go:\n```json\n{"risk": "HIGH"}\n```\nHope it helps.', { risk: 'HIGH' }, ['unwrapped a ```json fenced block']],
  ['bare ``` fence', '```\n[1, 2]\n```', [1, 2], ['unwrapped a ``` fenced block']],
  ['fence + trailing comma', '```json\n{"a": [1, 2,],}\n```', { a: [1, 2] }, ['unwrapped a ```json fenced block', 'trailing commas']],
  ['leading/trailing prose', 'The result is {"ok": true} as requested.', { ok: true }, ['ignored prose around the JSON']],
  ['array in prose', 'ids: ["d1","d2"] — done', ['d1', 'd2'], ['ignored prose around the JSON']],
  ['trailing commas', '{"a": 1, "b": [1,],}', { a: 1, b: [1] }, ['trailing commas']],
  ['smart quotes', '{“party”: “Banque Horizon”}', { party: 'Banque Horizon' }, ['smart quotes as string delimiters']],
  ['smart quotes keep an inner apostrophe', '{“note”: “Borrower’s fee”}', { note: 'Borrower’s fee' }, ['smart quotes as string delimiters']],
  ['single quotes', "{'risk': 'LOW', 'n': 2}", { risk: 'LOW', n: 2 }, ['single-quoted strings']],
  ['single quotes with an apostrophe inside', "{'note': 'it's fine'}", { note: "it's fine" }, ['single-quoted strings']],
  ['unquoted keys', '{risk: "LOW"}', { risk: 'LOW' }, ['unquoted keys']],
  ['Python literals', "{'a': True, 'b': None}", { a: true, b: null }, ['Python literals (True/False/None)']],
  ['raw line break in a string', '{"t": "line1\nline2"}', { t: 'line1\nline2' }, ['raw line break inside a string']],
  ['escapes', '{"q": "say \\"x\\" \\u00e9"}', { q: 'say "x" é' }, []],
  ['first value wins', 'a {"x":1} then {"y":2}', { x: 1 }, ['ignored prose around the JSON']],
  ['skips a non-JSON brace first', 'use {placeholder} then {"x": 1}', { x: 1 }, ['ignored prose around the JSON']],
];

for (const [label, input, value, notes] of OK) {
  test(`parseLooseJson: ${label}`, () => {
    const r = parseLooseJson(input);
    assert.deepEqual(r.value, value);
    if (!notes.length) assert.deepEqual(r.repaired, []);
    for (const n of notes) assert.ok(r.repaired.includes(n), `note "${n}" in ${JSON.stringify(r.repaired)}`);
  });
}

test('parseLooseJson: __proto__ is an own key, never the prototype', () => {
  const r = parseLooseJson("{'__proto__': {'polluted': 1}}");
  assert.equal(Object.getPrototypeOf(r.value), Object.prototype);
  assert.deepEqual(Object.keys(r.value), ['__proto__']);
  assert.equal({}.polluted, undefined);
});

const BAD = [
  ['empty', '   ', /empty text/],
  ['plain prose', 'The answer is 42.', /no JSON object or array found/],
  ['an embedded scalar is not guessed', 'risk: "HIGH"', /no JSON object or array/],
  ['unclosable single quote is ambiguous', "{'a': 'it's}", /could not repair.*(ambiguous|unterminated)/],
  ['broken fence', '```json\n{"a": }\n```', /fenced block was found but/],
  ['code is never evaluated', '{"a": (() => 1)()}', /could not repair/],
];
for (const [label, input, re] of BAD) {
  test(`parseLooseJson refuses: ${label}`, () => assert.throws(() => parseLooseJson(input), re));
}

test('matchLoose: raw text first, then strict JSON, then repaired JSON (reported)', () => {
  assert.deepEqual(matchLoose(/HIGH/, 'risk HIGH'), { pass: true, via: 'text', repaired: [] });
  // strict JSON, regex written against the compact form
  assert.equal(matchLoose(/"risk":"HIGH"/, '{ "risk" :  "HIGH" }').via, 'json');
  // a fenced, single-quoted answer passes a content check written for clean JSON
  const r = matchLoose(/"risk":"HIGH"/, "Sure!\n```json\n{'risk': 'HIGH',}\n```");
  assert.equal(r.pass, true);
  assert.equal(r.via, 'json-repaired');
  assert.ok(r.repaired.includes('single-quoted strings') && r.repaired.includes('trailing commas'));
  // the 2-space pretty form is tried too
  assert.equal(matchLoose(/"risk": "HIGH"/, "{'risk':'HIGH'}").pass, true);
  // content still has to be right
  assert.deepEqual(matchLoose(/"risk":"LOW"/, '```json\n{"risk": "HIGH"}\n```'), { pass: false, via: null, repaired: [] });
  assert.equal(matchLoose('"a":1', 'no json here').pass, false);
  // a /g regex is not poisoned by lastIndex between tries
  assert.equal(matchLoose(/"a":1/g, '```json\n{"a": 1}\n```').pass, true);
});
