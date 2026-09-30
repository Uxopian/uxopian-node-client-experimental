// Tag-class deltas (DESIGN §28): an EXTENSION package adds values to a CHOICELIST tag class it does
// not own (a product's CmTaskType, CmEmailSituation, …). Everything here is PURE — no network, no
// filesystem but the offline lint — so the product's own `fusionnerDelta` (Case Management
// outils/extension/verifier.mjs) and the kind `fd.tagclass-delta` share ONE merge.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prefixForms } from './naming.mjs';

export const EXT_TAG_VALUE_PREFIX = 'EXT_TAG_VALUE_PREFIX';
export const EXT_TAG_CLASS_UNKNOWN = 'EXT_TAG_CLASS_UNKNOWN';
export const EXT_TAG_DELTA_OWN = 'EXT_TAG_DELTA_OWN';

const nameOf = (v) => (v && typeof v === 'object' ? v.symbolicName : undefined);
const clone = (v) => JSON.parse(JSON.stringify(v));
/** Plain code-unit order (never localeCompare: the slice hash must not depend on the host's ICU). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** [{language, value}] -> comparable string (language-insensitive case, order-insensitive). */
const labelKey = (dns) => JSON.stringify(
  (Array.isArray(dns) ? dns : [])
    .map((d) => [String(d?.language ?? '').toUpperCase(), String(d?.value ?? '')])
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])),
);

/** The package's uppercase value prefix: manifest.idPrefixes.upper, else derived from `code` ('ACME_'). */
export function valuePrefix(manifest) {
  return manifest?.idPrefixes?.upper ?? (manifest?.code ? prefixForms(manifest.code).upper : null);
}

/**
 * Merge a delta into a server tag class's allowedValues, by symbolicName. PURE.
 *  - a delta value the server lacks is APPENDED (server order kept, delta order for the new ones);
 *    it inherits the echo's `type` discriminator from a sibling when the siblings carry one;
 *  - a value the server already has is NEVER removed or renamed; its labels are refreshed only when
 *    `prefix` is given and the value carries it (the extension's own value) — any other existing
 *    value is the product's and stays byte for byte (reported in `kept` when the delta disagrees);
 *  - nothing is ever dropped: every server value is in `values`, in its original position.
 * @returns {{values:object[], added:string[], updated:string[], unchanged:string[], kept:string[]}}
 */
export function mergeTagDelta(serverValues, deltaValues, { prefix = null } = {}) {
  const values = clone(Array.isArray(serverValues) ? serverValues : []);
  const added = []; const updated = []; const unchanged = []; const kept = [];
  const typeOf = values.map((v) => v?.type).find((t) => typeof t === 'string');
  for (const d of Array.isArray(deltaValues) ? deltaValues : []) {
    const name = nameOf(d);
    if (!name) continue;
    const at = values.findIndex((v) => nameOf(v) === name);
    if (at === -1) {
      const v = clone(d);
      if (typeOf && v.type == null) v.type = typeOf;
      values.push(v);
      added.push(name);
    } else if (labelKey(values[at].displayNames) === labelKey(d.displayNames)) {
      unchanged.push(name);
    } else if (prefix && name.startsWith(prefix)) {
      values[at].displayNames = clone(d.displayNames ?? []);
      updated.push(name);
    } else {
      kept.push(name);
    }
  }
  return { values, added, updated, unchanged, kept };
}

/** Remove ONLY the extension's own values (named in `names`, and carrying `prefix` when given). PURE. */
export function removeOwnValues(serverValues, names, { prefix = null } = {}) {
  const own = new Set(names ?? []);
  const removed = [];
  const values = (Array.isArray(serverValues) ? clone(serverValues) : []).filter((v) => {
    const n = nameOf(v);
    if (n && own.has(n) && (!prefix || n.startsWith(prefix))) { removed.push(n); return false; }
    return true;
  });
  return { values, removed };
}

/** The slice of a server tag class the delta speaks about: its own names only, projected to the
 *  fields a delta carries, sorted — the form both sides are hashed in. PURE. */
export function sliceOwn(serverValues, names) {
  const own = new Set(names ?? []);
  return projectValues((serverValues ?? []).filter((v) => own.has(nameOf(v))));
}

/** {symbolicName, displayNames:[{language,value}]} sorted by name — the canonical delta value form. */
export function projectValues(values) {
  return (Array.isArray(values) ? values : [])
    .filter((v) => nameOf(v))
    .map((v) => ({
      symbolicName: v.symbolicName,
      displayNames: (v.displayNames ?? [])
        .map((d) => ({ language: String(d.language ?? '').toUpperCase(), value: d.value }))
        .sort((a, b) => cmp(a.language, b.language) || cmp(String(a.value ?? ''), String(b.value ?? ''))),
    }))
    .sort((a, b) => cmp(a.symbolicName, b.symbolicName));
}

/** True when `serverValues` differs from `deltaValues` ONLY by values the server lacks: every value
 *  the server holds is named by the delta with the same labels. A merge push then adds what is
 *  missing and clobbers nothing; anything else (a relabel on the server) is a real server edit. PURE. */
export function onlyMissing(deltaValues, serverValues) {
  const want = new Map((Array.isArray(deltaValues) ? deltaValues : []).filter(nameOf).map((v) => [v.symbolicName, labelKey(v.displayNames)]));
  return (Array.isArray(serverValues) ? serverValues : []).filter(nameOf)
    .every((v) => want.has(v.symbolicName) && want.get(v.symbolicName) === labelKey(v.displayNames));
}

/**
 * Offline checks of ONE delta. PURE. -> [{code, message}]
 *  EXT_TAG_CLASS_UNKNOWN  the `tagclass` field is missing/not a string, or disagrees with the file's id
 *                         (and, when `knownTagclasses` is given, names a class outside that set)
 *  EXT_TAG_DELTA_OWN      the delta targets a tag class this package owns (edit its fd/tagclasses file)
 *  EXT_TAG_VALUE_PREFIX   a value lacks the package's uppercase prefix (or has no symbolicName)
 */
export function checkTagDelta(delta, { id = null, prefix = null, ownTagclasses = [], knownTagclasses = null } = {}) {
  const errs = [];
  const tc = delta?.tagclass;
  const where = id ?? tc ?? '(delta)';
  if (typeof tc !== 'string' || !tc) {
    errs.push({ code: EXT_TAG_CLASS_UNKNOWN, message: `${EXT_TAG_CLASS_UNKNOWN} ${where}: the delta names no "tagclass"` });
  } else {
    if (id && tc !== id) errs.push({ code: EXT_TAG_CLASS_UNKNOWN, message: `${EXT_TAG_CLASS_UNKNOWN} ${where}: "tagclass" is "${tc}" but the file is ${id}.delta.json — the name must match` });
    if (knownTagclasses && !new Set(knownTagclasses).has(tc)) errs.push({ code: EXT_TAG_CLASS_UNKNOWN, message: `${EXT_TAG_CLASS_UNKNOWN} ${where}: "${tc}" is not a tag class of a declared dependency` });
    if (new Set(ownTagclasses).has(tc)) errs.push({ code: EXT_TAG_DELTA_OWN, message: `${EXT_TAG_DELTA_OWN} ${where}: "${tc}" is this package's own tag class — edit fd/tagclasses/${tc}.json, a delta is for a class you do not own` });
  }
  const list = delta?.allowedValues;
  if (!Array.isArray(list) || !list.length) {
    errs.push({ code: EXT_TAG_VALUE_PREFIX, message: `${EXT_TAG_VALUE_PREFIX} ${where}: allowedValues must be a non-empty array` });
    return errs;
  }
  for (const v of list) {
    const n = nameOf(v);
    if (typeof n !== 'string' || !n) errs.push({ code: EXT_TAG_VALUE_PREFIX, message: `${EXT_TAG_VALUE_PREFIX} ${where}: a value has no symbolicName` });
    else if (prefix && !n.startsWith(prefix)) errs.push({ code: EXT_TAG_VALUE_PREFIX, message: `${EXT_TAG_VALUE_PREFIX} ${where}: value "${n}" must start with the package prefix "${prefix}" — a delta adds only its own values` });
  }
  return errs;
}

/** Offline lint of every registered delta of a package -> [{code, message}]. */
export function lintTagDeltas(pkg, { knownTagclasses = null } = {}) {
  const prefix = valuePrefix(pkg.manifest);
  const own = pkg.entries('fd.tagclass').map((e) => e.id);
  const out = [];
  for (const e of pkg.entries('fd.tagclass-delta')) {
    if (e.retired) continue;
    const p = join(pkg.dir, e.path ?? '');
    if (!e.path || !existsSync(p)) continue;
    let delta;
    try { delta = JSON.parse(readFileSync(p, 'utf8')); } catch { out.push({ code: EXT_TAG_CLASS_UNKNOWN, message: `${EXT_TAG_CLASS_UNKNOWN} ${e.id}: ${e.path} is not valid JSON` }); continue; }
    out.push(...checkTagDelta(delta, { id: e.id, prefix, ownTagclasses: own, knownTagclasses }));
  }
  return out;
}
