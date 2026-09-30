// JSON Schemas of the package files (DESIGN §29, #97): the schemas themselves, the zero-dep validator
// subset, the example packages, hash neutrality of `$schema`, the scaffolds and `uxc verify`. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { validateSchema, keywordsOf, SUPPORTED_KEYWORDS, ANNOTATION_KEYWORDS, joinPath } from '../lib/jsonschema.mjs';
import { loadSchemas, lintSchemas, schemaUrl, SCHEMA_DIR, KIND_SCHEMAS, validateAgainst, stampSchema, keepSchemaKey } from '../lib/schemas.mjs';
import { openPackage } from '../lib/registry.mjs';
import { KINDS } from '../lib/kinds/index.mjs';
import { hashResource, canonicalize } from '../lib/canonical.mjs';
import { localOf } from '../lib/sync.mjs';
import verifyCmd from '../lib/commands/verify.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'uxc.mjs');
const EXAMPLES = ['agentic-portfolio', 'sample-package'].map((n) => join(ROOT, 'examples', n));
const made = [];
const tmp = (p = 'uxc-schema-') => { const d = mkdtempSync(join(os.tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const HOME = tmp('uxc-schema-home-');
const env = { ...process.env, UXC_HOME: HOME, HOME, USERPROFILE: HOME };
function uxc(args, cwd) {
  try { return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- the schema files

test('schemas: every file is draft 2020-12, its $id is schemaUrl(name), and it uses only the supported subset', () => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));
  assert.deepEqual(files.sort(), ['compat', 'fd.guiconfig.meta', 'fd.handler.meta', 'fd.script.meta', 'marketplace', 'registry', 'tagclass-delta', 'uxopian-project']
    .map((n) => `${n}.schema.json`));
  const structural = new Set(['properties', '$defs']);
  for (const f of files) {
    const s = readJson(join(SCHEMA_DIR, f));
    const name = f.replace(/\.schema\.json$/, '');
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', f);
    assert.equal(s.$id, schemaUrl(name), f);
    assert.ok(s.description && s.title, `${f}: title + description (editor hover)`);
    for (const k of keywordsOf(s)) {
      // property NAMES are walked too (they sit under `properties`), so accept those by shape
      if (SUPPORTED_KEYWORDS.has(k) || ANNOTATION_KEYWORDS.has(k) || structural.has(k)) continue;
      assert.ok(isPropertyName(s, k), `${f}: keyword "${k}" is outside the validator's subset`);
    }
    // every $ref resolves: validating anything must never report an unresolvable $ref
    const refs = JSON.stringify(s).match(/"\$ref":"[^"]+"/g) ?? [];
    for (const r of refs) {
      const ref = JSON.parse(`{${r}}`).$ref;
      const abs = ref.startsWith('#') ? s.$id + ref : ref; // a local ref resolves inside its own file
      const errs = validateSchema({ $ref: abs }, null, { registry: loadSchemas().byId }).filter((e) => e.keyword === '$ref');
      assert.deepEqual(errs, [], `${f}: ${ref}`);
    }
  }
});
function isPropertyName(schema, k) {
  let found = false;
  (function walk(n) {
    if (!n || typeof n !== 'object' || found) return;
    if (n.properties && Object.prototype.hasOwnProperty.call(n.properties, k)) { found = true; return; }
    for (const v of Object.values(n)) walk(v);
  })(schema);
  return found;
}

test('schemas: registry kind enum lists exactly the kinds uxc knows', () => {
  const { byName } = loadSchemas();
  const kinds = byName.get('registry').$defs.entry.properties.kind.enum;
  assert.deepEqual([...kinds].sort(), Object.keys(KINDS).sort());
  for (const [kind, name] of Object.entries(KIND_SCHEMAS)) {
    assert.ok(KINDS[kind], kind);
    assert.ok(byName.get(name), name);
  }
});

// ---------------------------------------------------------------- the validator subset

test('validator: types, enum, const, pattern, bounds, required, items — with precise paths', () => {
  const s = {
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'integer', minimum: 1, maximum: 5 },
      b: { enum: ['X', 'Y'] },
      c: { const: 'k' },
      d: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 3 },
      e: { type: 'array', minItems: 1, maxItems: 2, items: { type: ['string', 'null'] } },
      'odd key': { type: 'boolean' },
    },
  };
  const v = (x) => validateSchema(s, x).map((e) => `${e.path}|${e.keyword}`);
  assert.deepEqual(v({ a: 3 }), []);
  assert.deepEqual(v({}), ['(root)|required']);
  assert.deepEqual(v([]), ['(root)|type']);
  assert.deepEqual(v({ a: 1.5 }), ['a|type']);
  assert.deepEqual(v({ a: 9 }), ['a|maximum']);
  assert.deepEqual(v({ a: 0 }), ['a|minimum']);
  assert.deepEqual(v({ a: 1, b: 'Z', c: 'j' }), ['b|enum', 'c|const']);
  assert.deepEqual(v({ a: 1, d: 'ABCD' }), ['d|pattern', 'd|maxLength']);
  assert.deepEqual(v({ a: 1, d: 'a' }), ['d|minLength']);
  assert.deepEqual(v({ a: 1, e: [] }), ['e|minItems']);
  assert.deepEqual(v({ a: 1, e: ['x', null, 3] }), ['e|maxItems', 'e[2]|type']);
  assert.deepEqual(v({ a: 1, 'odd key': 1 }), ['["odd key"]|type']);
  const [m] = validateSchema(s, { a: 1, b: 'Z' });
  assert.match(m.message, /must be one of "X", "Y" \(got "Z"\)/);
  assert.equal(joinPath('resources', 3), 'resources[3]');
  assert.equal(joinPath('resources[3]', 'kind'), 'resources[3].kind');
});

test('validator: additionalProperties (false / schema), propertyNames, allOf, anyOf, oneOf, not', () => {
  const closed = { type: 'object', properties: { a: {} }, additionalProperties: false };
  assert.deepEqual(validateSchema(closed, { a: 1, zz: 2 }).map((e) => e.path), ['zz']);
  assert.match(validateSchema(closed, { zz: 2 })[0].message, /unknown key "zz" \(known: a\)/);
  const map = { type: 'object', additionalProperties: { type: 'integer' }, propertyNames: { pattern: '^[a-z]+$' } };
  assert.deepEqual(validateSchema(map, { ok: 1, bad: 'x', Up: 2 }).map((e) => `${e.path}|${e.keyword}`), ['bad|type', 'Up|pattern']);
  assert.deepEqual(validateSchema({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a').map((e) => e.keyword), ['minLength']);
  // anyOf: the branch whose type matched speaks, with its own path
  const any = { anyOf: [{ type: 'string' }, { type: 'object', required: ['v'], properties: { v: { type: 'string' } } }] };
  assert.deepEqual(validateSchema(any, 'x'), []);
  assert.deepEqual(validateSchema(any, { v: 1 }).map((e) => `${e.path}|${e.keyword}`), ['v|type']);
  assert.match(validateSchema(any, 5)[0].message, /must be string or object \(got number\)/);
  const one = { oneOf: [{ type: 'integer' }, { type: 'number' }] };
  assert.equal(validateSchema(one, 1.5).length, 0);
  assert.equal(validateSchema(one, 2)[0].keyword, 'oneOf');
  assert.match(validateSchema({ not: { const: 'Script' } }, 'Script')[0].message, /must not be "Script"/);
});

test('validator: local and cross-file $ref; severity is per node and covers the node\'s own $ref', () => {
  const other = { $id: 'urn:other', $defs: { n: { type: 'integer' } } };
  const s = {
    $defs: { s: { type: 'string' } },
    type: 'object',
    'x-uxc-severity': 'error',
    required: ['must'],
    properties: {
      loc: { $ref: '#/$defs/s' },
      err: { $ref: '#/$defs/s', 'x-uxc-severity': 'error' },
      far: { $ref: 'urn:other#/$defs/n' },
      gone: { $ref: '#/$defs/nope' },
    },
  };
  const registry = new Map([['urn:other', other]]);
  const r = validateSchema(s, { loc: 1, err: 1, far: 'x', gone: 1 }, { registry });
  const by = Object.fromEntries(r.map((e) => [e.path, e]));
  assert.equal(by['(root)'].severity, 'error', 'required at an error node');
  assert.equal(by.loc.severity, 'warning', 'severity does not flow into properties');
  assert.equal(by.err.severity, 'error', 'a node\'s severity covers its $ref');
  assert.equal(by.far.keyword, 'type');
  assert.match(by.gone.message, /unresolvable \$ref/);
});

// ---------------------------------------------------------------- real packages

test('every example package validates clean (no error, no warning)', () => {
  for (const dir of EXAMPLES) assert.deepEqual(lintSchemas(openPackage(dir)), [], dir);
});

test('lintSchemas: errors only where uxc already refuses, warnings otherwise', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'XY-too-long', name: 'x', minClientVersion: 'soon', compat: 'c.json' }));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ kind: 'nope', provides: { f: [] }, renames: { f: { a: 1 } } }));
  writeFileSync(join(dir, 'marketplace.json'), JSON.stringify({ slug: 'Bad Slug', audience: 'everyone' }));
  mkdirSync(join(dir, 'fd/handlers/XyA_onCreate'), { recursive: true });
  writeFileSync(join(dir, 'fd/handlers/XyA_onCreate/meta.json'), JSON.stringify({ objectType: 'DOCUMENT', order: '21', phase: 'LATER', asynchronous: 'yes', custom: 1 }));
  mkdirSync(join(dir, 'fd/scripts/xy-lib'), { recursive: true });
  writeFileSync(join(dir, 'fd/scripts/xy-lib/meta.json'), JSON.stringify({ registrationOrder: null, classId: 'Script' }));
  mkdirSync(join(dir, 'fd/tagclass-deltas'), { recursive: true });
  writeFileSync(join(dir, 'fd/tagclass-deltas/T.delta.json'), JSON.stringify({ tagclass: 'T', allowedValues: [{ displayNames: 'x' }] }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [
    { kind: 'fd.handler', id: 'XyA_onCreate', path: 'fd/handlers/XyA_onCreate' },
    { kind: 'fd.script', id: 'xy-lib', path: 'fd/scripts/xy-lib' },
    { kind: 'fd.tagclass-delta', id: 'T', path: 'fd/tagclass-deltas/T.delta.json' },
    { kind: 'fd.nope', id: 'Q' },
    { kind: 'ai.prompt', policy: 'sometimes' },
  ] }));
  const f = lintSchemas(openPackage(dir));
  const errors = f.filter((x) => x.severity === 'error').map((x) => x.where).sort();
  const warnings = f.filter((x) => x.severity === 'warning').map((x) => x.where).sort();
  assert.deepEqual(errors, [
    'c.json: kind', 'c.json: provides.f',
    'fd/handlers/XyA_onCreate/meta.json: (root)', // action required
    'fd/handlers/XyA_onCreate/meta.json: order', 'fd/handlers/XyA_onCreate/meta.json: phase',
    'fd/scripts/xy-lib/meta.json: classId',
    'fd/tagclass-deltas/T.delta.json: allowedValues[0]', // symbolicName required
    'registry.json: resources[3].kind',
    'uxopian-project.json: minClientVersion',
  ].sort(), JSON.stringify(f, null, 1));
  assert.deepEqual(warnings, [
    'c.json: renames.f.a',
    'fd/handlers/XyA_onCreate/meta.json: asynchronous',
    'fd/tagclass-deltas/T.delta.json: allowedValues[0].displayNames',
    'marketplace.json: (root)', 'marketplace.json: (root)', 'marketplace.json: (root)', 'marketplace.json: audience', 'marketplace.json: slug',
    'registry.json: resources[4]', 'registry.json: resources[4].policy',
    'uxopian-project.json: code',
  ].sort(), JSON.stringify(f, null, 1));
  // unknown keys are tolerated everywhere (no existing package may start failing)
  assert.ok(!f.some((x) => x.path.endsWith('custom')));
});

test('lintSchemas: an inline compat object is checked through the manifest schema', () => {
  const r = validateAgainst('uxopian-project', { code: 'xy', compat: { kind: 'uxc-compat/2' } });
  assert.deepEqual(r.map((e) => `${e.path}|${e.severity}`), ['compat.kind|error']);
  assert.deepEqual(validateAgainst('uxopian-project', { code: 'xy', compat: 'compat.json' }), []);
});

// ---------------------------------------------------------------- $schema is an editor hint only

const URL_OF = (kind) => schemaUrl(KIND_SCHEMAS[kind] ?? 'registry');

test('$schema never changes a resource hash (every kind, every example resource)', () => {
  const samples = {
    'fd.script': { name: 'X', acl: 'acl-readonly', registrationOrder: '930', contentFile: 'x.js' },
    'fd.guiconfig': { name: 'X', acl: 'acl-admin', registrationOrder: '31', contentFile: 'x.xml' },
    'fd.handler': { action: 'CREATE', objectType: 'DOCUMENT', order: 21, script: 'handler.js' },
    'fd.tagclass-delta': { tagclass: 'T', allowedValues: [{ symbolicName: 'XY_A', displayNames: [{ language: 'EN', value: 'A' }] }] },
    'fd.tagclass': { id: 'XyT', type: 'STRING', data: { owner: 'x' } },
    'ai.prompt': { id: 'xyP', role: 'USER', temperature: 0.2 },
  };
  for (const kind of Object.keys(KINDS)) {
    const obj = samples[kind] ?? { id: 'XyThing', name: 'thing' };
    assert.equal(hashResource(kind, { $schema: URL_OF(kind), ...obj }), hashResource(kind, obj), kind);
    assert.equal(canonicalize(kind, { $schema: 'x', ...obj })?.$schema, undefined, kind);
  }
  for (const dir of EXAMPLES) {
    const pkg = openPackage(dir);
    for (const e of pkg.entries()) {
      const local = localOf(pkg, e);
      if (!local?.obj || Array.isArray(local.obj) || typeof local.obj !== 'object') continue;
      const contents = Object.values(local.contents ?? {});
      assert.equal(hashResource(e.kind, { ...local.obj, $schema: URL_OF(e.kind) }, contents), hashResource(e.kind, local.obj, contents), `${e.kind}/${e.id}`);
    }
  }
});

test('$schema survives a canonical rewrite of a meta file (pull / push echo) and is never pushed', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'xy' }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  const pkg = openPackage(dir);
  const cases = [
    ['fd.script', 'xy-a', 'fd/scripts/xy-a', 'meta.json', { name: 'A', acl: 'acl-readonly', registrationOrder: '930', contentFile: 'xy-a.js' }, { 'xy-a.js': Buffer.from('1') }],
    ['fd.guiconfig', 'xy-g', 'fd/guiconfig/xy-g', 'meta.json', { name: 'G', acl: 'acl-admin', registrationOrder: '31', contentFile: 'xy-g.xml' }, { 'xy-g.xml': Buffer.from('<beans/>') }],
    ['fd.handler', 'XyA_onCreate', 'fd/handlers/XyA_onCreate', 'meta.json', { action: 'CREATE', objectType: 'DOCUMENT', order: 21, script: 'handler.js', phase: 'AFTER' }, { 'handler.js': Buffer.from('//') }],
    ['fd.tagclass-delta', 'T', 'fd/tagclass-deltas/T.delta.json', '', { tagclass: 'T', allowedValues: [{ symbolicName: 'XY_A', displayNames: [] }] }, undefined],
    ['fd.tagclass', 'XyT', 'fd/tagclasses/XyT.json', '', { id: 'XyT', type: 'STRING' }, undefined],
  ];
  for (const [kind, id, path, meta, obj, contents] of cases) {
    const entry = pkg.addEntry({ kind, id, path, policy: 'managed' });
    const file = meta ? join(dir, path, meta) : join(dir, path);
    KINDS[kind].writeLocal(pkg, entry, { obj, contents });
    assert.equal(readJson(file).$schema, undefined, `${kind}: a plain write adds nothing`);
    stampSchema(file, KIND_SCHEMAS[kind] ?? 'registry');
    const stamped = readJson(file).$schema;
    assert.ok(stamped, kind);
    KINDS[kind].writeLocal(pkg, entry, { obj, contents }); // the echo leg rewrites the file
    assert.equal(readJson(file).$schema, stamped, `${kind}: $schema kept across the rewrite`);
    assert.equal(Object.keys(readJson(file))[0], '$schema', `${kind}: keys stay sorted`);
  }
  assert.deepEqual(keepSchemaKey(join(dir, 'nope.json'), { a: 1 }), { a: 1 });
  // a class kind's create/update body never carries it to FlowerDocs
  const bodies = [];
  const ctx = { target: { user: 'u' }, clients: { core: { post: async (_p, b) => { bodies.push(b[0]); }, getOne: async () => ({ data: {} }) } } };
  await KINDS['fd.tagclass'].create(ctx, { obj: { $schema: 'x', id: 'XyT' } });
  await KINDS['fd.tagclass'].update(ctx, 'XyT', { obj: { $schema: 'x', id: 'XyT' } });
  assert.ok(bodies.length === 2 && bodies.every((b) => !('$schema' in b)));
});

// ---------------------------------------------------------------- scaffolds

test('scaffolds write $schema: init, add (meta.json, *.delta.json), mp init — and the result validates', () => {
  const dir = join(tmp(), 'pkg');
  let r = uxc(['init', '--name', 'Schema Demo', '--code', 'xy', dir], ROOT);
  assert.equal(r.code, 0, r.out);
  assert.equal(readJson(join(dir, 'uxopian-project.json')).$schema, schemaUrl('uxopian-project'));
  assert.equal(readJson(join(dir, 'registry.json')).$schema, schemaUrl('registry'));
  for (const args of [['fd.script', 'widgets'], ['fd.guiconfig', 'search', '--class', 'XyFoo'], ['fd.handler', 'XyIngest_onCreate'], ['fd.tagclass-delta', 'ProductTag', '--values', 'A,B'], ['fd.tagclass', 'Kind']]) {
    r = uxc(['add', ...args], dir);
    assert.equal(r.code, 0, r.out);
  }
  const reg = readJson(join(dir, 'registry.json'));
  assert.equal(reg.$schema, schemaUrl('registry'), 'add keeps the registry $schema');
  const at = (kind) => reg.resources.find((e) => e.kind === kind).path;
  assert.equal(readJson(join(dir, at('fd.script'), 'meta.json')).$schema, schemaUrl('fd.script.meta'));
  assert.equal(readJson(join(dir, at('fd.guiconfig'), 'meta.json')).$schema, schemaUrl('fd.guiconfig.meta'));
  assert.equal(readJson(join(dir, at('fd.handler'), 'meta.json')).$schema, schemaUrl('fd.handler.meta'));
  assert.equal(readJson(join(dir, at('fd.tagclass-delta'))).$schema, schemaUrl('tagclass-delta'));
  assert.equal(readJson(join(dir, at('fd.tagclass'))).$schema, undefined, 'no schema for class kinds: nothing stamped');
  r = uxc(['mp', 'init'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readJson(join(dir, 'marketplace.json')).$schema, schemaUrl('marketplace'));
  const findings = lintSchemas(openPackage(dir));
  assert.deepEqual(findings.filter((f) => f.severity === 'error'), [], JSON.stringify(findings));
  // the scaffold's own files are clean but for what mp init leaves for the author to fill in
  assert.ok(findings.every((f) => f.file === 'marketplace.json' && /^(maintainer\.(name|email)|summary)$/.test(f.path)), JSON.stringify(findings));
});

test('init --extension stamps the manifest, the registry and the generic script meta', () => {
  const dir = join(tmp(), 'ext');
  const r = uxc(['init', '--extension', 'acme', '--depends-on', 'case-management@>=0.3', '--dep-code', 'cm', dir], ROOT);
  assert.equal(r.code, 0, r.out);
  assert.equal(readJson(join(dir, 'uxopian-project.json')).$schema, schemaUrl('uxopian-project'));
  assert.equal(readJson(join(dir, 'registry.json')).$schema, schemaUrl('registry'));
  const script = readJson(join(dir, 'registry.json')).resources.find((e) => e.kind === 'fd.script');
  assert.equal(readJson(join(dir, script.path, 'meta.json')).$schema, schemaUrl('fd.script.meta'));
  assert.deepEqual(lintSchemas(openPackage(dir)), []);
});

// ---------------------------------------------------------------- verify

test('uxc verify: schema errors fail, schema warnings only warn (offline)', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] })); // nothing to read on a server
  const run = async (manifest) => {
    writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify(manifest));
    const warns = []; let result = null;
    const ctx = { args: [], flags: {}, out: { line() {}, note() {}, warn: (w) => warns.push(w), result: (o) => { result = o; } },
      requirePkg: () => openPackage(dir), connect() {} };
    const prev = process.exitCode;
    await verifyCmd.run(ctx);
    const code = process.exitCode; process.exitCode = prev;
    return { code, warns, failures: result.failures };
  };
  let r = await run({ code: 'xy', name: 'X', version: 'one' });
  assert.notEqual(r.code, 1, 'warnings never fail verify');
  assert.deepEqual(r.failures, []);
  assert.ok(r.warns.some((w) => /^uxopian-project\.json: version: "one" does not match/.test(w)), r.warns.join('\n'));
  r = await run({ code: 'xy', name: 'X', minClientVersion: 'soon' });
  assert.equal(r.code, 1);
  assert.ok(r.failures.some((f) => /^uxopian-project\.json: minClientVersion: "soon" does not match/.test(f)), r.failures.join('\n'));
});

test('minClientVersion: error only where uxc refuses — lenient forms uxc accepts are clean (0.23.0 review)', async () => {
  const { validateAgainst } = await import('../lib/schemas.mjs');
  const errs = (m) => validateAgainst('uxopian-project', { code: 'xy', name: 'X', ...m }).filter((f) => f.severity === 'error').map((f) => f.path);
  for (const v of [null, '', 0.2, ' 1.2.0 ', '1.2.0-', 'v1.2', '1.2.3+build']) assert.deepEqual(errs({ minClientVersion: v }), [], JSON.stringify(v));
  for (const v of ['soon', '1.x', '1.2.3.4']) assert.equal(errs({ minClientVersion: v }).length, 1, v);
});
