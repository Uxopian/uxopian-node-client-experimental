// Offline tests for the fd.tagclass-delta kind (DESIGN §28): pure merge, push/re-read/skip, rm of own
// values only, status presence, serialization, lint codes. A fake core client stands in for the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { pushResources, pullResources, statusAll } from '../lib/sync.mjs';
import { KINDS, PUSH_ORDER } from '../lib/kinds/index.mjs';
import adapter from '../lib/kinds/fd-tagclass-delta.mjs';
import { hashResource } from '../lib/canonical.mjs';
import {
  mergeTagDelta, removeOwnValues, legacyOf, sliceOwn, checkTagDelta, lintTagDeltas, valuePrefix,
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
  for (const c of ['EXT_TAG_VALUE_PREFIX', 'EXT_TAG_CLASS_UNKNOWN', 'EXT_TAG_DELTA_OWN', 'EXT_TAG_LEGACY']) assert.equal(explainCode(c).length, 1);
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
  await assert.rejects(pushResources(ctx, pkg.entries('fd.tagclass-delta')), /LOST values: CHECK/);
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

// ---- review fixes (PR #88) -------------------------------------------------------------------

test('a server-side relabel of an own value is a server edit: status says so, plain push refuses, --force overwrites', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC', 'Quality')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const entries = pkg.entries('fd.tagclass-delta');
  await pushResources(ctx, entries);
  srv.tcs.get('CmTaskType').allowedValues[1] = v('ACME_QC', 'Edited on the server');
  const s = await statusAll(ctx, { remote: false });
  assert.equal(s.rows[0].state, 'insync', 'offline status only compares file vs base');
  const { classify } = await import('../lib/sync.mjs');
  assert.equal((await classify(ctx, entries[0])).state, 'server');
  const posts = srv.log.posts.length;
  const r = await pushResources(ctx, entries);
  assert.equal(r[0].action, 'refused');
  assert.match(r[0].detail, /server edited since last sync/);
  assert.equal(srv.log.posts.length, posts, 'no write without --force');
  const f = await pushResources(ctx, entries, { force: true });
  assert.equal(f[0].action, 'updated');
  assert.equal(srv.tcs.get('CmTaskType').allowedValues[1].displayNames[0].value, 'Quality');
});

test('an own value removed on the server is NOT a server edit: status local, push re-merges it without --force', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_A'), d('ACME_B')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const entries = pkg.entries('fd.tagclass-delta');
  await pushResources(ctx, entries);
  srv.tcs.get('CmTaskType').allowedValues = [v('CHECK'), v('ACME_A')]; // a product push wiped ACME_B
  const { classify } = await import('../lib/sync.mjs');
  assert.equal((await classify(ctx, entries[0])).state, 'local');
  const r = await pushResources(ctx, entries);
  assert.notEqual(r[0].action, 'refused');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ACME_A', 'ACME_B']);
});

test('lost-update guard: the write merges onto a re-read taken right before the POST', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK')] });
  srv.tcs.get('CmTaskType').lastUpdateDate = 1;
  const realGet = srv.core.getOne;
  let calls = 0;
  srv.core.getOne = async (p) => {
    if (++calls === 2) { // another writer lands between our first read and the pre-POST re-read
      const t = srv.tcs.get('CmTaskType');
      t.allowedValues.push(v('OTHER_WRITER'));
      t.lastUpdateDate = 2;
    }
    return realGet(p);
  };
  const { ctx, pkg, lines } = ctxFor(dir, srv.core);
  const e = pkg.entry('fd.tagclass-delta', 'CmTaskType');
  await adapter.push(ctx, e, adapter.readLocal(pkg, e));
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'OTHER_WRITER', 'ACME_QC']);
  assert.ok(lines.some((l) => /changed on the server since it was read/.test(l)));
});

test('a value another writer added is caught loudly if the write erases it', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('OTHER_WRITER')] });
  const realPost = srv.core.post;
  srv.core.post = async (p, body) => { body[0].allowedValues = body[0].allowedValues.filter((x) => x.symbolicName !== 'OTHER_WRITER'); return realPost(p, body); };
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const e = pkg.entry('fd.tagclass-delta', 'CmTaskType');
  await assert.rejects(adapter.push(ctx, e, adapter.readLocal(pkg, e)), /LOST values: OTHER_WRITER/);
});

test('ownValues is recorded when the values were already on the server at first push (adopted, no write)', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_QC')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  const r = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(r[0].action, 'adopted');
  assert.equal(srv.log.posts.length, 0);
  assert.deepEqual(pkg.resState('t1', 'fd.tagclass-delta', 'CmTaskType').ownValues, ['ACME_QC']);
});

test('rm with no file and no recorded ownValues says the values are unknown and writes nothing', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_QC')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK'), v('ACME_QC')] });
  const { ctx, warns } = ctxFor(dir, srv.core);
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'fd/tagclass-deltas/CmTaskType.delta.json'));
  await adapter.remove(ctx, 'CmTaskType');
  assert.equal(srv.log.posts.length, 0);
  assert.match(warns.join('\n'), /UNKNOWN .*nothing removed.*ACME_QC/);
});

test('a value dropped from the delta is reported orphaned, then removed by push (prefix only, product untouched)', async () => {
  const dir = makePkg({ CmTaskType: { tagclass: 'CmTaskType', allowedValues: [d('ACME_A'), d('ACME_B')] } });
  const srv = fakeServer({ CmTaskType: [v('CHECK')] });
  const { ctx, pkg, lines } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  // a stray non-prefixed name in recorded state must never be removed
  pkg.setResState('t1', 'fd.tagclass-delta', 'CmTaskType', { ownValues: ['ACME_A', 'ACME_B', 'CHECK'] });
  writeFileSync(join(dir, 'fd/tagclass-deltas/CmTaskType.delta.json'), JSON.stringify({ tagclass: 'CmTaskType', allowedValues: [d('ACME_A')] }));
  const s = await statusAll(ctx, { remote: true });
  assert.equal(s.rows[0].state, 'local');
  assert.match(s.rows[0].detail, /orphaned .*: ACME_B — uxc push removes them/);
  const r = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.notEqual(r[0].action, 'unchanged');
  assert.deepEqual(names(srv.tcs.get('CmTaskType').allowedValues), ['CHECK', 'ACME_A']);
  assert.ok(lines.some((l) => /removed ACME_B — no longer in the delta/.test(l)));
  assert.deepEqual(pkg.resState('t1', 'fd.tagclass-delta', 'CmTaskType').ownValues, ['ACME_A']);
  const again = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(again[0].action, 'unchanged');
});

test('projectValues sorts by code unit (not locale) and labels by (language, value)', async () => {
  const { projectValues } = await import('../lib/tagdelta.mjs');
  const p = projectValues([
    { symbolicName: 'a_x', displayNames: [{ language: 'en', value: 'b' }, { language: 'EN', value: 'a' }, { language: 'DE', value: 'z' }] },
    { symbolicName: 'B_y', displayNames: [] },
  ]);
  assert.deepEqual(p.map((x) => x.symbolicName), ['B_y', 'a_x']);
  assert.deepEqual(p[1].displayNames.map((x) => x.language + x.value), ['DEz', 'ENa', 'ENb']);
});

// ---- legacy values (DESIGN §30) ----
const LEG = (extra = {}) => ({ tagclass: 'CmCaseType', legacy: ['ORDER'], allowedValues: [d('ORDER'), d('ACME_QUOTE')], ...extra });

test('legacy: the prefix check skips a declared value only; undeclared and malformed legacy are flagged', () => {
  const opts = { id: 'CmCaseType', prefix: 'ACME_' };
  assert.deepEqual(checkTagDelta(LEG(), opts), []);
  assert.deepEqual(legacyOf(LEG()), ['ORDER']);
  assert.deepEqual(legacyOf({}), []);
  const undeclared = checkTagDelta(LEG({ legacy: [] }), opts);
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].code, 'EXT_TAG_VALUE_PREFIX');
  assert.match(undeclared[0].message, /"ORDER".*legacy/);
  assert.deepEqual(checkTagDelta(LEG({ legacy: ['ORDER', 'GHOST'] }), opts).map((e) => e.code), ['EXT_TAG_LEGACY']);
  assert.deepEqual(checkTagDelta(LEG({ legacy: 'ORDER' }), opts).map((e) => e.code), ['EXT_TAG_LEGACY', 'EXT_TAG_VALUE_PREFIX']);
  // another unprefixed value stays flagged even when ORDER is declared
  const other = checkTagDelta(LEG({ allowedValues: [d('ORDER'), d('CLAIM')] }), opts);
  assert.deepEqual(other.map((e) => e.code), ['EXT_TAG_VALUE_PREFIX']);
  assert.match(other[0].message, /"CLAIM"/);
});

test('legacy: lintTagDeltas on a package honours it (no EXT_TAG_VALUE_PREFIX)', () => {
  const dir = makePkg({ CmCaseType: LEG() });
  assert.deepEqual(lintTagDeltas(openPackage(dir)), []);
  const bad = makePkg({ CmCaseType: LEG({ legacy: undefined }) });
  assert.deepEqual(lintTagDeltas(openPackage(bad)).map((e) => e.code), ['EXT_TAG_VALUE_PREFIX']);
});

test('removeOwnValues: an unprefixed own name goes only when declared legacy', () => {
  const server = [v('ORDER'), v('ACME_QUOTE'), v('CLAIM')];
  assert.deepEqual(removeOwnValues(server, ['ORDER', 'ACME_QUOTE'], { prefix: 'ACME_' }).removed, ['ACME_QUOTE']);
  const r = removeOwnValues(server, ['ORDER', 'ACME_QUOTE', 'CLAIM'], { prefix: 'ACME_', legacy: ['ORDER'] });
  assert.deepEqual(r.removed, ['ORDER', 'ACME_QUOTE']);
  assert.deepEqual(names(r.values), ['CLAIM']);
});

test('legacy: push adds a missing legacy value, leaves product labels alone, records legacyValues', async () => {
  const dir = makePkg({ CmCaseType: LEG({ allowedValues: [d('ORDER', 'Order'), d('ACME_QUOTE')] }) });
  const srv = fakeServer({ CmCaseType: [v('ORDER', 'Order'), v('CLAIM')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  const vals = srv.tcs.get('CmCaseType').allowedValues;
  assert.deepEqual(names(vals), ['ORDER', 'CLAIM', 'ACME_QUOTE']);
  assert.equal(vals[0].displayNames[0].value, 'Order', 'the product value is not rewritten');
  const st = pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType');
  assert.deepEqual(st.ownValues, ['ACME_QUOTE', 'ORDER']);
  assert.deepEqual(st.legacyValues, ['ORDER']);
  assert.deepEqual(st.legacyAdded, [], 'ORDER was on the server already: declared, NOT removable');
});

test('legacy: rm --server removes a legacy value this package\'s push ADDED, never an undeclared one', async () => {
  const dir = makePkg({ CmCaseType: LEG() });
  const srv = fakeServer({ CmCaseType: [v('CLAIM'), v('KEEP')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  const st = pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType');
  assert.deepEqual(st.legacyAdded, ['ORDER']);
  pkg.setResState('t1', 'fd.tagclass-delta', 'CmCaseType', { ownValues: [...st.ownValues, 'CLAIM'] }); // a stray undeclared name
  await adapter.remove(ctx, 'CmCaseType');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLAIM', 'KEEP']);
});

test('legacy: a declaration alone never makes a product value removable (push adopts, rm keeps it and says so)', async () => {
  const dir = makePkg({ CmCaseType: { tagclass: 'CmCaseType', legacy: ['CLOSED'], allowedValues: [d('CLOSED'), d('ACME_QUOTE')] } });
  const srv = fakeServer({ CmCaseType: [v('OPEN'), v('CLOSED'), v('ACME_QUOTE')] });
  const { ctx, pkg, lines } = ctxFor(dir, srv.core);
  const r = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(r[0].action, 'adopted');
  assert.equal(srv.log.posts.length, 0);
  const st = pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType');
  assert.ok(!(st.legacyAdded ?? []).includes('CLOSED'));
  const s = await statusAll(ctx, { remote: true });
  assert.match(s.rows[0].detail, /kept: CLOSED \(legacy value present before this package/);
  await adapter.remove(ctx, 'CmCaseType');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['OPEN', 'CLOSED']);
  assert.ok(lines.some((l) => /kept: CLOSED — legacy value present before this package/.test(l)));
});

test('legacy: a push that writes (adds a prefixed value) still records only what it added', async () => {
  const dir = makePkg({ CmCaseType: { tagclass: 'CmCaseType', legacy: ['CLOSED', 'ORDER'], allowedValues: [d('CLOSED'), d('ORDER'), d('ACME_QUOTE')] } });
  const srv = fakeServer({ CmCaseType: [v('CLOSED')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.deepEqual(pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType').legacyAdded, ['ORDER']);
  await adapter.remove(ctx, 'CmCaseType');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLOSED']);
});

test('legacy: file gone, rm uses the recorded legacyAdded (a declared-only or unrecorded unprefixed name stays)', async () => {
  const dir = makePkg({ CmCaseType: LEG() });
  const srv = fakeServer({ CmCaseType: [v('ORDER'), v('CLAIM'), v('ACME_QUOTE'), v('OLD')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  pkg.setResState('t1', 'fd.tagclass-delta', 'CmCaseType', { ownValues: ['ORDER', 'CLAIM', 'ACME_QUOTE', 'OLD'], legacyValues: ['ORDER', 'OLD'], legacyAdded: ['ORDER'] });
  const { rmSync } = await import('node:fs');
  rmSync(join(dir, 'fd/tagclass-deltas/CmCaseType.delta.json'));
  await adapter.remove(ctx, 'CmCaseType');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLAIM', 'OLD']);
});

test('legacy: a legacy value dropped from the delta is an orphan and removed by push; an undeclared one is not', async () => {
  const dir = makePkg({ CmCaseType: LEG({ allowedValues: [d('ORDER'), d('ACME_QUOTE')] }) });
  const srv = fakeServer({ CmCaseType: [v('CLAIM')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  srv.tcs.get('CmCaseType').allowedValues.push(v('STRAY'));
  const st = pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType');
  pkg.setResState('t1', 'fd.tagclass-delta', 'CmCaseType', { ...st, ownValues: [...st.ownValues, 'STRAY'] });
  writeFileSync(join(dir, 'fd/tagclass-deltas/CmCaseType.delta.json'), JSON.stringify({ tagclass: 'CmCaseType', allowedValues: [d('ACME_QUOTE')] }));
  const s = await statusAll(ctx, { remote: true });
  assert.match(s.rows[0].detail, /orphaned .*: ORDER — uxc push removes them/);
  assert.doesNotMatch(s.rows[0].detail, /STRAY/);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLAIM', 'ACME_QUOTE', 'STRAY']);
});

test('legacy: dropping a pre-existing legacy value from legacy AND allowedValues stops tracking it, never deletes it', async () => {
  const dir = makePkg({ CmCaseType: { tagclass: 'CmCaseType', legacy: ['CLOSED'], allowedValues: [d('CLOSED'), d('ACME_QUOTE')] } });
  const srv = fakeServer({ CmCaseType: [v('CLOSED')] });
  const { ctx, pkg, lines } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLOSED', 'ACME_QUOTE']);
  writeFileSync(join(dir, 'fd/tagclass-deltas/CmCaseType.delta.json'), JSON.stringify({ tagclass: 'CmCaseType', allowedValues: [d('ACME_QUOTE')] }));
  const s = await statusAll(ctx, { remote: true });
  assert.doesNotMatch(s.rows[0].detail ?? '', /orphaned/);
  const r = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(srv.log.posts.length, 1, 'no write: nothing to remove');
  assert.equal(r[0].action, 'rebased');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLOSED', 'ACME_QUOTE']);
  assert.ok(lines.some((l) => /no longer tracked: CLOSED — not added by this package/.test(l)));
  assert.deepEqual(pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType').ownValues, ['ACME_QUOTE']);
  await adapter.remove(ctx, 'CmCaseType');
  assert.deepEqual(names(srv.tcs.get('CmCaseType').allowedValues), ['CLOSED']);
});

test('legacy survives the push echo write and pull; the next push still lints clean; baseState keeps it', async () => {
  const file = (dir) => JSON.parse(readFileSync(join(dir, 'fd/tagclass-deltas/CmCaseType.delta.json'), 'utf8'));
  const dir = makePkg({ CmCaseType: LEG() });
  const srv = fakeServer({ CmCaseType: [v('CLAIM')] });
  const { ctx, pkg } = ctxFor(dir, srv.core);
  await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.deepEqual(file(dir).legacy, ['ORDER'], 'echo leg keeps the declaration');
  assert.deepEqual(lintTagDeltas(openPackage(dir)), []);
  const e = pkg.entry('fd.tagclass-delta', 'CmCaseType');
  assert.deepEqual(adapter.validate(pkg, e, adapter.readLocal(pkg, e)), []);
  // relabel on the server, then pull: the file takes the server labels and keeps `legacy`
  srv.tcs.get('CmCaseType').allowedValues.find((x) => x.symbolicName === 'ACME_QUOTE').displayNames[0].value = 'Quote!';
  const p = await pullResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(p[0].action, 'pulled');
  assert.deepEqual(file(dir).legacy, ['ORDER'], 'pull keeps the declaration');
  const st = pkg.resState('t1', 'fd.tagclass-delta', 'CmCaseType');
  assert.deepEqual(st.legacyValues, ['ORDER'], 'pull base records the declared legacy values');
  assert.deepEqual(st.legacyAdded, ['ORDER'], 'a base record never touches the removable set');
  const again = await pushResources(ctx, pkg.entries('fd.tagclass-delta'));
  assert.equal(again[0].action, 'unchanged');
  // a pulled value the server lacks leaves `legacy` narrowed to what is listed (never EXT_TAG_LEGACY)
  srv.tcs.get('CmCaseType').allowedValues = srv.tcs.get('CmCaseType').allowedValues.filter((x) => x.symbolicName !== 'ORDER');
  await pullResources(ctx, pkg.entries('fd.tagclass-delta'), { force: true });
  assert.equal(file(dir).legacy, undefined);
});

test('legacy is not hashed: a delta hashes as on main with or without it', () => {
  const obj = { tagclass: 'CmCaseType', allowedValues: [{ symbolicName: 'ACME_QUOTE', displayNames: [{ language: 'EN', value: 'Quote' }, { language: 'FR', value: 'Devis' }] }, { symbolicName: 'ORDER', displayNames: [{ language: 'en', value: 'Order' }] }] };
  const MAIN = 'sha256:624d7848bbf2a3b830e9be9a9e7e9e76fd68e1b5b20a5d0252e6bad234e2f665'; // computed on main (ee62ec5)
  assert.equal(hashResource('fd.tagclass-delta', { obj }), MAIN);
  assert.equal(hashResource('fd.tagclass-delta', { obj: { ...obj, legacy: ['ORDER'] } }), MAIN);
});
