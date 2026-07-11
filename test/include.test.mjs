// Offline unit tests for lib/include.mjs — @include directive expansion for
// fd.script / fd.handler sources (build-time composition; server stays self-contained).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandIncludes, isExpansionOf, hasIncludeDirective } from '../lib/include.mjs';

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
