// Offline unit tests for lib/output.mjs diffLines (minimal line diff with resync).
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../lib/output.mjs';

test('diffLines: identical texts -> empty diff', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nb\nc'), []);
  assert.deepEqual(diffLines('', ''), []);
});

test('diffLines: pure addition', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nx\nb'), ['+ x']);
  assert.deepEqual(diffLines('a\nb', 'a\nb\nc\nd'), ['+ c', '+ d']); // trailing add
});

test('diffLines: pure removal', () => {
  assert.deepEqual(diffLines('a\nx\nb', 'a\nb'), ['- x']);
  assert.deepEqual(diffLines('a\nb\nc', 'a'), ['- b', '- c']); // trailing remove
});

test('diffLines: change with resync on the following common line', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), ['- b', '+ B']);
  // multi-line change between two anchors
  assert.deepEqual(
    diffLines('head\none\ntwo\ntail', 'head\nuno\ndos\ntail'),
    ['- one', '- two', '+ uno', '+ dos'],
  );
});
