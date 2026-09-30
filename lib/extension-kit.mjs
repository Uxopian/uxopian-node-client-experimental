// The partner kit behind `uxc init --extension` (DESIGN §26). Generic by construction:
//   - a depended-on package that wants integrators to extend it SHIPS an `extension-kit/` directory
//     (its own manifest may relocate it: "extensionKit": "path") — uxc renders it, never knows it;
//   - without a kit (no --product-dir, or the dependency ships none) uxc falls back to its built-in
//     generic kit: one example per generic resource kind (`script`, `prompt`, `dataset`), each with
//     a self-contained offline test.
//
// kit.json (format "uxc-extension-kit/1"):
//   {
//     "format": "uxc-extension-kit/1",
//     "manifest": { "extension": {…}, "registrationOrderBands": {…}, … },   // deep-merged into the new manifest
//     "claude": "extra lines for the generated CLAUDE.md",                   // optional
//     "examples": {
//       "<kind>": { "summary": "…",
//                   "files": { "<dest path>": "<kit-relative source>" },     // dest AND content rendered
//                   "registry": [ { "kind": "fd.script", "id": "{{kebab}}lib", "path": "fd/scripts/{{kebab}}lib" } ],
//                   "dataSets": [ { "name": "{{pascal}}Extras", "classId": "…", "path": "data/{{pascal}}Extras.jsonl" } ] }
//     }
//   }
// Placeholders (text files only): {{code}} {{pascal}} {{camel}} {{kebab}} {{upper}} {{name}}
//   {{dep.code}} {{dep.slug}} {{dep.range}} {{dep.version}}. An unknown placeholder is an error, never
//   a silent blank. Tests the kit ships go under tests/*.test.mjs (that is where `uxc test` looks).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, sep } from 'node:path';
import { prefixForms, conventionalId } from './naming.mjs';
import { RANGE_RE } from './extension.mjs';
import { openPackage } from './registry.mjs';
import { KINDS } from './kinds/index.mjs';
import { fail } from './output.mjs';

export const KIT_FORMAT = 'uxc-extension-kit/1';
export const DEFAULT_KIT_DIR = 'extension-kit';
export const GENERIC_KINDS = ['script', 'prompt', 'dataset'];
export const DEFAULT_EXTENSION_BANDS = { 'fd.script': [950, 959] };

/** `case-management@>=0.3` -> { slug, range }. The range grammar is the dependency one. */
export function parseDependsOn(value) {
  if (typeof value !== 'string' || !value.includes('@')) fail('--depends-on takes <slug>@<range>, e.g. --depends-on case-management@">=0.3"');
  const at = value.indexOf('@');
  const slug = value.slice(0, at).trim();
  const range = value.slice(at + 1).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`--depends-on: slug "${slug}" must be lowercase letters, digits and dashes`);
  if (!RANGE_RE.test(range)) fail(`--depends-on: range "${range}" is not valid ('*', '1.1.*', '>=1.1', or exact)`);
  return { slug, range };
}

export function renderText(text, vars, where = 'kit') {
  return String(text).replace(/\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g, (_, k) => {
    if (!(k in vars)) fail(`${where}: unknown placeholder {{${k}}} — known: ${Object.keys(vars).join(', ')}`);
    return vars[k];
  });
}

/** Render every string of a parsed JSON value — keys included — so a placeholder value is data,
 *  never JSON text (a name with a quote neither crashes nor injects keys). */
export function renderDeep(value, vars, where = 'kit') {
  if (typeof value === 'string') return renderText(value, vars, where);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars, where));
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [renderText(k, vars, where), renderDeep(v, vars, where)]));
  }
  return value;
}

// Windows refuses these in a file name, and a trailing dot or space is silently dropped
const WIN_BAD = /[<>:"|?*\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** A rendered kit path (after placeholders): relative, inside the package, portable to Windows. */
export function safeRelPath(p, where) {
  const segs = String(p).split(/[\\/]/);
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || segs.includes('..')) fail(`${where}: "${p}" must be a relative path inside the package`);
  for (const s of segs.filter((x) => x && x !== '.')) {
    if (WIN_BAD.test(s) || /[. ]$/.test(s) || WIN_RESERVED.test(s)) {
      fail(`${where}: "${p}" is not a portable file name — "${s}" has one of <>:"|?* or ends with a dot or space (or is a reserved Windows name); a placeholder like {{name}} or {{dep.range}} cannot be used in a path`);
    }
  }
  return p;
}

export function templateVars({ code, name, dep }) {
  const f = prefixForms(code);
  return {
    code, name, pascal: f.pascal, camel: f.camel, kebab: f.kebab, upper: f.upper,
    'dep.code': dep.code, 'dep.slug': dep.slug, 'dep.range': dep.range, 'dep.version': dep.version ?? '',
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** The kit a product directory ships, or null. Refuses a kit that escapes its directory. */
export function loadKit(productDir) {
  if (!productDir) return null;
  const root = resolve(productDir);
  const mpath = join(root, 'uxopian-project.json');
  if (!existsSync(mpath)) fail(`--product-dir ${root}: no uxopian-project.json — point it at the depended-on package's checkout or unpacked .uxpkg`);
  const productManifest = JSON.parse(readFileSync(mpath, 'utf8'));
  const kitDir = resolve(root, productManifest.extensionKit ?? DEFAULT_KIT_DIR);
  if (kitDir !== root && !kitDir.startsWith(root + sep)) fail(`${mpath}: "extensionKit" must stay inside the package`);
  const kpath = join(kitDir, 'kit.json');
  if (!existsSync(kpath)) return { productManifest, kit: null, kitDir };
  const kit = JSON.parse(readFileSync(kpath, 'utf8'));
  if (kit.format !== KIT_FORMAT) fail(`${kpath}: format must be "${KIT_FORMAT}" (found ${JSON.stringify(kit.format ?? null)})`);
  if (!isObj(kit.examples) || !Object.keys(kit.examples).length) fail(`${kpath}: "examples" must name at least one extension kind`);
  return { productManifest, kit, kitDir };
}

// ------------------------------------------------------------------ kit rendering

/** Write the selected kit examples into `dir`; returns { created, registry, dataSets, kinds }. */
export function renderKit({ kit, kitDir, dir, vars, kinds }) {
  const all = Object.keys(kit.examples);
  const selected = kinds ?? all;
  for (const k of selected) if (!kit.examples[k]) fail(`--kinds: "${k}" is not an extension kind of this kit — available: ${all.join(', ')}`);
  const created = [], registry = [], dataSets = [];
  for (const k of selected) {
    const ex = kit.examples[k];
    for (const [destT, srcRel] of Object.entries(ex.files ?? {})) {
      const src = resolve(kitDir, srcRel);
      if (!src.startsWith(kitDir + sep) || isAbsolute(srcRel)) fail(`kit example ${k}: source "${srcRel}" must stay inside the kit`);
      if (!existsSync(src)) fail(`kit example ${k}: source "${srcRel}" is missing`);
      const dest = safeRelPath(renderText(destT, vars, `kit example ${k} destination`), `kit example ${k}: destination`);
      const p = join(dir, dest);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, renderText(readFileSync(src, 'utf8'), vars, `kit example ${k} file ${srcRel}`));
      created.push(dest);
    }
    for (const r of ex.registry ?? []) {
      const path = safeRelPath(renderText(r.path, vars), `kit example ${k}: registry path`);
      registry.push({ ...r, kind: r.kind, id: renderText(r.id, vars), path, ...(r.title ? { title: renderText(r.title, vars) } : {}) });
    }
    for (const d of ex.dataSets ?? []) {
      const name = renderText(d.name, vars);
      const path = safeRelPath(d.path != null ? renderText(d.path, vars) : `data/${name}.jsonl`, `kit example ${k}: dataSet path`);
      dataSets.push({ ...d, name, path, content: d.content ?? false });
    }
  }
  return { created, registry, dataSets, kinds: selected };
}

// ------------------------------------------------------------------ built-in generic kit

/** Self-contained offline test: no import from uxc, so it runs wherever `uxc test --offline` runs. */
function genericTest({ kind, vars, extra }) {
  const cfg = { code: vars.code, upper: vars.upper, kebab: vars.kebab, pascal: vars.pascal, camel: vars.camel, depCode: vars['dep.code'] };
  return `// ${kind} example — offline, no server. Generated by \`uxc init --extension\`; keep it green.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const C = ${JSON.stringify(cfg)};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const depHas = (id) => id.startsWith(C.depCode.toUpperCase() + '_') || id.toLowerCase().startsWith(C.depCode + '-')
  || (id.startsWith(cap(C.depCode)) && /^[A-Z0-9_]/.test(id.slice(C.depCode.length)))
  || (id.startsWith(C.depCode) && /^[A-Z0-9_]/.test(id.slice(C.depCode.length)));
const mine = (id) => id.startsWith(C.upper) || id.toLowerCase().startsWith(C.kebab)
  || (id.startsWith(C.pascal) && /^[A-Z0-9_]/.test(id.slice(C.pascal.length)))
  || (id.startsWith(C.camel) && /^[A-Z0-9_]/.test(id.slice(C.camel.length)));

export default {
  name: '${kind} example',
  description: 'the ${kind} example is registered, under this package\\'s prefix, and well formed',
  offline: true,
  async run(t) {
    const res = t.pkg.resources.filter((r) => r.kind === ${JSON.stringify(extra.resKind)});
    t.expect(res.length >= 1, 'no ${extra.resKind} resource registered');
    for (const r of res) {
      t.expect(mine(r.id), r.id + ' must carry one of this package\\'s prefixes');
      t.expect(!depHas(r.id) || mine(r.id), r.id + ' sits in the dependency\\'s namespace');
    }
${extra.body}
  },
};
`;
}

const BODY = {
  script: `    for (const r of res) {
      const meta = JSON.parse(readFileSync(join(t.pkg.dir, r.path, 'meta.json'), 'utf8'));
      const file = join(t.pkg.dir, r.path, meta.contentFile ?? r.id + '.js');
      t.expect(existsSync(file), r.id + ': content file missing');
      try { new Function(readFileSync(file, 'utf8')); } catch (e) { t.fail(r.id + ': does not parse — ' + e.message); }
    }`,
  prompt: `    for (const r of res) {
      const meta = JSON.parse(readFileSync(join(t.pkg.dir, r.path), 'utf8'));
      t.expect(meta.id === r.id, r.id + ': meta id mismatch');
      t.expect(existsSync(join(t.pkg.dir, r.path.replace(/\\.json$/, '.content.md'))), r.id + ': content file missing');
    }`,
  dataset: `    const sets = t.pkg.manifest.dataSets ?? [];
    t.expect(sets.length >= 1, 'no dataset declared in the manifest');
    const classes = new Set(t.pkg.resources.filter((r) => r.kind === 'fd.documentclass').map((r) => r.id));
    for (const ds of sets) {
      t.expect(mine(ds.name), 'dataset ' + ds.name + ' must carry this package\\'s prefix');
      t.expect(classes.has(ds.classId), 'dataset ' + ds.name + ': class ' + ds.classId + ' is not registered in this package');
      const rows = readFileSync(join(t.pkg.dir, ds.path), 'utf8').split(/\\n/).filter(Boolean).map((l) => JSON.parse(l));
      t.expect(rows.length >= 1, ds.name + ': no example row');
      for (const row of rows) t.expect(mine(row.id), 'row ' + row.id + ' must carry this package\\'s upper prefix (' + C.upper + ')');
    }`,
};
const RES_KIND = { script: 'fd.script', prompt: 'ai.prompt', dataset: 'fd.dataset' };
const TEST_FILE = { script: '10-script.test.mjs', prompt: '20-prompt.test.mjs', dataset: '30-dataset.test.mjs' };

/** Scaffold the generic examples through the kind adapters (templates ARE the mechanics). */
export function scaffoldGeneric({ dir, vars, kinds }) {
  const selected = kinds ?? GENERIC_KINDS;
  for (const k of selected) if (!GENERIC_KINDS.includes(k)) fail(`--kinds: "${k}" is not a generic extension kind — available: ${GENERIC_KINDS.join(', ')} (a depended-on package can ship its own kit: --product-dir)`);
  const pkg = openPackage(dir);
  const ctx = { pkg };
  const created = [];
  const register = (kind, id, flags = {}) => {
    const adapter = KINDS[kind];
    const local = adapter.template(ctx, id, flags);
    const path = adapter.pathFor ? adapter.pathFor(pkg, id) : adapter.layout === 'dir' ? `${adapter.dir}/${id}` : `${adapter.dir}/${id}.json`;
    const entry = pkg.addEntry({ kind, id, title: local.obj?.name ?? id, path, policy: adapter.defaultPolicy });
    return { adapter, local, entry };
  };

  if (selected.includes('script')) {
    const id = conventionalId('fd.script', pkg.manifest, 'example');
    const { adapter, local, entry } = register('fd.script', id, { order: pkg.manifest.registrationOrderBands?.['fd.script']?.[0] ?? 950 });
    adapter.writeLocal(pkg, entry, local);
    created.push(`${entry.path}/meta.json`, `${entry.path}/${Object.keys(local.contents)[0]}`);
  }
  if (selected.includes('prompt')) {
    const id = conventionalId('ai.prompt', pkg.manifest, 'example');
    const { adapter, local, entry } = register('ai.prompt', id);
    local.obj.content = `Reply with OK. (Example prompt of ${vars.name}; replace it.)`;
    adapter.writeLocal(pkg, entry, local);
    created.push(entry.path, entry.path.replace(/\.json$/, '.content.md'));
  }
  if (selected.includes('dataset')) {
    const classId = `${vars.pascal}Example`;
    const dc = register('fd.documentclass', classId, { title: classId });
    dc.adapter.writeLocal(pkg, dc.entry, dc.local);
    created.push(dc.entry.path);
    const dsName = `${vars.pascal}Examples`;
    pkg.manifest.dataSets = [...(pkg.manifest.dataSets ?? []), { name: dsName, classId, path: `data/${dsName}.jsonl`, content: false }];
    pkg.saveManifest();
    const ds = register('fd.dataset', dsName, { class: classId });
    const rowId = `${vars.upper}EXAMPLE`;
    const row = { category: 'DOCUMENT', data: { ACL: 'acl-readonly', classId }, id: rowId, name: rowId };
    ds.adapter.writeLocal(pkg, ds.entry, { contents: { [`${dsName}.jsonl`]: Buffer.from(JSON.stringify(row) + '\n') } });
    created.push(ds.entry.path);
  }
  pkg.saveRegistry();

  for (const k of selected) {
    const rel = join('tests', TEST_FILE[k]);
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, rel), genericTest({ kind: k, vars, extra: { resKind: RES_KIND[k], body: BODY[k] } }));
    created.push(rel);
  }
  return { created, kinds: selected };
}
