// Offline unit tests for lib/version.mjs — the client/package compatibility gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLIENT_VERSION, parseSemver, compareSemver, satisfiesMinClient,
  minClientVersionOf, assertClientSupports,
} from '../lib/version.mjs';

test('CLIENT_VERSION is the package.json version (single source of truth)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLIENT_VERSION, pkg.version);
  assert.match(CLIENT_VERSION, /^\d+\.\d+\.\d+/);
});

test('parseSemver: lenient core, prerelease split, v-prefix, build stripped, validity', () => {
  assert.deepEqual(parseSemver('1.2.3').nums, [1, 2, 3]);
  assert.deepEqual(parseSemver('v0.2').nums, [0, 2, 0]);       // missing patch -> 0
  assert.deepEqual(parseSemver('1.2.3-rc.1').pre, ['rc', '1']);
  assert.deepEqual(parseSemver('1.2.3+build.5').pre, []);      // build metadata ignored
  assert.equal(parseSemver('1.2.3').valid, true);
  assert.equal(parseSemver('0.2').valid, true);
  assert.equal(parseSemver('latest').valid, false);
  assert.equal(parseSemver('').valid, false);
  assert.equal(parseSemver('1.x').valid, false);
});

test('compareSemver: ordering, equality, prerelease precedence', () => {
  assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
  assert.equal(compareSemver('0.2.0', '0.2.0'), 0);
  assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
  assert.equal(compareSemver('0.2.10', '0.2.9'), 1);            // numeric, not lexical
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);       // release outranks prerelease
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('v0.2.0', '0.2.0'), 0);           // v-prefix tolerated
});

test('satisfiesMinClient: client >= required; no requirement always passes', () => {
  assert.equal(satisfiesMinClient('0.2.0', '0.2.0'), true);
  assert.equal(satisfiesMinClient('0.2.0', '0.3.1'), true);
  assert.equal(satisfiesMinClient('0.3.0', '0.2.9'), false);
  assert.equal(satisfiesMinClient(null, '0.1.0'), true);
  assert.equal(satisfiesMinClient('', '0.1.0'), true);
});

test('minClientVersionOf: top-level field, requires.uxc alias, or null', () => {
  assert.equal(minClientVersionOf({ minClientVersion: '0.2.0' }), '0.2.0');
  assert.equal(minClientVersionOf({ requires: { uxc: '0.4.0' } }), '0.4.0');
  assert.equal(minClientVersionOf({ minClientVersion: '0.2.0', requires: { uxc: '9.9.9' } }), '0.2.0'); // top-level wins
  assert.equal(minClientVersionOf({}), null);
  assert.equal(minClientVersionOf(undefined), null);
});

test('assertClientSupports: passes when satisfied or unconstrained', () => {
  assert.deepEqual(assertClientSupports({}, { client: '0.2.0' }), { required: null, ok: true });
  assert.deepEqual(
    assertClientSupports({ minClientVersion: '0.2.0' }, { client: '0.2.0' }),
    { required: '0.2.0', ok: true },
  );
  assert.deepEqual(
    assertClientSupports({ minClientVersion: '0.2.0' }, { client: '0.5.1' }),
    { required: '0.2.0', ok: true },
  );
});

test('assertClientSupports: THROWS when the client is too old (with an explanation)', () => {
  assert.throws(
    () => assertClientSupports({ minClientVersion: '0.3.0' }, { client: '0.2.0', action: 'install' }),
    (e) => /requires uxc >= 0\.3\.0/.test(e.message) && /running 0\.2\.0/.test(e.message) && typeof e.explanation === 'string',
  );
});

test('assertClientSupports: THROWS on a malformed minClientVersion', () => {
  assert.throws(
    () => assertClientSupports({ minClientVersion: 'latest' }, { client: '0.2.0' }),
    /not valid semver/,
  );
});

test('assertClientSupports: --ignore-client-version warns instead of throwing', () => {
  const warnings = [];
  const out = { warn: (m) => warnings.push(m) };
  const res = assertClientSupports({ minClientVersion: '9.9.9' }, { client: '0.2.0', ignore: true, out, action: 'push' });
  assert.deepEqual(res, { required: '9.9.9', ok: false, ignored: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OVERRIDDEN by --ignore-client-version/);
  // malformed value under ignore also warns (does not throw)
  warnings.length = 0;
  assert.doesNotThrow(() => assertClientSupports({ minClientVersion: 'nope' }, { ignore: true, out }));
  assert.match(warnings[0], /not valid semver/);
});

test('the running client satisfies the bundled example package (minClientVersion 0.2.0)', () => {
  // guards against shipping a client older than what the reference package declares
  assert.equal(satisfiesMinClient('0.2.0', CLIENT_VERSION), true);
});
