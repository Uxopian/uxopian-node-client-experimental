// fd.tagclass-delta — values an EXTENSION adds to a CHOICELIST tag class it does not own (DESIGN §26).
// File: fd/tagclass-deltas/<Tag>.delta.json  { "tagclass": "<Tag>", "allowedValues": [ {symbolicName, displayNames} ] }
// id = the target tag class name. Push = GET /rest/tagclass/{id}, merge by symbolicName (append what
// is missing, never remove or rename a value the product owns), POST /rest/tagclass/{id} (ARRAY body,
// full replace of the object we just read), re-GET to confirm. The server-side view hashed against the
// file is the SLICE of the tag class the delta names — so the product's other values never read as drift
// and an unchanged delta is skipped WITHOUT a write (a tag class write costs ~65 s on fd.demo).
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { dn } from '../util.mjs';
import {
  mergeTagDelta, removeOwnValues, sliceOwn, projectValues, checkTagDelta, valuePrefix,
} from '../tagdelta.mjs';

const KIND = 'fd.tagclass-delta';
const DIR = 'fd/tagclass-deltas';
const WRITE_TIMEOUT_MS = 240_000; // the default 60 s is shorter than a slow tag class write

const pkgOf = (ctx) => ctx.pkg ?? ctx.requirePkg?.() ?? null;
const valuesOf = (tc) => (Array.isArray(tc?.allowedValues) ? tc.allowedValues : []);
const namesOfDelta = (obj) => projectValues(obj?.allowedValues).map((v) => v.symbolicName);

/** Names this delta owns: the local file when present, else what the last push recorded. */
function ownNames(ctx, id, adapter) {
  const pkg = pkgOf(ctx);
  if (!pkg) return [];
  const entry = pkg.entry(KIND, id) ?? { kind: KIND, id, path: adapter.pathFor(pkg, id) };
  let local = null;
  try { local = adapter.readLocal(pkg, entry); } catch { /* unreadable: fall back to state */ }
  if (local?.obj) return namesOfDelta(local.obj);
  return (ctx.target?.name && pkg.resState(ctx.target.name, KIND, id)?.ownValues) || [];
}

// Strictly one tag class write at a time (a write is ~65 s and concurrent ones 500 on fd.demo).
let chain = Promise.resolve();
const serialized = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function writeTagClass(ctx, id, body, label) {
  const say = ctx.out?.line?.bind(ctx.out) ?? (() => {});
  say(`${KIND}/${id}: ${label} — a tag class write takes up to ~65 s on fd.demo; one at a time, please wait…`);
  const t0 = Date.now();
  await ctx.clients.core.post(`/rest/tagclass/${encodeURIComponent(id)}`, [body], { timeout: WRITE_TIMEOUT_MS });
  say(`${KIND}/${id}: written in ${Math.round((Date.now() - t0) / 1000)} s — re-reading to confirm`);
}

const adapter = {
  kind: KIND,
  dir: DIR,
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,
  mergeOnPush: true, // sync.mjs: a merge cannot clobber — no collision/conflict refusal, no --recreate

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
    const tc = await ctx.clients.core.getOne(`/rest/tagclass/${encodeURIComponent(id)}`);
    if (!tc) return null;
    const slice = sliceOwn(valuesOf(tc), ownNames(ctx, id, adapter));
    return slice.length ? { obj: { tagclass: id, allowedValues: slice } } : null;
  },

  /** status --remote: presence of each value, in words. */
  async presence(ctx, entry) {
    const tc = await ctx.clients.core.getOne(`/rest/tagclass/${encodeURIComponent(entry.id)}`);
    if (!tc) return `tag class ${entry.id} is not on the server (${'EXT_TAG_CLASS_UNKNOWN'})`;
    const names = ownNames(ctx, entry.id, adapter);
    const have = new Set(valuesOf(tc).map((v) => v?.symbolicName));
    const missing = names.filter((n) => !have.has(n));
    return missing.length
      ? `${names.length - missing.length}/${names.length} values present — absent: ${missing.join(', ')} — uxc push`
      : `${names.length}/${names.length} values present`;
  },

  push(ctx, entry, local) {
    return serialized(async () => {
      const pkg = pkgOf(ctx);
      const id = entry.id;
      const { core } = ctx.clients;
      const prefix = valuePrefix(pkg.manifest);
      const tc = await core.getOne(`/rest/tagclass/${encodeURIComponent(id)}`);
      if (!tc) {
        throw new Error(`EXT_TAG_CLASS_UNKNOWN: tag class "${id}" does not exist on the server — the extension's dependency (the product package) must be deployed first`);
      }
      if (tc.type && tc.type !== 'CHOICELIST') {
        throw new Error(`EXT_TAG_CLASS_UNKNOWN: "${id}" is a ${tc.type} tag class, not a CHOICELIST — a delta only extends a closed list`);
      }
      const before = valuesOf(tc);
      const merged = mergeTagDelta(before, local.obj.allowedValues, { prefix });
      const ownValues = namesOfDelta(local.obj);
      if (!merged.added.length && !merged.updated.length) {
        ctx.out?.note?.(`${KIND}/${id}: every value is already on the server — nothing to write`);
        return { ownValues };
      }
      if (merged.kept.length) {
        ctx.out?.warn?.(`${KIND}/${id}: ${merged.kept.join(', ')} already exist with other labels and are not this package's (no prefix) — left untouched`);
      }
      await writeTagClass(ctx, id, { ...tc, allowedValues: merged.values },
        `adding ${merged.added.length} value(s)${merged.updated.length ? `, relabelling ${merged.updated.length}` : ''} to ${id}`);
      // confirm: a fresh read must hold every value we wrote AND every value that was there before
      const after = await core.getOne(`/rest/tagclass/${encodeURIComponent(id)}`);
      const have = new Set(valuesOf(after).map((v) => v?.symbolicName));
      const lost = before.map((v) => v?.symbolicName).filter((n) => n && !have.has(n));
      const absent = merged.added.filter((n) => !have.has(n));
      if (lost.length || absent.length) {
        throw new Error(`${id}: the re-read does not confirm the write — ${absent.length ? `absent: ${absent.join(', ')}` : ''}${lost.length ? ` LOST product values: ${lost.join(', ')}` : ''}`);
      }
      return { ownValues };
    });
  },

  /** rm --server / prune: remove ONLY the extension's own values; the tag class and the product's values stay. */
  remove(ctx, id) {
    return serialized(async () => {
      const pkg = pkgOf(ctx);
      const { core } = ctx.clients;
      const tc = await core.getOne(`/rest/tagclass/${encodeURIComponent(id)}`);
      if (!tc) return;
      const { values, removed } = removeOwnValues(valuesOf(tc), ownNames(ctx, id, adapter), { prefix: valuePrefix(pkg?.manifest) });
      if (!removed.length) { ctx.out?.note?.(`${KIND}/${id}: none of the extension's values is on the server`); return; }
      await writeTagClass(ctx, id, { ...tc, allowedValues: values }, `removing ${removed.length} own value(s) from ${id}`);
      const after = await core.getOne(`/rest/tagclass/${encodeURIComponent(id)}`);
      const still = valuesOf(after).map((v) => v?.symbolicName).filter((n) => removed.includes(n));
      if (still.length) throw new Error(`${id}: the re-read still holds ${still.join(', ')}`);
    });
  },
};

export default adapter;
