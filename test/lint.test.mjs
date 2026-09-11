// Offline unit tests for lib/lint.mjs — the checks whose BOTH halves live in the package
// (BACKLOG-AGENTIC #7/#9/#17/#20). Every scenario here is one that actually broke a live push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openPackage } from '../lib/registry.mjs';
import {
  lintTagValues, tagclassIndex, promptVariables, promptCallSites, lintPromptVariables,
  promptProviderOrder, lintIncludeOrder, includeOrders, declaredIncludeOrder,
  resourceSizes, sizeWarnings, HARD_LIMIT_BYTES,
} from '../lib/lint.mjs';

/** Build a throwaway package from {path: contents} plus a manifest and registry resources. */
function pkgOf({ manifest = {}, resources = [], files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'uxc-lint-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'po', ...manifest }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { pkg: openPackage(dir), dir };
}

const tagclass = (id, type, values) => ({
  kind: 'fd.tagclass', id, path: `fd/tagclasses/${id}.json`,
});
const tagclassFile = (id, type, values) => ({
  id, type, ...(values ? { allowedValues: values.map((v) => ({ symbolicName: v })) } : {}),
});
const row = (id, tags) => JSON.stringify({
  category: 'DOCUMENT', data: { classId: 'PoRule' }, id, name: id,
  tags: Object.entries(tags).map(([name, value]) => ({ name, readOnly: false, value: [value].flat() })),
});

// ---------------------------------------------------------------------------
// #20 — constrained tag values
// ---------------------------------------------------------------------------

test('a CHOICELIST value outside allowedValues is caught, with the admitted values named', () => {
  // the exact Gerflor failure: PoRuleSet=PoProfileRules, absent from PoRuleSet's allowedValues
  const { pkg, dir } = pkgOf({
    manifest: { dataSets: [{ name: 'rules', classId: 'PoRule', path: 'data/rules.jsonl' }] },
    resources: [tagclass('PoRuleSet'), { kind: 'fd.dataset', id: 'rules', path: 'data/rules.jsonl' }],
    files: {
      'fd/tagclasses/PoRuleSet.json': tagclassFile('PoRuleSet', 'CHOICELIST', ['PoRefCustomers', 'PoRefOrders']),
      'data/rules.jsonl': `${row('r1', { PoRuleSet: 'PoProfileRules' })}\n${row('r2', { PoRuleSet: 'PoRefOrders' })}\n`,
    },
  });
  const problems = lintTagValues(pkg);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].where, 'rules/r1');
  assert.equal(problems[0].value, 'PoProfileRules');
  assert.deepEqual(problems[0].allowed, ['PoRefCustomers', 'PoRefOrders']);
  assert.match(problems[0].message, /not an allowed choice/);
  assert.match(problems[0].message, /"PoRefCustomers", "PoRefOrders"/, 'name the admitted values');
  rmSync(dir, { recursive: true, force: true });
});

test('FREELIST and unconstrained types accept anything (FREELIST is open by design)', () => {
  const { pkg, dir } = pkgOf({
    manifest: { dataSets: [{ name: 'rules', classId: 'PoRule', path: 'data/rules.jsonl' }] },
    resources: [tagclass('PoFree'), tagclass('PoText'), { kind: 'fd.dataset', id: 'rules', path: 'data/rules.jsonl' }],
    files: {
      'fd/tagclasses/PoFree.json': tagclassFile('PoFree', 'FREELIST', ['A']),
      'fd/tagclasses/PoText.json': tagclassFile('PoText', 'TEXT'),
      'data/rules.jsonl': `${row('r1', { PoFree: 'anything', PoText: 'whatever' })}\n`,
    },
  });
  assert.deepEqual(lintTagValues(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('a tagclass the package does not own cannot be checked (no local allowedValues)', () => {
  const { pkg, dir } = pkgOf({
    manifest: { dataSets: [{ name: 'rules', classId: 'PoRule', path: 'data/rules.jsonl' }] },
    resources: [{ kind: 'fd.dataset', id: 'rules', path: 'data/rules.jsonl' }],
    files: { 'data/rules.jsonl': `${row('r1', { ServerSideTag: 'whatever' })}\n` },
  });
  assert.deepEqual(lintTagValues(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('tags on a plain JSON resource are checked too, and tombstones are skipped', () => {
  const { pkg, dir } = pkgOf({
    manifest: { dataSets: [{ name: 'rules', classId: 'PoRule', path: 'data/rules.jsonl' }] },
    resources: [
      tagclass('PoRuleSet'),
      { kind: 'fd.vfinstance', id: 'PoFolder', path: 'fd/vfinstances/PoFolder.json' },
      { kind: 'fd.dataset', id: 'rules', path: 'data/rules.jsonl' },
    ],
    files: {
      'fd/tagclasses/PoRuleSet.json': tagclassFile('PoRuleSet', 'CHOICELIST', ['OK']),
      'fd/vfinstances/PoFolder.json': { id: 'PoFolder', data: { classId: 'PoVf' }, tags: [{ name: 'PoRuleSet', value: ['NOPE'] }] },
      'data/rules.jsonl': `${JSON.stringify({ _deleted: true, _id: 'gone' })}\n`,
    },
  });
  const problems = lintTagValues(pkg);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].where, 'fd.vfinstance/PoFolder');
  rmSync(dir, { recursive: true, force: true });
});

test('tagclassIndex marks only CHOICELIST-with-values as constrained', () => {
  const { pkg, dir } = pkgOf({
    resources: [tagclass('A'), tagclass('B'), tagclass('C')],
    files: {
      'fd/tagclasses/A.json': tagclassFile('A', 'CHOICELIST', ['x']),
      'fd/tagclasses/B.json': tagclassFile('B', 'CHOICELIST'),      // no values yet
      'fd/tagclasses/C.json': tagclassFile('C', 'STRING', ['x']),
    },
  });
  const idx = tagclassIndex(pkg);
  assert.equal(idx.get('A').constrained, true);
  assert.equal(idx.get('B').constrained, false);
  assert.equal(idx.get('C').constrained, false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #7 — prompt variables
// ---------------------------------------------------------------------------

test('promptVariables takes bare ${x} and ignores server-side helper calls', () => {
  const vars = promptVariables('A [[${clauseText}]] and [[${flowerDocsService.extractTextualContent(documentId)}]] plus ${bare}');
  assert.deepEqual([...vars].sort(), ['bare', 'clauseText']);
});

test('promptCallSites reads an inline payload object literal', () => {
  const src = "var a = callPrompt(token, 'poAssess', { caseId: id, typeCode: t }, 90);";
  const [site] = promptCallSites(src, 'poAssess');
  assert.deepEqual(site.keys, ['caseId', 'typeCode']);
  assert.equal(site.line, 1);
});

test('promptCallSites survives nested objects, arrays and quoted keys', () => {
  const src = "callPrompt(t,'p',{ a: {b: 1}, 'c': [1,2], d: \"x, y: z\" },5)";
  assert.deepEqual(promptCallSites(src, 'p')[0].keys, ['a', 'c', 'd']);
});

test('a variable no caller mentions is reported — the ${openObligations} outage', () => {
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'ai.prompt', id: 'poCase', path: 'ai/prompts/poCase.json' }],
    files: {
      'ai/prompts/poCase.json': { id: 'poCase' },
      'ai/prompts/poCase.content.md': 'Case [[${caseId}]] with [[${openObligations}]]',
      'fd/handlers/PoCase_onUpdate/handler.js': "callPrompt(token, 'poCase', { caseId: id }, 60);",
    },
  });
  const findings = lintPromptVariables(pkg);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'unprovided');
  assert.deepEqual(findings[0].variables, ['openObligations']);
  assert.match(findings[0].message, /hang until timeout/);
  assert.match(findings[0].message, /fd\/handlers\/PoCase_onUpdate\/handler\.js:1/);
  rmSync(dir, { recursive: true, force: true });
});

test('a key passed as a separate ARGUMENT counts as provided (no false positive)', () => {
  // fireGathered('poCase', {...}, 'openObligations', fn) — the key is gathered, not inlined
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'ai.prompt', id: 'poCase', path: 'ai/prompts/poCase.json' }],
    files: {
      'ai/prompts/poCase.json': { id: 'poCase' },
      'ai/prompts/poCase.content.md': 'Case [[${caseId}]] with [[${openObligations}]]',
      'fd/scripts/w/parts/a.js': "fireGathered('poCase', { caseId: id }, 'openObligations', function (cb) { gather(cb); });",
    },
  });
  assert.deepEqual(lintPromptVariables(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('no caller at all is informational, never evidence (a prompt may be called from outside)', () => {
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'ai.prompt', id: 'poSolo', path: 'ai/prompts/poSolo.json' }],
    files: {
      'ai/prompts/poSolo.json': { id: 'poSolo' },
      'ai/prompts/poSolo.content.md': 'Hello [[${who}]]',
    },
  });
  const [f] = lintPromptVariables(pkg);
  assert.equal(f.kind, 'no-caller');
  assert.match(f.message, /fine if it is called from outside/);
  rmSync(dir, { recursive: true, force: true });
});

test('a dynamically built payload proves nothing and is not reported', () => {
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'ai.prompt', id: 'poDyn', path: 'ai/prompts/poDyn.json' }],
    files: {
      'ai/prompts/poDyn.json': { id: 'poDyn' },
      'ai/prompts/poDyn.content.md': '[[${a}]] [[${b}]]',
      'fd/handlers/H/handler.js': "var p = build(); callPrompt(token, 'poDyn', p, 60);",
    },
  });
  assert.deepEqual(lintPromptVariables(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('a prompt with no variables is never reported', () => {
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'ai.prompt', id: 'poFlat', path: 'ai/prompts/poFlat.json' }],
    files: { 'ai/prompts/poFlat.json': { id: 'poFlat' }, 'ai/prompts/poFlat.content.md': 'no variables here' },
  });
  assert.deepEqual(lintPromptVariables(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('promptProviderOrder explains why the handler pushes before the prompt', () => {
  const { pkg, dir } = pkgOf({
    resources: [
      { kind: 'ai.prompt', id: 'poCase', path: 'ai/prompts/poCase.json' },
      { kind: 'fd.handler', id: 'PoCase_onUpdate', path: 'fd/handlers/PoCase_onUpdate' },
    ],
    files: {
      'ai/prompts/poCase.json': { id: 'poCase' },
      'fd/handlers/PoCase_onUpdate/handler.js': "callPrompt(token, 'poCase', { caseId: id }, 60);",
    },
  });
  const [hint] = promptProviderOrder(pkg, pkg.entries());
  assert.equal(hint.prompt, 'poCase');
  assert.deepEqual(hint.before, ['PoCase_onUpdate']);
  assert.match(hint.why, /already carries every variable/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #9 — include order
// ---------------------------------------------------------------------------

test('includeOrders reports directives in source order', () => {
  const { pkg, dir } = pkgOf({
    files: { 'fd/handlers/H/handler.js': '// @include ../_shared/a.js\n// @include ../_shared/b.js\nmain();' },
  });
  assert.deepEqual(includeOrders(pkg), [{ path: 'fd/handlers/H/handler.js', includes: ['../_shared/a.js', '../_shared/b.js'] }]);
  rmSync(dir, { recursive: true, force: true });
});

test('an order contradicting the declaration is caught; the right order is silent', () => {
  const files = { 'fd/handlers/H/handler.js': '// @include ../_shared/sla.js\n// @include ../_shared/po-lib.js\n' };
  const bad = pkgOf({ manifest: { includeOrder: ['po-lib.js', 'sla.js'] }, files });
  const [p] = lintIncludeOrder(bad.pkg);
  assert.match(p.message, /@include po-lib\.js comes after sla\.js/);
  assert.match(p.message, /fails only at run time/);
  rmSync(bad.dir, { recursive: true, force: true });

  const good = pkgOf({ manifest: { includeOrder: ['sla.js', 'po-lib.js'] }, files });
  assert.deepEqual(lintIncludeOrder(good.pkg), []);
  rmSync(good.dir, { recursive: true, force: true });
});

test('a source using only SOME libraries must not contradict the order (subsequence, not equality)', () => {
  const { pkg, dir } = pkgOf({
    manifest: { includeOrder: ['a.js', 'b.js', 'c.js'] },
    files: { 'fd/handlers/H/handler.js': '// @include ../_shared/a.js\n// @include ../_shared/c.js\n' },
  });
  assert.deepEqual(lintIncludeOrder(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

test('no declaration = no lint (the order stays optional)', () => {
  const { pkg, dir } = pkgOf({
    files: { 'fd/handlers/H/handler.js': '// @include ../_shared/z.js\n// @include ../_shared/a.js\n' },
  });
  assert.deepEqual(declaredIncludeOrder(pkg), []);
  assert.deepEqual(lintIncludeOrder(pkg), []);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #17 — composed size budget
// ---------------------------------------------------------------------------

test('resourceSizes measures the COMPOSED bytes and what strip would save', () => {
  const body = `${'// a full-line comment that strip removes\n'.repeat(200)}code();\n`;
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'fd.script', id: 's', path: 'fd/scripts/s' }],
    files: {
      'fd/scripts/s/meta.json': { name: 's', registrationOrder: '1', contentFile: 's.js' },
      'fd/scripts/s/s.js': '// @include ./part.js\n',
      'fd/scripts/s/part.js': body,
    },
  });
  const [r] = resourceSizes(pkg, pkg.entries());
  assert.equal(r.file, 's.js');
  assert.ok(r.bytes > 8000, `expanded, not the 22-byte source (got ${r.bytes})`);
  assert.ok(r.saved > 7000, `strip should save the comment lines (got ${r.saved})`);
  rmSync(dir, { recursive: true, force: true });
});

test('sizeWarnings distinguishes "close to the limit" from "over it"', () => {
  const near = sizeWarnings([{ kind: 'fd.script', id: 'a', file: 'a.js', bytes: 950_000, saved: 0 }], 900_000);
  assert.equal(near[0].over, false);
  assert.match(near[0].message, /within 50\.0 kB of the ~1000\.0 kB server body limit/);

  const over = sizeWarnings([{ kind: 'fd.script', id: 'b', file: 'b.js', bytes: HARD_LIMIT_BYTES + 1, saved: 5000 }], 900_000);
  assert.equal(over[0].over, true);
  assert.match(over[0].message, /the push will answer 413/);
  assert.match(over[0].message, /strip.*would save/);

  assert.deepEqual(sizeWarnings([{ kind: 'x', id: 'y', file: 'f', bytes: 10, saved: 0 }], 900_000), []);
});

// ---------------------------------------------------------------------------
// #1 — pull must not flatten a composed source (lib/sync.mjs: composedSources)
// ---------------------------------------------------------------------------

test('composedSources finds the @include-built files pull must not overwrite', async () => {
  const { composedSources } = await import('../lib/sync.mjs');
  const { pkg, dir } = pkgOf({
    resources: [
      { kind: 'fd.script', id: 'w', path: 'fd/scripts/w' },
      { kind: 'fd.script', id: 'flat', path: 'fd/scripts/flat' },
    ],
    files: {
      'fd/scripts/w/meta.json': { name: 'w', registrationOrder: '1', contentFile: 'w.js' },
      'fd/scripts/w/w.js': '// @include ./parts/01.js\n// @include ./parts/02.js\n',
      'fd/scripts/w/parts/01.js': 'one();\n',
      'fd/scripts/w/parts/02.js': 'two();\n',
      'fd/scripts/flat/meta.json': { name: 'flat', registrationOrder: '2', contentFile: 'flat.js' },
      'fd/scripts/flat/flat.js': 'plain();\n',
    },
  });
  assert.deepEqual(composedSources(pkg, pkg.entry('fd.script', 'w')), ['fd/scripts/w/w.js']);
  assert.deepEqual(composedSources(pkg, pkg.entry('fd.script', 'flat')), [], 'a plain source pulls normally');
  rmSync(dir, { recursive: true, force: true });
});

test('composedSources ignores json-layout kinds (nothing to flatten there)', async () => {
  const { composedSources } = await import('../lib/sync.mjs');
  const { pkg, dir } = pkgOf({
    resources: [{ kind: 'fd.tagclass', id: 'T', path: 'fd/tagclasses/T.json' }],
    files: { 'fd/tagclasses/T.json': { id: 'T', type: 'STRING' } },
  });
  assert.deepEqual(composedSources(pkg, pkg.entry('fd.tagclass', 'T')), []);
  rmSync(dir, { recursive: true, force: true });
});
