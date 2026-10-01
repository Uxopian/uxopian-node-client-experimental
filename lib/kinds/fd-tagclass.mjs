// fd.tagclass — /rest/tagclass (learnings §6: array bodies, id-in-path update, F00903 on re-create).
//
// Shared CHOICELIST classes (#126, DESIGN §28): a product's tag class also holds the values an installed
// extension's fd.tagclass-delta added. This package's VIEW of the class leaves those values out — the
// server form hashed, compared, pulled and echoed is the class minus another installed package's values
// (receipts' tagContributions + the §31 longest-prefix rule, lib/ownership.mjs). Push MERGES: the full
// replace re-adds the other packages' values present on the server. Alone on the target nothing is
// foreign and the server form is the object as read (byte-identical to 0.25.0).
// Receipts unreadable -> fail safe: every value stays in the hash (drift shows), a value that may be
// another package's is never pulled, and push never removes a value carrying another package's prefix.
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';
import { tagValueOwners, splitTagValues, guardTagValues } from '../ownership.mjs';

const TYPES = ['STRING', 'TEXT', 'INT', 'CHOICELIST', 'DATE', 'BOOLEAN', 'ICON', 'FREELIST']; // NOT 'INTEGER'

/** 'Credit insurance' | 'CreditInsurance' -> 'CREDIT_INSURANCE' (choicelist symbolicName convention). */
const upperSnake = (s) =>
  String(s).trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

const adapter = classKindAdapter({
  kind: 'fd.tagclass',
  dir: 'fd/tagclasses',
  restPath: 'tagclass',
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return errs;
    if (!TYPES.includes(o.type)) errs.push(`${entry.id}: type "${o.type}" — must be one of ${TYPES.join('/')}`);
    if (o.type === 'CHOICELIST' && !(Array.isArray(o.allowedValues) && o.allowedValues.length)) {
      errs.push(`${entry.id}: CHOICELIST requires non-empty allowedValues`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    const obj = {
      id: name,
      type: flags.type || 'STRING',
      searchable: true,
      displayNames: dn(flags.title ?? name, flags.fr),
    };
    if (flags.values) {
      obj.allowedValues = String(flags.values).split(',').map((v) => v.trim()).filter(Boolean)
        .map((v) => ({ symbolicName: upperSnake(v), displayNames: dn(v) }));
    }
    return { obj };
  },
});

const KIND = 'fd.tagclass';
const nameOf = (v) => (v && typeof v === 'object' ? v.symbolicName : undefined);
const valuesOf = (o) => (Array.isArray(o?.allowedValues) ? o.allowedValues : []);
const strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pkgOf(ctx) {
  if (ctx?.pkg) return ctx.pkg;
  try { return ctx?.requirePkg?.() ?? null; } catch { return null; }
}

/** The value names of the local file (empty when absent/unreadable). */
function localNames(pkg, id) {
  try {
    const entry = pkg.entry?.(KIND, id) ?? { kind: KIND, id, path: adapter.pathFor(pkg, id) };
    return new Set(valuesOf(adapter.readLocal(pkg, entry)?.obj).map(nameOf).filter(Boolean));
  } catch { return new Set(); }
}

/** Values recorded as another package's at the last successful receipt read (state, per target). */
function recordedForeign(ctx, pkg, id) {
  try {
    const m = ctx.target?.name ? pkg.targetState(ctx.target.name).foreignTagValues : null;
    return Array.isArray(m?.[id]) ? m[id] : [];
  } catch { return []; }
}
function recordForeign(ctx, pkg, id, names) {
  try {
    if (!ctx.target?.name || typeof pkg.targetState !== 'function') return;
    const ts = pkg.targetState(ctx.target.name);
    const next = [...new Set(names)].sort(strCmp);
    const prev = Array.isArray(ts.foreignTagValues?.[id]) ? ts.foreignTagValues[id] : [];
    if (prev.join(',') === next.join(',')) return; // saved only on change: status must not churn state
    ts.foreignTagValues ??= {};
    if (next.length) ts.foreignTagValues[id] = next;
    else delete ts.foreignTagValues[id];
    if (!Object.keys(ts.foreignTagValues).length) delete ts.foreignTagValues;
    pkg.saveState?.();
  } catch { /* best-effort */ }
}

/** "+3 values of po, +1 value of qa" */
export function foreignValuesNote(foreign) {
  if (!foreign?.length) return null;
  const by = new Map();
  for (const f of foreign) by.set(f.code, (by.get(f.code) ?? 0) + 1);
  const parts = [...by].sort((a, b) => strCmp(a[0], b[0])).map(([code, n]) => `+${n} value${n === 1 ? '' : 's'} of ${code}`);
  return `${parts.join(', ')} (another installed package's values in this tag class — not hashed, not drift)`;
}

/**
 * This package's view of a server tag class object (#126). -> {obj, foreign?, refusePull?, exclude?}
 *   receipts read      obj = the class minus another installed package's values; foreign = [{name, code}]
 *   receipts unreadable obj = the class as read (fail safe: drift shows); values absent from the local
 *                      file that may be another package's -> refusePull (pull refuses, says why) and
 *                      exclude (an echo write never puts them into the local file)
 * No other package, no foreign value: {obj} exactly as read.
 */
async function ownView(ctx, id, obj) {
  ctx._tagForeign?.delete(id);
  const pkg = pkgOf(ctx);
  const names = valuesOf(obj).map(nameOf).filter(Boolean);
  if (!obj || !names.length || !pkg?.manifest?.code) return { obj };
  const view = await tagValueOwners(ctx, pkg.manifest);
  const seen = (ctx._tagForeign ??= new Map());
  if (view.receiptsReadable) {
    const { foreign } = splitTagValues(names, id, pkg.manifest, view);
    recordForeign(ctx, pkg, id, foreign.map((f) => f.name));
    seen.set(id, { foreign });
    if (!foreign.length) return { obj };
    const out = new Set(foreign.map((f) => f.name));
    return { obj: { ...obj, allowedValues: obj.allowedValues.filter((v) => !out.has(nameOf(v))) }, foreign };
  }
  const local = localNames(pkg, id);
  let neverRead = true;
  try { neverRead = !ctx.target?.name || pkg.installedSeen?.(ctx.target.name) == null; } catch { neverRead = true; }
  const { maybeForeign } = guardTagValues(names, pkg.manifest, view, recordedForeign(ctx, pkg, id), { neverRead });
  const suspects = names.filter((n) => !local.has(n) && maybeForeign(n));
  const errors = (view.receiptErrors ?? []).join('; ').slice(0, 160);
  seen.set(id, { foreign: [], unreadable: errors, suspects });
  if (!suspects.length) return { obj };
  return {
    obj,
    exclude: suspects,
    refusePull: `installation receipts could not be read (${errors}) — ${suspects.join(', ')} may be another installed package's value${suspects.length === 1 ? '' : 's'}: not pulled (fail safe); re-run when the receipts are readable`,
  };
}

/** The server values a push of this package must KEEP (re-add): another package's values on the server
 *  that the local file does not carry. Receipts unreadable: every value carrying a guard prefix or
 *  recorded as another package's (never an unprefixed value of unknown owner — those are ours to drop). */
async function valuesToKeep(ctx, pkg, id, server, localObj) {
  const names = valuesOf(server).map(nameOf).filter(Boolean);
  if (!names.length || !pkg?.manifest?.code) return [];
  const mine = new Set(valuesOf(localObj).map(nameOf).filter(Boolean));
  const view = await tagValueOwners(ctx, pkg.manifest);
  const keep = view.receiptsReadable
    ? new Set(splitTagValues(names, id, pkg.manifest, view).foreign.map((f) => f.name))
    : guardTagValues(names, pkg.manifest, view, recordedForeign(ctx, pkg, id)).guarded;
  return valuesOf(server).filter((v) => keep.has(nameOf(v)) && !mine.has(nameOf(v)));
}

const baseUpdate = adapter.update;
const baseWriteLocal = adapter.writeLocal;

Object.assign(adapter, {
  /** status --remote batch path (sync.statusAll): the listed object goes through the same view. */
  async serverView(ctx, id, res) {
    return res?.obj ? ownView(ctx, id, res.obj) : res;
  },
  async readServer(ctx, id) {
    const obj = await adapter.get(ctx, id);
    return obj ? ownView(ctx, id, obj) : null;
  },
  /** Push = full replace of the local file MERGED with the other installed packages' values still on
   *  the server (#126): their values survive, this package's own values deleted locally go. */
  async update(ctx, id, local) {
    const pkg = pkgOf(ctx);
    if (!pkg || !Array.isArray(local?.obj?.allowedValues)) return baseUpdate(ctx, id, local);
    const server = await adapter.get(ctx, id);
    const keep = await valuesToKeep(ctx, pkg, id, server, local.obj);
    if (!keep.length) return baseUpdate(ctx, id, local);
    ctx.out?.note?.(`${KIND}/${id}: keeping ${keep.length} value(s) of other installed packages on the server (${keep.map(nameOf).join(', ')}) — merged, not replaced`);
    return baseUpdate(ctx, id, { ...local, obj: { ...local.obj, allowedValues: [...local.obj.allowedValues, ...keep] } });
  },
  /** pull / push echo: never writes values the view flagged as possibly another package's. */
  writeLocal(pkg, entry, res) {
    const ex = new Set(res?.exclude ?? []);
    if (!ex.size || !Array.isArray(res?.obj?.allowedValues)) return baseWriteLocal(pkg, entry, res);
    return baseWriteLocal(pkg, entry, { ...res, obj: { ...res.obj, allowedValues: res.obj.allowedValues.filter((v) => !ex.has(nameOf(v))) } });
  },
  /** status --remote: another installed package's values, as a note (from the view classify just read). */
  async presence(ctx, entry) {
    const seen = ctx._tagForeign?.get(entry.id);
    if (!seen) return undefined;
    if (seen.foreign?.length) return { note: foreignValuesNote(seen.foreign) };
    if (seen.suspects?.length) {
      return { note: `installation receipts could not be read (${seen.unreadable}) — ${seen.suspects.join(', ')} may be another installed package's: counted in the hash (fail safe), never pulled` };
    }
    return undefined;
  },
});

export default adapter;
