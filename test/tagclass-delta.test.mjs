// Offline tests for the fd.tagclass-delta kind (DESIGN §26): pure merge, push/re-read/skip, rm of own
// values only, status presence, serialization, lint codes. A fake core client stands in for the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { pushResources, statusAll } from '../lib/sync.mjs';
import { KINDS, PUSH_ORDER } from '../lib/kinds/index.mjs';
import adapter from '../lib/kinds/fd-tagclass-delta.mjs';
import { hashResource } from '../lib/canonical.mjs';
import {
  mergeTagDelta, removeOwnValues, sliceOwn, checkTagDelta, lintTagDeltas, valuePrefix,
} from '../lib/tagdelta.mjs';
import { explainCode } from '../lib/explain.mjs';

const FQ = 'com.flower.docs.domain.tagclass.AllowedValue';
const v = (n, en = n, fr = en) => ({ type: FQ, symbolicName: n, displayNames: [{ language: 'EN', value: en }, { language: 'FR', value: fr }] });
const d = (n, en = n, fr = en) => ({ symbolicName: n, displayNames: [{ language: 'EN', value: en }, { language: 'FR', value: fr }] });
const names = (vals) => vals.map((x) => x.symbolicName);

function fakeServer(initial) {
  const tcs = new Map(Object.entries(initial).map(([id, vals]) => [id, { id, type: 'CHOICELIST', allowedValues: vals }]));
  const log = { gets: 0, posts: [], active: 0, maxActive: 0 };
  const core = {
    getOne: async (path) => { log.gets++; const t = tcs.get(decodeURIComponent(path.split('/').pop())); return t ? JSON.parse(JSON.stringify(t)) : null; },
    post: async (path, body) => {
      log.active++; log.maxActive = Math.max(log.maxActive, log.active);
      await new Promise((r) => setTimeout(r, 15));
      log.active--;
      const id = decodeURIComponent(path.split('/').pop());
      assert.ok(Array.isArray(body), 'array body');
      tcs.set(id, JSON.parse(JSON.stringify(body[0])));
      log.posts.push({ path, body: body[0] });
      return {};
    },
  };
  return { tcs, log, core };
}

function makePkg(deltas, { code = 'acme', ownTagclasses = [] } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-tcd-'));
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code, name: 'x', format: 'uxopian-package/1', version: '1.0.0', products: ['flowerdocs'] }));
  const resources = [];
  mkdirSync(join(dir, 'fd/tagclass-deltas'), { recursive: true });
  for (const [tag, obj] of Object.entries(deltas)) {
    const path = `fd/tagclass-deltas/${tag}.delta.json`;
    writeFileSync(join(dir, path), JSON.stringify(obj));
    resources.push({ kind: 'fd.tagclass-delta', id: tag, path });
  }
  mkdirSync(join(dir, 'fd/tagclasses'), { recursive: true });
  for (const t of ownTagclasses) {
    writeFileSync(join(dir, `fd/tagclasses/${t}.json`), JSON.stringify({ id: t, type: 'CHOICELIST', allowedValues: [d('A')] }));
    resources.push({ kind: 'fd.tagclass', id: t, path: `fd/tagclasses/${t}.json` });
  }
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources }));
  return dir;
}

function ctxFor(dir, core) {
  const lines = []; const warns = [];
  const pkg = openPackage(dir);
  const ctx = {
    pkg, requirePkg: () => pkg, connect: () => {}, target: { name: 't1', user: 'admin' },
    clients: { core, cacheClear: async () => {} },
    out: { line: (m) => lines.push(m), note: (m) => lines.push(m), warn: (m) => warns.push(m) },
  };
  return { ctx, lines, warns, pkg };
}

// ---- pure merge ------------------------------------------------------------------------------

test('mergeTagDelta: appends missing values, keeps every server value in place, inherits the echo type', () => {
  const server = [v('CHECK'), v('ISSUE')];
  const r = mergeTagDelta(server, [d('ACME_QC', 'Quality'), d('ACME_X')], { prefix: 'ACME_' });
  assert.deepEqual(names(r.values), ['CHECK', 'ISSUE', 'ACME_QC', 'ACME_X']);
  assert.deepEqual(r.added, ['ACME_QC', 'ACME_X']);
  assert.equal(r.values[2].type, FQ);
  assert.deepEqual(server, [v('CHECK'), v('ISSUE')], 'input untouched (pure)');
});

test('mergeTagDelta: never renames a product value; relabels only prefixed own values', () => {
  const server = [v('CHECK', 'Check'), v('ACME_QC', 'Old')];
  const r = mergeTagDelta(server, [d('CHECK', 'HIJACKED'), d('ACME_QC', 'New')], { prefix: 'ACME_' });
  assert.deepEqual(r.kept, ['CHECK']);
  assert.deepEqual(r.updated, ['ACME_QC']);
  assert.equal(r.values[0].displayNames[0].value, 'Check');
  assert.equal(r.values[1].displayNames[0].value, 'New');
  // without a prefix nothing existing is ever touched
  const r2 = mergeTagDelta(server, [d('ACME_QC', 'New')]);
  assert.deepEqual(r2.kept, ['ACME_QC']);
  assert.equal(r2.values[1].displayNames[0].value, 'Old');
});

test('mergeTagDelta: idempotent', () => {
  const once = mergeTagDelta([v('CHECK')], [d('ACME_QC')], { prefix: 'ACME_' });
  const twice = mergeTagDelta(once.values, [d('ACME_QC')], { prefix: 'ACME_' });
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.unchanged, ['ACME_QC']);
  assert.deepEqual(twice.values, once.values);
});

test('removeOwnValues / sliceOwn: only the named (and prefixed) values', () => {
  const server = [v('CHECK'), v('ACME_QC'), v('ACME_Z')];
  const r = removeOwnValues(server, ['ACME_QC', 'CHECK'], { prefix: 'ACME_' });
  assert.deepEqual(r.removed, ['ACME_QC']);
  assert.deepEqual(names(r.values), ['CHECK', 'ACME_Z']);
  assert.deepEqual(sliceOwn(server, ['ACME_Z', 'ACME_QC']).map((x) => x.symbolicName), ['ACME_QC', 'ACME_Z']);
  assert.equal(sliceOwn(server, ['ACME_QC'])[0].type, undefined, 'projected: no echo discriminator');
});

// ---- lint codes ------------------------------------------------------------------------------

test('checkTagDelta: the three codes', () => {
  const ok = checkTagDelta({ tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] }, { id: 'CmTaskType', prefix: 'ACME_' });
  assert.deepEqual(ok, []);
  const bad = checkTagDelta({ tagclass: 'CmTaskType', allowedValues: [d('QC')] }, { id: 'CmTaskType', prefix: 'ACME_' });
  assert.equal(bad[0].code, 'EXT_TAG_VALUE_PREFIX');
  const own = checkTagDelta({ tagclass: 'AcmeKind', allowedValues: [d('ACME_QC')] }, { id: 'AcmeKind', prefix: 'ACME_', ownTagclasses: ['AcmeKind'] });
  assert.deepEqual(own.map((e) => e.code), ['EXT_TAG_DELTA_OWN']);
  assert.equal(checkTagDelta({ allowedValues: [d('ACME_QC')] }, { id: 'X', prefix: 'ACME_' })[0].code, 'EXT_TAG_CLASS_UNKNOWN');
  assert.equal(checkTagDelta({ tagclass: 'Other', allowedValues: [d('ACME_QC')] }, { id: 'X', prefix: 'ACME_' })[0].code, 'EXT_TAG_CLASS_UNKNOWN');
  assert.equal(checkTagDelta({ tagclass: 'Nope', allowedValues: [d('ACME_QC')] }, { id: 'Nope', prefix: 'ACME_', knownTagclasses: ['CmTaskType'] })[0].code, 'EXT_TAG_CLASS_UNKNOWN');
});

test('lintTagDeltas reads the package; the codes are explained', () => {
  const dir = makePkg({
    CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC'), d('BAD')] },
    AcmeOwn: { tagclass: 'AcmeOwn', allowedValues: [d('ACME_OWN')] },
  }, { ownTagclasses: ['AcmeOwn'] });
  const pkg = openPackage(dir);
  assert.equal(valuePrefix(pkg.manifest), 'ACME_');
  const codes = lintTagDeltas(pkg).map((e) => e.code).sort();
  assert.deepEqual(codes, ['EXT_TAG_DELTA_OWN', 'EXT_TAG_VALUE_PREFIX']);
  for (const c of ['EXT_TAG_VALUE_PREFIX', 'EXT_TAG_CLASS_UNKNOWN', 'EXT_TAG_DELTA_OWN']) assert.equal(explainCode(c).length, 1);
});

// ---- registration ----------------------------------------------------------------------------

test('registered; pushed LAST; id verbatim; delta file path', () => {
  assert.equal(KINDS['fd.tagclass-delta'], adapter);
  assert.equal(PUSH_ORDER[PUSH_ORDER.length - 1], 'fd.tagclass-delta');
  assert.equal(adapter.pathFor({}, 'CmTaskType'), 'fd/tagclass-deltas/CmTaskType.delta.json');
  assert.equal(adapter.restPath, undefined, 'no restPath: status must not batch-list whole tag classes');
});

test('validate refuses a wrong-prefix or own-class delta before any network call', () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('NOPE')] } });
  const pkg = openPackage(dir);
  const e = pkg.entry('fd.tagclass-delta', 'CmTaskType');
  const errs = adapter.validate(pkg, e, adapter.readLocal(pkg, e));
  assert.match(errs.join('\n'), /EXT_TAG_VALUE_PREFIX/);
});

// ---- push ------------------------------------------------------------------------------------

test('push merges, POSTs an array to /rest/tagclass/{id}, re-reads, keeps the product values; second push skips', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC', 'Quality', 'Qualite')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ISSUE')] });
  const { ctx, lines, pkg } = ctxFor(dir, srv.core);
  const entries = pkg.entries('fd.tagclass-delta');

  const r1 = await pushResources(ctx, entries);
  assert.equal(r1[0].action, 'created');
  assert.equal(srv.log.posts.length, 1);
  assert.equal(srv.log.posts[0].path, '/rest/tagclass/CmTaskType');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ISSUE', 'ACME_QC']);
  assert.ok(lines.some((l) => /65 s/.test(l)), 'progress is printed');
  assert.ok(pkg.resState('t1', 'fd.tagclass-delta', 'CmTaskType').syncedHash);
  assert.deepEqual(pkg.resState('t1', 'fd.tagclass-delta', 'CmTaskType').ownValues, ['ACME_QC']);

  const r2 = await pushResources(ctx, entries);
  assert.equal(r2[0].action, 'unchanged');
  assert.equal(srv.log.posts.length, 1, 'unchanged hash: no second write');
});

test('push: a partially present delta merges only the rest, never a collision refusal', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_A'), d('ACME_B')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_A')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const r = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.notEqual(r[0].action, 'refused');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ACME_A', 'ACME_B']);
});

test('push: unknown tag class -> EXT_TAG_CLASS_UNKNOWN, nothing written', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({});
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await assert.rejects(pushResources(ctx, pkg.entries('fd.tagclass-delta')), /EXT_TAG_CLASS_UNKNOWN/);
  assert.equal(srv.log.posts.length, 0);
});

test('push: a server that loses a product value on write is caught by the re-read', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK')] });
  const realPost = srv.core.post;
  srv.core.post = async (p, body) => { body[0].allowedValues = body[0].allowedValues.filter((x) => x.symbolicName !== 'CHECK'); return realPost(p, body); };
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await assert.rejects(pushResources(ctx, pkg.entries('fd.tagclass-delta')), /LOST product values: CHECK/);
});

test('two deltas are written strictly one after the other, each with progress', async () => {
  const dir = makePkg({
    CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] },
    CmEmailSituation: { tagclass: 'CmEmailSituation', allowedValues: [d('ACME_SIT')] },
  });
  const srv = fakeServer({ CmTaskType: [v('CHECK')], CmEmailSituation: [v('OTHER')] });
  const { ctx, pkg, lines } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(srv.log.posts.length, 2);
  assert.equal(srv.log.maxActive, 1);
  assert.equal(lines.filter((l) => /please wait/.test(l)).length, 2);
  // the mutex also holds when a caller fires two pushes at once
  const e = pkg.entries('fd.tagclass-delta');
  srv.tcs.get('CmTaskType').allowedValues = [v('CHECK')];
  srv.tcs.get('CmEmailSituation').allowedValues = [v('OTHER')];
  await Promise.all(e.map((x) => adapter.push(ctx, x, adapter.readLocal(pkg, x))));
  assert.equal(srv.log.maxActive, 1);
});

// ---- hashing / status / rm -------------------------------------------------------------------

test('the product\'s other values never show as drift: server slice hashes like the file', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC', 'Quality', 'Qualite')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_QC', 'Quality', 'Qualite')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const e = pkg.entry('fd.tagclass-delta', 'CmTaskType');
  const server = await adapter.readServer(ctx, 'CmTaskType');
  const local = adapter.readLocal(pkg, e);
  assert.equal(hashResource('fd.tagclass-delta', server.obj), hashResource('fd.tagclass-delta', local.obj));
});

test('status --remote says which values are present or absent', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_A'), d('ACME_B')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_A')] });
  const { ctx } = ctxFor(dir, srv.core);
  const s = await statusAll(ctx, { remote: true });
  assert.equal(s.rows.length, 1);
  assert.match(s.rows[0].detail, /1\/2 values present — absent: ACME_B/);
  assert.equal(s.rows[0].state, 'local');
  srv.tcs.delete('CmTaskType');
  const s2 = await statusAll(ctx, { remote: true });
  assert.match(s2.rows[0].detail, /EXT_TAG_CLASS_UNKNOWN/);
});

test('rm removes ONLY the extension\'s own values (file present, or recorded in state once the file is gone)', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_QC'), v('ACME_OTHER_PKG')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await adapter.remove(ctx, 'CmTaskType');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ACME_OTHER_PKG']);
  assert.ok(srv.tcs.has('CmTaskType'), 'the tag class itself stays');

  // file gone (prune path): names come from the state recorded at push
  srv.tcs.get('CmTaskType').allowedValues.push(v('ACME_QC'));
  pkg.setResState('t1', 'fd.tagclass-delta', 'CmTaskType', { ownValues: ['ACME_QC'] });
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'fd/tagclass-deltas/CmTaskType.delta.json'));
  await adapter.remove(ctx, 'CmTaskType');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ACME_OTHER_PKG']);

  // nothing of ours left: no write at all
  const posts = srv.log.posts.length;
  await adapter.remove(ctx, 'CmTaskType');
  assert.equal(srv.log.posts.length, posts);
});

test('template scaffolds a prefixed value', () => {
  const dir = makePkg({});
  const pkg = openPackage(dir);
  const t = adapter.template({ pkg }, 'CmTaskType', { values: 'quality check' });
  assert.equal(t.obj.tagclass, 'CmTaskType');
  assert.equal(t.obj.allowedValues[0].symbolicName, 'ACME_QUALITY_CHECK');
  assert.equal(readFileSync(join(dir, 'uxopian-project.json'), 'utf8').includes('acme'), true);
});
