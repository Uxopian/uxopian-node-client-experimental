// Package dependencies v1 — CHECK-AND-GUIDE (DESIGN §22, #46): a package declares what must
// already be installed on the target; deploys REFUSE with the exact ordered fix-it commands when
// a dependency is missing or too old. Deliberately simple and applied:
//   - keys are PACKAGE CODES (receipts are code-keyed — works offline, air-gapped, marketplace-less);
//   - `slug` is only the marketplace hint used in the fix-it command;
//   - the installed-ledger IS the receipts (DESIGN §19) — no lockfiles, no registry database;
//   - NO transitive resolution: each install checks ITS OWN deps, so a chain
//     (contract-management -> uxoai-flowerdocs -> uxopian-ai-default-providers-set) resolves
//     naturally, one guided install at a time;
//   - version constraints reuse the supportedVersions pattern language ('*', '1.1.*', '>=1.1', exact).
//
// Manifest block:
//   "dependencies": {
//     "uxoai": { "versions": ">=1.1", "slug": "uxoai-flowerdocs" },
//     "llm":   "*"                                  // shorthand: pattern string only
//   }
//
// v2 (NOT here): --with-deps auto-install — must aggregate per-dependency VARIABLE tables (#44)
// into one refusal; decide namespacing (--var dep.name=…) in its own session.
import { versionSupported } from './version.mjs';
import { readReceipts } from './receipt.mjs';
import { compareSemver } from './version.mjs';

/** Normalize manifest.dependencies -> [{ code, versions: [patterns], slug|null }] (declaration order). */
export function declaredDependencies(manifest) {
  const out = [];
  for (const [code, raw] of Object.entries(manifest?.dependencies ?? {})) {
    const d = raw && typeof raw === 'object' ? raw : { versions: raw };
    const v = d.versions ?? '*';
    out.push({ code, versions: Array.isArray(v) ? v : [String(v)], slug: d.slug ?? null });
  }
  return out;
}

/** The installed version of a package code, from the receipts. Surfaces can disagree after a
 *  partial deploy — the HIGHEST version wins, with a note. -> { version|null, note? } */
export function installedVersionOf(receipts, code) {
  const mine = receipts.filter((r) => r.code === code && r.version && r.version !== '?');
  if (!mine.length) return { version: null };
  const versions = [...new Set(mine.map((r) => r.version))];
  versions.sort((a, b) => compareSemver(b, a));
  return {
    version: versions[0],
    ...(versions.length > 1 ? { note: `surfaces disagree (${versions.join(' vs ')}) — a partial deploy; re-run the dependency's install` } : {}),
  };
}

/**
 * Check a manifest's dependencies against the target's receipts.
 * -> [{ code, versions, slug, installed, ok, why }] in declaration order.
 */
export async function checkDependencies(ctx, manifest) {
  const deps = declaredDependencies(manifest);
  if (!deps.length) return [];
  let receipts = [];
  try { receipts = await readReceipts(ctx, {}); } catch { receipts = []; }
  return deps.map((d) => {
    if (d.code === manifest.code) return { ...d, installed: null, ok: true, why: 'self-reference ignored' };
    const { version, note } = installedVersionOf(receipts, d.code);
    if (!version) return { ...d, installed: null, ok: false, why: 'NOT INSTALLED' };
    const ok = versionSupported(version, d.versions);
    return { ...d, installed: version, ok, why: ok ? (note ?? 'ok') : `installed ${version} does not satisfy ${JSON.stringify(d.versions)}${note ? ` (${note})` : ''}` };
  });
}

/** The ordered fix-it command for one unmet dependency. */
export function fixCommand(dep, targetName) {
  const slug = dep.slug ?? dep.code;
  return `uxc mp install ${slug}${targetName ? ` --target ${targetName}` : ''}   (variables? uxc vars ${slug})`;
}

/**
 * Deploy gate: REFUSE (with the ordered fix-it recipe) when dependencies are unmet.
 * `ignore` (--ignore-dependencies) downgrades to a loud warning. Returns the check rows.
 */
export async function assertDependencies(ctx, manifest, { ignore = false, out, action = 'deploy' } = {}) {
  const rows = await checkDependencies(ctx, manifest);
  const unmet = rows.filter((r) => !r.ok);
  if (!unmet.length) {
    const met = rows.filter((r) => r.installed);
    if (met.length) out?.note?.(`dependencies ok: ${met.map((r) => `${r.code}@${r.installed}`).join(', ')}`);
    return rows;
  }
  const lines = unmet.map((r) =>
    `  ${r.code}: requires ${r.versions.join(' | ')} — ${r.installed ? `installed ${r.installed} (too old)` : 'NOT INSTALLED'}\n    fix: ${fixCommand(r, ctx.target?.name)}`);
  const msg =
    `unmet package dependencies on ${ctx.target?.name ?? 'the target'}:\n${lines.join('\n')}\n` +
    `install them in the order listed, then re-run this ${action}.\n` +
    `NOT INSTALLED can be a false negative: dependencies are checked against installation RECEIPTS — ` +
    `something configured manually (or installed pre-receipts) has none. If you verify it is present, ` +
    `stamp it (uxc installed --write, from its package checkout) or use --ignore-dependencies.`;
  if (ignore) {
    out?.warn?.(`${msg}\n  ↳ OVERRIDDEN by --ignore-dependencies — the ${action} may not work until they are installed.`);
    return rows;
  }
  const e = new Error(msg);
  e.explanation = 'dependencies are checked against the target\'s installation receipts (uxc installed); --ignore-dependencies overrides (unsafe).';
  throw e;
}
