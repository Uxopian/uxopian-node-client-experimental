// Offline tests for the f2.map kind (issue #63). Every expectation here mirrors a mechanic
// verified live on a fast2 2026.0.0-rc4 broker and recorded in docs/FAST2-LEARNINGS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import adapter, {
  escapeRe, findLeakedSecrets, danglingLinks, resolveMasked, mapSecrets, MASKED,
} from '../lib/kinds/f2-map.mjs';
import { canonicalize, hashResource } from '../lib/canonical.mjs';
import { KINDS, PUSH_ORDER } from '../lib/kinds/index.mjs';
import { DIALECTS, rangeForVersion } from '../lib/dialects.mjs';
import { conventionalId } from '../lib/naming.mjs';

const tpl = (name = 'ZfDemo') => adapter.template({}, name).obj;
const fieldOf = (obj, step, path) => {
  let fields = obj.steps.find((s) => s.name === step).objectConfiguration.fields;
  const parts = path.split('.');
  for (const p of parts.slice(0, -1)) fields = fields.find((f) => f.name === p).objectConfiguration.fields;
  return fields.find((f) => f.name === parts.at(-1));
};

test('registered with the fd.taskclass shape: createOnly + inPlaceUpdate, pushed LAST (§F8)', () => {
  assert.equal(KINDS['f2.map'], adapter);
  assert.equal(adapter.defaultPolicy, 'createOnly'); // deletion is gated: campaigns can block it
  assert.equal(adapter.inPlaceUpdate, true);         // but updates are safe
  // a map references FD classes and AI prompts, so it deploys after everything it points at
  assert.equal(PUSH_ORDER.at(-1), 'f2.map');
});

test('dialect: fast2 resolves 2026.0.0-rc4 -> f2-2026 with the verified caps (§F2)', () => {
  const r = rangeForVersion('fast2', '2026.0.0-rc4');
  assert.equal(r.name, 'f2-2026');
  assert.equal(r.caps.mapJsonCrud, true);
  assert.equal(r.caps.uploadAutoRenames, true); // why push never uses the upload endpoint (§F7)
  assert.ok(DIALECTS.fast2.ranges.length >= 1);
});

test('conventionalId: map names take the pascal project prefix', () => {
  assert.equal(conventionalId('f2.map', { code: 'ct' }, 'IngestFromShare'), 'CtIngestFromShare');
  assert.equal(conventionalId('f2.map', { code: 'ct' }, 'CtIngestFromShare'), 'CtIngestFromShare');
});

test('escapeRe: an exact-name lookup must not be read as a regex (§F6)', () => {
  assert.equal(escapeRe('Ct.Ingest+v1'), 'Ct\\.Ingest\\+v1');
  assert.ok(new RegExp(`^${escapeRe('Ct.Ingest')}$`).test('Ct.Ingest'));
  assert.ok(!new RegExp(`^${escapeRe('Ct.Ingest')}$`).test('CtXIngest'));
});

test('canonicalize strips ONLY the four server-minted fields; content survives (§F5)', () => {
  const server = { ...tpl(), id: 'uuid', mapVersion: { versionNumber: '2' }, mapVersionsSerieId: 's', isReadOnly: true };
  const c = canonicalize('f2.map', server);
  for (const k of ['id', 'mapVersion', 'mapVersionsSerieId', 'isReadOnly']) assert.ok(!(k in c), `${k} stripped`);
  assert.equal(c.name, 'ZfDemo');
  assert.equal(c.steps.length, 3);
  // step ids and canvas positions are CONTENT (campaign stats are keyed by step id, §F9)
  assert.ok(c.steps.every((s) => s.id));
  assert.equal(c.steps[0].graphic.x, 200);
  assert.deepEqual(c.steps[0].links, [{ target: c.steps[1].id }]);
});

test('secrets: masked on BOTH sides, so a real password never lands on disk and never drifts (§F11)', () => {
  const withPw = (v) => {
    const o = tpl();
    fieldOf(o, 'FlowerInjector', 'connection.password').primitiveConfiguration.value = v;
    return o;
  };
  const server = { ...withPw('xr1c/1e36425517101f'), id: 'u', mapVersion: {}, mapVersionsSerieId: 's', isReadOnly: false };
  const local = withPw('xr1c/1e36425517101f');
  // both sides canonicalize to the same masked form -> insync, no permanent drift
  assert.equal(hashResource('f2.map', server), hashResource('f2.map', local));
  const c = canonicalize('f2.map', local);
  assert.equal(fieldOf(c, 'FlowerInjector', 'connection.password').primitiveConfiguration.value, MASKED);
  assert.deepEqual(findLeakedSecrets(c), []);
  // a DIFFERENT live password still hashes equal: the credential is out of the hash entirely
  const server2 = { ...withPw('xr1c/totallydifferent'), id: 'u' };
  assert.equal(hashResource('f2.map', server2), hashResource('f2.map', local));
});

test('an unrendered {{uxc:…}} variable survives canonicalize (a template stays a template)', () => {
  const c = canonicalize('f2.map', tpl());
  assert.equal(fieldOf(c, 'FlowerInjector', 'connection.password').primitiveConfiguration.value, '{{uxc:f2FlowerPassword}}');
  assert.deepEqual(findLeakedSecrets(c), []); // a placeholder is not a leak
});

test('findLeakedSecrets flags a literal and an obfuscated password, ignores non-secret fields', () => {
  const o = tpl();
  fieldOf(o, 'FlowerInjector', 'connection.password').primitiveConfiguration.value = 'xr1c/abc';
  fieldOf(o, 'FlowerInjector', 'connection.login').primitiveConfiguration.value = 'system';
  const hits = findLeakedSecrets(o);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, 'connection.password');
  assert.match(hits[0].reason, /obfuscated/);

  const o2 = tpl();
  fieldOf(o2, 'FlowerInjector', 'connection.password').primitiveConfiguration.value = 'hunter2';
  assert.match(findLeakedSecrets(o2)[0].reason, /literal/);
});

test('resolveMasked puts the LIVE value back on push, and refuses when there is none', () => {
  const server = tpl();
  fieldOf(server, 'FlowerInjector', 'connection.password').primitiveConfiguration.value = 'xr1c/live';
  const local = mapSecrets(tpl(), () => MASKED);
  const out = resolveMasked(local, server, 'ZfDemo');
  assert.equal(fieldOf(out, 'FlowerInjector', 'connection.password').primitiveConfiguration.value, 'xr1c/live');
  // nothing live to resolve against -> explicit failure, never deploy the literal '__masked__'
  assert.throws(() => resolveMasked(local, mapSecrets(tpl(), () => MASKED), 'ZfDemo'), /no live server value/);
});

test('danglingLinks catches a link to a removed step (links resolve by step id, §F4)', () => {
  assert.deepEqual(danglingLinks(tpl()), []);
  const broken = tpl();
  broken.steps[0].links = [{ target: 'gone' }];
  assert.deepEqual(danglingLinks(broken), [{ from: 'LocalSource', target: 'gone' }]);
});

test('validate: structural checks only — a concrete credential is NOT a push error (DESIGN §21)', () => {
  assert.deepEqual(adapter.validate({}, { id: 'ZfDemo' }, { obj: tpl() }), []);
  // a rendered checkout holds the real value and MUST still push
  const rendered = tpl();
  fieldOf(rendered, 'FlowerInjector', 'connection.password').primitiveConfiguration.value = 'xr1c/real';
  assert.deepEqual(adapter.validate({}, { id: 'ZfDemo' }, { obj: rendered }), []);

  const bad = tpl();
  bad.name = 'Other';
  assert.match(adapter.validate({}, { id: 'ZfDemo' }, { obj: bad }).join(' '), /does not match the registry id/);
  const dupe = tpl();
  dupe.steps[1].id = dupe.steps[0].id;
  assert.match(adapter.validate({}, { id: 'ZfDemo' }, { obj: dupe }).join(' '), /duplicate step ids/);
  assert.match(adapter.validate({}, { id: 'ZfDemo' }, { obj: { name: 'ZfDemo', steps: [] } }).join(' '), /at least one step/);
});

test('template: ASCII description (§F13) and the catalog-verified field names (§F15)', () => {
  const o = tpl();
  // an em dash in the description is a 400 from the broker
  assert.ok(!/[^\x20-\x7E]/.test(o.mapDescription.content), 'description is ASCII');
  // the docs call these flowerDocsConnectionProvider / loadDocumentFileContent — both wrong
  assert.ok(fieldOf(o, 'FlowerInjector', 'connection'), 'connection (not flowerDocsConnectionProvider)');
  assert.ok(fieldOf(o, 'FlowerInjector', 'loadContent'), 'loadContent (not loadDocumentFileContent)');
  assert.ok(fieldOf(o, 'FlowerInjector', 'category'), 'category is required though absent from accessibleFields');
  // map fields wrap BOTH key and value; values are Pattern beans
  const pm = fieldOf(o, 'SetDocumentClass', 'propertyMap');
  assert.ok(Array.isArray(pm.mapConfiguration));
  assert.equal(pm.mapConfiguration[0].key.primitiveConfiguration.value, 'classid');
  assert.equal(pm.mapConfiguration[0].value.objectConfiguration.className, 'com.fast2.model.context.Pattern');
});
