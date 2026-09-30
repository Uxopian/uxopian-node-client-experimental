// JSON Schemas of the package files (DESIGN §29, #97): what editors (through `$schema`) and
// `uxc verify` check, from the same files — so a typo shows while typing, not mid-push.
//
// The schemas ship with uxc under schemas/ and are read from there (verify never needs a network).
// Their `$id` — also the value scaffolds write as `$schema` — is the raw GitHub URL of the file on
// main: stable, the same on every machine, resolvable by an editor that fetches schemas, and never a
// path into one person's checkout. `$schema` is an editor hint only: canonicalize() strips it (no hash
// change), push never sends it, and writeLocal keeps it when it rewrites a meta file.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from './util.mjs';
import { validateSchema } from './jsonschema.mjs';

export const SCHEMA_BASE = 'https://raw.githubusercontent.com/Uxopian/uxopian-node-client-experimental/main/schemas/';
export const SCHEMA_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));

/** Schema of each package file, by name (schemas/<name>.schema.json). */
export const SCHEMA_NAMES = {
  manifest: 'uxopian-project',
  registry: 'registry',
  marketplace: 'marketplace',
  compat: 'compat',
};
/** Kinds whose per-resource JSON file has a schema -> schema name. */
export const KIND_SCHEMAS = {
  'fd.script': 'fd.script.meta',
  'fd.guiconfig': 'fd.guiconfig.meta',
  'fd.handler': 'fd.handler.meta',
  'fd.tagclass-delta': 'tagclass-delta',
};

/** The `$id` (= the `$schema` a scaffold writes) of a schema name. */
export const schemaUrl = (name) => `${SCHEMA_BASE}${name}.schema.json`;

let cache = null;
/** Map name -> schema and $id -> schema, read once from schemas/. */
export function loadSchemas() {
  if (cache) return cache;
  const byName = new Map();
  const byId = new Map();
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.schema.json')).sort()) {
    const s = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
    byName.set(f.replace(/\.schema\.json$/, ''), s);
    if (s.$id) byId.set(s.$id, s);
  }
  cache = { byName, byId };
  return cache;
}

/** Validate a value against a named schema -> [{path, message, keyword, severity}]. */
export function validateAgainst(name, value) {
  const { byName, byId } = loadSchemas();
  const schema = byName.get(name);
  if (!schema) throw new Error(`no schema named "${name}" in ${SCHEMA_DIR}`);
  return validateSchema(schema, value, { registry: byId });
}

/** The schema name of a meta file for this kind, or null. */
export const schemaForKind = (kind) => KIND_SCHEMAS[kind] ?? null;

/** Absolute path of the schema-covered JSON file of a registry entry, or null. */
function entryFile(pkg, entry) {
  if (!entry.path || !schemaForKind(entry.kind)) return null;
  return entry.kind === 'fd.tagclass-delta' ? join(pkg.dir, entry.path) : join(pkg.dir, entry.path, 'meta.json');
}

/**
 * Validate the package files against the schemas. PURE apart from reading files; offline.
 * -> [{ file, path, message, severity: 'error'|'warning', where }] where `where` = "file: path".
 * An 'error' is only reported where uxc already refuses the same input (DESIGN §29); everything
 * else is a warning, so a package that pushes today never fails verify because of a schema.
 * Files that do not parse are skipped: the adapters and openPackage report those already.
 */
export function lintSchemas(pkg) {
  const out = [];
  const run = (file, name, value) => {
    for (const f of validateAgainst(name, value)) {
      out.push({ file, path: f.path, message: f.message, severity: f.severity, where: `${file}: ${f.path}` });
    }
  };
  const readJson = (abs) => { try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return undefined; } };

  const manifest = readJson(join(pkg.dir, 'uxopian-project.json'));
  if (manifest !== undefined) run('uxopian-project.json', SCHEMA_NAMES.manifest, manifest);
  const registryPath = join(pkg.dir, 'registry.json');
  if (existsSync(registryPath)) {
    const reg = readJson(registryPath);
    if (reg !== undefined) run('registry.json', SCHEMA_NAMES.registry, reg);
  }
  const mpPath = join(pkg.dir, 'marketplace.json');
  if (existsSync(mpPath)) {
    const mp = readJson(mpPath);
    if (mp !== undefined) run('marketplace.json', SCHEMA_NAMES.marketplace, mp);
  }
  // compat: a path (default compat.json); an inline object is covered by the manifest schema
  const compatRel = typeof manifest?.compat === 'string' ? manifest.compat
    : manifest?.compat && typeof manifest.compat === 'object' ? null : 'compat.json';
  if (compatRel && existsSync(join(pkg.dir, compatRel))) {
    const c = readJson(join(pkg.dir, compatRel));
    if (c !== undefined) run(compatRel, SCHEMA_NAMES.compat, c);
  }
  for (const e of pkg.entries()) {
    if (e.retired) continue;
    const abs = entryFile(pkg, e);
    if (!abs || !existsSync(abs)) continue; // a missing file is the adapter's finding
    const v = readJson(abs);
    if (v === undefined) continue;
    const rel = e.kind === 'fd.tagclass-delta' ? e.path : `${e.path}/meta.json`;
    run(rel, schemaForKind(e.kind), v);
  }
  return out;
}

/**
 * Add `"$schema": <url of name>` to a JSON file a scaffold just wrote (no-op when the file already
 * names one, or is not a JSON object). Keys stay sorted, as every uxc writer leaves them.
 */
export function stampSchema(absPath, name) {
  if (!existsSync(absPath)) return false;
  let obj;
  try { obj = JSON.parse(readFileSync(absPath, 'utf8')); } catch { return false; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.$schema !== undefined) return false;
  writeFileSync(absPath, stableStringify({ $schema: schemaUrl(name), ...obj }));
  return true;
}

/** `$schema` of the JSON object at absPath, when there is one — writeLocal keeps it across rewrites. */
export function schemaKeyOf(absPath) {
  if (!existsSync(absPath)) return undefined;
  try {
    const o = JSON.parse(readFileSync(absPath, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) && typeof o.$schema === 'string' ? o.$schema : undefined;
  } catch { return undefined; }
}

/** obj + the `$schema` the file on disk carries (canonical writers drop it; the editor hint must survive a pull). */
export function keepSchemaKey(absPath, obj) {
  const s = schemaKeyOf(absPath);
  if (s === undefined || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return { $schema: s, ...obj };
}
