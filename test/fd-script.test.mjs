// Offline unit tests for lib/kinds/fd-script.mjs — the server-only library document (0.17):
// `"registrationOrder": null`, spelled out, pushes a Script document WITHOUT a RegistrationOrder tag
// (the GUI never loads it; a handler fetches and load()s it — FLOWERDOCS-LEARNINGS §40).
import test from 'node:test';
import assert from 'node:assert/strict';
import script, { isServerOnly } from '../lib/kinds/fd-script.mjs';
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
