// Package access: manifest + registry.json (the shared catalog) + .uxc/state.json (per-target sync state).
// registry.json is committed AND exported; .uxc/state.json is committed but NEVER exported.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { stableStringify, nowIso } from './util.mjs';

export const resourceKey = (kind, id) => `${kind}/${id}`;

export function openPackage(dir) {
  const manifestPath = join(dir, 'uxopian-project.json');
  if (!existsSync(manifestPath)) throw new Error(`not a uxopian package: ${dir} (no uxopian-project.json)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const registryPath = join(dir, 'registry.json');
  const statePath = join(dir, '.uxc', 'state.json');
  const registry = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf8'))
    : { resources: [] };
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { targets: {} };

  const pkg = {
    dir, manifest, registry, state,

    saveManifest() { writeFileSync(manifestPath, stableStringify(pkg.manifest)); },
    saveRegistry() {
      pkg.registry.resources.sort((a, b) => resourceKey(a.kind, a.id).localeCompare(resourceKey(b.kind, b.id)));
      writeFileSync(registryPath, stableStringify(pkg.registry));
    },
    saveState() {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, stableStringify(pkg.state));
    },

    // ---- registry entries ----
    entries(kind) {
      return pkg.registry.resources.filter((r) => !kind || r.kind === kind);
    },
    entry(kind, id) {
      return pkg.registry.resources.find((r) => r.kind === kind && r.id === id) ?? null;
    },
    /** Resolve a CLI id argument: 'kind/id' always works; bare id when unique. Deployed handler _vN ids accepted. */
    resolve(arg) {
      if (arg.includes('/')) {
        const i = arg.indexOf('/');
        const e = pkg.entry(arg.slice(0, i), arg.slice(i + 1));
        if (e) return e;
      }
      let hits = pkg.registry.resources.filter((r) => r.id === arg);
      if (!hits.length) {
        const stripped = arg.replace(/_v\d+$/, '');
        hits = pkg.registry.resources.filter((r) => r.id === stripped);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new Error(`ambiguous id "${arg}" — use kind/id: ${hits.map((h) => resourceKey(h.kind, h.id)).join(', ')}`);
      }
      return null;
    },
    addEntry(entry) {
      const ex = pkg.entry(entry.kind, entry.id);
      if (ex) Object.assign(ex, entry);
      else pkg.registry.resources.push(entry);
      pkg.saveRegistry();
      return pkg.entry(entry.kind, entry.id);
    },
    removeEntry(kind, id) {
      pkg.registry.resources = pkg.registry.resources.filter((r) => !(r.kind === kind && r.id === id));
      pkg.saveRegistry();
    },

    // ---- per-target state ----
    targetState(targetName) {
      pkg.state.targets ??= {};
      pkg.state.targets[targetName] ??= { pendingCacheClear: false, fixtures: {}, resources: {} };
      return pkg.state.targets[targetName];
    },
    resState(targetName, kind, id) {
      return pkg.targetState(targetName).resources[resourceKey(kind, id)] ?? null;
    },
    setResState(targetName, kind, id, patch) {
      const ts = pkg.targetState(targetName);
      const key = resourceKey(kind, id);
      ts.resources[key] = patch === null ? undefined : { ...ts.resources[key], ...patch, syncedAt: nowIso() };
      if (patch === null) delete ts.resources[key];
      pkg.saveState();
    },
    setPendingCacheClear(targetName, val) {
      pkg.targetState(targetName).pendingCacheClear = val;
      pkg.saveState();
    },

    // ---- untracked files (like git): files under fd/ ai/ data/ not referenced by any entry ----
    untracked() {
      const referenced = new Set();
      for (const r of pkg.registry.resources) {
        if (!r.path) continue;
        referenced.add(r.path);
        // content-bearing dirs: every file inside counts as referenced
      }
      const out = [];
      for (const root of ['fd', 'ai', 'data']) {
        const abs = join(dir, root);
        if (!existsSync(abs)) continue;
        walk(abs, (file) => {
          const rel = relative(dir, file);
          if (!coveredBy(rel, referenced)) out.push(rel);
        });
      }
      return out;
    },
  };
  return pkg;
}

function coveredBy(rel, referenced) {
  for (const p of referenced) {
    if (rel === p) return true;
    // directory-style resource paths (handlers/scripts/guiconfig dirs) cover their files
    if (rel.startsWith(p.replace(/\/$/, '') + '/')) return true;
    // meta + sibling content files: 'ai/prompts/ctX.json' covers 'ai/prompts/ctX.content.md'
    const stem = p.replace(/\.json$/, '');
    if (rel.startsWith(stem + '.')) return true;
  }
  // shared sources (handler metas' ../shared paths + @include libs) are referenced from other
  // files, not the registry — cover the conventional dirs under both handlers/ and scripts/
  if (/\/(handlers|scripts)\/_?shared\//.test(rel)) return true;
  return false;
}

function walk(d, fn) {
  for (const name of readdirSync(d)) {
    const f = join(d, name);
    if (statSync(f).isDirectory()) walk(f, fn);
    else fn(f);
  }
}
