// Package compatibility (DESIGN §26): "what does the NEXT version of a product do to the
// extensions already installed on top of it?" — a pure comparison of SETS, product-agnostic.
// uxc never learns what a family or an identifier means (no package-specific notion lives here):
// a package may ship `compat.json`, and uxc compares its declarations to the receipts.
//
// compat.json (`uxc-compat/1`), all sections optional:
//   {
//     "kind": "uxc-compat/1",
//     "provides": {                       // what THIS package offers others, per family
//       "<family>": { "contract": "v1", "ids": ["a", "b"] | { "a": { "params": ["p", "q"] } } }
//     },
//     "requires": {                       // what THIS package needs from a dependency (by code)
//       "<depCode>": { "versions": ">=1.0", "families": { "<family>": { "contract": "v1", "ids": [...] | {...} } } }
//     },
//     "renames": { "<family>": { "<oldId>": "<newId>" } }   // provided ids renamed since earlier versions
//   }
//
// The manifest field `compat` is a path (default `compat.json`) or the inline object; `mp publish`
// inlines the parsed content into the marketplace-stored manifest. Receipts keep `dependencies`
// and `compat.requires` (tag `UxcCompat`) so the judgement below needs no checkout of the extension.
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipTo } from './zip.mjs';
import { versionSupported } from './version.mjs';

export const COMPAT_KIND = 'uxc-compat/1';
export const COMPAT_FILE = 'compat.json';

/** Normalize `ids` (array of names, or { name: { params } }) -> Map(name -> [params]|null). */
const idMap = (ids) => {
  const m = new Map();
  if (Array.isArray(ids)) for (const id of ids) m.set(String(id), null);
  else if (ids && typeof ids === 'object') {
    for (const [id, v] of Object.entries(ids)) m.set(id, Array.isArray(v?.params) ? v.params.map(String) : null);
  }
  return m;
};

/** Structural problems of a compat object (mp publish refuses on these). -> [string] */
export function validateCompat(c) {
  const errs = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['compat must be a JSON object'];
  if (c.kind !== undefined && c.kind !== COMPAT_KIND) errs.push(`compat.kind must be "${COMPAT_KIND}" (got ${JSON.stringify(c.kind)})`);
  const fam = (where, f, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return errs.push(`${where}.${f} must be an object`);
    if (v.contract !== undefined && typeof v.contract !== 'string') errs.push(`${where}.${f}.contract must be a string`);
    if (v.ids !== undefined && !Array.isArray(v.ids) && (typeof v.ids !== 'object' || v.ids === null)) errs.push(`${where}.${f}.ids must be an array or an object`);
  };
  for (const [f, v] of Object.entries(c.provides ?? {})) fam('provides', f, v);
  for (const [dep, r] of Object.entries(c.requires ?? {})) {
    if (!r || typeof r !== 'object') { errs.push(`requires.${dep} must be an object`); continue; }
    for (const [f, v] of Object.entries(r.families ?? {})) fam(`requires.${dep}.families`, f, v);
  }
  for (const [f, m] of Object.entries(c.renames ?? {})) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) errs.push(`renames.${f} must be an object of oldId -> newId`);
  }
  return errs;
}

function fromDir(dir, manifest) {
  const m = manifest ?? (existsSync(join(dir, 'uxopian-project.json')) ? JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8')) : {});
  if (m.compat && typeof m.compat === 'object') return m.compat;
  const rel = typeof m.compat === 'string' ? m.compat : COMPAT_FILE;
  const file = join(dir, rel);
  if (!existsSync(file)) {
    if (typeof m.compat === 'string') throw new Error(`manifest "compat" points to ${rel}, which does not exist in the package`);
    return null;
  }
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${rel}: invalid JSON (${e.message})`); }
}

/** Read the compat declaration of a package directory or a .uxpkg archive. -> object | null
 *  (null = the package ships none). Throws on a present-but-invalid file. */
export async function readCompat(src) {
  let c;
  if (/\.uxpkg$/i.test(src)) {
    const tmp = mkdtempSync(join(tmpdir(), 'uxc-compat-'));
    try {
      await unzipTo(src, tmp);
      let root = tmp;
      if (!existsSync(join(tmp, 'uxopian-project.json'))) {
        const subs = readdirSync(tmp).filter((n) => statSync(join(tmp, n)).isDirectory());
        if (subs.length === 1) root = join(tmp, subs[0]);
      }
      c = fromDir(root);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } else c = fromDir(resolve(src));
  if (c == null) return null;
  const errs = validateCompat(c);
  if (errs.length) throw new Error(`compat declaration invalid: ${errs.join('; ')}`);
  return c;
}

/** readCompat for receipt stamping: an unreadable/invalid file never blocks a deploy (warn, no compat). */
export async function readCompatLenient(dir, out) {
  try { return await readCompat(dir); }
  catch (e) { out?.warn?.(`compat.json ignored for the receipt: ${e.message}`); return null; }
}

/** The receipt-side view of a manifest (+ its compat): what an installed package depends on. */
export function receiptDeps(manifest, compat) {
  const dependencies = {};
  for (const [code, raw] of Object.entries(manifest?.dependencies ?? {})) {
    const d = raw && typeof raw === 'object' ? raw : { versions: raw };
    const v = d.versions ?? '*';
    dependencies[code] = { versions: Array.isArray(v) ? v : [String(v)], ...(d.slug ? { slug: d.slug } : {}) };
  }
  const requires = compat?.requires && Object.keys(compat.requires).length ? compat.requires : null;
  return { dependencies: Object.keys(dependencies).length ? dependencies : null, requires };
}

const RANK = { holds: 0, review: 1, breaks: 2 };

/**
 * Judge an upgrade. receipts = the target's installed receipts; manifest = the NEW version of the
 * product ({code, version}); compat = its compat declaration (null -> nothing to judge, []);
 * collisions = pre-flight rows for the product's own resources edited on the instance (optional).
 * -> [{ code, version, verdict: 'holds'|'review'|'breaks', reasons: [{level, kind, detail, remedy?}] }]
 *    one row per installed package that depends on manifest.code, sorted by code.
 *    breaks: version outside the declared range, required id absent or renamed (remedy: the new
 *    name), family contract changed. review: params of a required id changed, product row edited
 *    on the instance. holds otherwise.
 */
export function judgeUpgrade(receipts, manifest, compat, { collisions = [] } = {}) {
  if (!compat) return [];
  const product = manifest.code;
  const provides = compat.provides ?? {};
  const renames = compat.renames ?? {};
  const byCode = new Map();
  for (const r of receipts ?? []) {
    if (!r?.code || r.code === product) continue;
    const prev = byCode.get(r.code);
    if (!prev || (!prev.requires && !prev.dependencies && (r.requires || r.dependencies))) byCode.set(r.code, r);
  }
  const rows = [];
  for (const [code, r] of byCode) {
    const dep = r.dependencies?.[product];
    const req = r.requires?.[product];
    if (!dep && !req) continue;
    const reasons = [];
    const add = (level, kind, detail, remedy) => reasons.push({ level, kind, detail, ...(remedy ? { remedy } : {}) });

    const range = req?.versions ?? dep?.versions;
    if (range && !versionSupported(manifest.version, range)) {
      add('breaks', 'version-range', `${code} declares ${product} ${[].concat(range).join(' | ')}, the new version is ${manifest.version}`,
        `install a ${code} version that supports ${product}@${manifest.version}, or stay on the installed ${product}`);
    }
    for (const [fam, need] of Object.entries(req?.families ?? {})) {
      const have = provides[fam];
      if (need.contract && have?.contract && need.contract !== have.contract) {
        add('breaks', 'contract-changed', `family "${fam}": ${code} is built for contract ${need.contract}, ${product}@${manifest.version} provides ${have.contract}`,
          `update ${code} to a version built for ${fam} contract ${have.contract}`);
      }
      const haveIds = idMap(have?.ids);
      for (const [id, params] of idMap(need.ids)) {
        if (!haveIds.has(id)) {
          const to = renames[fam]?.[id];
          if (to) add('breaks', 'renamed', `${fam} "${id}" was renamed to "${to}"`, `use "${to}" in ${code} (${fam} "${id}" -> "${to}")`);
          else add('breaks', 'missing', `${fam} "${id}" is no longer provided by ${product}@${manifest.version}`, `no replacement is declared: stay on the installed ${product}, or ask the ${product} maintainers`);
          continue;
        }
        const provided = haveIds.get(id);
        if (params && provided) {
          const gone = params.filter((p) => !provided.includes(p));
          if (gone.length) add('review', 'params-changed', `${fam} "${id}": parameter(s) ${gone.join(', ')} no longer offered (now: ${provided.join(', ') || 'none'})`,
            `check ${code}'s use of ${fam} "${id}"`);
        }
      }
    }
    if (collisions.length) {
      const shown = collisions.slice(0, 5).map((c) => `${c.kind}/${c.id}`).join(', ');
      add('review', 'product-row-edited', `${collisions.length} ${product} resource(s) edited on the instance would be overwritten: ${shown}${collisions.length > 5 ? ', …' : ''}`,
        'diff them (uxc diff), keep the instance edits deliberately (merge into the package) or accept the overwrite with --force');
    }
    const verdict = reasons.reduce((v, x) => (RANK[x.level] > RANK[v] ? x.level : v), 'holds');
    rows.push({ code, version: r.version, verdict, reasons });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

/** Print the report (human table; --json callers get the rows via out.result). */
export function printUpgradeReport(out, product, version, rows) {
  if (!rows.length) { out.line(`upgrade report ${product}@${version}: no installed package depends on ${product} (nothing to judge)`); return; }
  out.line(`upgrade report ${product}@${version}:`);
  out.table(rows.map((r) => ({ extension: `${r.code}@${r.version}`, verdict: r.verdict, why: r.reasons[0]?.detail ?? '' })),
    [{ key: 'extension' }, { key: 'verdict' }, { key: 'why', max: 100 }]);
  for (const r of rows) {
    for (const x of r.reasons) {
      out.line(`  ${r.code}: ${x.level} (${x.kind}) ${x.detail}`);
      if (x.remedy) out.line(`    remedy: ${x.remedy}`);
    }
  }
}

export const hasBreaks = (rows) => rows.some((r) => r.verdict === 'breaks');
