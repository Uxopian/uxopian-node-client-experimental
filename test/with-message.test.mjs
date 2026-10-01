// #128: a timeout/abort rejects with a DOMException whose `message` is getter-only — re-messaging it
// must never throw "Cannot set property message … which has only a getter" and hide the real error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withMessage } from '../lib/util.mjs';

test('withMessage: a plain Error is re-messaged in place', () => {
  const e = Object.assign(new Error('boom'), { explanation: 'why', status: 500 });
  const r = withMessage(e, 'ctx: boom');
  assert.equal(r, e);
  assert.equal(r.message, 'ctx: boom');
  assert.equal(r.explanation, 'why');
});

test('withMessage: a DOMException (timeout) is wrapped, keeping name and cause', () => {
  const d = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const r = withMessage(d, `fd.dataset/CmCaseTypes row X: ${d.message}`);
  assert.ok(r instanceof Error);
  assert.equal(r.message, 'fd.dataset/CmCaseTypes row X: The operation was aborted due to timeout');
  assert.equal(r.name, 'TimeoutError', 'timeout detection by name still works');
  assert.equal(r.cause, d);
});

test('withMessage: nested wrappers (row then push) keep the real cause in the message', () => {
  const d = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const inner = withMessage(d, `row X: ${d.message}`);
  const outer = withMessage(inner, `fd.dataset/CmCaseTypes: ${inner.message} — re-run to resume`);
  assert.match(outer.message, /aborted due to timeout/);
  assert.doesNotMatch(outer.message, /only a getter/);
});
