// Package export/import (DESIGN §10).
//   export: stage-copy minus .uxc/ + *.uxpkg (+ .git), scrub ai/mcp header secrets, zip.
//   import: unpack (or use dir in place) -> optional registry-driven code-remap (token-boundary,
//           abort-on-residual BEFORE any file is written) -> PRE-FLIGHT classify every resource
//           and print the full table before any write -> pushResources in PUSH_ORDER.
import {
  readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync,
  copyFileSync, renameSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { zipDir, unzipTo } from './zip.mjs';
import { openPackage } from './registry.mjs';
import { statusAll, classify, pushResources } from './sync.mjs';
import { buildRemapMap, applyRemap, prefixForms } from './naming.mjs';
import { isBinary } from './refs.mjs';
import { out as makeOut, fail } from './output.mjs';
import { stableStringify, sha256, shaEq } from './util.mjs';
import { assertClientSupports } from './version.mjs';
import { writeReceipts } from './receipt.mjs';
import { goalEntryId, parseGoalId } from './kinds/ai-goal.mjs';

const MASKED = '__masked__';
const SECRET_KEY_RE = /authorization|token|api[-_]?key|secret/i;

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export async function exportPackage(ctx, { output, allowDirty = false } = {}) {
  const pkg = ctx.requirePkg();

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
    // 'marketplace/' holds listing assets (screenshots) uploaded separately to the marketplace —
    // they are not deployable resources, so they stay out of the importable artifact.
    const files = copyTree(pkg.dir, staging, { excludeDirs: ['.uxc', '.git', 'marketplace'], excludeExts: ['.uxpkg'] });
    scrubMcpSecrets(staging);
    scrubLlmSecrets(staging);
    const name = `${pkg.manifest.code}-${pkg.manifest.version ?? '0.0.0'}.uxpkg`;
    const outFile = resolve(output ?? name);
    const { entries, bytes } = await zipDir(staging, outFile);
    return { output: outFile, files, entries, bytes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
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

export async function importPackage(ctx, src, { remap = null, force = false, expectSha256 = null, ignoreClientVersion = false } = {}) {
  const out = ctx.out ?? makeOut(ctx.flags ?? {});
  if (!ctx.clients) ctx.connect?.();
  if (!ctx.clients) fail('importPackage needs a connected target (ctx.connect)');

  // 1. unpack a .uxpkg into a NEW directory next to cwd, or use a package dir in place
  let dir;
  let artifactSha = null;
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
    out.note?.(`artifact sha256 ${artifactSha}${expectSha256 ? '  (verified)' : ''}`);
    const tmp = mkdtempSync(join(tmpdir(), 'uxc-import-'));
    try {
      await unzipTo(src, tmp);
      const root = unpackedRoot(tmp, src);
      const manifest = JSON.parse(readFileSync(join(root, 'uxopian-project.json'), 'utf8'));
      // CLIENT-VERSION GATE: refuse before creating the target dir / writing anything if this uxc is
      // older than the package's declared minimum (the unpack tmp is cleaned by the finally below).
      assertClientSupports(manifest, { ignore: ignoreClientVersion, out, action: 'install' });
      const dirName = remap ? String(remap).split('=')[1] : manifest.code;
      dir = resolve(process.cwd(), dirName);
      if (existsSync(dir)) fail(`import target directory already exists: ${dir}`);
      moveDir(root, dir);
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
  }

  // 2. registry-driven code-remap (experimental: refuses on residuals rather than guessing)
  if (remap) applyCodeRemap(dir, remap, out);

  // 3. open the unpacked package; same clients/target, pkg swapped
  const pkg = openPackage(dir);
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

  // stamp the installation receipts (DESIGN §19) — best-effort, never fails the import
  const receipts = await writeReceipts(ctx2, pkg.manifest, { artifactSha });
  for (const r of receipts) {
    if (r.ok) out.note?.(`receipt ${r.surface}: ${r.receipt.code}@${r.receipt.version}`);
    else out.warn?.(`receipt FAILED on ${r.surface}: ${r.error} (import unaffected — uxc installed --write to retry)`);
  }

  return { dir, pushed, collisions, artifactSha, receipts };
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
