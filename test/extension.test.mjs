// `uxc init --extension` (the partner kit) and the extension prefix lint (DESIGN §27). Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { lintExtension, carriesPrefix } from '../lib/extension.mjs';
import { parseDependsOn, renderText } from '../lib/extension-kit.mjs';
import verifyCmd from '../lib/commands/verify.mjs';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'uxc.mjs');
const made = [];
const tmp = (p = 'uxc-ext-') => { const d = mkdtempSync(join(os.tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
// the child's os.tmpdir() — where `init --extension` stages — is private, so a test can see leftovers
const STAGE = tmp('uxc-stage-');
const childEnv = { ...process.env, TMPDIR: STAGE, TEMP: STAGE, TMP: STAGE };
function uxc(args, { cwd } = {}) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, ...args], { cwd, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
}
const initGeneric = (extra = []) => {
  const dir = join(tmp(), 'ext');
  const r = uxc(['init', '--extension', 'acme', '--depends-on', 'case-management@>=0.3', '--dep-code', 'cm', ...extra, dir]);
  assert.equal(r.code, 0, r.out);
  return dir;
};
const codes = (dir) => lintExtension(openPackage(dir)).map((f) => f.code);

// ---------------------------------------------------------------- init: generic kit

test('init --extension (generic kit): own package, dependency declared, one example per kind', () => {
  const dir = initGeneric();
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  assert.equal(m.code, 'acme');
  assert.deepEqual(m.dependencies, { cm: { slug: 'case-management', versions: '>=0.3' } });
  assert.deepEqual(m.extension, { of: 'cm' });
  assert.deepEqual(m.idPrefixes, { pascal: 'Acme', camel: 'acme', kebab: 'acme-', upper: 'ACME_' });
  assert.deepEqual(m.registrationOrderBands, { 'fd.script': [950, 959] });
  const res = openPackage(dir).entries().map((e) => `${e.kind}/${e.id}`).sort();
  assert.deepEqual(res, ['ai.prompt/acmeExample', 'fd.dataset/AcmeExamples', 'fd.documentclass/AcmeExample', 'fd.script/acme-example']);
  for (const f of ['tests/10-script.test.mjs', 'tests/20-prompt.test.mjs', 'tests/30-dataset.test.mjs']) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /EXTENDS `cm`/);
  assert.deepEqual(codes(dir), [], 'a fresh extension passes its own lint');
});

test('init --extension: the generated offline tests are green through `uxc test --offline`', () => {
  const dir = initGeneric();
  const r = uxc(['test', '--offline'], { cwd: dir });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 pass · 0 fail/);
});

test('init --extension: a generated test turns red when an id leaves the package prefix', () => {
  const dir = initGeneric();
  const p = join(dir, 'registry.json');
  const reg = JSON.parse(readFileSync(p, 'utf8'));
  reg.resources.find((r) => r.kind === 'ai.prompt').id = 'cmStray';
  writeFileSync(p, JSON.stringify(reg));
  const r = uxc(['test', '--offline', 'prompt'], { cwd: dir });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /cmStray must carry one of this package/);
});

test('init --extension --kinds narrows the examples; the form --extension --code works too', () => {
  const dir = join(tmp(), 'ext');
  const r = uxc(['init', '--extension', '--code', 'zed', '--depends-on', 'cm@*', '--kinds', 'script', dir]);
  assert.equal(r.code, 0, r.out); // the slug "cm" doubles as the dependency code
  const pkg = openPackage(dir);
  assert.deepEqual(pkg.entries().map((e) => e.kind), ['fd.script']);
  assert.ok(pkg.manifest.dependencies.cm);
  assert.ok(!existsSync(join(dir, 'tests', '20-prompt.test.mjs')));
});

test('init --extension refusals', () => {
  const base = ['init', '--extension', 'acme'];
  const dep = ['--depends-on', 'case-management@>=0.3', '--dep-code', 'cm'];
  const d = () => join(tmp(), 'x');
  assert.match(uxc([...base, d()]).out, /needs --depends-on/);
  assert.match(uxc([...base, '--depends-on', 'case-management', d()]).out, /<slug>@<range>/);
  assert.match(uxc([...base, '--depends-on', 'case-management@nonsense', d()]).out, /range "nonsense" is not valid/);
  assert.match(uxc([...base, '--depends-on', 'case-management@>=1', d()]).out, /cannot tell the package code/);
  assert.match(uxc([...base, '--depends-on', 'case-management@>=1', '--dep-code', 'acme', d()]).out, /is the dependency's code/);
  assert.match(uxc(['init', '--extension', 'Bad!', ...dep, d()]).out, /must be short lowercase/);
  assert.match(uxc([...base, ...dep, '--kinds', 'nope', d()]).out, /"nope" is not an extension kind here/);
  assert.match(uxc(['init', '--name', 'X', '--code', 'xy', '--depends-on', 'a@*', d()]).out, /only applies with --extension/);
  assert.match(uxc(['init', '--extension', 'acme', '--code', 'other', ...dep, d()]).out, /disagree/);
  const dir = initGeneric();
  assert.match(uxc([...base, ...dep, dir]).out, /already exists/);
});

test('plain `uxc init` is unchanged (no extension block, default bands)', () => {
  const dir = join(tmp(), 'plain');
  assert.equal(uxc(['init', '--name', 'Plain', '--code', 'pl', dir]).code, 0);
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  assert.equal(m.extension, undefined);
  assert.equal(m.dependencies, undefined);
  assert.deepEqual(m.registrationOrderBands['fd.script'], [930, 949]);
});

test('parseDependsOn / renderText', () => {
  assert.deepEqual(parseDependsOn('case-management@>=0.3'), { slug: 'case-management', range: '>=0.3' });
  assert.deepEqual(parseDependsOn('a@1.2.*'), { slug: 'a', range: '1.2.*' });
  assert.equal(renderText('{{pascal}}-{{ dep.code }}', { pascal: 'Acme', 'dep.code': 'cm' }), 'Acme-cm');
});

// ---------------------------------------------------------------- init: the dependency's own kit

function fakeProduct() {
  const root = tmp('uxc-product-');
  writeFileSync(join(root, 'uxopian-project.json'), JSON.stringify({
    format: 'uxopian-package/1', name: 'Case Management', code: 'cm', version: '0.4.2', products: ['flowerdocs'],
  }));
  const kit = join(root, 'extension-kit');
  mkdirSync(join(kit, 'tpl'), { recursive: true });
  writeFileSync(join(kit, 'kit.json'), JSON.stringify({
    format: 'uxc-extension-kit/1',
    manifest: {
      extension: { library: { classId: 'CmServerLibrary', endMarker: "var CM_LIB_FIN = '{id}';" }, rowKeyTags: { CmRuleSet: ['CmRuleKey'] } },
      registrationOrderBands: { 'fd.script': [950, 959] },
    },
    claude: 'Read docs/REFERENCE.md (contract v1) and run the verifier before any push. Dependency: {{dep.code}} {{dep.version}}.',
    examples: {
      detector: {
        summary: 'a detector library',
        files: {
          'fd/scripts/{{kebab}}lib/meta.json': 'tpl/meta.json',
          'fd/scripts/{{kebab}}lib/{{kebab}}lib.js': 'tpl/lib.js',
          'data/{{pascal}}Extensions.jsonl': 'tpl/ext.jsonl',
          'tests/10-detector.test.mjs': 'tpl/detector.test.mjs',
        },
        registry: [{ kind: 'fd.script', id: '{{kebab}}lib', path: 'fd/scripts/{{kebab}}lib' }],
        dataSets: [{ name: '{{pascal}}Extensions', classId: 'CmExtensions', path: 'data/{{pascal}}Extensions.jsonl' }],
      },
      effect: { summary: 'an effect', files: { 'tests/20-effect.test.mjs': 'tpl/effect.test.mjs' } },
    },
  }));
  writeFileSync(join(kit, 'tpl/meta.json'), JSON.stringify({ name: '{{pascal}} lib', acl: 'acl-readonly', classId: 'CmServerLibrary', registrationOrder: null, contentFile: '{{kebab}}lib.js' }));
  writeFileSync(join(kit, 'tpl/lib.js'), "CmCap.detecteur('{{upper}}X', 'd', function () { return false; });\nvar CM_LIB_FIN = '{{kebab}}lib';\n");
  writeFileSync(join(kit, 'tpl/ext.jsonl'), JSON.stringify({ category: 'DOCUMENT', data: { classId: 'CmExtensions' }, id: '{{upper}}LIB', name: '{{upper}}LIB', tags: [{ name: 'CmRuleKey', readOnly: false, value: ['{{upper}}LIB'] }] }) + '\n');
  const t = (n) => `export default { name: '${n} {{code}}', offline: true, run: async (t) => { t.expect(t.pkg.manifest.dependencies['{{dep.code}}'].versions === '{{dep.range}}', 'dep'); } };\n`;
  writeFileSync(join(kit, 'tpl/detector.test.mjs'), t('detector'));
  writeFileSync(join(kit, 'tpl/effect.test.mjs'), t('effect'));
  return root;
}
const initKit = (root, extra = []) => {
  const dir = join(tmp(), 'ext');
  const r = uxc(['init', '--extension', 'acme', '--depends-on', 'case-management@>=0.3', '--product-dir', root, ...extra, dir]);
  return { dir, r };
};

test('init --product-dir: the kit of the depended-on package drives the examples', () => {
  const { dir, r } = initKit(fakeProduct());
  assert.equal(r.code, 0, r.out);
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.dependencies), ['cm'], 'the code comes from the product manifest, not the slug');
  assert.equal(m.extension.of, 'cm');
  assert.equal(m.extension.library.classId, 'CmServerLibrary');
  assert.deepEqual(m.dataSets, [{ classId: 'CmExtensions', content: false, name: 'AcmeExtensions', path: 'data/AcmeExtensions.jsonl' }]);
  assert.equal(readFileSync(join(dir, 'fd/scripts/acme-lib/acme-lib.js'), 'utf8').split('\n').at(-2), "var CM_LIB_FIN = 'acme-lib';");
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /Dependency: cm 0\.4\.2\./);
  assert.deepEqual(codes(dir), []);
  const t = uxc(['test', '--offline'], { cwd: dir });
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /2 pass · 0 fail/);
});

test('init --product-dir --kinds picks kit kinds; a kind the kit lacks is refused', () => {
  const root = fakeProduct();
  const ok = initKit(root, ['--kinds', 'effect']);
  assert.equal(ok.r.code, 0, ok.r.out);
  assert.ok(!existsSync(join(ok.dir, 'fd/scripts')));
  assert.match(initKit(root, ['--kinds', 'script']).r.out, /"script" is not an extension kind here/);
});

test('the kit-generated package is held to the kit\'s library and key rules', () => {
  const { dir } = initKit(fakeProduct());
  // a library that loses its end marker
  appendFileSync(join(dir, 'fd/scripts/acme-lib/acme-lib.js'), 'var stray = 1;\n');
  assert.deepEqual(codes(dir), ['EXT_LIBRARY']);
  // a product class on the library
  const mp = join(dir, 'fd/scripts/acme-lib/meta.json');
  writeFileSync(mp, readFileSync(mp, 'utf8').replace('CmServerLibrary', 'Script'));
  assert.equal(codes(dir).filter((c) => c === 'EXT_LIBRARY').length, 2);
  // a row key that does not end with our upper prefix
  const rp = join(dir, 'data/AcmeExtensions.jsonl');
  writeFileSync(rp, readFileSync(rp, 'utf8').replace('"value":["ACME_LIB"]', '"value":["cm.rules.CM_ORDER"]').replace('CmExtensions', 'CmRuleSet'));
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  m.dataSets[0].classId = 'CmRuleSet';
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify(m));
  assert.ok(codes(dir).includes('EXT_ROW_KEY'));
});

test('init --product-dir refusals', () => {
  const dir = join(tmp(), 'x');
  assert.match(uxc(['init', '--extension', 'acme', '--depends-on', 'a@*', '--product-dir', tmp(), dir]).out, /no uxopian-project.json/);
  const root = fakeProduct();
  writeFileSync(join(root, 'extension-kit/kit.json'), JSON.stringify({ format: 'nope', examples: { a: {} } }));
  assert.match(uxc(['init', '--extension', 'acme', '--depends-on', 'a@*', '--product-dir', root, dir]).out, /format must be "uxc-extension-kit\/1"/);
  const r2 = fakeProduct();
  const kj = JSON.parse(readFileSync(join(r2, 'extension-kit/kit.json'), 'utf8'));
  kj.examples.effect.files = { '../escape.txt': 'tpl/effect.test.mjs' };
  writeFileSync(join(r2, 'extension-kit/kit.json'), JSON.stringify(kj));
  assert.match(uxc(['init', '--extension', 'acme', '--depends-on', 'a@*', '--product-dir', r2, dir]).out, /must be a relative path inside the package/);
  // registry and dataSet paths get the same check as file destinations, after rendering
  for (const [field, bad] of [['registry', '../{{kebab}}lib'], ['dataSets', '{{kebab}}/../../x.jsonl'], ['registry', '/abs/{{kebab}}']]) {
    const rp = fakeProduct();
    const k = JSON.parse(readFileSync(join(rp, 'extension-kit/kit.json'), 'utf8'));
    k.examples.detector[field][0].path = bad;
    writeFileSync(join(rp, 'extension-kit/kit.json'), JSON.stringify(k));
    const out = uxc(['init', '--extension', 'acme', '--depends-on', 'a@*', '--product-dir', rp, dir]).out;
    assert.match(out, field === 'registry' ? /registry path: ".*" must be a relative path inside the package/ : /dataSet path: ".*" must be a relative path/);
  }
  assert.ok(!existsSync(dir), 'nothing reached the target');
  const r3 = fakeProduct();
  writeFileSync(join(r3, 'extension-kit/tpl/effect.test.mjs'), '{{nope}}');
  assert.match(uxc(['init', '--extension', 'acme', '--depends-on', 'a@*', '--product-dir', r3, dir]).out, /unknown placeholder \{\{nope\}\}/);
});

test('a dependency without a kit falls back to the generic examples', () => {
  const root = tmp('uxc-product-');
  writeFileSync(join(root, 'uxopian-project.json'), JSON.stringify({ format: 'uxopian-package/1', name: 'P', code: 'pp', version: '1.0.0' }));
  const dir = join(tmp(), 'ext');
  const r = uxc(['init', '--extension', 'acme', '--depends-on', 'p-slug@*', '--product-dir', root, dir]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(openPackage(dir).manifest.dependencies), ['pp']);
  assert.equal(openPackage(dir).entries().length, 4);
});

// ---------------------------------------------------------------- the prefix lint

test('carriesPrefix is strict about word boundaries', () => {
  assert.ok(carriesPrefix('cm', 'CmBoot') && carriesPrefix('cm', 'cmBoot') && carriesPrefix('cm', 'cm-lib-b') && carriesPrefix('cm', 'CM_X'));
  assert.ok(!carriesPrefix('cm', 'Cmd') && !carriesPrefix('cm', 'cmdFoo') && !carriesPrefix('cm', 'Acme'));
});

test('lint: a package with no dependency and no extension block is never judged', () => {
  const dir = initGeneric();
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  delete m.dependencies; delete m.extension;
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify(m));
  assert.deepEqual(codes(dir), []);
});

function mutate(dir, fn) {
  const pkg = openPackage(dir);
  fn(pkg);
  pkg.saveRegistry();
  return codes(dir);
}

test('lint: EXT_PRODUCT_RESOURCE and EXT_FOREIGN_RESOURCE (and external references stay allowed)', () => {
  const dir = initGeneric();
  assert.deepEqual(mutate(dir, (p) => p.addEntry({ kind: 'fd.documentclass', id: 'CmOrder', path: 'fd/classes/CmOrder.json', policy: 'managed' })), ['EXT_PRODUCT_RESOURCE']);
  assert.deepEqual(mutate(dir, (p) => p.addEntry({ kind: 'fd.documentclass', id: 'Stray', path: 'fd/classes/Stray.json', policy: 'managed' })), ['EXT_PRODUCT_RESOURCE', 'EXT_FOREIGN_RESOURCE']);
  assert.deepEqual(mutate(dir, (p) => { for (const e of p.entries()) if (['CmOrder', 'Stray'].includes(e.id)) e.policy = 'external'; }), []);
});

test('lint: a non-extension package that depends on another is only judged on the dependency\'s namespace', () => {
  const dir = initGeneric();
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  delete m.extension;
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify(m));
  assert.deepEqual(mutate(dir, (p) => p.addEntry({ kind: 'fd.documentclass', id: 'Stray', path: 'x', policy: 'managed' })), [], 'foreign ids are fine without the opt-in');
  assert.deepEqual(mutate(dir, (p) => p.addEntry({ kind: 'fd.documentclass', id: 'CmOrder', path: 'y', policy: 'managed' })), ['EXT_PRODUCT_RESOURCE']);
});

test('lint: dataset rows — EXT_PRODUCT_ROW, EXT_ROW_PREFIX, tombstones judged by _id', () => {
  const dir = initGeneric();
  const f = join(dir, 'data/AcmeExamples.jsonl');
  const row = (id) => JSON.stringify({ category: 'DOCUMENT', data: { classId: 'AcmeExample' }, id, name: id }) + '\n';
  appendFileSync(f, row('CM_ORDER_FR'));
  assert.deepEqual(codes(dir), ['EXT_PRODUCT_ROW']);
  appendFileSync(f, row('OTHER_ROW'));
  appendFileSync(f, JSON.stringify({ _deleted: true, _id: 'CM_GONE' }) + '\n');
  assert.deepEqual(codes(dir).sort(), ['EXT_PRODUCT_ROW', 'EXT_PRODUCT_ROW', 'EXT_ROW_PREFIX']);
});

test('lint: EXT_NO_DEPENDENCY and EXT_PRODUCT_CODE', () => {
  const dir = initGeneric();
  const p = join(dir, 'uxopian-project.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...m, dependencies: {} }));
  assert.deepEqual(codes(dir), ['EXT_NO_DEPENDENCY']);
  writeFileSync(p, JSON.stringify({ ...m, dependencies: { acme: '*' } }));
  assert.ok(codes(dir).includes('EXT_PRODUCT_CODE'));
});

test('lint findings carry the code in the message and the offending id', () => {
  const dir = initGeneric();
  mutate(dir, (p) => p.addEntry({ kind: 'ai.prompt', id: 'cmHijack', path: 'ai/prompts/cmHijack.json', policy: 'managed' }));
  const [f] = lintExtension(openPackage(dir));
  assert.equal(f.code, 'EXT_PRODUCT_RESOURCE');
  assert.match(f.message, /^EXT_PRODUCT_RESOURCE: ai\.prompt\/cmHijack .*dependency "cm"/);
});

test('uxc verify fails offline on a prefix violation (no server involved for the lint)', async () => {
  const dir = initGeneric();
  // verify reads the registry entries on the server; keep the registry empty so only the lint speaks
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  appendFileSync(join(dir, 'data/AcmeExamples.jsonl'), JSON.stringify({ category: 'DOCUMENT', data: { classId: 'AcmeExample' }, id: 'CM_STOLEN', name: 'x' }) + '\n');
  const lines = []; let result = null;
  const ctx = {
    args: [], flags: {},
    out: { line: (l) => lines.push(l), note() {}, warn() {}, result: (o) => { result = o; } },
    requirePkg: () => openPackage(dir), connect() {},
  };
  const prev = process.exitCode;
  await verifyCmd.run(ctx);
  const code = process.exitCode; process.exitCode = prev;
  assert.equal(code, 1);
  assert.ok(result.failures.some((m) => m.startsWith('EXT_PRODUCT_ROW:')), lines.join('\n'));
});

// ---------------------------------------------------------------- review fixes (#87)

test('lint: a self-reference in dependencies is tolerated without an extension block', () => {
  const dir = initGeneric();
  const p = join(dir, 'uxopian-project.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  delete m.extension;
  writeFileSync(p, JSON.stringify({ ...m, dependencies: { acme: { versions: '*' } } }));
  assert.deepEqual(codes(dir), [], 'dependencies.mjs ignores a self-reference; the lint must not block it');
  writeFileSync(p, JSON.stringify({ ...m, dependencies: { acme: { versions: '*' }, cm: { versions: '*' } } }));
  assert.deepEqual(codes(dir), []);
});

test('lint: rows honor a custom manifest.idPrefixes', () => {
  const dir = initGeneric();
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  const p = join(dir, 'uxopian-project.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...m, idPrefixes: { pascal: 'Ax', camel: 'ax', kebab: 'ax-', upper: 'AX_' } }));
  const f = join(dir, 'data/AcmeExamples.jsonl');
  writeFileSync(f, JSON.stringify({ category: 'DOCUMENT', data: { classId: 'AcmeExample' }, id: 'AX_ROW', name: 'AX_ROW' }) + '\n');
  assert.deepEqual(codes(dir), [], 'AX_ROW carries the custom upper prefix');
  appendFileSync(f, JSON.stringify({ category: 'DOCUMENT', data: { classId: 'AcmeExample' }, id: 'ZZ_ROW', name: 'ZZ_ROW' }) + '\n');
  const [finding] = lintExtension(openPackage(dir));
  assert.equal(finding.code, 'EXT_ROW_PREFIX');
  assert.match(finding.message, /Ax, ax, ax-, AX_/);
});

test('init --extension refuses to overwrite files in the target unless --force; CLAUDE.md is appended', () => {
  const dir = join(tmp(), 'ext');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests/10-script.test.mjs'), 'mine');
  writeFileSync(join(dir, 'README.md'), 'mine too');
  writeFileSync(join(dir, 'CLAUDE.md'), '# keep me\n');
  const args = ['init', '--extension', 'acme', '--depends-on', 'case-management@>=0.3', '--dep-code', 'cm', dir];
  const r = uxc(args);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /2 file\(s\) already exist/);
  assert.match(r.out, /README\.md/);
  assert.match(r.out, /tests\/10-script\.test\.mjs/);
  assert.match(r.out, /--force/);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'mine too');
  assert.ok(!existsSync(join(dir, 'uxopian-project.json')));
  const f = uxc([...args, '--force']);
  assert.equal(f.code, 0, f.out);
  assert.notEqual(readFileSync(join(dir, 'tests/10-script.test.mjs'), 'utf8'), 'mine');
  assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /^# keep me\n[\s\S]*EXTENDS `cm`/);
  assert.match(uxc(['init', '--name', 'X', '--code', 'xy', '--force', join(tmp(), 'p')]).out, /--force only applies with --extension/);
});

test('init --extension: a name with quotes is data in the kit manifest, never JSON syntax', () => {
  const root = fakeProduct();
  const kp = join(root, 'extension-kit/kit.json');
  const k = JSON.parse(readFileSync(kp, 'utf8'));
  k.manifest.extension.label = '{{name}} for {{dep.code}}';
  k.manifest.extension.rowKeyTags['{{pascal}}Rules'] = ['{{pascal}}Key'];
  writeFileSync(kp, JSON.stringify(k));
  const name = 'Acme "Pro", \\ "x": 1';
  const { dir, r } = initKit(root, ['--name', name]);
  assert.equal(r.code, 0, r.out);
  const m = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  assert.equal(m.extension.label, `${name} for cm`);
  assert.deepEqual(m.extension.rowKeyTags.AcmeRules, ['AcmeKey'], 'keys are rendered too');
  assert.equal(m.x, undefined, 'no key injected');
});

test('init --extension: a placeholder value that is not a portable file name is refused in a path', () => {
  for (const dest of ['docs/{{dep.range}}.md', 'docs/{{name}}.md', 'docs/x./a.md']) {
    const root = fakeProduct();
    const kp = join(root, 'extension-kit/kit.json');
    const k = JSON.parse(readFileSync(kp, 'utf8'));
    k.examples.effect.files = { [dest]: 'tpl/effect.test.mjs' };
    writeFileSync(kp, JSON.stringify(k));
    const { dir, r } = initKit(root, ['--kinds', 'effect', '--name', 'What? Now']);
    assert.notEqual(r.code, 0, dest);
    assert.match(r.out, /is not a portable file name/, dest);
    assert.ok(!existsSync(dir));
  }
});

test('init --extension leaves no staging directory behind, on success or failure', () => {
  const before = readdirSync(STAGE).filter((n) => n.startsWith('uxc-init-'));
  initGeneric();
  const root = fakeProduct();
  writeFileSync(join(root, 'extension-kit/tpl/effect.test.mjs'), '{{nope}}');
  assert.notEqual(initKit(root).r.code, 0);
  const dir = join(tmp(), 'ext');
  mkdirSync(dir); writeFileSync(join(dir, 'README.md'), 'x');
  assert.notEqual(uxc(['init', '--extension', 'acme', '--depends-on', 'cm@*', dir]).code, 0);
  assert.deepEqual(readdirSync(STAGE).filter((n) => n.startsWith('uxc-init-')), before);
});
