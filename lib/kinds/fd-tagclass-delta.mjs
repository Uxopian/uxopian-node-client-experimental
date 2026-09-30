// fd.tagclass-delta — values an EXTENSION adds to a CHOICELIST tag class it does not own (DESIGN §28).
// File: fd/tagclass-deltas/<Tag>.delta.json  { "tagclass": "<Tag>", "allowedValues": [ {symbolicName, displayNames} ] }
// id = the target tag class name. Push = GET /rest/tagclass/{id}, merge by symbolicName (append what
// is missing, never remove or rename a value the product owns; remove only this package's own values
// that were dropped from the delta), RE-GET immediately before the write and merge onto that fresh
// copy (lost-update guard), POST /rest/tagclass/{id} (ARRAY body, full replace), re-GET to confirm that
// every value of the pre-POST read survived. The server-side view hashed against the file is the SLICE
// of the tag class the delta names — so the product's other values never read as drift and an
// unchanged delta is skipped WITHOUT a write (a tag class write costs ~65 s on fd.demo).
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { dn } from '../util.mjs';
import {
  mergeTagDelta, removeOwnValues, sliceOwn, projectValues, checkTagDelta, valuePrefix, onlyMissing,
} from '../tagdelta.mjs';

const KIND = 'fd.tagclass-delta';
const DIR = 'fd/tagclass-deltas';
const WRITE_TIMEOUT_MS = 240_000; // the default 60 s is shorter than a slow tag class write

const pkgOf = (ctx) => ctx.pkg ?? ctx.requirePkg?.() ?? null;
const valuesOf = (tc) => (Array.isArray(tc?.allowedValues) ? tc.allowedValues : []);
const namesOfDelta = (obj) => projectValues(obj?.allowedValues).map((v) => v.symbolicName);
const tcPath = (id) => `/rest/tagclass/${encodeURIComponent(id)}`;

/** ownValues recorded in state for this target (at push, or whenever sync recorded a base), or null. */
function recordedOwn(ctx, id) {
  const pkg = pkgOf(ctx);
  const names = pkg && ctx.target?.name ? pkg.resState(ctx.target.name, KIND, id)?.ownValues : null;
  return Array.isArray(names) ? names : null;
}

/** Names this delta owns: the local file when present, else what state recorded.
 *  known=false when neither exists (file gone and nothing ever recorded for this target). */
function ownNamesInfo(ctx, id, adapter) {
  const pkg = pkgOf(ctx);
  if (!pkg) return { names: [], known: false };
  const entry = pkg.entry(KIND, id) ?? { kind: KIND, id, path: adapter.pathFor(pkg, id) };
  let local = null;
  try { local = adapter.readLocal(pkg, entry); } catch { /* unreadable: fall back to state */ }
  if (local?.obj) return { names: namesOfDelta(local.obj), known: true };
  const recorded = recordedOwn(ctx, id);
  return recorded ? { names: recorded, known: true } : { names: [], known: false };
}
const ownNames = (ctx, id, adapter) => ownNamesInfo(ctx, id, adapter).names;

/** Values recorded as ours, no longer in the delta file, carrying the package prefix (never a product value). */
function droppedNames(ctx, id, local, prefix) {
  if (!prefix) return []; // without a prefix ours cannot be told from the product's: never remove
  const now = new Set(namesOfDelta(local?.obj));
  return (recordedOwn(ctx, id) ?? []).filter((n) => !now.has(n) && n.startsWith(prefix));
}

// Strictly one tag class write at a time (a write is ~65 s and concurrent ones 500 on fd.demo).
let chain = Promise.resolve();
const serialized = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

/**
 * The one write path (push and remove). Lost-update guard: RE-GET immediately before the POST and
 * rebuild the value list from THAT copy via `plan(freshValues)` — never from an older read — so a value
 * another writer added since our first read is carried over. After the POST a fresh read must hold every
 * value of the pre-POST read (minus what `plan` removed on purpose) and every value it added; anything
 * else throws. Residual window: a writer landing DURING the POST itself (DESIGN §28).
 * plan(values) -> null (nothing to write) | {values, added?, removed?, label}
 */
async function replaceValues(ctx, id, plan, firstRead = null) {
  const { core } = ctx.clients;
  const say = ctx.out?.line?.bind(ctx.out) ?? (() => {});
  const fresh = await core.getOne(tcPath(id));
  if (!fresh) throw new Error(`EXT_TAG_CLASS_UNKNOWN: tag class "${id}" vanished from the server before the write`);
  if (firstRead?.lastUpdateDate && fresh.lastUpdateDate && fresh.lastUpdateDate !== firstRead.lastUpdateDate) {
    ctx.out?.note?.(`${KIND}/${id}: the tag class changed on the server since it was read (lastUpdateDate ${firstRead.lastUpdateDate} -> ${fresh.lastUpdateDate}) — merging onto the fresh copy`);
  }
  const p = plan(valuesOf(fresh));
  if (!p) return null;
  say(`${KIND}/${id}: ${p.label} — a tag class write takes up to ~65 s on fd.demo; one at a time, please wait…`);
  const t0 = Date.now();
  await core.post(tcPath(id), [{ ...fresh, allowedValues: p.values }], { timeout: WRITE_TIMEOUT_MS });
  say(`${KIND}/${id}: written in ${Math.round((Date.now() - t0) / 1000)} s — re-reading to confirm`);
  const after = await core.getOne(tcPath(id));
  const have = new Set(valuesOf(after).map((v) => v?.symbolicName));
  const removed = new Set(p.removed ?? []);
  const lost = valuesOf(fresh).map((v) => v?.symbolicName).filter((n) => n && !removed.has(n) && !have.has(n));
  const absent = (p.added ?? []).filter((n) => !have.has(n));
  const still = [...removed].filter((n) => have.has(n));
  if (lost.length || absent.length || still.length) {
    throw new Error(`${id}: the re-read does not confirm the write —`
      + `${absent.length ? ` absent: ${absent.join(', ')}` : ''}`
      + `${still.length ? ` still present: ${still.join(', ')}` : ''}`
      + `${lost.length ? ` LOST values: ${lost.join(', ')} (present before the write, gone after — a concurrent writer or the server dropped them; restore them)` : ''}`);
  }
  return p;
}

const adapter = {
  kind: KIND,
  dir: DIR,
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,
  // sync.mjs: when the server slice differs from the file ONLY by absent values (onlyMissing), a merge
  // cannot clobber — no collision/conflict refusal, no --recreate. A relabel made on the server is a
  // real server edit and is refused like any other kind's (uxc pull, or push --force).
  mergeOnPush: true,
  onlyMissing: (local, server) => onlyMissing(local?.obj?.allowedValues, server?.obj?.allowedValues),
  /** sync.mjs merges this into state whenever it records a base without calling push (adopted/rebased/pull). */
  baseState: (local) => (local?.obj ? { ownValues: namesOfDelta(local.obj) } : {}),

  ...jsonLayout({ kind: KIND, dir: DIR }),
  pathFor: (pkg, id) => join(DIR, `${id}.delta.json`),

  validate(pkg, entry, local) {
    const o = local?.obj;
    if (!o) return [];
    const own = pkg.entries('fd.tagclass').map((e) => e.id);
    return checkTagDelta(o, { id: entry.id, prefix: valuePrefix(pkg.manifest), ownTagclasses: own }).map((e) => e.message);
  },

  template(ctx, name, flags) {
    const pkg = pkgOf(ctx);
    const prefix = (pkg && valuePrefix(pkg.manifest)) || 'EXT_';
    const values = flags.values
      ? String(flags.values).split(',').map((v) => v.trim()).filter(Boolean)
      : ['EXAMPLE_VALUE'];
    return {
      obj: {
        tagclass: name,
        allowedValues: values.map((v) => {
          const sym = v.startsWith(prefix) ? v : prefix + v.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
          return { symbolicName: sym, displayNames: dn(v, flags.fr) };
        }),
      },
    };
  },

  /** The slice of the server tag class this delta names; null when the class or all its values are absent. */
  async readServer(ctx, id) {
    const tc = await ctx.clients.core.getOne(tcPath(id));
    if (!tc) return null;
    const slice = sliceOwn(valuesOf(tc), ownNames(ctx, id, adapter));
    return slice.length ? { obj: { tagclass: id, allowedValues: slice } } : null;
  },

  /** sync.mjs: values dropped from the delta but still on the server — push must write although the slice is unchanged. */
  async orphans(ctx, entry, local) {
    const dropped = droppedNames(ctx, entry.id, local, valuePrefix(pkgOf(ctx)?.manifest));
    if (!dropped.length) return []; // no network when nothing was dropped
    const have = new Set(valuesOf(await ctx.clients.core.getOne(tcPath(entry.id))).map((v) => v?.symbolicName));
    return dropped.filter((n) => have.has(n));
  },

  /** status --remote: presence of each value, in words. Orphans (dropped from the delta, still on the
   *  server) turn the row `local`: the next push removes them. */
  async presence(ctx, entry) {
    const tc = await ctx.clients.core.getOne(tcPath(entry.id));
    if (!tc) return `tag class ${entry.id} is not on the server (${'EXT_TAG_CLASS_UNKNOWN'})`;
    const names = ownNames(ctx, entry.id, adapter);
    const have = new Set(valuesOf(tc).map((v) => v?.symbolicName));
    const missing = names.filter((n) => !have.has(n));
    const head = missing.length
      ? `${names.length - missing.length}/${names.length} values present — absent: ${missing.join(', ')} — uxc push`
      : `${names.length}/${names.length} values present`;
    const pkg = pkgOf(ctx);
    let local = null;
    try { local = pkg ? adapter.readLocal(pkg, entry) : null; } catch { /* no file */ }
    const orphaned = local?.obj ? droppedNames(ctx, entry.id, local, valuePrefix(pkg?.manifest)).filter((n) => have.has(n)) : [];
    if (!orphaned.length) return head;
    return { state: 'local', detail: `${head} — orphaned (dropped from the delta, still on the server): ${orphaned.join(', ')} — uxc push removes them` };
  },

  push(ctx, entry, local) {
    return serialized(async () => {
      const pkg = pkgOf(ctx);
      const id = entry.id;
      const prefix = valuePrefix(pkg.manifest);
      const tc = await ctx.clients.core.getOne(tcPath(id));
      if (!tc) {
        throw new Error(`EXT_TAG_CLASS_UNKNOWN: tag class "${id}" does not exist on the server — the extension's dependency (the product package) must be deployed first`);
      }
      if (tc.type && tc.type !== 'CHOICELIST') {
        throw new Error(`EXT_TAG_CLASS_UNKNOWN: "${id}" is a ${tc.type} tag class, not a CHOICELIST — a delta only extends a closed list`);
      }
      const ownValues = namesOfDelta(local.obj);
      const dropped = droppedNames(ctx, id, local, prefix);
      let warned = false;
      const plan = (serverValues) => {
        const merged = mergeTagDelta(serverValues, local.obj.allowedValues, { prefix });
        const { values, removed } = removeOwnValues(merged.values, dropped, { prefix });
        if (merged.kept.length && !warned) {
          warned = true;
          ctx.out?.warn?.(`${KIND}/${id}: ${merged.kept.join(', ')} already exist with other labels and are not this package's (no prefix) — left untouched`);
        }
        if (!merged.added.length && !merged.updated.length && !removed.length) return null;
        const parts = [
          merged.added.length ? `adding ${merged.added.length} value(s)` : null,
          merged.updated.length ? `relabelling ${merged.updated.length}` : null,
          removed.length ? `removing ${removed.length} value(s) dropped from the delta (${removed.join(', ')})` : null,
        ].filter(Boolean);
        return { values, added: merged.added, removed, label: `${parts.join(', ')} on ${id}` };
      };
      if (!plan(valuesOf(tc))) {
        ctx.out?.note?.(`${KIND}/${id}: every value is already on the server — nothing to write`);
        return { ownValues };
      }
      const done = await replaceValues(ctx, id, plan, tc);
      if (done?.removed?.length) ctx.out?.line?.(`${KIND}/${id}: removed ${done.removed.join(', ')} — no longer in the delta`);
      return { ownValues };
    });
  },

  /** rm --server / prune: remove ONLY the extension's own values; the tag class and the product's values stay. */
  remove(ctx, id) {
    return serialized(async () => {
      const pkg = pkgOf(ctx);
      const prefix = valuePrefix(pkg?.manifest);
      const tc = await ctx.clients.core.getOne(tcPath(id));
      if (!tc) return;
      const { names, known } = ownNamesInfo(ctx, id, adapter);
      if (!known) {
        const candidates = prefix ? valuesOf(tc).map((v) => v?.symbolicName).filter((n) => n?.startsWith(prefix)) : [];
        ctx.out?.warn?.(`${KIND}/${id}: this package's values are UNKNOWN (no local delta file, no ownValues recorded for this target) — nothing removed`
          + (candidates.length ? `; values carrying ${prefix} on the server: ${candidates.join(', ')} — restore the delta file and re-run, or remove them by hand` : ''));
        return;
      }
      const plan = (serverValues) => {
        const { values, removed } = removeOwnValues(serverValues, names, { prefix });
        return removed.length ? { values, removed, label: `removing ${removed.length} own value(s) from ${id}` } : null;
      };
      if (!plan(valuesOf(tc))) { ctx.out?.note?.(`${KIND}/${id}: none of the extension's values is on the server`); return; }
      await replaceValues(ctx, id, plan, tc);
    });
  },
};

export default adapter;
