// Extension packages (DESIGN §27): a package that EXTENDS another (declares it in `dependencies`)
// may only create ids under its OWN prefixes, and never under the dependency's. Pure, offline,
// generic: uxc knows prefix forms and manifests, never what the depended-on package is.
//
//   lintExtension(pkg) -> [{ code, where, message }]
//
// Two tiers, so an existing package that merely depends on another is never broken by a rule it
// did not opt into:
//   - ALWAYS (any declared dependency): EXT_PRODUCT_RESOURCE, EXT_PRODUCT_ROW
//     — "you are writing into someone else's namespace".
//   - OPT-IN (manifest `"extension": {…}`, written by `uxc init --extension`): EXT_PRODUCT_CODE,
//     EXT_NO_DEPENDENCY, EXT_FOREIGN_RESOURCE, EXT_ROW_PREFIX, EXT_ROW_KEY, EXT_LIBRARY — "everything
//     you own is yours". EXT_PRODUCT_CODE is opt-in because a package listing its OWN code under
//     `dependencies` is a tolerated self-reference (dependencies.mjs ignores it).
//
// Both tiers also carry the tag-class delta lint (lintTagDeltas, DESIGN §28: EXT_TAG_VALUE_PREFIX,
// EXT_TAG_CLASS_UNKNOWN, EXT_TAG_DELTA_OWN, EXT_TAG_LEGACY), so a partner package gets every EXT_*
// check in one pass, `mp publish` included. A caller that ALSO runs lintTagDeltas (verify) dedupes
// with findingKey (code + id).
//
// The optional `extension` block (all keys optional; a kit or the integrator fills them):
//   "extension": {
//     "of": "cm",                                   // the depended-on package code (informational)
//     "rowKeyTags": { "<classId>": ["KeyTag", …] }, // rows of that class carry a logical key in these
//                                                   // tags; its last segment (split on . / : > |)
//                                                   // must start with the package's UPPER prefix
//     "library": { "classId": "XServerLibrary",     // a server-only fd.script (registrationOrder null)
//                  "endMarker": "var LIB_FIN = '{id}';" }   // must have this class and end with this line
//   }
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prefixForms, conventionalId } from './naming.mjs';
import { declaredDependencies } from './dependencies.mjs';
import { lintTagDeltas } from './tagdelta.mjs';


// kinds whose ids are not package-prefixed by convention (global provider ids, routing names)
const SKIP_KINDS = new Set(['ai.llm', 'ai.goal', 'fd.surfacing']);
/** Does `id` carry one of the code's prefix forms? Strict: the character after a pascal/camel prefix
 *  must start a new word, so "Cmd" / "cmdFoo" are not "Cm" / "cm" ids. */
export function carriesPrefix(code, id) {
  return carriesForms(prefixForms(code), id);
}
/** carriesPrefix over explicit forms — the package's own side honors a custom manifest.idPrefixes. */
export function carriesForms(f, id) {
  return id.startsWith(f.upper) || id.toLowerCase().startsWith(f.kebab)
    || (id.startsWith(f.pascal) && /^[A-Z0-9_]/.test(id.slice(f.pascal.length)))
    || (id.startsWith(f.camel) && /^[A-Z0-9_]/.test(id.slice(f.camel.length)));
}

/** The id a tag-delta finding is about: its own `id`/`where` when the lint gives one, else the
 *  "<CODE> <id>: …" head of its message (the lintTagDeltas message form). */
function tagDeltaId(d) {
  if (d.id) return String(d.id);
  if (d.where) return String(d.where).replace(/^fd\.tagclass-delta\//, '');
  const m = String(d.message ?? '').slice(String(d.code).length).match(/^\s*([^:\s]+)\s*:/);
  return m ? m[1] : '';
}
/** Dedupe key of a finding (lintExtension's, or a raw lintTagDeltas one): code + offending id. */
export function findingKey(f) {
  const id = f.where ? String(f.where).replace(/^fd\.tagclass-delta\//, '') : tagDeltaId(f);
  return `${f.code}|${id}`;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const KEY_SPLIT = /[.:/>|]/;

function readRows(pkg, ds) {
  const p = join(pkg.dir, ds.path ?? `data/${ds.name}.jsonl`);
  if (!existsSync(p)) return [];
  const rows = [];
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* the kind's own validate reports bad JSON */ }
  }
  return rows;
}

const tagValues = (row, name) => (row.tags ?? []).filter((t) => t.name === name)
  .flatMap((t) => (Array.isArray(t.value) ? t.value : [t.value ?? t.values]).flat().filter((v) => v != null).map(String));

/** The ids a package owns are conventionalId-stable: re-forming the id under OUR prefix is a no-op. */
const ownedId = (manifest, kind, id) => {
  try { return conventionalId(kind, manifest, id) === id; } catch { return true; }
};

export function lintExtension(pkg) {
  const m = pkg.manifest ?? {};
  const findings = [];
  const add = (code, where, message) => findings.push({ code, where, message: `${code}: ${message}` });

  const allDeps = declaredDependencies(m);
  const deps = allDeps.filter((d) => d.code !== m.code);
  const ext = m.extension && typeof m.extension === 'object' ? m.extension : null;
  if (!allDeps.length && !ext) return findings;

  if (ext && allDeps.some((d) => d.code === m.code)) {
    add('EXT_PRODUCT_CODE', 'uxopian-project.json', `the package code "${m.code}" is the code of a dependency — an extension needs its own code (its own id prefixes)`);
  }
  if (ext && !deps.length) {
    add('EXT_NO_DEPENDENCY', 'uxopian-project.json', 'the manifest declares "extension" but no dependency — say what this package extends: "dependencies": { "<code>": { "versions": ">=1.0", "slug": "<marketplace slug>" } }');
  }
  const depHit = (id) => deps.find((d) => carriesPrefix(d.code, id));
  const own = { ...prefixForms(m.code), ...(isObj(m.idPrefixes) ? m.idPrefixes : {}) };
  const ownList = Object.values(own).join(', ');

  // ---- resources ----
  for (const e of pkg.entries().filter((x) => !x.retired && x.policy !== 'external' && !SKIP_KINDS.has(x.kind))) {
    if (ownedId(m, e.kind, e.id)) continue;
    const dep = depHit(e.id);
    const where = `${e.kind}/${e.id}`;
    if (dep) {
      add('EXT_PRODUCT_RESOURCE', where, `${where} carries the prefix of dependency "${dep.code}" — an extension never ships a resource in the depended-on package's namespace; rename it under ${own.pascal}/${own.camel}/${own.kebab}/${own.upper} or register it as policy "external" if you only reference it`);
    } else if (ext) {
      add('EXT_FOREIGN_RESOURCE', where, `${where} is outside this package's prefixes (${ownList}) — an extension may only create ids under its own prefix`);
    }
  }

  // ---- dataset rows ----
  const upper = own.upper;
  for (const ds of m.dataSets ?? []) {
    const entry = pkg.entry?.('fd.dataset', ds.name);
    if (entry && (entry.retired || entry.policy === 'external')) continue;
    for (const row of readRows(pkg, ds)) {
      const id = String(row._deleted ? row._id : row.id ?? '');
      if (!id) continue;
      if (!carriesForms(own, id)) {
        const dep = depHit(id);
        if (dep) add('EXT_PRODUCT_ROW', `${ds.name}/${id}`, `row ${id} of dataset ${ds.name} carries the prefix of dependency "${dep.code}" — an extension never ships a row in the depended-on package's namespace`);
        else if (ext) add('EXT_ROW_PREFIX', `${ds.name}/${id}`, `row ${id} of dataset ${ds.name} is outside this package's prefixes (${ownList})`);
      }
      const keyTags = ext?.rowKeyTags?.[ds.classId] ?? ext?.rowKeyTags?.['*'] ?? [];
      if (row._deleted) continue;
      for (const tag of keyTags) {
        for (const v of tagValues(row, tag)) {
          const last = v.split(KEY_SPLIT).filter(Boolean).pop() ?? v;
          if (!last.startsWith(upper)) add('EXT_ROW_KEY', `${ds.name}/${id}`, `row ${id} of dataset ${ds.name}: ${tag}="${v}" — its last segment "${last}" must start with ${upper} (the package's upper prefix), or it could shadow a dependency's row`);
        }
      }
    }
  }

  // ---- server libraries ----
  const lib = ext?.library;
  if (lib) {
    for (const e of pkg.entries('fd.script').filter((x) => !x.retired && x.policy !== 'external')) {
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(pkg.dir, e.path, 'meta.json'), 'utf8')); } catch { continue; }
      if (meta.registrationOrder != null) continue; // a browser script, not a server library
      if (lib.classId && meta.classId !== lib.classId) {
        add('EXT_LIBRARY', `fd.script/${e.id}`, `server library ${e.id} must have "classId": "${lib.classId}" (found ${JSON.stringify(meta.classId ?? null)})`);
      }
      if (lib.endMarker) {
        const file = join(pkg.dir, e.path, meta.contentFile ?? `${e.id}.js`);
        const want = String(lib.endMarker).replaceAll('{id}', e.id);
        const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
        if (lines[lines.length - 1] !== want) {
          add('EXT_LIBRARY', `fd.script/${e.id}`, `server library ${e.id} must end with the line \`${want}\` — the loader demands the last statement; a truncated upload would otherwise load silently`);
        }
      }
    }
  }

  // ---- tag-class deltas (DESIGN §28): the same pass, so `mp publish` and push refuse them too ----
  for (const d of lintTagDeltas(pkg)) findings.push({ code: d.code, where: `fd.tagclass-delta/${tagDeltaId(d)}`, message: d.message });
  return findings;
}
