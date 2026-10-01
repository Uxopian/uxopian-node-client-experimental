// Offline unit tests for lib/kinds/fd-script.mjs — the server-only library document (0.17):
// `"registrationOrder": null`, spelled out, pushes a Script document WITHOUT a RegistrationOrder tag
// (the GUI never loads it; a handler fetches and load()s it — FLOWERDOCS-LEARNINGS §40).
import test from 'node:test';
import assert from 'node:assert/strict';
import script, { isServerOnly, libraryClassIds } from '../lib/kinds/fd-script.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashResource } from '../lib/canonical.mjs';

const entry = { id: 'po-lib-a', path: 'fd/scripts/po-lib-a' };
const bytes = Buffer.from("'use strict';\nvar PO_LIB_FIN = 'po-lib-a';\n");

function recordingCtx() {
  const pushed = [];
  return {
    pushed,
    ctx: { target: { user: 'admin' }, clients: { core: { upsertDoc: async (doc, files) => { pushed.push({ doc, files }); return { action: 'created' }; } } } },
  };
}

test('isServerOnly: only an explicit null counts', () => {
  assert.equal(isServerOnly({ registrationOrder: null }), true);
  assert.equal(isServerOnly({}), false);
  assert.equal(isServerOnly({ registrationOrder: undefined }), false);
  assert.equal(isServerOnly({ registrationOrder: '0' }), false);
  assert.equal(isServerOnly(null), false);
});

test('validate: explicit null passes, a missing or non-integer order is still refused', () => {
  const ok = { obj: { name: 'Po Lib A', acl: 'acl-readonly', registrationOrder: null, contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } };
  assert.deepEqual(script.validate({}, entry, ok), []);
  const missing = { obj: { name: 'X', contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } };
  assert.match(script.validate({}, entry, missing).join('\n'), /registrationOrder must be an integer string.*"registrationOrder": null/);
  const junk = { obj: { name: 'X', registrationOrder: 'abc', contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } };
  assert.equal(script.validate({}, entry, junk).length, 1);
});

test('push: a server-only document carries NO RegistrationOrder tag; a browser script still does', async () => {
  const lib = recordingCtx();
  await script.create(lib.ctx, { id: 'po-lib-a', obj: { name: 'Po Lib A', registrationOrder: null, contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } });
  assert.equal(lib.pushed.length, 1);
  assert.deepEqual(lib.pushed[0].doc.tags, []);
  assert.equal(lib.pushed[0].doc.data.classId, 'Script');

  const gui = recordingCtx();
  await script.create(gui.ctx, { id: 'po-widgets', obj: { name: 'Po Widgets', registrationOrder: '932', contentFile: 'po-widgets.js' }, contents: { 'po-widgets.js': bytes } });
  assert.deepEqual(gui.pushed[0].doc.tags.map((t) => t.name), ['RegistrationOrder']);
});

test('round trip: the server echo of a tag-less document hashes like the local null meta (no drift)', async () => {
  const local = { name: 'Po Lib A', acl: 'acl-readonly', registrationOrder: null, contentFile: 'po-lib-a.js' };
  const ctx = { clients: { core: {
    getDoc: async () => ({ id: 'po-lib-a', name: 'Po Lib A', data: { ACL: 'acl-readonly', classId: 'Script' }, tags: [], files: [{ id: 'f1' }] }),
    getContent: async () => bytes,
  } } };
  const server = await script.readServer(ctx, 'po-lib-a');
  assert.equal(server.obj.registrationOrder, null);
  assert.equal(hashResource('fd.script', server.obj, Object.values(server.contents)), hashResource('fd.script', local, [bytes]));
});

// 0.19 — a server-only library stored under ANOTHER class: the GUI loads every Script-class document
// of the scope whatever its tags (FLOWERDOCS-LEARNINGS § "RegistrationOrder does not keep a script
// out of the browser"); the class is the documented gate.
test('classId: a server-only library is pushed under its declared class, a plain script stays Script', async () => {
  const lib = recordingCtx();
  await script.create(lib.ctx, { id: 'po-lib-a', obj: { name: 'Po Lib A', registrationOrder: null, classId: 'PoServerLibrary', contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } });
  assert.equal(lib.pushed[0].doc.data.classId, 'PoServerLibrary');
  assert.deepEqual(lib.pushed[0].doc.tags, []);
  const gui = recordingCtx();
  await script.create(gui.ctx, { id: 'po-widgets', obj: { name: 'Po Widgets', registrationOrder: '932', contentFile: 'po-widgets.js' }, contents: { 'po-widgets.js': bytes } });
  assert.equal(gui.pushed[0].doc.data.classId, 'Script');
});

test('classId: validate refuses Script spelled out, an empty value, and a browser script under another class', () => {
  const mk = (o) => ({ obj: { name: 'X', contentFile: 'po-lib-a.js', ...o }, contents: { 'po-lib-a.js': bytes } });
  assert.deepEqual(script.validate({}, entry, mk({ registrationOrder: null, classId: 'PoServerLibrary' })), []);
  assert.match(script.validate({}, entry, mk({ registrationOrder: null, classId: 'Script' })).join('\n'), /other than Script/);
  assert.match(script.validate({}, entry, mk({ registrationOrder: null, classId: '' })).join('\n'), /other than Script/);
  assert.match(script.validate({}, entry, mk({ registrationOrder: '930', classId: 'PoServerLibrary' })).join('\n'), /only for a server-only library/);
});

test('classId: the echo of a library under another class hashes like the local meta; a Script echo drifts', async () => {
  const local = { name: 'Po Lib A', acl: 'acl-readonly', registrationOrder: null, classId: 'PoServerLibrary', contentFile: 'po-lib-a.js' };
  const echo = (classId) => ({ clients: { core: {
    getDoc: async () => ({ id: 'po-lib-a', name: 'Po Lib A', data: { ACL: 'acl-readonly', classId }, tags: [], files: [{ id: 'f1' }] }),
    getContent: async () => bytes,
  } } });
  const moved = await script.readServer(echo('PoServerLibrary'), 'po-lib-a');
  assert.equal(moved.obj.classId, 'PoServerLibrary');
  assert.equal(hashResource('fd.script', moved.obj, Object.values(moved.contents)), hashResource('fd.script', local, [bytes]));
  // still a Script on the server (not migrated yet): it must DRIFT from the local meta, so `push --changed` moves it
  const stale = await script.readServer(echo('Script'), 'po-lib-a');
  assert.equal(Object.prototype.hasOwnProperty.call(stale.obj, 'classId'), false);
  assert.notEqual(hashResource('fd.script', stale.obj, Object.values(stale.contents)), hashResource('fd.script', local, [bytes]));
});

test('classId: an update whose class change the server did not apply fails loudly instead of erasing classId', async () => {
  const local = { obj: { name: 'Po Lib A', registrationOrder: null, classId: 'PoServerLibrary', contentFile: 'po-lib-a.js' }, contents: { 'po-lib-a.js': bytes } };
  const ctxWith = (serverClass) => {
    const lib = recordingCtx();
    lib.ctx.clients.core.getDoc = async () => ({ id: 'po-lib-a', data: { classId: serverClass } });
    return lib;
  };
  const moved = ctxWith('PoServerLibrary');
  await script.update(moved.ctx, 'po-lib-a', local);
  assert.equal(moved.pushed[0].doc.data.classId, 'PoServerLibrary');
  await assert.rejects(script.update(ctxWith('Script').ctx, 'po-lib-a', local), /server kept Script/);
  // and back: removing classId locally must really return the document to Script
  const back = { obj: { ...local.obj }, contents: local.contents };
  delete back.obj.classId;
  await script.update(ctxWith('Script').ctx, 'po-lib-a', back);
  await assert.rejects(script.update(ctxWith('PoServerLibrary').ctx, 'po-lib-a', back), /pushed as class Script but the server kept PoServerLibrary/);
});

// ---- #76: the class must be known to the package; ls/adopt see a library moved to another class ----

/** A minimal package view: registry entries + meta.json files on disk. */
function fakePkg(entries, metas = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uxc-fdscript-'));
  for (const [id, meta] of Object.entries(metas)) {
    mkdirSync(join(dir, 'fd/scripts', id), { recursive: true });
    writeFileSync(join(dir, 'fd/scripts', id, 'meta.json'), JSON.stringify(meta));
  }
  return {
    dir,
    entries: (kind) => entries.filter((e) => !kind || e.kind === kind),
    entry: (kind, id) => entries.find((e) => e.kind === kind && e.id === id) ?? null,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('classId: validate requires an fd.documentclass entry of the package (typo -> did-you-mean)', () => {
  const mk = (o) => ({ obj: { name: 'X', contentFile: 'po-lib-a.js', registrationOrder: null, ...o }, contents: { 'po-lib-a.js': bytes } });
  const pkg = fakePkg([{ kind: 'fd.documentclass', id: 'PoServerLibrary', path: 'fd/classes/PoServerLibrary.json' }]);
  try {
    assert.deepEqual(script.validate(pkg, entry, mk({ classId: 'PoServerLibrary' })), []);
    assert.match(script.validate(pkg, entry, mk({ classId: 'PoServerlibrary' })).join('\n'), /not an fd\.documentclass.*did you mean "PoServerLibrary"/);
    const unknown = script.validate(pkg, entry, mk({ classId: 'PoOther' })).join('\n');
    assert.match(unknown, /not an fd\.documentclass of this package/);
    assert.match(unknown, /uxc adopt fd\.documentclass PoOther --external/, 'a server-side class is registered, not pushed');
    // a class registered as external satisfies it
    const ext = fakePkg([{ kind: 'fd.documentclass', id: 'PoOther', policy: 'external' }]);
    assert.deepEqual(script.validate(ext, entry, mk({ classId: 'PoOther' })), []);
    ext.cleanup();
  } finally { pkg.cleanup(); }
});

test('list: searches Script plus the library classes the package declares, and reports the class', async () => {
  const pkg = fakePkg(
    [
      { kind: 'fd.script', id: 'po-lib-a', path: 'fd/scripts/po-lib-a' },
      { kind: 'fd.script', id: 'po-lib-b', path: 'fd/scripts/po-lib-b' },
      { kind: 'fd.script', id: 'po-ui', path: 'fd/scripts/po-ui' },
    ],
    {
      'po-lib-a': { registrationOrder: null, classId: 'PoServerLibrary' },
      'po-lib-b': { registrationOrder: null, classId: 'PoServerLibrary' },
      'po-ui': { registrationOrder: '930' },
    },
  );
  try {
    assert.deepEqual(libraryClassIds({ pkg }), ['PoServerLibrary']);
    let asked;
    const ctx = {
      pkg,
      clients: { core: { search: async (q) => {
        asked = q;
        return { found: 2, results: [
          { id: 'po-ui', fields: { name: 'Po UI', classid: 'Script' } },
          { id: 'po-lib-c', fields: { name: 'Po Lib C', classid: 'PoServerLibrary' } },
        ] };
      } } },
    };
    const rows = await script.list(ctx);
    assert.deepEqual(asked.classId, ['Script', 'PoServerLibrary']);
    assert.deepEqual(rows, [{ id: 'po-ui', name: 'Po UI' }, { id: 'po-lib-c', name: 'Po Lib C', classId: 'PoServerLibrary' }]);
    // no package (uxc ls outside a package): Script only, and requirePkg throwing is not fatal
    const bare = { requirePkg: () => { throw new Error('no package'); }, clients: ctx.clients };
    await script.list(bare);
    assert.deepEqual(asked.classId, ['Script']);
  } finally { pkg.cleanup(); }
});
