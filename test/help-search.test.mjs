// uxc help --search (#94): the offline index over commands, explain codes, kinds.md and the
// learnings' § headings. Runs against the repo's own docs (they ship with uxc) + a tmp root for
// the missing-file case. Offline, deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { helpSearch, formatHelpSearch, parseHeading, tokenize, markdownSections } from '../lib/helpsearch.mjs';
import { TEXT } from '../lib/commands/help.mjs';

const search = (q, opts = {}) => helpSearch(q, { helpText: TEXT, ...opts });

test('"rate limit 429" -> FLOWERDOCS-LEARNINGS §42 first', async () => {
  const r = await search('rate limit 429');
  assert.equal(r.refs[0].ref, 'FLOWERDOCS-LEARNINGS §42');
  assert.equal(r.refs[0].file, 'docs/FLOWERDOCS-LEARNINGS.md');
  assert.ok(r.refs[0].line > 0);
});

test('"delete a document" -> doc rm first', async () => {
  const r = await search('delete a document');
  assert.equal(r.commands[0].name, 'doc rm');
  assert.match(r.commands[0].usage, /^uxc doc rm /);
});

test('"tag class values extension" -> kinds.md fd.tagclass-delta first', async () => {
  const r = await search('tag class values extension');
  assert.equal(r.refs[0].type, 'kind');
  assert.equal(r.refs[0].ref, 'kinds.md fd.tagclass-delta');
});

test('"update a tag class" -> push (synonym + command intent)', async () => {
  const r = await search('update a tag class');
  assert.equal(r.commands[0].name, 'push');
});

test('explain codes and the other knowledge files are indexed', async () => {
  assert.ok((await search('F00903 already exists')).refs.some((x) => x.type === 'explain' && x.ref === 'explain F00903'));
  assert.equal((await search('fast2 map upload duplicate renames')).refs[0].ref, 'FAST2-LEARNINGS §F7');
  assert.ok((await search('running plans')).refs.some((x) => x.ref === 'UXOPIAN-AI-LEARNINGS §A14'));
});

test('json shape + limit', async () => {
  const r = await search('push a prompt', { limit: 3 });
  assert.deepEqual(Object.keys(r), ['query', 'commands', 'refs']);
  assert.ok(r.commands.length + r.refs.length <= 3);
  for (const c of r.commands) assert.deepEqual(Object.keys(c), ['name', 'usage', 'summary', 'score']);
  for (const x of r.refs) {
    assert.ok(['learning', 'kind', 'explain'].includes(x.type));
    assert.equal(typeof x.ref, 'string');
    assert.equal(typeof x.score, 'number');
  }
  assert.deepEqual(await search('zzqqx wwvvk'), { query: 'zzqqx wwvvk', commands: [], refs: [] });
});

test('deterministic', async () => {
  assert.deepEqual(await search('why did the handler not fire'), await search('why did the handler not fire'));
});

test('missing docs are skipped silently', async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'uxc-hs-'));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/FAST2-LEARNINGS.md'), '# t\n\n## §F9 — Zz frobnication of widgets\nbody\n');
    const r = await search('frobnication', { root });
    assert.equal(r.refs[0].ref, 'FAST2-LEARNINGS §F9');
    assert.equal(r.refs[0].line, 3);
    assert.deepEqual((await search('rate limit 429', { root })).refs.filter((x) => x.type !== 'explain'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('index build + search stays fast', async () => {
  await search('warm up');
  const t = performance.now();
  await search('handler version rotation cache clear');
  // budget is 150 ms; the assertion is looser so a slow CI box never flakes
  assert.ok(performance.now() - t < 1000);
});

test('helpers: headings, tokens, sections, human output', () => {
  assert.deepEqual(parseHeading('§42 — fd.demo rate limit'), { section: '§42', title: 'fd.demo rate limit' });
  assert.deepEqual(parseHeading('5b. JSAPI entry points'), { section: '§5b', title: 'JSAPI entry points' });
  assert.deepEqual(parseHeading('A19.1 — Only inline forms'), { section: '§A19.1', title: 'Only inline forms' });
  assert.equal(parseHeading('2026-09-04 · `uxc export` crashed').section, null);
  assert.ok(tokenize('tag class').includes('tagclass'));
  assert.ok(tokenize('fd.tagclass-delta').includes('fdtagclassdelta'));
  assert.ok(tokenize('RegistrationOrder').includes('registration'));
  assert.equal(markdownSections('## a\n```\n## not a heading\n```\n### b\nx').length, 2);
  const lines = formatHelpSearch({ query: 'q', commands: [{ name: 'push', usage: 'uxc push', summary: 's' }],
    refs: [{ type: 'learning', ref: 'X §1', title: 't', file: 'docs/X.md', line: 3 }] });
  assert.deepEqual(lines, ['commands:', '  uxc push  — s', 'knowledge:', '  X §1 — t  docs/X.md:3']);
});

test('CLI: help --search / -s / --json, and plain help advertises it', () => {
  const run = (args) => spawnSync(process.execPath, [resolve('bin/uxc.mjs'), ...args], { encoding: 'utf8' });
  const plain = run(['help']);
  assert.match(plain.stdout, /help --search/);
  const human = run(['help', '--search', 'rate', 'limit', '429']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /FLOWERDOCS-LEARNINGS §42/);
  assert.ok(human.stdout.trim().split('\n').length <= 10);
  const short = run(['help', '-s', 'delete a document', '--json', '--limit', '4']);
  const j = JSON.parse(short.stdout);
  assert.equal(j.commands[0].name, 'doc rm');
  assert.ok(j.commands.length + j.refs.length <= 4);
});
