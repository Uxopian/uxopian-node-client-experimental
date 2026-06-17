// fd.dataset — row-level-synced document collections (DESIGN §7.13).
// One registry entry per manifest.dataSets row ({name, classId, path, content?}); the local file
// is ONE JSONL at the manifest path: one canonical document row per line, sorted by id.
// Row canonical form = canonicalize('fd.document', {id, name, category:'DOCUMENT',
// data:{classId, ACL?}, tags}) with tags sorted by name and keys sorted manually per row
// (JSON.stringify per row — NOT stableStringify, which is multi-line).
// Whole-file hashing: obj = {name, classId}, contents = {'<name>.jsonl': sorted JSONL text} —
// hashResource(kind, obj, contents) covers manifest binding AND every row.
// Row-level 3-way: state stores per-row base hashes ({rows: {docId -> 'sha256:…'}}); disjoint
// row edits merge cleanly, only same-row divergence conflicts. Push NEVER deletes server docs
// by default: only explicit local tombstone rows ({"_id": id, "_deleted": true}) or
// --prune + --yes after the exact kill list is printed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { toArray } from '../util.mjs';
import { canonicalize, hashResource, hashBytes } from '../canonical.mjs';

const KIND = 'fd.dataset';
const DIR = 'data';

const strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // locale-independent, both sides identical

// ---------- canonical rows ----------

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeysDeep(v[k]);
    return o;
  }
  return v;
}

const isTombstone = (row) => row?._deleted === true;
const rowId = (row) => (isTombstone(row) ? String(row._id) : String(row.id));

/** Canonical row from a local-authored row OR a server document. Deterministic key order. */
function canonRow(src, classId) {
  if (isTombstone(src)) return { _deleted: true, _id: String(src._id) };
  const data = { classId: src.data?.classId ?? classId };
  if (src.data?.ACL != null) data.ACL = src.data.ACL;
  const row = canonicalize('fd.document', {
    id: src.id,
    name: src.name ?? src.id,
    category: 'DOCUMENT',
    data,
    tags: (src.tags ?? []).map((t) => ({
      name: t.name,
      readOnly: !!t.readOnly,
      value: toArray(t.value).map(String), // FlowerDocs read shape: `value` (array), not `values`
    })),
  });
  row.tags.sort((a, b) => strCmp(a.name, b.name));
  return sortKeysDeep(row);
}

const lineOf = (row) => JSON.stringify(row); // rows are already key-sorted single objects
const rowHash = (row) => hashBytes(lineOf(row));

/** Sorted JSONL text: one row per line, sorted by id, trailing newline (empty -> ''). */
function jsonlText(rows) {
  const sorted = [...rows].sort((a, b) => strCmp(rowId(a), rowId(b)));
  return sorted.length ? sorted.map(lineOf).join('\n') + '\n' : '';
}

/** Parse a JSONL text into canonical rows. Lenient: bad lines land in parseErrors (validate aborts push). */
function parseRows(text, classId) {
  const rows = new Map(); // id -> canonical row (tombstones included, keyed by _id)
  const allIds = [];
  const parseErrors = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let raw;
    try { raw = JSON.parse(line); } catch (e) { parseErrors.push(`line ${i + 1}: not valid JSON (${e.message})`); return; }
    if (isTombstone(raw)) {
      if (!raw._id) { parseErrors.push(`line ${i + 1}: tombstone row needs "_id"`); return; }
    } else if (!raw?.id) { parseErrors.push(`line ${i + 1}: row has no "id"`); return; }
    const row = canonRow(raw, classId);
    allIds.push(rowId(row));
    rows.set(rowId(row), row);
  });
  return { rows, allIds, parseErrors };
}

// ---------- manifest / package plumbing ----------

const dataSetOf = (pkg, name) => (pkg.manifest?.dataSets ?? []).find((d) => d.name === name) ?? null;

function requireDataSet(pkg, name) {
  const ds = dataSetOf(pkg, name);
  if (!ds) {
    throw new Error(
      `dataset "${name}" has no manifest entry — add {"name":"${name}","classId":"<ClassId>","path":"data/${name}.jsonl"} ` +
      'to uxopian-project.json dataSets (uxc add fd.dataset <name> --class <ClassId> does it)',
    );
  }
  return ds;
}

function pkgOf(ctx) {
  const pkg = ctx.pkg ?? ctx.requirePkg?.();
  if (!pkg) throw new Error('fd.dataset needs a package context');
  return pkg;
}

/** Helpers accept a registry entry OR a bare dataset name. */
function entryOf(pkg, idOrEntry) {
  if (idOrEntry && typeof idOrEntry === 'object') return idOrEntry;
  return pkg.entry(KIND, idOrEntry) ?? { kind: KIND, id: idOrEntry, path: adapter.pathFor(pkg, idOrEntry) };
}

const fileOf = (pkg, entry) => join(pkg.dir, entry.path ?? adapter.pathFor(pkg, entry.id));
const contentsKey = (entry) => `${entry.id}.jsonl`;
const contentFilePath = (pkg, docId) => join(pkg.dir, DIR, 'files', docId);

// ---------- server side ----------

/** All documents of the dataset's class -> Map(id -> canonical row). Paged search (max 200/page). */
async function readServerRows(ctx, ds) {
  const { core } = ctx.clients;
  const ids = [];
  let start = 0;
  for (;;) {
    const { found, results } = await core.search({ classId: ds.classId, fields: ['name'], max: 200, start });
    for (const r of results) ids.push(r.id);
    start += results.length;
    if (!results.length || start >= found) break;
  }
  const rows = new Map();
  for (const id of ids.sort(strCmp)) {
    const doc = await core.getDoc(id);
    if (doc) rows.set(String(doc.id), canonRow(doc, ds.classId));
  }
  return rows;
}

/** Upsert one row; returns the canonical SERVER ECHO row (base law: base = canon(server echo)). */
async function upsertRow(ctx, pkg, ds, row) {
  const doc = {
    id: row.id,
    name: row.name ?? row.id,
    category: 'DOCUMENT',
    data: { classId: ds.classId, ...(row.data?.ACL != null ? { ACL: row.data.ACL } : {}) },
    tags: row.tags ?? [],
  };
  const files = [];
  if (ds.content) {
    // content:true — each document carries one payload file, mirrored locally at data/files/<docId>;
    // attach it (fresh tmp per attempt inside upsertDoc — T00707) when the local copy exists.
    const p = contentFilePath(pkg, row.id);
    if (existsSync(p)) files.push({ bytes: readFileSync(p), filename: row.id, mime: 'application/octet-stream' });
  }
  await ctx.clients.core.upsertDoc(doc, files); // exists-check FIRST; F00033 etc. carry .explanation
  const echo = await ctx.clients.core.getDoc(row.id);
  return canonRow(echo ?? doc, ds.classId);
}

/** Shared loader for the row-level helpers. */
async function load(ctx, pkg, idOrEntry) {
  const entry = entryOf(pkg, idOrEntry);
  const ds = requireDataSet(pkg, entry.id);
  const targetName = ctx.target?.name;
  const localRead = adapter.readLocal(pkg, entry);
  const local = localRead?.rows ?? new Map();
  const server = await readServerRows(ctx, ds);
  const base = { ...(pkg.resState(targetName, KIND, entry.id)?.rows ?? {}) };
  return { entry, ds, targetName, localRead, local, server, base };
}

const wholeFileHash = (entry, ds, rows) =>
  rows.size
    ? hashResource(KIND, { name: entry.id, classId: ds.classId }, [Buffer.from(jsonlText(rows.values()))])
    : null;

// ---------- row-level sync helpers (used by `uxc data pull|push`; the generic engine treats the whole file) ----------

/**
 * Per-row 3-way classification vs the state rows map. Buckets (arrays of doc ids):
 *   added         — new on the SERVER (no base, absent locally): pull adds them
 *   removed       — base exists but the server row is gone (deleted remotely; pull drops with a notice)
 *   changedLocal  — push-direction work: local edit (server == base), NEW local rows, tombstones,
 *                   and local deletions without tombstone (listed, but push never deletes for them)
 *   changedServer — server edit (local == base): pull
 *   conflict      — both sides differ from base (or no-base collision with differing content)
 * In-sync / identical-both-sides rows appear in no bucket. Extra key `parseErrors` when the JSONL is broken.
 */
async function rowStatus(ctx, pkg, idOrEntry) {
  const { local, server, base, localRead } = await load(ctx, pkg, idOrEntry);
  const res = { added: [], removed: [], changedLocal: [], changedServer: [], conflict: [] };
  if (localRead?.parseErrors?.length) res.parseErrors = localRead.parseErrors;
  const ids = new Set([...local.keys(), ...server.keys(), ...Object.keys(base)]);
  for (const id of [...ids].sort(strCmp)) {
    const lRow = local.get(id) ?? null;
    if (isTombstone(lRow)) { res.changedLocal.push(id); continue; } // pending (or satisfied) delete — push handles it
    const lH = lRow ? rowHash(lRow) : null;
    const sH = server.has(id) ? rowHash(server.get(id)) : null;
    const bH = base[id] ?? null;
    if (lH && !sH && !bH) { res.changedLocal.push(id); continue; }     // new local row
    if (!lH && sH && !bH) { res.added.push(id); continue; }            // new server row
    if (lH && !sH && bH) { res.removed.push(id); continue; }           // deleted on server
    if (!lH && !sH && bH) { res.removed.push(id); continue; }          // gone both sides (stale base)
    if (!lH && sH && bH) { (sH === bH ? res.changedLocal : res.conflict).push(id); continue; } // deleted locally w/o tombstone
    if (lH === sH) continue;                                           // in sync (base recorded on next pull/push)
    if (!bH) { res.conflict.push(id); continue; }                      // no-base collision
    if (lH === bH) { res.changedServer.push(id); continue; }
    if (sH === bH) { res.changedLocal.push(id); continue; }
    res.conflict.push(id);
  }
  return res;
}

/**
 * Rewrite the local JSONL from the server rows, 3-way per row: local-only edits (new rows,
 * local edits, tombstones, conflicts) are KEPT unless force; server-deleted rows are dropped
 * with a printed notice. Updates state.rows + syncedHash. Returns the report.
 */
async function pullRows(ctx, pkg, idOrEntry, { force = false } = {}) {
  const { entry, ds, targetName, localRead, local, server, base } = await load(ctx, pkg, idOrEntry);
  if (localRead?.parseErrors?.length && !force) {
    throw new Error(`${KIND}/${entry.id}: local JSONL broken (${localRead.parseErrors.join('; ')}) — fix it or pull --force`);
  }
  const report = { added: [], updated: [], unchanged: 0, keptLocal: [], dropped: [], conflicts: [], tombstonesKept: [], tombstonesCleared: [] };
  const out = new Map(); // id -> row to write locally
  const newBase = {};    // id -> base hash to persist (stale bases drop automatically)

  const ids = new Set([...local.keys(), ...server.keys(), ...Object.keys(base)]);
  for (const id of [...ids].sort(strCmp)) {
    const lRow = local.get(id) ?? null;
    const tomb = isTombstone(lRow);
    const sRow = server.get(id) ?? null;
    const sH = sRow ? rowHash(sRow) : null;
    const lH = lRow && !tomb ? rowHash(lRow) : null;
    const bH = base[id] ?? null;

    if (!sRow) {
      if (tomb) { report.tombstonesCleared.push(id); continue; }           // satisfied tombstone -> drop the line
      if (!lRow) continue;                                                  // stale base, nothing anywhere
      if (bH) { ctx.out?.note?.(`dropped ${id} (deleted on server)`); report.dropped.push(id); continue; }
      if (force) { report.dropped.push(id); continue; }                     // force = mirror the server exactly
      out.set(id, lRow); report.keptLocal.push(id);                         // new local row -> keep for push
      continue;
    }
    if (tomb) {
      if (force) { out.set(id, sRow); newBase[id] = sH; report.updated.push(id); }
      else { out.set(id, lRow); if (bH) newBase[id] = bH; report.tombstonesKept.push(id); } // pending delete kept
      continue;
    }
    if (!lRow) {
      if (!bH || force) { out.set(id, sRow); newBase[id] = sH; report.added.push(id); continue; } // new on server
      if (sH === bH) { newBase[id] = bH; report.keptLocal.push(id); continue; } // deleted locally, server unchanged — kept deleted (tombstone it to delete server-side)
      newBase[id] = bH; report.conflicts.push(id);                            // deleted locally + server edited
      continue;
    }
    if (lH === sH) { out.set(id, sRow); newBase[id] = sH; report.unchanged++; continue; }
    if (force || (bH && lH === bH)) { out.set(id, sRow); newBase[id] = sH; report.updated.push(id); continue; } // server edit (or forced)
    if (bH && sH === bH) { out.set(id, lRow); newBase[id] = bH; report.keptLocal.push(id); continue; }          // local edit kept
    out.set(id, lRow); if (bH) newBase[id] = bH; report.conflicts.push(id);  // same-row divergence — kept local, base untouched
  }

  if (ds.content) {
    // content:true — mirror each pulled document's payload file to data/files/<docId>
    for (const id of [...report.added, ...report.updated]) {
      const bytes = await ctx.clients.core.getContent(id);
      if (bytes) {
        mkdirSync(join(pkg.dir, DIR, 'files'), { recursive: true });
        writeFileSync(contentFilePath(pkg, id), bytes);
      }
    }
  }

  adapter.writeLocal(pkg, entry, {
    obj: { name: entry.id, classId: ds.classId },
    contents: { [contentsKey(entry)]: Buffer.from(jsonlText(out.values())) },
  });
  pkg.setResState(targetName, KIND, entry.id, { rows: newBase, syncedHash: wholeFileHash(entry, ds, server) });

  if (report.conflicts.length) ctx.out?.warn?.(`${entry.id}: ${report.conflicts.length} row conflicts kept local — diff then data pull --force or edit + data push`);
  ctx.out?.note?.(`dataset ${entry.id}: +${report.added.length} ~${report.updated.length} kept ${report.keptLocal.length} dropped ${report.dropped.length} (=${report.unchanged})`);
  return report;
}

/**
 * Upsert changed/added local rows (core.upsertDoc). Server rows absent locally are NEVER
 * deleted unless (a) an explicit tombstone row {"_id":id,"_deleted":true} or (b) prune && yes
 * after the exact kill list is printed. state.rows is committed IMMEDIATELY after each
 * successful upsert/delete — a failure at row N leaves rows 1..N-1 synced (resumable).
 */
async function pushRows(ctx, pkg, idOrEntry, { prune = false, yes = false, force = false } = {}) {
  const { entry, ds, targetName, localRead, local, server, base } = await load(ctx, pkg, idOrEntry);
  if (localRead?.parseErrors?.length) {
    throw new Error(`${KIND}/${entry.id}: local JSONL broken — ${localRead.parseErrors.join('; ')}`);
  }
  const report = {
    created: [], updated: [], deleted: [], unchanged: 0,
    skippedConflict: [], skippedServerEdit: [], skippedDeletedOnServer: [],
    serverOnly: [], pruneCandidates: [], pruned: [],
  };
  const stateRows = { ...base };
  const saveRow = (id, h) => { // per-row immediate commit (resumable)
    if (h == null) delete stateRows[id]; else stateRows[id] = h;
    pkg.setResState(targetName, KIND, entry.id, { rows: { ...stateRows } });
  };
  const finalLocal = new Map(local);   // echo write-back container
  const finalServer = new Map(server); // best known canon(server) for syncedHash

  try {
    for (const id of [...local.keys()].sort(strCmp)) {
      const row = local.get(id);
      try {
        if (isTombstone(row)) {
          // explicit tombstone = the only default-path server delete
          if (server.has(id)) {
            await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(id)}`);
            report.deleted.push(id);
            ctx.out?.note?.(`deleted ${id} (tombstone)`);
          }
          finalLocal.delete(id); finalServer.delete(id); saveRow(id, null); // satisfied tombstone leaves the file
          continue;
        }
        const lH = rowHash(row);
        const sRow = server.get(id) ?? null;
        const sH = sRow ? rowHash(sRow) : null;
        const bH = base[id] ?? null;
        if (sH === lH) { saveRow(id, lH); report.unchanged++; continue; } // in sync / adopted / rebased — record base
        if (!sH) {
          if (bH && !force) { report.skippedDeletedOnServer.push(id); continue; } // deleted remotely; recreate only with --force
          const echo = await upsertRow(ctx, pkg, ds, row);
          finalLocal.set(id, echo); finalServer.set(id, echo); saveRow(id, rowHash(echo));
          report.created.push(id);
          continue;
        }
        if (!bH && !force) { report.skippedConflict.push(id); continue; }             // no-base collision
        if (bH && lH === bH) { report.skippedServerEdit.push(id); continue; }         // only server changed -> pull
        if (bH && sH !== bH && !force) { report.skippedConflict.push(id); continue; } // both changed
        const echo = await upsertRow(ctx, pkg, ds, row);
        finalLocal.set(id, echo); finalServer.set(id, echo); saveRow(id, rowHash(echo));
        report.updated.push(id);
      } catch (e) {
        e.message = `${KIND}/${entry.id} row ${id}: ${e.message}`; // .explanation (F00033…) rides along
        throw e;
      }
    }

    // server rows absent locally (no tombstone): never deleted by default
    const orphans = [...server.keys()].filter((id) => !local.has(id)).sort(strCmp);
    if (orphans.length && !prune) report.serverOnly = orphans;
    if (orphans.length && prune) {
      ctx.out?.warn?.(`data push --prune kill list for ${entry.id} (${orphans.length} server docs, class ${ds.classId}):`);
      for (const id of orphans) ctx.out?.warn?.(`  DELETE ${id}`);
      if (!yes) {
        report.pruneCandidates = orphans;
        ctx.out?.warn?.('prune: nothing deleted — re-run with --yes to confirm');
      } else {
        for (const id of orphans) {
          await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(id)}`);
          finalServer.delete(id); saveRow(id, null);
          report.pruned.push(id);
        }
      }
    }
  } finally {
    // persist echo write-backs + cleared tombstones even on mid-run failure (resumable),
    // sweep stale bases (rows gone on both sides), and record syncedHash = hash(canon(server)).
    for (const id of Object.keys(stateRows)) {
      if (!finalLocal.has(id) && !finalServer.has(id)) delete stateRows[id];
    }
    adapter.writeLocal(pkg, entry, {
      obj: { name: entry.id, classId: ds.classId },
      contents: { [contentsKey(entry)]: Buffer.from(jsonlText(finalLocal.values())) },
    });
    pkg.setResState(targetName, KIND, entry.id, { rows: { ...stateRows }, syncedHash: wholeFileHash(entry, ds, finalServer) });
  }

  const skipped = report.skippedConflict.length + report.skippedServerEdit.length + report.skippedDeletedOnServer.length;
  if (skipped) ctx.out?.warn?.(`${entry.id}: ${skipped} rows skipped (${report.skippedConflict.length} conflict, ${report.skippedServerEdit.length} server-edit — pull first, ${report.skippedDeletedOnServer.length} deleted-on-server — --force recreates)`);
  ctx.out?.note?.(`dataset ${entry.id}: +${report.created.length} ~${report.updated.length} -${report.deleted.length + report.pruned.length} =${report.unchanged}`);
  return report;
}

// ---------- the adapter ----------

const adapter = {
  kind: KIND,
  dir: DIR,
  layout: 'file', // one JSONL per dataset
  defaultPolicy: 'managed',
  cacheAffecting: false,
  // create/update delegate to pushRows, which writes the local JSONL + commits rows/syncedHash
  // itself. The generic push echo-leg must NOT re-read+overwrite the local file: dataset rows are
  // enumerated via search, which lags creation, so a post-create re-GET can drop not-yet-indexed
  // rows from the local file (verified data-loss, 2026-06-15).
  selfManagedWriteback: true,

  pathFor: (pkg, id) => dataSetOf(pkg, id)?.path ?? join(DIR, `${id}.jsonl`),

  /** Datasets are manifest-declared, not server-enumerable: list = the manifest entries. */
  async list(ctx) {
    const pkg = ctx.pkg ?? ctx.requirePkg?.();
    return (pkg?.manifest?.dataSets ?? []).map((d) => ({ id: d.name, classId: d.classId, path: d.path, content: !!d.content }));
  },

  async get(ctx, id) {
    const pkg = pkgOf(ctx);
    const ds = requireDataSet(pkg, id);
    const rows = await readServerRows(ctx, ds);
    return rows.size ? { name: id, classId: ds.classId, rows: rows.size } : null;
  },

  /** Whole-file push paths (generic engine): delegate to the row-level pushRows. */
  async create(ctx, local) {
    const pkg = pkgOf(ctx);
    const id = local?.id ?? local?.obj?.name;
    await pushRows(ctx, pkg, entryOf(pkg, id), {});
    return undefined; // state (rows + syncedHash) already written by pushRows
  },
  async update(ctx, id, local) { // eslint-disable-line no-unused-vars -- local file re-read inside pushRows
    const pkg = pkgOf(ctx);
    await pushRows(ctx, pkg, entryOf(pkg, id), {});
    return undefined;
  },

  /** rm --server / destroy: delete every server document of the dataset's class (per-id; no
   *  verified batch-delete endpoint — DESIGN's "batched ≤20" stays per-id with this fallback). */
  async remove(ctx, id) {
    const pkg = pkgOf(ctx);
    const ds = requireDataSet(pkg, id);
    const rows = await readServerRows(ctx, ds);
    for (const docId of [...rows.keys()].sort(strCmp)) {
      await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(docId)}`);
    }
    ctx.out?.note?.(`dataset ${id}: deleted ${rows.size} server documents`);
  },

  /** Server form: paged search on the dataset class -> getDoc each -> sorted canonical JSONL.
   *  Zero documents = dataset absent (null) — an empty dataset is indistinguishable server-side. */
  async readServer(ctx, idOrEntry) {
    const pkg = pkgOf(ctx);
    const entry = entryOf(pkg, idOrEntry);
    const ds = requireDataSet(pkg, entry.id);
    const rows = await readServerRows(ctx, ds);
    if (!rows.size) return null;
    return {
      obj: { name: entry.id, classId: ds.classId },
      contents: { [contentsKey(entry)]: Buffer.from(jsonlText(rows.values())) },
      rows,
    };
  },

  /** Local form: parse the JSONL -> canonical rows. contents = the SORTED canonical text (so
   *  hashing is insensitive to author-side row/key order); raw bytes only when unparseable. */
  readLocal(pkg, entry) {
    const ds = dataSetOf(pkg, entry.id);
    const p = fileOf(pkg, entry);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    const { rows, allIds, parseErrors } = parseRows(text, ds?.classId);
    const buf = parseErrors.length ? Buffer.from(text) : Buffer.from(jsonlText(rows.values()));
    return {
      id: entry.id,
      obj: { name: entry.id, classId: ds?.classId ?? null },
      contents: { [contentsKey(entry)]: buf },
      rows,        // Map(id -> canonical row), tombstones included
      allIds,      // every row id in file order (duplicate detection)
      parseErrors, // checked by validate()
    };
  },

  writeLocal(pkg, entry, { obj, contents } = {}) { // eslint-disable-line no-unused-vars
    const p = fileOf(pkg, entry);
    mkdirSync(dirname(p), { recursive: true });
    const buf = contents?.[contentsKey(entry)] ?? Object.values(contents ?? {})[0] ?? Buffer.from('');
    writeFileSync(p, buf);
  },

  removeLocal(pkg, entry) {
    const p = fileOf(pkg, entry);
    if (existsSync(p)) unlinkSync(p);
  },

  validate(pkg, entry, local) {
    const errs = [];
    const ds = dataSetOf(pkg, entry.id);
    if (!ds) {
      errs.push(`${entry.id}: no manifest dataSets entry — add {"name":"${entry.id}","classId":"<ClassId>","path":"data/${entry.id}.jsonl"} to uxopian-project.json`);
    } else if (!ds.classId) {
      errs.push(`${entry.id}: manifest dataSets entry has no classId`);
    }
    if (!local) return errs; // missing file is the engine's business
    for (const e of local.parseErrors ?? []) errs.push(`${entry.id}: ${e}`);
    const seen = new Set();
    for (const id of local.allIds ?? []) {
      if (seen.has(id)) errs.push(`${entry.id}: duplicate row id "${id}"`);
      seen.add(id);
    }
    if (ds?.classId) {
      for (const row of local.rows?.values() ?? []) {
        if (!isTombstone(row) && row.data?.classId && row.data.classId !== ds.classId) {
          errs.push(`${entry.id}: row ${row.id} has classId "${row.data.classId}" but the dataset class is "${ds.classId}"`);
        }
      }
    }
    return errs;
  },

  template(ctx, name, flags = {}) {
    // empty JSONL; rows are full canonical documents, one per line:
    //   {"category":"DOCUMENT","data":{"ACL":"acl-readonly","classId":"<ClassId>"},"id":"…","name":"…","tags":[{"name":"…","readOnly":false,"value":["…"]}]}
    // tombstone to delete a server doc: {"_deleted":true,"_id":"<docId>"}
    ctx.out?.note?.(
      `dataset "${name}": the manifest dataSets entry must exist — ` +
      `{"name":"${name}","classId":"${flags.class ?? '<ClassId>'}","path":"data/${name}.jsonl","content":false} ` +
      '(uxc add fd.dataset creates it with --class)',
    );
    return { obj: { name, classId: flags.class ?? null }, contents: { [`${name}.jsonl`]: Buffer.from('') } };
  },

  /** adopt --scan candidates: manifest dataSets not yet in the registry. */
  async scan(ctx, manifest) {
    return (manifest?.dataSets ?? [])
      .filter((d) => !ctx.pkg?.entry(KIND, d.name))
      .map((d) => ({ id: d.name, title: `${d.classId} -> ${d.path}` }));
  },

  // row-level sync helpers (data-pull / data-push commands)
  rowStatus,
  pullRows,
  pushRows,
};

export default adapter;
export { rowStatus, pullRows, pushRows };
