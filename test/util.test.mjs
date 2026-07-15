// Offline unit tests for lib/util.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stableStringify,
  parseDuration,
  truncate,
  tagsOf,
  tag,
  fdTimestamp,
  sha256,
  toArray,
} from '../lib/util.mjs';

test('stableStringify: sorted keys (recursively) + trailing newline', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{\n  "a": 1,\n  "b": 2\n}\n');
  const txt = stableStringify({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] });
  assert.ok(txt.endsWith('\n'));
  assert.ok(txt.indexOf('"a"') < txt.indexOf('"z"'));
  assert.ok(txt.indexOf('"c"') < txt.indexOf('"d"')); // inside array elements too
  assert.ok(txt.indexOf('"a": 2') < txt.indexOf('"b": 1')); // nested object sorted
  // identical regardless of input key order
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
});

test('parseDuration: bare number means SECONDS; ms/s/m/h units', () => {
  assert.equal(parseDuration('90'), 90_000); // 90 seconds, default unit
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration(' 1.5s '), 1_500); // trim + fractional
  assert.throws(() => parseDuration('soon'), /unparseable duration/);
});

test('truncate: short strings untouched; long ones get the (+N chars) marker', () => {
  assert.equal(truncate('hello', 120), 'hello');
  const long = 'x'.repeat(130);
  const t = truncate(long, 120);
  assert.equal(t, 'x'.repeat(120) + ' (+10 chars)');
  assert.match(t, /\(\+\d+ chars\)$/);
  assert.equal(truncate(null), ''); // nullish-safe
});

test('tagsOf / tag: FlowerDocs tag shapes (key is `value`, not `values`)', () => {
  const doc = {
    tags: [
      { name: 'CtTypeCode', value: ['NDA', 'EXTRA'] }, // first value wins
      { name: 'Empty', value: [] },
      { name: 'WrongShape', values: ['ignored'] }, // `values` is NOT the read key
    ],
  };
  assert.deepEqual(tagsOf(doc), { CtTypeCode: 'NDA', Empty: undefined, WrongShape: undefined });
  assert.deepEqual(tagsOf({}), {});
  assert.deepEqual(tagsOf(null), {});

  // write shape: value array of strings + readOnly flag
  assert.deepEqual(tag('CtTypeCode', 'NDA'), { name: 'CtTypeCode', value: ['NDA'], readOnly: false });
  assert.deepEqual(tag('RegistrationOrder', 930, true), { name: 'RegistrationOrder', value: ['930'], readOnly: true });
  assert.deepEqual(tag('Multi', ['a', 'b']).value, ['a', 'b']);
});

test('fdTimestamp: FlowerDocs format, and safely in the past (F00013)', () => {
  const ts = fdTimestamp();
  assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+0000$/);
  const parsed = new Date(ts.replace(' ', 'T').replace(' +0000', 'Z')).getTime();
  assert.ok(Number.isFinite(parsed));
  assert.ok(parsed < Date.now(), `fdTimestamp must be in the past: ${ts}`);
  // explicit date formats exactly
  assert.equal(fdTimestamp(new Date(Date.UTC(2025, 0, 2, 3, 4, 5, 67))), '2025-01-02 03:04:05.067 +0000');
});

test('sha256 / toArray basics', () => {
  assert.match(sha256('abc'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(sha256('abc'), sha256('abc'));
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray('a'), ['a']);
  assert.deepEqual(toArray(['a', 'b']), ['a', 'b']);
});

test('http ABSENT_CODES: the four verified not-found signals, incl. T01002 (ACL) — matched in code field or body text', async () => {
  const { ABSENT_CODES } = await import('../lib/http.mjs');
  for (const code of ['F00206', 'F00012', 'T00103', 'T01002']) {
    assert.ok(ABSENT_CODES.test(code), `${code} must classify as absent`);
    assert.ok(ABSENT_CODES.test(`{"code":"${code}","message":"ACL cannot be got for [ZzX]"}`), `${code} must match inside a body`);
  }
  assert.ok(!ABSENT_CODES.test('T01006'), 'T01006 (get-ALL ACLs failed) is a real error, never absent');
  assert.ok(!ABSENT_CODES.test('T00108'), 'T00108 (already exists) is the exists signal, not absence');
});
