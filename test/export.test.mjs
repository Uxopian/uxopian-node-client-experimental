// Offline tests for export file selection (issue #100): the archive holds the package's own
// files only — never node_modules/, .claude/ (incl. worktrees), nested git worktrees, .gitignore'd
// files, .uxc/, marketplace/ or *.uxpkg — on both paths (git file list and plain walk), and the
// secret scrubbers still run on the staged copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { exportPackage, selectExportFiles } from '../lib/packageio.mjs';
import { unzipTo } from '../lib/zip.mjs';

const HAS_GIT = (() => {
  try { return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function scaffold() {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-export-'));
  const w = (rel, data) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  w('uxopian-project.json', { code: 'tp', name: 'tp', format: 'uxopian-package/1', version: '1.0.0', products: ['uxopian-ai'] });
  w('registry.json', { resources: [
    { kind: 'ai.prompt', id: 'tpHello', path: 'ai/prompts/tpHello.json', policy: 'managed' },
    { kind: 'ai.agent', id: 'tpHelloAgent', path: 'ai/agents/tpHelloAgent.json', policy: 'managed' },
  ] });
  w('ai/prompts/tpHello.json', { id: 'tpHello', role: 'USER' });
  w('ai/prompts/tpHello.content.md', 'Reply PONG');
  w('ai/agents/tpHelloAgent.json', { id: 'tpHelloAgent', objective: 'tpHello', secrets: { REAL: { value: 'sk-live-123' } } });
  // the noise issue #100 found in a real package
  w('node_modules/left-pad/index.js', 'x'.repeat(4096));
  w('node_modules/left-pad/package.json', '{}');
  w('.claude/settings.local.json', '{}');
  w('.claude/worktrees/wt1/registry.json', '{}');
  w('nested/.git', 'gitdir: /elsewhere/.git/worktrees/nested\n'); // a nested worktree checkout
  w('nested/registry.json', '{}');
  w('.uxc/state.json', '{}');
  w('marketplace/shot.png', 'png');
  w('old-0.9.0.uxpkg', 'zip');
  w('scratch.log', 'debug output');
  w('.gitignore', 'scratch.log\n');
  return { dir, w };
}

const quietOut = () => {
  const notes = [], warns = [];
  return { notes, warns, out: { line: () => {}, note: (m) => notes.push(m), warn: (m) => warns.push(m), result: () => {} } };
};

async function exportAndList(dir, out) {
  const pkg = openPackage(dir);
  const file = join(os.tmpdir(), `uxc-export-${process.pid}-${Math.random().toString(36).slice(2)}.uxpkg`);
  const into = mkdtempSync(join(os.tmpdir(), 'uxc-export-unzip-'));
  try {
    const res = await exportPackage({ requirePkg: () => pkg, pkg, flags: {}, out }, { output: file, allowDirty: true });
    await unzipTo(file, into);
    const names = [];
    (function walk(d, rel) {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${n.name}` : n.name;
        if (n.isDirectory()) walk(join(d, n.name), r); else names.push(r);
      }
    })(into, '');
    const agent = JSON.parse(readFileSync(join(into, 'ai/agents/tpHelloAgent.json'), 'utf8'));
    return { res, names: names.sort(), agent, raw: readFileSync(file) };
  } finally {
    rmSync(into, { recursive: true, force: true });
    rmSync(file, { force: true });
  }
}

const EXPECTED = [
  '.gitignore', 'ai/agents/tpHelloAgent.json', 'ai/prompts/tpHello.content.md', 'ai/prompts/tpHello.json',
  'registry.json', 'uxopian-project.json',
];

function assertOnlyPackageContent(names) {
  for (const n of names) {
    assert.ok(!/^(node_modules|\.claude|nested|\.uxc|marketplace)\//.test(n), `${n} must not ship`);
    assert.ok(!n.endsWith('.uxpkg'), `${n} must not ship`);
  }
}

test('export without git: walk the tree, drop node_modules/.claude/nested worktree/.uxc/marketplace/*.uxpkg', async () => {
  const { dir } = scaffold();
  try {
    const sel = selectExportFiles(dir);
    // the temp dir may sit inside some git work tree on a dev machine — only assert walk when it is not
    if (sel.source === 'walk') {
      assert.deepEqual(sel.files, [...EXPECTED, 'scratch.log'].sort(), 'without git, .gitignore is not consulted');
    }
    const { out, notes } = quietOut();
    const { names, agent, raw, res } = await exportAndList(dir, out);
    assertOnlyPackageContent(names);
    for (const e of EXPECTED) assert.ok(names.includes(e), `${e} ships`);
    assert.equal(agent.secrets.REAL.value, '__masked__', 'secret scrubbing still applies');
    assert.ok(!raw.includes(Buffer.from('sk-live-123')));
    const paths = res.excluded.map((g) => g.path);
    for (const p of ['node_modules', '.claude', 'nested', 'marketplace', 'old-0.9.0.uxpkg']) assert.ok(paths.includes(p), `${p} reported`);
    assert.equal(res.excluded.find((g) => g.path === 'nested').reason, 'nested-worktree');
    assert.ok(notes.some((m) => /node_modules\/\s+4\.\d KB \(2 files, never exported\)/.test(m)), notes.join('\n'));
    assert.ok(!notes.some((m) => /\.uxc/.test(m)), 'sync state is expected — not listed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export in a git work tree: .gitignore honoured, committed node_modules still excluded and flagged', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const { dir } = scaffold();
  try {
    git(dir, 'init', '-q');
    git(dir, 'add', '-f', 'node_modules/left-pad/index.js'); // committed by mistake
    git(dir, 'add', 'uxopian-project.json', 'registry.json', 'ai');
    git(dir, 'commit', '-q', '-m', 'init');
    const sel = selectExportFiles(dir);
    assert.equal(sel.source, 'git');
    assert.deepEqual(sel.files, EXPECTED, 'tracked + untracked-not-ignored, minus default exclusions');
    const ign = sel.excluded.find((g) => g.path === 'scratch.log');
    assert.equal(ign?.reason, 'gitignored');
    const nm = sel.excluded.find((g) => g.path === 'node_modules');
    assert.equal(nm.tracked, 1, 'the committed file is counted as tracked');

    const { out, warns, notes } = quietOut();
    const { names, agent } = await exportAndList(dir, out);
    assert.deepEqual(names, EXPECTED);
    assert.equal(agent.secrets.REAL.value, '__masked__');
    assert.ok(notes.some((m) => /git file list/.test(m)));
    assert.ok(warns.some((m) => /node_modules has 1 file\(s\) tracked in git but is excluded anyway/.test(m)), warns.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export of a package in a subdirectory of a repo uses paths relative to the package', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'uxc-export-repo-'));
  try {
    git(root, 'init', '-q');
    writeFileSync(join(root, 'README.md'), 'repo');
    const { dir } = scaffold();
    const pkgDir = join(root, 'pkg');
    cpSync(dir, pkgDir, { recursive: true }); // the package lives in pkg/ of a larger repo
    rmSync(dir, { recursive: true, force: true });
    const sel = selectExportFiles(pkgDir);
    assert.equal(sel.source, 'git');
    assert.deepEqual(sel.files, EXPECTED);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('export warns when the archive exceeds UXC_EXPORT_WARN_MB', async () => {
  const { dir, w } = scaffold();
  const prev = process.env.UXC_EXPORT_WARN_MB;
  try {
    // incompressible-ish content so the zip stays above the tiny threshold
    w('ai/prompts/big.content.md', Array.from({ length: 40000 }, (_, i) => (i * 2654435761 >>> 0).toString(36)).join(''));
    process.env.UXC_EXPORT_WARN_MB = '0.01';
    const { out, warns } = quietOut();
    await exportAndList(dir, out);
    assert.ok(warns.some((m) => /archive is .* \(> 0\.01 MB, UXC_EXPORT_WARN_MB\)/.test(m)), warns.join('\n'));
    process.env.UXC_EXPORT_WARN_MB = '1000';
    const q = quietOut();
    await exportAndList(dir, q.out);
    assert.ok(!q.warns.some((m) => /archive is/.test(m)));
  } finally {
    if (prev === undefined) delete process.env.UXC_EXPORT_WARN_MB; else process.env.UXC_EXPORT_WARN_MB = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
