// Package export/import (DESIGN §10).
//   export: stage-copy of the package's own files (git file list when in a work tree, else a walk;
//           symlinks followed; never .uxc/ .git marketplace/ node_modules/ .claude/ nested
//           worktrees *.uxpkg; registered resource files ship even when gitignored),
//           scrub ai/mcp header secrets, zip; print what was left out, warn on a big archive.
//   import: unpack (or use dir in place) -> optional registry-driven code-remap (token-boundary,
//           abort-on-residual BEFORE any file is written) -> PRE-FLIGHT classify every resource
//           and print the full table before any write -> pushResources in PUSH_ORDER.
import {
  readFileSync, writeFileSync, readdirSync, statSync, lstatSync, mkdirSync, mkdtempSync,
  copyFileSync, cpSync, renameSync, rmSync, existsSync, realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename, sep } from 'node:path';
import { zipDir, unzipTo } from './zip.mjs';
import { openPackage } from './registry.mjs';
import { statusAll, classify, pushResources } from './sync.mjs';
import { buildRemapMap, applyRemap, prefixForms } from './naming.mjs';
import { isBinary } from './refs.mjs';
import { out as makeOut, fail } from './output.mjs';
import { stableStringify, sha256, shaEq } from './util.mjs';
import { assertClientSupports } from './version.mjs';
import { writeReceipts, assertReceiptFlow } from './receipt.mjs';
import { assertServerSupported } from './dialects.mjs';
import { declaredVariables, resolveValues, renderDir, lintVariables, variablesTable, publicValues } from './variables.mjs';
import { assertDependencies } from './dependencies.mjs';
import { readCompat, readCompatLenient, judgeUpgrade, printUpgradeReport, hasBreaks, EXIT_BREAKS } from './compat.mjs';
import { pruneRemoved, shouldHoldReceipt } from './prune.mjs';
import { readReceipts } from './receipt.mjs';
import { goalEntryId, parseGoalId } from './kinds/ai-goal.mjs';
import { findLeakedSecrets } from './kinds/f2-map.mjs';
import { canonicalize } from './canonical.mjs';

const MASKED = '__masked__';
const SECRET_KEY_RE = /authorization|token|api[-_]?key|secret/i;

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export async function exportPackage(ctx, { output, allowDirty = false } = {}) {
  const pkg = ctx.requirePkg();
  const out = ctx.out ?? makeOut(ctx.flags ?? {});

  if (!allowDirty) {
    // local-only status: hash(file) vs base, no network
    const { rows } = await statusAll(ctx, { remote: false });
    const dirty = (rows ?? []).filter(
      (r) => r.state !== 'insync' && r.state !== 'external' && r.state !== 'retired',
    );
    if (dirty.length) {
      fail(
        `export refused: ${dirty.length} resource(s) drifted vs the last sync — push/pull first, or --allow-dirty:\n` +
        dirty.map((r) => `  ${r.kind}/${r.id}  ${r.state}`).join('\n'),
      );
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'uxc-export-'));
  try {
    const sel = selectExportFiles(pkg.dir);
    const files = sel.files;
    for (const rel of files) {
      const dst = join(staging, ...rel.split('/'));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(pkg.dir, ...rel.split('/')), dst);
    }
    reportExcluded(out, sel);
    scrubMcpSecrets(staging);
    scrubLlmSecrets(staging);
    scrubAgentSecrets(staging);
    scrubF2MapSecrets(staging, out);
    const name = `${pkg.manifest.code}-${pkg.manifest.version ?? '0.0.0'}.uxpkg`;
    const outFile = resolve(output ?? name);
    const { entries, bytes } = await zipDir(staging, outFile);
    const warnMb = Number(process.env.UXC_EXPORT_WARN_MB) > 0 ? Number(process.env.UXC_EXPORT_WARN_MB) : EXPORT_WARN_MB;
    if (bytes > warnMb * 1024 * 1024) {
      out.warn(`export: archive is ${fmtBytes(bytes)} (> ${warnMb} MB, UXC_EXPORT_WARN_MB) — check that nothing but package content went in`);
    }
    return {
      output: outFile, files, entries, bytes, fileSource: sel.source,
      excluded: sel.excluded.map(({ path, bytes: b, files: n, reason, tracked }) => ({ path, bytes: b, files: n, reason, tracked })),
      included: sel.included,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// export file selection (issue #100)
// ---------------------------------------------------------------------------

/** Directory names never exported, at any depth. '.uxc' = sync state; 'marketplace' = listing
 *  assets uploaded separately (not deployable); the rest is tooling, never package content. */
const EXPORT_EXCLUDED_DIRS = ['.uxc', '.git', 'marketplace', 'node_modules', '.claude'];
/** Tooling dirs a RESOURCE may legitimately hold: shipped when inside a registry entry path. */
const RESOURCE_MAY_HOLD = new Set(['node_modules', '.claude']);
const EXPORT_EXCLUDED_EXTS = ['.uxpkg'];
const EXPORT_WARN_MB = 25;
/** Always-excluded and expected: not worth a line in the "left out" summary. */
const QUIET_EXCLUDED = new Set(['.uxc', '.git']);
/** Package-level files that always ship (registry wins over ignore rules). */
const PACKAGE_FILES = ['uxopian-project.json', 'registry.json', 'marketplace.json', 'AGENTS.md', 'CLAUDE.md', 'compat.json'];
const EXCLUDED_WHY = {
  default: 'never exported', 'nested-worktree': 'nested git worktree', gitignored: '.gitignore',
  'symlink-cycle': 'symlink loop — not followed', 'broken-symlink': 'broken symlink',
  unreadable: 'unreadable', special: 'not a regular file',
};

/** Paths owned by a registered resource: registry entry paths (file, dir, or a .json meta whose
 *  `<stem>.*` siblings are its content), manifest dataSets paths, and the package files. */
function resourceOwners(dir) {
  const readJson = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
  const clean = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const owners = [];
  for (const r of readJson('registry.json')?.resources ?? []) {
    if (r?.path) owners.push({ path: clean(r.path), label: `${r.kind}/${r.id}` });
  }
  for (const d of readJson('uxopian-project.json')?.dataSets ?? []) {
    if (d?.path) owners.push({ path: clean(d.path), label: `fd.dataset/${d.name}` });
  }
  for (const f of PACKAGE_FILES) owners.push({ path: f, label: 'package file', exact: true });
  return owners;
}

/** The owner of `rel` (a file), or null. */
function ownerOf(rel, owners) {
  for (const o of owners) {
    if (rel === o.path) return o;
    if (o.exact) continue;
    if (rel.startsWith(`${o.path}/`)) return o;
    if (o.path.endsWith('.json') && rel.startsWith(`${o.path.slice(0, -5)}.`)) return o;
  }
  return null;
}

/** The resource whose entry path contains directory `parent` (a dir-style entry), or null. */
function dirOwnerOf(parent, owners) {
  for (const o of owners) {
    if (o.exact) continue;
    if (parent === o.path || parent.startsWith(`${o.path}/`)) return o;
  }
  return null;
}

/**
 * Why `rel` (a '/'-separated path relative to the package root) never ships.
 * `asDir` = rel names a directory (a symlink loop), so its last segment counts as a directory.
 * Returns { excluded: {reason, root} | null, exempt: {root, label} | null } — root is the excluded
 * path prefix used to group the summary; exempt = a node_modules/.claude dir inside a resource.
 */
function defaultExclusion(rel, worktreeRoots, owners, asDir = false) {
  const segs = rel.split('/');
  let exempt = null;
  for (let i = 0; i < segs.length; i++) {
    const prefix = segs.slice(0, i + 1).join('/');
    const last = i === segs.length - 1 && !asDir;
    if (!last && worktreeRoots.has(prefix)) return { excluded: { reason: 'nested-worktree', root: prefix }, exempt };
    if (EXPORT_EXCLUDED_DIRS.includes(segs[i]) && (!last || segs[i] === '.git')) {
      const o = !last && RESOURCE_MAY_HOLD.has(segs[i]) && i > 0 ? dirOwnerOf(segs.slice(0, i).join('/'), owners) : null;
      if (o) { exempt ??= { root: prefix, label: o.label }; continue; }
      return { excluded: { reason: 'default', root: prefix }, exempt };
    }
  }
  const name = segs.at(-1);
  if (!asDir && EXPORT_EXCLUDED_EXTS.some((x) => name.endsWith(x))) return { excluded: { reason: 'default', root: rel }, exempt };
  return { excluded: null, exempt };
}

/** A nested `.git`: 'worktree' (a FILE whose gitdir points into a `/worktrees/` dir), 'repo'
 *  (a `.git` directory, or a submodule's `.git` file pointing into `/modules/`), or null. */
function nestedGitKind(abs) {
  const p = join(abs, '.git');
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isDirectory()) return 'repo';
  try {
    const m = readFileSync(p, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (m && /\/worktrees\//.test(m[1].replace(/\\/g, '/'))) return 'worktree';
  } catch { /* unreadable .git file: treat as a plain nested repo */ }
  return 'repo';
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Every regular file under dir with sizes, FOLLOWING symlinks (files and directories, as the
 * pre-0.24.1 copyTree did) with a cycle guard: a symlinked dir resolving to one of its ancestors
 * (or to an ancestor of the package root) is not followed and reported. Inside a dir that never
 * ships, symlinked dirs are not followed (pnpm-style node_modules) — counted as one entry.
 * Also returns: worktreeRoots (subdirs that are git worktrees — excluded), opaqueRoots (paths git
 * lists as ONE entry: symlinks and nested repos/submodules), problems [{rel, reason, asDir}].
 */
function walkAll(dir, owners) {
  const files = new Map(); // rel -> bytes
  const worktreeRoots = new Set();
  const opaqueRoots = new Set();
  const problems = [];
  const rootReal = realOf(dir) ?? resolve(dir);
  (function walk(abs, rel, chain) {
    let names;
    try { names = readdirSync(abs).sort(); } catch { if (rel) problems.push({ rel, reason: 'unreadable', asDir: true }); return; }
    if (rel && names.includes('.git')) {
      const k = nestedGitKind(abs);
      if (k === 'worktree') worktreeRoots.add(rel);
      else if (k === 'repo') opaqueRoots.add(rel);
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(abs, name);
      let st, link = false;
      try { st = lstatSync(p); link = st.isSymbolicLink(); } catch { problems.push({ rel: r, reason: 'unreadable' }); continue; }
      if (link) {
        opaqueRoots.add(r);
        try { st = statSync(p); } catch { problems.push({ rel: r, reason: 'broken-symlink' }); continue; }
      }
      if (st.isDirectory()) {
        if (name === '.git') continue;
        if (link) {
          if (defaultExclusion(r, worktreeRoots, owners, true).excluded) { problems.push({ rel: r, reason: 'default', asDir: true }); continue; }
          const real = realOf(p);
          if (!real || chain.some((a) => isWithin(a, real))) {
            problems.push({ rel: r, reason: 'symlink-cycle', asDir: true });
            continue;
          }
          walk(p, r, [...chain, real]);
        } else {
          walk(p, r, [...chain, realOf(p) ?? p]);
        }
      } else if (st.isFile()) files.set(r, st.size);
      else problems.push({ rel: r, reason: 'special' });
    }
  })(dir, '', [rootReal]);
  return { files, worktreeRoots, opaqueRoots, problems };
}

/** Is the filesystem holding dir case-insensitive? Probed on a real entry (its case-swapped name
 *  resolving to the same inode), falling back to the dir's own name. */
export function isCaseInsensitiveFs(dir) {
  const probe = (parent, name) => {
    const alt = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
    if (alt === name) return null;
    try {
      const a = statSync(join(parent, name));
      const b = statSync(join(parent, alt));
      return a.ino === b.ino && a.dev === b.dev;
    } catch { return false; }
  };
  try {
    for (const n of readdirSync(dir)) {
      const v = probe(dir, n);
      if (v !== null) return v;
    }
  } catch { /* fall through */ }
  const v = probe(dirname(resolve(dir)), basename(resolve(dir)));
  return v === true;
}

/** Files git considers part of the work tree under dir — `all` (tracked + untracked-not-ignored)
 *  and `tracked` — as '/'-separated paths relative to dir; null when git is missing or dir is
 *  not inside a work tree. A symlink, a submodule and an untracked nested repo appear as ONE
 *  entry (their path, trailing '/' removed). */
export function gitFileList(dir) {
  const ls = (...args) => {
    let r;
    try {
      r = spawnSync('git', ['ls-files', ...args, '-z'], {
        cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return null; }
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.split('\0').filter(Boolean).map((x) => x.replace(/\\/g, '/').replace(/\/$/, ''));
  };
  const tracked = ls('--cached');
  const others = tracked && ls('--others', '--exclude-standard');
  if (!tracked || !others) return null;
  return { all: [...new Set([...tracked, ...others])], tracked: new Set(tracked) };
}

/**
 * Pick the files an export ships (issue #100). Inside a git work tree the candidate list comes
 * from git (so .gitignore is honoured); otherwise from a walk. Rules, in order:
 *   - the hard exclusions apply on both paths, even to files git tracks — except a node_modules/
 *     or .claude/ dir INSIDE a registry entry path (a resource may hold one: shipped + noted);
 *   - a file owned by a registered resource (or a package file) ships even when gitignored (noted);
 *   - symlinks are followed (cycle-guarded); git lists a symlink / nested repo as one entry, whose
 *     verdict covers every file under it; a nested git WORKTREE is excluded, a nested repo or
 *     submodule ships like any directory (minus its own .git);
 *   - git paths are matched case-insensitively on a case-insensitive filesystem;
 *   - nothing is dropped silently: whatever is left out is in `excluded` with its reason.
 * Returns { source: 'git'|'walk', files: [rel], excluded: [{path, bytes, files, reason, tracked}],
 *           included: [{path, reason: 'gitignored'|'tooling-dir', resource, files}] }.
 */
export function selectExportFiles(dir, { caseInsensitive } = {}) {
  const owners = resourceOwners(dir);
  const { files: onDisk, worktreeRoots, opaqueRoots, problems } = walkAll(dir, owners);
  const fromGit = gitFileList(dir);
  const ci = caseInsensitive ?? (fromGit ? isCaseInsensitiveFs(dir) : false);
  const norm = ci ? (p) => p.toLowerCase() : (p) => p;
  const gitAll = new Set((fromGit?.all ?? []).map(norm));
  const gitTracked = new Set([...(fromGit?.tracked ?? [])].map(norm));
  const opaque = new Set([...opaqueRoots].map(norm));
  /** git's verdict for a disk path: listed itself, or under a listed symlink / nested repo. */
  const gitHas = (set, rel) => {
    const n = norm(rel);
    if (set.has(n)) return true;
    const segs = n.split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (opaque.has(prefix)) return set.has(prefix); // git sees nothing below the first opaque root
    }
    return false;
  };
  // a package dir that is itself entirely ignored yields nothing from git: fall back to the walk
  const useGit = !!fromGit && [...onDisk.keys()].some((p) => gitHas(gitAll, p));
  const isCandidate = (rel) => !useGit || gitHas(gitAll, rel);
  const isTracked = (rel) => useGit && gitHas(gitTracked, rel);

  const files = [];
  const groups = new Map(); // root -> {path, bytes, files, reason, tracked}
  const add = (root, reason, rel, tracked, { count = true, asDir = false } = {}) => {
    const g = groups.get(root) ?? { path: root, dir: asDir || root !== rel, bytes: 0, files: 0, reason, tracked: 0 };
    g.bytes += onDisk.get(rel) ?? 0;
    if (count) g.files += 1;
    if (tracked) g.tracked += 1;
    groups.set(root, g);
  };
  const included = [];
  const toolingDirs = new Map(); // root -> {path, reason, resource, files}
  for (const rel of [...onDisk.keys()].sort()) {
    const { excluded: ex, exempt } = defaultExclusion(rel, worktreeRoots, owners);
    if (ex) { add(ex.root, ex.reason, rel, isTracked(rel)); continue; }
    if (!isCandidate(rel)) {
      const o = ownerOf(rel, owners);
      if (!o) { add(rel.split('/')[0], 'gitignored', rel, false); continue; }
      included.push({ path: rel, reason: 'gitignored', resource: o.label, files: 1 });
    }
    if (exempt) {
      const t = toolingDirs.get(exempt.root) ?? { path: exempt.root, reason: 'tooling-dir', resource: exempt.label, files: 0 };
      t.files += 1;
      toolingDirs.set(exempt.root, t);
    }
    files.push(rel);
  }
  for (const pr of problems) {
    const { excluded: ex } = defaultExclusion(pr.rel, worktreeRoots, owners, !!pr.asDir);
    if (ex) { add(ex.root, ex.reason, pr.rel, false); continue; }
    add(pr.rel, pr.reason, pr.rel, isTracked(pr.rel), { count: !pr.asDir, asDir: !!pr.asDir });
  }
  included.push(...toolingDirs.values());
  const excluded = [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { source: useGit ? 'git' : 'walk', files, excluded, included };
}

function reportExcluded(out, sel) {
  for (const i of sel.included ?? []) {
    if (i.reason === 'gitignored') out.note(`included although gitignored: ${i.path} (resource ${i.resource})`);
    else out.note(`included although a tooling dir: ${i.path}/ (${i.files} file${i.files === 1 ? '' : 's'}, inside resource ${i.resource})`);
  }
  const shown = sel.excluded.filter((g) => !QUIET_EXCLUDED.has(g.path.split('/').at(-1)));
  if (!shown.length) return;
  const total = shown.reduce((n, g) => n + g.bytes, 0);
  out.note(`left out of the archive (${sel.source === 'git' ? 'git file list' : 'directory walk'}): ${fmtBytes(total)}`);
  for (const g of shown) {
    out.note(`  ${g.path}${g.dir ? '/' : ''}  ${fmtBytes(g.bytes)} (${g.files} file${g.files === 1 ? '' : 's'}, ${EXCLUDED_WHY[g.reason] ?? g.reason})`);
  }
  for (const g of shown.filter((x) => x.tracked)) {
    out.warn(`export: ${g.path} has ${g.tracked} file(s) tracked in git but is excluded anyway (${EXCLUDED_WHY[g.reason] ?? g.reason}) — remove it from the repository`);
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Recursive copy; returns the rel paths copied. excludeDirs match by basename at any depth. */
function copyTree(srcDir, dstDir, { excludeDirs = [], excludeExts = [] } = {}, rel = '', acc = []) {
  for (const name of readdirSync(srcDir).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const s = join(srcDir, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      if (excludeDirs.includes(name)) continue;
      copyTree(s, join(dstDir, name), { excludeDirs, excludeExts }, r, acc);
    } else if (st.isFile()) {
      if (excludeExts.some((x) => name.endsWith(x))) continue;
      mkdirSync(dstDir, { recursive: true });
      copyFileSync(s, join(dstDir, name));
      acc.push(r);
    }
  }
  return acc;
}

/** Mask header values whose key matches SECRET_KEY_RE in every staged ai/mcp/*.json.
 *  Handles both shapes: headers as an object map and headers as [{name, value}] arrays.
 *  '__masked__' is the ai-mcp placeholder: push resolves it against the live server value. */
function scrubMcpSecrets(stagingDir) {
  const dir = join(stagingDir, 'ai', 'mcp');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    let obj;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const scrubbed = scrubHeaders(obj);
    if (JSON.stringify(scrubbed) !== JSON.stringify(obj)) writeFileSync(p, stableStringify(scrubbed));
  }
}

/**
 * f2/maps/*.json: a fast2 map embeds FlowerDocs credentials inline and fast2's obfuscation is
 * REVERSIBLE (FAST2-LEARNINGS §F11). canonicalize() already masks them on every write, so a
 * literal here means a hand-edited file — mask it and SAY SO, because the alternative is shipping
 * a working credential inside a .uxpkg that gets published to the marketplace.
 */
function scrubF2MapSecrets(stagingDir, out) {
  const dir = join(stagingDir, 'f2', 'maps');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    const leaked = findLeakedSecrets(obj);
    if (!leaked.length) continue;
    writeFileSync(p, stableStringify(canonicalize('f2.map', obj))); // canonicalize does the masking
    for (const h of leaked) {
      out?.warn?.(`export: masked a credential in f2/maps/${f} (step "${h.stepName}", ${h.field}: ${h.reason}) — the artifact ships '__masked__'; use a {{uxc:…}} variable so installs supply their own`);
    }
  }
}

/** Defense-in-depth for ai/llm/*.json: mask any secret-keyed string (e.g. globalConf.apiSecret).
 *  Pulled files are already masked by the adapter (writeLocal canonicalizes secrets to __masked__);
 *  this catches a hand-edited real key so it can never ride out in an exported .uxpkg. */
function scrubLlmSecrets(stagingDir) {
  const dir = join(stagingDir, 'ai', 'llm');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    let obj;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const scrubbed = maskSecretKeys(obj);
    if (JSON.stringify(scrubbed) !== JSON.stringify(obj)) writeFileSync(p, stableStringify(scrubbed));
  }
}

/** ai/agents/*.json: EVERY `secrets.<NAME>.value` is a secret, whatever the name (MY_KEY…). Pulled
 *  files already hold '__masked__' (the server echoes '********'); a hand-written value is masked
 *  here so it never ships. A {{uxc:var}} placeholder is kept — installs supply their own value. */
function scrubAgentSecrets(stagingDir) {
  const dir = join(stagingDir, 'ai', 'agents');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const p = join(dir, name);
    let obj;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    if (!obj?.secrets || typeof obj.secrets !== 'object') continue;
    let changed = false;
    for (const s of Object.values(obj.secrets)) {
      if (s && typeof s.value === 'string' && s.value && s.value !== MASKED && !/\{\{uxc:[A-Za-z_]\w*\}\}/.test(s.value)) {
        s.value = MASKED;
        changed = true;
      }
    }
    if (changed) writeFileSync(p, stableStringify(obj));
  }
}

/** Recursively replace any non-empty string whose KEY matches SECRET_KEY_RE with the placeholder. */
function maskSecretKeys(v) {
  if (Array.isArray(v)) return v.map(maskSecretKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = typeof x === 'string' && x && SECRET_KEY_RE.test(k) ? MASKED : maskSecretKeys(x);
    }
    return out;
  }
  return v;
}

function scrubHeaders(v) {
  if (Array.isArray(v)) return v.map(scrubHeaders);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (/^headers$/i.test(k) && x && typeof x === 'object') out[k] = maskWithin(x);
      else out[k] = scrubHeaders(x);
    }
    return out;
  }
  return v;
}

function maskWithin(headers) {
  if (Array.isArray(headers)) {
    return headers.map((h) =>
      h && typeof h === 'object' && typeof h.name === 'string' && SECRET_KEY_RE.test(h.name) &&
      typeof h.value === 'string' && h.value
        ? { ...h, value: MASKED }
        : scrubHeaders(h));
  }
  const out = {};
  for (const [k, x] of Object.entries(headers)) {
    out[k] = typeof x === 'string' && x && SECRET_KEY_RE.test(k) ? MASKED : scrubHeaders(x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** Package variables (DESIGN §21): lint + resolve + render ONCE. Runs on the UNPACK dir BEFORE it
 *  moves into place (a refusal leaves nothing behind) — and in place for dir-mode imports (a dir
 *  import IS the checkout being materialized). Returns the applied public values, or null. */
function applyPackageVariables(dir, out, { vars = {}, varFile = {} } = {}) {
  const manifest0 = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
  const vlint = lintVariables(manifest0, dir);
  if (vlint.forbidden.length) {
    fail(`package variables: placeholders are FORBIDDEN in ${vlint.forbidden.join(', ')} (ids and sync keys must be concrete)`);
  }
  if (vlint.undeclared.length) {
    fail(`package variables: placeholders not declared in the manifest: ${vlint.undeclared.map((n) => `{{uxc:${n}}}`).join(', ')} — fix the package (or upgrade it)`);
  }
  if (!Object.keys(declaredVariables(manifest0)).length) return null;
  const { values, missing, unknown, invalid } = resolveValues(manifest0, { vars, varFile });
  if (unknown.length) fail(`unknown --var name(s): ${unknown.join(', ')} — this package declares: ${Object.keys(declaredVariables(manifest0)).join(', ')}`);
  if (invalid.length) fail(`variable value(s) failed validation:\n${invalid.map((i) => `  ${i.name}=${i.value} does not match ${i.pattern}`).join('\n')}`);
  if (missing.length) {
    const table = variablesTable(manifest0, values)
      .map((r) => `  ${r.name.padEnd(16)} ${r.required.padEnd(4)} ${r.value.padEnd(28)} ${r.description}`).join('\n');
    fail(
      `this package requires variable value(s): ${missing.join(', ')} — NOTHING was installed\n` +
      `  name             req  value                        description\n${table}\n` +
      `provide them with --var name=value (repeatable) or --var-file values.json; uxc vars <pkg> lists them.`,
    );
  }
  const r = renderDir(dir, values); // strict: throws (writing NOTHING) on unresolved
  out.note(`variables: ${r.replaced} substitution(s) across ${r.files.length} file(s)`);
  const appliedVars = publicValues(manifest0, values);
  mkdirSync(join(dir, '.uxc'), { recursive: true });
  writeFileSync(join(dir, '.uxc', 'variables.json'), stableStringify(appliedVars));
  return appliedVars;
}

export async function importPackage(ctx, src, opts = {}) {
  // the --report scratch copy (uxc-report-*) is removed on EVERY path: return, throw, and fail()
  // — whose process.exit skips finally blocks, hence the 'exit' hook as well
  const scratch = { dir: null };
  const cleanup = () => { if (scratch.dir) { rmSync(scratch.dir, { recursive: true, force: true }); scratch.dir = null; } };
  process.once('exit', cleanup);
  try { return await importPackageIn(ctx, src, opts, scratch); }
  finally { cleanup(); process.removeListener('exit', cleanup); }
}

async function importPackageIn(ctx, src, { remap = null, force = false, expectSha256 = null, ignoreClientVersion = false, ignoreServerVersion = false, ignoreDependencies = false, vars = {}, varFile = {}, pruneFrom = null, yesRemovals = false, keepRemoved = false, report = false } = {}, scratch) {
  const out = ctx.out ?? makeOut(ctx.flags ?? {});
  if (!ctx.clients) ctx.connect?.();
  if (!ctx.clients) fail('importPackage needs a connected target (ctx.connect)');

  // 1. unpack a .uxpkg into a NEW directory next to cwd, or use a package dir in place
  let dir;
  let artifactSha = null;
  let appliedVars = null;
  if (/\.uxpkg$/i.test(src)) {
    if (!existsSync(src)) fail(`no such file: ${src}`);
    // SECURITY GATE: hash the archive BEFORE unpacking or touching any server. If an expected
    // hash was supplied (explicitly or by `mp install` from the marketplace), a mismatch aborts
    // here — nothing is unpacked, nothing is deployed to FlowerDocs / Uxopian AI.
    artifactSha = sha256(readFileSync(src));
    if (expectSha256 && !shaEq(artifactSha, expectSha256)) {
      fail(
        `integrity check FAILED for ${src} — refusing to deploy to ${ctx.target?.name ?? 'the target'}.\n` +
        `  expected ${expectSha256}\n  actual   ${artifactSha}\n` +
        'the archive does not match the trusted hash (tampered, corrupted, or wrong file). Nothing was written.',
      );
    }
    out.note(`artifact sha256 ${artifactSha}${expectSha256 ? '  (verified)' : ''}`);
    const tmp = mkdtempSync(join(tmpdir(), 'uxc-import-'));
    try {
      await unzipTo(src, tmp);
      const root = unpackedRoot(tmp, src);
      const manifest = JSON.parse(readFileSync(join(root, 'uxopian-project.json'), 'utf8'));
      // CLIENT-VERSION GATE: refuse before creating the target dir / writing anything if this uxc is
      // older than the package's declared minimum (the unpack tmp is cleaned by the finally below).
      assertClientSupports(manifest, { ignore: ignoreClientVersion, out, action: 'install' });
      // VARIABLES (DESIGN §21): resolve + render INSIDE the unpack tmp — a refusal (missing value,
      // lint error) cleans up via the finally and leaves NO half-materialized install dir.
      appliedVars = applyPackageVariables(root, out, { vars, varFile });
      if (report) {
        // --report is READ-ONLY, locally too: work on a scratch copy, never create ./<code>/
        scratch.dir = mkdtempSync(join(tmpdir(), 'uxc-report-'));
        dir = join(scratch.dir, 'pkg');
        moveDir(root, dir);
      } else {
      const dirName = remap ? String(remap).split('=')[1] : manifest.code;
      dir = resolve(process.cwd(), dirName);
      if (existsSync(dir)) {
        fail(
          `import target directory already exists: ${dir}\n` +
          `  the archive unpacks into ./${dirName}/ under the CURRENT directory — nothing was written or deployed.\n` +
          `  fixes: run the import from a different parent directory, remove/rename the existing ${dirName}/,\n` +
          `  or install under a different code with --code-remap ${dirName}=<newcode>`,
        );
      }
      moveDir(root, dir);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    if (expectSha256) {
      fail('--expect-sha256 verifies a .uxpkg archive (a single artifact), not a package directory — point it at the .uxpkg.');
    }
    dir = resolve(src);
    if (!existsSync(join(dir, 'uxopian-project.json'))) {
      fail(`not a uxopian package: ${dir} (no uxopian-project.json)`);
    }
    // CLIENT-VERSION GATE: refuse before any server write if this uxc is older than the minimum.
    const manifest = JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8'));
    assertClientSupports(manifest, { ignore: ignoreClientVersion, out, action: 'install' });
    if (report) {
      // --report is READ-ONLY, locally too: render variables on a scratch copy, never in the checkout
      scratch.dir = mkdtempSync(join(tmpdir(), 'uxc-report-'));
      cpSync(dir, join(scratch.dir, 'pkg'), { recursive: true });
      dir = join(scratch.dir, 'pkg');
    }
    // VARIABLES: a dir import IS the checkout being materialized — render in place.
    appliedVars = applyPackageVariables(dir, out, { vars, varFile });
  }

  // 2. registry-driven code-remap (experimental: refuses on residuals rather than guessing)
  if (remap) applyCodeRemap(dir, remap, out);

  // 3. open the unpacked package; same clients/target, pkg swapped
  const pkg = openPackage(dir);
  // SERVER-version gate (DESIGN §18): refuse before any pre-flight/write when the target server
  // version is outside the package's supportedVersions (mirror of the client gate above)
  await assertServerSupported(ctx, pkg.manifest, { ignore: ignoreServerVersion, out, action: 'install' });
  // dependency gate (DESIGN §22): everything this package NEEDS must already be on the target
  await assertDependencies(ctx, pkg.manifest, { ignore: ignoreDependencies, out, action: 'install' });
  // receipt flow gate (DESIGN §19): refuse silent downgrades vs the installed receipt (--force overrides)
  await assertReceiptFlow(ctx, pkg.manifest, { force, out, action: 'install' });
  const ctx2 = { ...ctx, out, pkg, requirePkg: () => pkg, clients: ctx.clients, target: ctx.target };

  // 4. PRE-FLIGHT: classify every entry (import has no base -> new/adopted/collision),
  //    print the FULL table before any write
  const entries = pkg.entries();
  const rows = [];
  for (const e of entries) {
    let c;
    try { c = await classify(ctx2, e); }
    catch (err) { c = { state: 'error', detail: err.message }; }
    rows.push({ entry: e, kind: e.kind, id: e.id, policy: e.policy ?? 'managed', state: c.state, detail: c.detail ?? '' });
  }
  out.line(`pre-flight: ${rows.length} resource(s) vs target ${ctx.target?.name ?? '?'}`);
  out.table(rows, [{ key: 'kind' }, { key: 'id' }, { key: 'policy' }, { key: 'state' }, { key: 'detail', max: 50 }]);

  const collisions = rows
    .filter((r) => r.state === 'collision' || r.state === 'conflict' || r.state === 'error')
    .map(({ kind, id, state, detail }) => ({ kind, id, state, detail }));

  // UPGRADE REPORT / GATE (DESIGN §26) — only for a package that ships a compat declaration.
  // Judges the extensions installed on top of this package; nothing is written by the judgement.
  let upgrade = null;
  try {
    const compat = await readCompat(dir);
    if (compat) {
      let receipts = [];
      try { receipts = await readReceipts(ctx2, {}); } catch { receipts = []; }
      const rowsJ = judgeUpgrade(receipts, pkg.manifest, compat, { collisions: collisions.filter((c) => c.state !== 'error') });
      upgrade = { product: pkg.manifest.code, version: pkg.manifest.version ?? '0.0.0', rows: rowsJ, breaks: hasBreaks(rowsJ) };
    }
  } catch (e) {
    fail(`compat declaration unreadable: ${e.message}`);
  }
  if (report) {
    if (upgrade) printUpgradeReport(out, upgrade.product, upgrade.version, upgrade.rows);
    else out.line(`upgrade report: ${pkg.manifest.code}@${pkg.manifest.version ?? '0.0.0'} ships no compat.json — nothing to judge`);
    if (upgrade?.breaks) process.exitCode = EXIT_BREAKS;
    return { report: true, upgrade, collisions, artifactSha, written: false };
  }
  if (upgrade) {
    printUpgradeReport(out, upgrade.product, upgrade.version, upgrade.rows);
    if (upgrade.breaks) {
      if (!force) {
        fail(
          `import aborted before any write — the upgrade breaks installed extension(s): ${upgrade.rows.filter((r) => r.verdict === 'breaks').map((r) => r.code).join(', ')}\n` +
          'fix them first (see the remedies above), or re-run with --force to install anyway.',
        );
      }
      out.warn(`upgrade breaks installed extension(s) — INSTALLING ANYWAY (--force)`);
    }
  }
  if (collisions.length && !force) {
    fail(
      `import aborted before any write — ${collisions.length} collision(s):\n` +
      collisions.map((c) => `  ${c.kind}/${c.id}  ${c.state}${c.detail ? `  ${c.detail}` : ''}`).join('\n') +
      '\nresolve with uxc diff / adopt, or re-run with --force to overwrite.',
    );
  }

  // 5. ordered push (pushResources orders by PUSH_ORDER and commits state per resource)
  const PUSHABLE = new Set(['new', 'local', ...(force ? ['collision', 'conflict', 'server'] : [])]);
  const toPush = rows.filter((r) => PUSHABLE.has(r.state) && r.state !== 'error').map((r) => r.entry);
  const pushed = toPush.length ? await pushResources(ctx2, toPush, { force }) : [];
  out.line(`import: pushed ${pushed.length}, skipped ${rows.length - toPush.length} (insync/adopted/external/retired)`);

  // UPGRADE PRUNING (DESIGN §23, DEFAULT): the previous version's resources that this version
  // no longer carries are deleted after a printed list + confirmation. Prune-source precedence:
  // the installed RECEIPT's `resources` list (exact — written by uxc >= 0.11 at every install,
  // marketplace-independent, enables plain-import upgrades) > `pruneFrom` supplied by the caller
  // (mp install: the installed version's marketplace catalog — receipts written by older uxc).
  let oldKeys = pruneFrom;
  try {
    const prev = (await readReceipts(ctx2, { code: pkg.manifest.code })).find((r) => r.resources?.length);
    if (prev?.resources?.length) oldKeys = prev.resources;
  } catch { /* receipts unreadable -> caller-supplied source (or none) */ }
  let pruneRes = null;
  if (oldKeys?.length) {
    pruneRes = await pruneRemoved(ctx2, oldKeys, pkg.entries(), {
      yes: yesRemovals, keep: keepRemoved, out,
      onDeleted: (c) => { try { pkg.setResState(ctx.target.name, c.kind, c.id, null); } catch { /* fresh state */ } },
    });
  }

  // stamp the installation receipts (DESIGN §19) — but ONLY when the upgrade is COMPLETE: an
  // advanced receipt over a skipped prune strands the orphan (field-reported, §23)
  let receipts = [];
  if (shouldHoldReceipt(pruneRes, { keep: keepRemoved })) {
    out.warn?.('receipt NOT advanced — the upgrade is incomplete until the removals above are resolved (re-run with --yes-removals, or --keep-removed to accept the leftovers)');
  } else {
    const resources = pkg.entries().filter((e) => !e.retired).map((e) => `${e.kind}/${e.id}`);
    receipts = await writeReceipts(ctx2, pkg.manifest, { artifactSha, variables: appliedVars ?? undefined, resources, compat: await readCompatLenient(dir, out) });
    for (const r of receipts) {
      if (r.ok) out.note(`receipt ${r.surface}: ${r.receipt.code}@${r.receipt.version}`);
      else out.warn?.(`receipt FAILED on ${r.surface}: ${r.error} (import unaffected — uxc installed --write to retry)`);
    }
  }

  return { dir, pushed, collisions, artifactSha, receipts, ...(upgrade ? { upgrade } : {}) };
}

/** Manifest at archive root, or inside a single wrapping directory. */
function unpackedRoot(tmp, src) {
  if (existsSync(join(tmp, 'uxopian-project.json'))) return tmp;
  const subs = readdirSync(tmp).filter((n) => statSync(join(tmp, n)).isDirectory());
  if (subs.length === 1 && existsSync(join(tmp, subs[0], 'uxopian-project.json'))) return join(tmp, subs[0]);
  fail(`not a uxopian package archive (no uxopian-project.json): ${src}`);
}

function moveDir(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch {
    copyTree(src, dst); // cross-device tmpdir: copy then drop
    rmSync(src, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// code-remap (registry-driven, token-boundary; two-phase so an abort writes NOTHING)
// ---------------------------------------------------------------------------

function applyCodeRemap(dir, remapSpec, out) {
  const m = String(remapSpec).match(/^([A-Za-z][A-Za-z0-9]*)=([A-Za-z][A-Za-z0-9]*)$/);
  if (!m) fail(`--code-remap must be "<oldCode>=<newCode>" (e.g. ct=xy), got "${remapSpec}"`);
  const oldCode = m[1].toLowerCase();
  const newCode = m[2].toLowerCase();

  const manifestPath = join(dir, 'uxopian-project.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (String(manifest.code ?? '').toLowerCase() !== oldCode) {
    fail(`--code-remap ${oldCode}=${newCode}: package code is "${manifest.code}", not "${oldCode}"`);
  }
  const registry = existsSync(join(dir, 'registry.json'))
    ? JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))
    : { resources: [] };
  const map = buildRemapMap(manifest, (registry.resources ?? []).map(({ kind, id }) => ({ kind, id })), newCode);

  // phase 1: compute every rewrite in memory; collect residual old-prefix tokens
  const rels = [];
  (function walk(d, rel) {
    for (const name of readdirSync(d).sort()) {
      if (name === '.uxc' || name === '.git') continue;
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else rels.push(r);
    }
  })(dir, '');

  const writes = []; // {abs, text}
  const residuals = []; // {path, token}
  let replaced = 0;
  for (const rel of rels) {
    if (rel === 'uxopian-project.json' || rel.endsWith('.uxpkg')) continue; // manifest handled structurally
    const abs = join(dir, rel);
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    const r = applyRemap(text, map, manifest);
    replaced += r.replaced;
    for (const t of r.residual) residuals.push({ path: rel, token: t });
    if (r.text !== text) writes.push({ abs, text: r.text });
  }

  // manifest: remap embedded ids (dataSets classIds, description…), then force code + prefixes
  const mr = applyRemap(JSON.stringify(manifest), map, manifest);
  const newManifest = JSON.parse(mr.text);
  newManifest.code = newCode;
  newManifest.idPrefixes = prefixForms(newCode);
  replaced += mr.replaced;
  for (const t of mr.residual) residuals.push({ path: 'uxopian-project.json', token: t });

  if (residuals.length) {
    fail(
      `code-remap ${oldCode}=${newCode} aborted — ${residuals.length} residual old-prefix token(s), NOTHING written:\n` +
      residuals.map((r) => `  ${r.path}: ${r.token}`).join('\n') +
      '\nthese ids are not in the registry (foreign ids sharing the prefix, or unregistered files) — adopt/register them first.',
    );
  }

  // phase 2: write rewritten texts, then rename files/dirs whose basenames carry mapped ids
  for (const w of writes) writeFileSync(w.abs, w.text);
  writeFileSync(manifestPath, stableStringify(newManifest));
  const renamed = renameTree(dir, map, manifest);

  // goal registry ids embed filterHash8(filter): a remapped filter changes the hash — recompute
  fixGoalRegistryIds(dir, map, out);

  out?.note?.(`code-remap ${oldCode}=${newCode}: ${replaced} token replacement(s), ${renamed} path rename(s)`);
  return { replaced, renamed };
}

/** Bottom-up rename of files/dirs whose basenames contain mapped ids. Uses applyRemap on the
 *  basename so renames follow EXACTLY the same replacement semantics (longest-first, token
 *  boundaries) as the file-content rewrites — paths and the registry `path` strings stay equal. */
function renameTree(d, map, manifest) {
  let n = 0;
  for (const name of readdirSync(d)) {
    if (name === '.uxc' || name === '.git') continue;
    const abs = join(d, name);
    if (statSync(abs).isDirectory()) n += renameTree(abs, map, manifest);
    const nn = applyRemap(name, map, manifest).text;
    if (nn !== name) {
      renameSync(abs, join(d, nn));
      n++;
    }
  }
  return n;
}

/** Re-derive ai.goal registry ids from the (remapped) goals.json rows. A composite goal id like
 *  'ctClassify+ctSummary+8f3a01bc' is itself a map ENTRY (longest-first wins), so its inner
 *  tokens can come out half-remapped — and a remapped filter changes the hash8. Recompute both. */
function fixGoalRegistryIds(dir, map, out) {
  const regPath = join(dir, 'registry.json');
  const goalsPath = join(dir, 'ai', 'goals', 'goals.json');
  if (!existsSync(regPath) || !existsSync(goalsPath)) return;
  let reg, rows;
  try {
    reg = JSON.parse(readFileSync(regPath, 'utf8'));
    rows = JSON.parse(readFileSync(goalsPath, 'utf8'));
  } catch { return; }
  if (!Array.isArray(rows)) return;
  const valid = new Set(rows.map(goalEntryId));
  let changed = false;
  for (const e of reg.resources ?? []) {
    if (e.kind !== 'ai.goal' || valid.has(e.id)) continue;
    const { goalName, promptId } = parseGoalId(e.id);
    const gn = map.get(goalName) ?? goalName;
    const pid = map.get(promptId) ?? promptId;
    const row = rows.find((r) => r.goalName === gn && r.promptId === pid);
    if (row) {
      e.id = goalEntryId(row);
      changed = true;
    } else {
      out?.warn?.(`code-remap: ai.goal registry id "${e.id}" has no matching row in ai/goals/goals.json — fix it manually`);
    }
  }
  if (changed) writeFileSync(regPath, stableStringify(reg));
}
