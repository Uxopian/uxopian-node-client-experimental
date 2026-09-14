// Offline unit tests for lib/include.mjs — @include directive expansion for
// fd.script / fd.handler sources (build-time composition; server stays self-contained).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandIncludes, isExpansionOf, hasIncludeDirective, includeDirectiveFiles, INCLUDE_MIN_CLIENT } from '../lib/include.mjs';

function scaffold() {
  const pkg = mkdtempSync(join(tmpdir(), 'uxc-include-'));
  mkdirSync(join(pkg, 'fd/handlers/A'), { recursive: true });
  mkdirSync(join(pkg, 'fd/handlers/_shared'), { recursive: true });
  return pkg;
}

test('directive expands with BEGIN/END markers, package-relative labels', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  writeFileSync(f, '// head\n// @include ../_shared/lib.js\nmain();\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), 'function lib() {}\n');
  const out = String(expandIncludes('// head\n// @include ../_shared/lib.js\nmain();\n', f, pkg));
  assert.match(out, /^\/\/ head\n\/\/ >>> uxc:include fd\/handlers\/_shared\/lib\.js /);
  assert.match(out, /function lib\(\) \{\}\n\/\/ <<< uxc:include fd\/handlers\/_shared\/lib\.js\nmain\(\);/);
  rmSync(pkg, { recursive: true, force: true });
});

test('no directive -> bytes pass through untouched', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  const src = Buffer.from('plain();\n');
  assert.equal(expandIncludes(src, f, pkg), src); // same Buffer, zero-copy
  assert.equal(hasIncludeDirective(src), false);
  rmSync(pkg, { recursive: true, force: true });
});

test('nested includes expand recursively', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  writeFileSync(f, '// @include ../_shared/outer.js\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/outer.js'), '// @include ./inner.js\nouter();\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/inner.js'), 'inner();\n');
  const out = String(expandIncludes('// @include ../_shared/outer.js\n', f, pkg));
  assert.ok(out.indexOf('inner();') >= 0 && out.indexOf('outer();') > out.indexOf('inner();'));
  rmSync(pkg, { recursive: true, force: true });
});

test('cycle is a hard error naming the chain', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  writeFileSync(f, '// @include ../_shared/lib.js\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), '// @include ../A/handler.js\n');
  assert.throws(() => expandIncludes('// @include ../_shared/lib.js\n', f, pkg), /cycle/);
  rmSync(pkg, { recursive: true, force: true });
});

test('path escaping the package root is a hard error', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  assert.throws(() => expandIncludes('// @include ../../../../etc/hosts\n', f, pkg), /escapes the package root/);
  rmSync(pkg, { recursive: true, force: true });
});

test('missing include file is a hard error (never push half-expanded)', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  assert.throws(() => expandIncludes('// @include ./nope.js\n', f, pkg), /not found/);
  rmSync(pkg, { recursive: true, force: true });
});

test('isExpansionOf: pull-guard matches only the true expansion of a directive file', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  writeFileSync(f, '// @include ../_shared/lib.js\nmain();\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), 'function lib() {}\n');
  const expanded = expandIncludes('// @include ../_shared/lib.js\nmain();\n', f, pkg);
  assert.equal(isExpansionOf(expanded, f, pkg), true);
  assert.equal(isExpansionOf(Buffer.from('something else'), f, pkg), false);
  // a plain file (no directive) never triggers the guard, even for identical bytes
  const plain = join(pkg, 'fd/handlers/A/plain.js');
  writeFileSync(plain, 'x();\n');
  assert.equal(isExpansionOf(Buffer.from('x();\n'), plain, pkg), false);
  rmSync(pkg, { recursive: true, force: true });
});

test('CRLF-authored directive lines expand too (never pushed verbatim)', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), 'lib();\n');
  const src = '// @include ../_shared/lib.js\r\nmain();\r\n';
  assert.equal(hasIncludeDirective(src), true);
  const out = String(expandIncludes(src, f, pkg));
  assert.ok(out.includes('uxc:include'), 'CRLF directive must expand');
  assert.ok(out.includes('lib();'));
  rmSync(pkg, { recursive: true, force: true });
});

test('includeDirectiveFiles: finds directive-bearing sources under fd/scripts+fd/handlers ONLY', () => {
  const pkg = scaffold();
  mkdirSync(join(pkg, 'fd/scripts/S'), { recursive: true });
  mkdirSync(join(pkg, 'assets'), { recursive: true });
  writeFileSync(join(pkg, 'fd/handlers/A/handler.js'), '// @include ../_shared/lib.js\n');
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), 'lib();\n');           // no directive
  writeFileSync(join(pkg, 'fd/scripts/S/script.js'), '// @include ../../handlers/_shared/lib.js\n');
  writeFileSync(join(pkg, 'assets/tool.js'), '// @include ./inert.js\n');       // outside scripts/handlers -> inert
  assert.deepEqual(includeDirectiveFiles(pkg), ['fd/handlers/A/handler.js', 'fd/scripts/S/script.js']);
  assert.match(INCLUDE_MIN_CLIENT, /^\d+\.\d+\.\d+$/); // the publish lint pins against this
  rmSync(pkg, { recursive: true, force: true });
});

// ---- strip, 0.17: full-line BLOCK comments go too (a /** … */ that owns its lines) ----
import { stripFullLineComments, INCLUDE_STRIP_BLOCKS_MIN_CLIENT } from '../lib/include.mjs';

test('strip drops a full-line block comment, single-line or JSDoc, and keeps the code around it', () => {
  const src = [
    'var a = 1;',
    '/** one-liner doc */',
    'function f() {',
    '  /**',
    '   * multi-line doc',
    '   */',
    '  return a;',
    '}',
    '/* plain block */',
    'f();',
  ].join('\n');
  assert.equal(stripFullLineComments(src), 'var a = 1;\nfunction f() {\n  return a;\n}\nf();');
  assert.equal(INCLUDE_STRIP_BLOCKS_MIN_CLIENT, '0.17.0');
});

test('strip keeps a block that is followed by code, opened after code, or never closed', () => {
  const followed = '/* note */ var x = 1;\nvar y = 2;';
  assert.equal(stripFullLineComments(followed), followed);
  const multiFollowed = '/* start\n   end */ var x = 1;\nvar y = 2;';
  assert.equal(stripFullLineComments(multiFollowed), multiFollowed);
  const after = 'var x = 1; /* trailing */\nvar y = 2;';
  assert.equal(stripFullLineComments(after), after);
  const unclosed = '/* never closed\nvar x = 1;';
  assert.equal(stripFullLineComments(unclosed), unclosed);
  // `/*/` does not close its own block: the block ends on the NEXT `*/`
  assert.equal(stripFullLineComments('/*/ still open\n */\nvar z = 3;'), 'var z = 3;');
});

test('strip still keeps uxc:include markers and collapses blank runs across removed blocks', () => {
  const src = '// >>> uxc:include a.js (expanded)\n\n/** doc */\n\nvar a = 1;\n// <<< uxc:include a.js';
  assert.equal(stripFullLineComments(src), '// >>> uxc:include a.js (expanded)\n\nvar a = 1;\n// <<< uxc:include a.js');
});

test('an @include … strip expansion drops the included file\'s block comments, never the host\'s', () => {
  const pkg = scaffold();
  const f = join(pkg, 'fd/handlers/A/handler.js');
  const host = '/** host doc stays */\n// @include ../_shared/lib.js strip\nmain();\n';
  writeFileSync(f, host);
  writeFileSync(join(pkg, 'fd/handlers/_shared/lib.js'), '/**\n * lib doc\n */\nfunction lib() {}\n');
  const out = String(expandIncludes(host, f, pkg));
  assert.match(out, /^\/\*\* host doc stays \*\/\n/);
  assert.doesNotMatch(out, /lib doc/);
  assert.match(out, /function lib\(\) \{\}/);
  rmSync(pkg, { recursive: true, force: true });
});
