// #84 / FAST2-LEARNINGS §F21: the OpenSearch checks behind fast2 run even when the target has no
// fast2 surface (they explain a dead broker), and report the disk against the 90% watermark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diskVerdict, checkF2OpenSearch } from '../lib/commands/doctor.mjs';

test('diskVerdict: ok below 85, warn from 85, bad from the 90% high watermark', () => {
  assert.equal(diskVerdict('42').level, 'ok');
  assert.equal(diskVerdict(85).level, 'warn');
  assert.equal(diskVerdict('94').level, 'bad');
  assert.match(diskVerdict(94).text, /90% high watermark/);
  assert.equal(diskVerdict(undefined), null);
});

test('checkF2OpenSearch: create_index block and disk per node, from the OpenSearch URL alone', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/_cluster/settings')) res.end(JSON.stringify({ persistent: { 'cluster.blocks.create_index': 'true' } }));
    else if (req.url.startsWith('/_cat/allocation')) res.end(JSON.stringify([{ node: 'n1', 'disk.percent': '94' }]));
    else res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const oks = []; const bads = [];
    const ctx = { flags: { 'f2-opensearch': `http://127.0.0.1:${server.address().port}` }, out: { note() {}, warn() {} } };
    await checkF2OpenSearch(ctx, (k, v) => oks.push([k, v]), (k, v) => bads.push([k, v]));
    assert.deepEqual(bads.map(([k]) => k), ['f2 opensearch create_index', 'f2 opensearch disk']);
    assert.match(bads[1][1], /94% used/);
  } finally { server.close(); }
});

test('checkF2OpenSearch: without a URL it only says how to check', async () => {
  const notes = [];
  await checkF2OpenSearch({ flags: {}, out: { note: (m) => notes.push(m) } }, () => assert.fail(), () => assert.fail());
  assert.match(notes[0], /--f2-opensearch/);
});
