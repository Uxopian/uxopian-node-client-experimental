// Offline tests for export file selection (issue #100): the archive holds the package's own
// files only — never node_modules/, .claude/ (incl. worktrees), nested git worktrees, .gitignore'd
// files, .uxc/, marketplace/ or *.uxpkg — on both paths (git file list and plain walk), and the
// secret scrubbers still run on the staged copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, cpSync, symlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { openPackage } from '../lib/registry.mjs';
import { exportPackage, selectExportFiles, isCaseInsensitiveFs } from '../lib/packageio.mjs';
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

// ---------------------------------------------------------------------------
// review follow-ups (#100): symlinks, registry wins, nested repos, case-insensitive matching
// ---------------------------------------------------------------------------

/** Create a symlink; false when the platform refuses (Windows without the privilege). */
function trySymlink(target, path, type) {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}

function symlinkScaffold() {
  const s = scaffold();
  const outside = mkdtempSync(join(os.tmpdir(), 'uxc-export-outside-'));
  mkdirSync(join(outside, 'lib'), { recursive: true });
  writeFileSync(join(outside, 'lib', 'util.js'), 'export const u = 1;');
  const ok = trySymlink(outside, join(s.dir, 'shared'), 'junction')
    && trySymlink(join(s.dir, 'ai', 'prompts'), join(s.dir, 'alias'), 'junction')
    && trySymlink(s.dir, join(s.dir, 'ai', 'loop'), 'junction')
    && trySymlink(join(s.dir, 'nowhere'), join(s.dir, 'dangling'), 'file');
  return { ...s, outside, ok };
}

test('symlinked dirs are followed (inside + outside the package), loops and broken links reported — walk', async (t) => {
  const { dir, outside, ok } = symlinkScaffold();
  try {
    if (!ok) return t.skip('symlinks not permitted here');
    const sel = selectExportFiles(dir);
    if (sel.source !== 'walk') return t.skip('temp dir inside a git work tree');
    for (const f of ['shared/lib/util.js', 'alias/tpHello.json', 'alias/tpHello.content.md']) assert.ok(sel.files.includes(f), `${f} ships`);
    assert.ok(!sel.files.some((f) => f.startsWith('ai/loop/')), 'the loop is not followed');
    assert.equal(sel.excluded.find((g) => g.path === 'ai/loop')?.reason, 'symlink-cycle');
    assert.equal(sel.excluded.find((g) => g.path === 'dangling')?.reason, 'broken-symlink');
    const { out, notes } = quietOut();
    const { names } = await exportAndList(dir, out);
    assert.ok(names.includes('shared/lib/util.js'));
    assert.ok(notes.some((m) => /ai\/loop\/.*symlink loop/.test(m)), notes.join('\n'));
    assert.ok(notes.some((m) => /dangling .*broken symlink/.test(m)), notes.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('symlinked dirs in a git work tree: git lists the link once — its verdict covers the files below', { skip: !HAS_GIT && 'git not installed' }, async (t) => {
  const { dir, outside, ok, w } = symlinkScaffold();
  try {
    if (!ok) return t.skip('symlinks not permitted here');
    w('.gitignore', 'scratch.log\nalias\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const sel = selectExportFiles(dir);
    assert.equal(sel.source, 'git');
    assert.ok(sel.files.includes('shared/lib/util.js'), 'tracked symlink to an outside dir: its files ship');
    assert.ok(!sel.files.some((f) => f.startsWith('alias/')), 'a gitignored symlink: its files do not');
    assert.equal(sel.excluded.find((g) => g.path === 'alias')?.reason, 'gitignored');
    assert.equal(sel.excluded.find((g) => g.path === 'ai/loop')?.reason, 'symlink-cycle');
    assert.equal(sel.excluded.find((g) => g.path === 'dangling')?.reason, 'broken-symlink');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function resourceScaffold() {
  const s = scaffold();
  const reg = JSON.parse(readFileSync(join(s.dir, 'registry.json'), 'utf8'));
  reg.resources.push({ kind: 'fd.script', id: 'tpScript', path: 'fd/scripts/tpScript/', policy: 'managed' });
  s.w('registry.json', reg);
  const man = JSON.parse(readFileSync(join(s.dir, 'uxopian-project.json'), 'utf8'));
  man.dataSets = [{ name: 'TpRows', classId: 'TpRow', path: 'data/TpRows.jsonl' }];
  s.w('uxopian-project.json', man);
  s.w('data/TpRows.jsonl', '{"a":1}\n');
  s.w('fd/scripts/tpScript/main.js', 'x');
  s.w('fd/scripts/tpScript/node_modules/dep/index.js', 'dep');
  s.w('fd/scripts/tpScript/.claude/notes.md', 'n');
  s.w('fd/scripts/tpScript/.uxc/x.json', '{}');
  s.w('compat.json', '{}');
  return s;
}

test('registry wins: node_modules/.claude inside a resource ship (noted); top-level ones do not — walk', async () => {
  const { dir } = resourceScaffold();
  try {
    const sel = selectExportFiles(dir);
    for (const f of ['fd/scripts/tpScript/node_modules/dep/index.js', 'fd/scripts/tpScript/.claude/notes.md', 'data/TpRows.jsonl', 'compat.json']) {
      assert.ok(sel.files.includes(f), `${f} ships`);
    }
    assert.ok(!sel.files.some((f) => f.startsWith('node_modules/') || f.startsWith('.claude/') || f.includes('/.uxc/')));
    const nm = sel.included.find((i) => i.path === 'fd/scripts/tpScript/node_modules');
    assert.deepEqual([nm?.reason, nm?.resource, nm?.files], ['tooling-dir', 'fd.script/tpScript', 1]);
    const { out, notes } = quietOut();
    await exportAndList(dir, out);
    assert.ok(notes.some((m) => /included although a tooling dir: fd\/scripts\/tpScript\/node_modules\/ .*fd\.script\/tpScript/.test(m)), notes.join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry wins over .gitignore (own, parent repo, global excludes) with a note', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const root = mkdtempSync(join(os.tmpdir(), 'uxc-export-repo-'));
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    const { dir } = resourceScaffold();
    const pkgDir = join(root, 'pkg');
    cpSync(dir, pkgDir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(join(pkgDir, '.gitignore'), 'scratch.log\nai/prompts/*.content.md\n');
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    writeFileSync(join(root, 'global-ignore'), 'compat.json\nmain.js\n');
    writeFileSync(join(root, 'gitconfig'), `[core]\n\texcludesFile = ${join(root, 'global-ignore').replace(/\\/g, '/')}\n`);
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
    git(root, 'init', '-q');
    const sel = selectExportFiles(pkgDir);
    assert.equal(sel.source, 'git');
    for (const f of ['ai/prompts/tpHello.content.md', 'data/TpRows.jsonl', 'compat.json', 'fd/scripts/tpScript/main.js']) {
      assert.ok(sel.files.includes(f), `${f} ships although gitignored`);
    }
    assert.equal(sel.excluded.find((g) => g.path === 'scratch.log')?.reason, 'gitignored', 'an unowned ignored file stays out');
    const byPath = Object.fromEntries(sel.included.filter((i) => i.reason === 'gitignored').map((i) => [i.path, i.resource]));
    assert.equal(byPath['ai/prompts/tpHello.content.md'], 'ai.prompt/tpHello');
    assert.equal(byPath['data/TpRows.jsonl'], 'fd.dataset/TpRows');
    assert.equal(byPath['fd/scripts/tpScript/main.js'], 'fd.script/tpScript');
    const { out, notes } = quietOut();
    await exportAndList(pkgDir, out);
    assert.ok(notes.includes('included although gitignored: data/TpRows.jsonl (resource fd.dataset/TpRows)'), notes.join('\n'));
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested repos: a worktree is excluded, a submodule or nested full repo ships (minus its .git) — walk', async () => {
  const { dir, w } = scaffold();
  try {
    w('sub/.git', 'gitdir: ../.git/modules/sub\n');
    w('sub/lib.js', 'sub');
    w('full/.git/HEAD', 'ref: refs/heads/main\n');
    w('full/readme.md', 'full');
    const sel = selectExportFiles(dir);
    for (const f of ['sub/lib.js', 'full/readme.md']) assert.ok(sel.files.includes(f), `${f} ships`);
    assert.ok(!sel.files.some((f) => f.split('/').includes('.git')));
    assert.ok(!sel.files.some((f) => f.startsWith('nested/')), 'the worktree is still excluded');
    assert.equal(sel.excluded.find((g) => g.path === 'nested')?.reason, 'nested-worktree');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nested repos in a git work tree: submodule + untracked nested repo ship, worktree does not', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const { dir, w } = scaffold();
  const subSrc = mkdtempSync(join(os.tmpdir(), 'uxc-export-subsrc-'));
  try {
    git(subSrc, 'init', '-q');
    writeFileSync(join(subSrc, 'lib.js'), 'sub');
    git(subSrc, 'add', '.');
    git(subSrc, 'commit', '-q', '-m', 'sub');
    git(dir, 'init', '-q');
    git(dir, 'add', 'uxopian-project.json', 'registry.json', 'ai');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc.replace(/\\/g, '/'), 'sub');
    git(join(dir), 'init', '-q', 'full'); // an untracked nested full repo
    w('full/readme.md', 'full');
    const sel = selectExportFiles(dir);
    assert.equal(sel.source, 'git');
    for (const f of ['sub/lib.js', 'full/readme.md', '.gitmodules']) assert.ok(sel.files.includes(f), `${f} ships`);
    assert.ok(!sel.files.some((f) => f.split('/').includes('.git')));
    assert.equal(sel.excluded.find((g) => g.path === 'nested')?.reason, 'nested-worktree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(subSrc, { recursive: true, force: true });
  }
});

test('case-only mismatch between the git index and disk is not "gitignored" on a case-insensitive fs', { skip: !HAS_GIT && 'git not installed' }, async (t) => {
  const { dir, w } = scaffold();
  try {
    if (!isCaseInsensitiveFs(dir)) return t.skip('case-sensitive filesystem: the mismatch cannot occur');
    w('docs/Notes.md', 'notes');
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    renameSync(join(dir, 'docs', 'Notes.md'), join(dir, 'docs', 'tmp.md'));
    renameSync(join(dir, 'docs', 'tmp.md'), join(dir, 'docs', 'notes.md')); // index still says Notes.md
    const sel = selectExportFiles(dir);
    assert.equal(sel.source, 'git');
    assert.ok(sel.files.includes('docs/notes.md'), 'matched case-insensitively');
    assert.ok(!sel.excluded.some((g) => g.reason === 'gitignored' && g.path === 'docs'));
    const strict = selectExportFiles(dir, { caseInsensitive: false });
    assert.ok(!strict.files.includes('docs/notes.md'), 'the case-sensitive match would have dropped it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isCaseInsensitiveFs answers a boolean and agrees with a direct probe', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-export-case-'));
  try {
    writeFileSync(join(dir, 'probe.txt'), 'x');
    let direct;
    try { direct = statSync(join(dir, 'PROBE.TXT')).isFile(); } catch { direct = false; }
    assert.equal(isCaseInsensitiveFs(dir), direct);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
