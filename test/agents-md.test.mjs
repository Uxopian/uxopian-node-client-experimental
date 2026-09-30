// AGENTS.md + the CLAUDE.md pointer written by `uxc init` / `init --extension`, and the refresh
// through `uxc context --agents-md` (DESIGN §27.3, #98). Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { renderAgentsSection, renderClaudeSection, upsertSection, BEGIN, END } from '../lib/agents-md.mjs';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'uxc.mjs');
const made = [];
const tmp = () => { const d = mkdtempSync(join(os.tmpdir(), 'uxc-agents-')); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function uxc(args, { cwd } = {}) {
  try {
    return { code: 0, out: execFileSync('node', [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UXC_AGENT: '0' } }) };
  } catch (e) { return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
}
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
const blocks = (s) => s.split(BEGIN).length - 1;

test('plain init writes AGENTS.md (package facts, rules, cheat-sheet, tests) and a CLAUDE.md pointer', () => {
  const dir = join(tmp(), 'p');
  const r = uxc(['init', '--name', 'Plain', '--code', 'pl', dir]);
  assert.equal(r.code, 0, r.out);
  const a = read(dir, 'AGENTS.md');
  assert.match(a, /^# AGENTS\.md — Plain\n\n<!-- uxc:begin -->\n/);
  assert.ok(a.endsWith(`${END}\n`));
  for (const re of [/package `pl` — Plain/, /`Pl` \(pascal/, /`PL_` \(upper/, /uxc context/, /uxc verify` before every push/,
    /uxc help --search/, /LEARNINGS/, /--target/, /uxc push --changed/, /uxc test --offline/]) assert.match(a, re);
  assert.doesNotMatch(a, /EXTENDS/);
  assert.ok(a.split('\n').length <= 80, `AGENTS.md is ${a.split('\n').length} lines`);
  const c = read(dir, 'CLAUDE.md');
  assert.match(c, /read AGENTS\.md first/);
  assert.match(c, /\/ux-push/);
  assert.doesNotMatch(c, /uxc push --changed/, 'CLAUDE.md points, it does not duplicate the cheat-sheet');
  assert.match(r.out, /AGENTS\.md/);
});

test('init --extension: AGENTS.md names the dependency and both namespaces', () => {
  const dir = join(tmp(), 'e');
  const r = uxc(['init', '--extension', 'acme', '--depends-on', 'case-management@>=0.3', '--dep-code', 'cm', dir]);
  assert.equal(r.code, 0, r.out);
  const a = read(dir, 'AGENTS.md');
  assert.match(a, /EXTENDS `cm` \(case-management\), versions `>=0\.3`/);
  assert.match(a, /`Acme` \(pascal/);
  assert.match(a, /Never under `Cm`\/`cm`\/`cm-`\/`CM_`/);
  assert.match(a, /EXT_PRODUCT_RESOURCE/);
});

test('an existing AGENTS.md / CLAUDE.md is kept and gets the uxc block appended (both init forms)', () => {
  for (const ext of [false, true]) {
    const dir = join(tmp(), 'k');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# Our agent rules\n\nBe nice.\n');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Ours\n');
    const args = ext ? ['init', '--extension', 'acme', '--depends-on', 'cm@*', dir] : ['init', '--name', 'K', '--code', 'kk', dir];
    const r = uxc(args);
    assert.equal(r.code, 0, r.out); // never a --force collision for these two
    const a = read(dir, 'AGENTS.md');
    assert.match(a, /^# Our agent rules\n\nBe nice\.\n\n<!-- uxc:begin -->\n## Uxopian package/);
    assert.equal(blocks(a), 1);
    assert.match(read(dir, 'CLAUDE.md'), /^# Ours\n\n<!-- uxc:begin -->[\s\S]*AGENTS\.md/);
    assert.match(r.out, /AGENTS\.md \(uxc section added\)/);
  }
});

test('context --agents-md prints the block; --write replaces only the block, is idempotent', () => {
  const dir = join(tmp(), 'r');
  assert.equal(uxc(['init', '--name', 'R', '--code', 'rr', dir]).code, 0);
  const printed = uxc(['context', '--agents-md'], { cwd: dir });
  assert.equal(printed.code, 0, printed.out);
  assert.equal(printed.out.trim(), renderAgentsSection(JSON.parse(read(dir, 'uxopian-project.json'))));

  // the author edits around the block and inside it; the manifest gains a pinned target
  const a0 = read(dir, 'AGENTS.md');
  writeFileSync(join(dir, 'AGENTS.md'), `PRE\n${a0.replace('Day to day', 'Stale heading')}POST\n`);
  const m = JSON.parse(read(dir, 'uxopian-project.json'));
  m.agent = { target: 'demo' };
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify(m));
  const w = uxc(['context', '--agents-md', '--write'], { cwd: dir });
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /refreshed: AGENTS\.md/);
  const a1 = read(dir, 'AGENTS.md');
  assert.ok(a1.startsWith('PRE\n# AGENTS.md — R\n'));
  assert.ok(a1.endsWith(`${END}\nPOST\n`));
  assert.doesNotMatch(a1, /Stale heading/);
  assert.match(a1, /PINNED to target `demo`/);
  assert.equal(blocks(a1), 1);
  assert.match(uxc(['context', '--agents-md', '--write'], { cwd: dir }).out, /already up to date/);
  assert.equal(read(dir, 'AGENTS.md'), a1);
  assert.match(uxc(['context', '--write'], { cwd: dir }).out, /--write only applies with --agents-md/);
});

test('upsertSection: CRLF files stay CRLF, the block is found and replaced', () => {
  const sec = renderClaudeSection({ code: 'xy', name: 'X' });
  const crlf = '# Mine\r\n\r\nkeep\r\n';
  const once = upsertSection(crlf, sec);
  assert.ok(once.startsWith('# Mine\r\n\r\nkeep\r\n\r\n<!-- uxc:begin -->\r\n'));
  assert.doesNotMatch(once.replace(/\r\n/g, ''), /\n/, 'no bare LF introduced');
  const edited = once.replace('read AGENTS.md first', 'old text') + 'after\r\n';
  const twice = upsertSection(edited, sec);
  assert.equal(twice, once + 'after\r\n');
  assert.equal(blocks(twice), 1);
  // new file, file without trailing newline, empty file
  assert.equal(upsertSection(null, sec, '# H\n\n'), `# H\n\n${sec}\n`);
  assert.equal(upsertSection('x', sec), `x\n\n${sec}\n`);
  assert.equal(upsertSection('', sec), `${sec}\n`);
});

test('renderAgentsSection is deterministic and lists non-extension dependencies', () => {
  const m = { name: 'D', code: 'dd', version: '1.0.0', dependencies: { zz: { versions: '1.*', slug: 'zeta' }, aa: { versions: '*' } } };
  assert.equal(renderAgentsSection(m), renderAgentsSection(structuredClone(m)));
  assert.match(renderAgentsSection(m), /depends on: `aa` `\*`, `zz` \(zeta\) `1\.\*`/);
});
