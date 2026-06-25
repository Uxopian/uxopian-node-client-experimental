// Shared adapter building blocks.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stableStringify, fdTimestamp } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';

/** Read/write single-JSON-file resources at <pkgDir>/<adapter.dir>/<id>.json. */
export function jsonLayout(adapter) {
  return {
    pathFor: (pkg, id) => join(adapter.dir, `${id}.json`),
    readLocal(pkg, entry) {
      const p = join(pkg.dir, entry.path);
      if (!existsSync(p)) return null;
      return { obj: JSON.parse(readFileSync(p, 'utf8')) };
    },
    writeLocal(pkg, entry, { obj }) {
      const p = join(pkg.dir, entry.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, stableStringify(canonicalize(adapter.kind, obj)));
    },
    removeLocal(pkg, entry) {
      const p = join(pkg.dir, entry.path);
      if (existsSync(p)) unlinkSync(p);
    },
  };
}

/**
 * Factory for the five class-style Core REST kinds (+ tagcategory): identical verb pattern,
 * all verified live:
 *   list   GET  /rest/<restPath>           -> array of FULL objects
 *   get    GET  /rest/<restPath>/{id}      -> array of 1
 *   create POST /rest/<restPath>           -> ARRAY body  (F00903 when exists)
 *   update POST /rest/<restPath>/{id}      -> ARRAY body, id in path, FULL-REPLACE
 *   delete DELETE /rest/<restPath>/{id}
 * The local file is authoritative for managed fields; `data` block is completed with
 * owner/creationDate when absent (create) and volatile fields are never round-tripped.
 */
export function classKindAdapter({ kind, dir, restPath, defaultPolicy = 'managed', category, validate, template, scanFilter, inPlaceUpdate = false }) {
  // inPlaceUpdate: for `createOnly` kinds (fd.taskclass) where a same-id POST /{id} full-replace is
  // binding-safe but delete+recreate is NOT (LEARNINGS §14/§20). It opens ONLY the update path in
  // sync.pushOne; the policy stays `createOnly`, so rm.mjs keeps gating server delete behind --force.
  const adapter = {
    kind, dir, restPath, layout: 'json', defaultPolicy, cacheAffecting: false, inPlaceUpdate,
    async list(ctx) {
      return (await ctx.clients.core.get(`/rest/${restPath}`)) ?? [];
    },
    async get(ctx, id) {
      return ctx.clients.core.getOne(`/rest/${restPath}/${encodeURIComponent(id)}`);
    },
    async create(ctx, { obj }) {
      const body = { ...obj };
      if (category && !body.category) body.category = category;
      // class kinds need a valid security object or create 500s F00208
      const needsAcl = category != null;
      body.data = {
        owner: ctx.target.user, creationDate: fdTimestamp(), lastUpdateDate: fdTimestamp(),
        ...(needsAcl ? { ACL: 'acl-readonly' } : {}),
        ...body.data,
      };
      await ctx.clients.core.post(`/rest/${restPath}`, [body]);
    },
    async update(ctx, id, { obj }) {
      // local-authoritative full replace: server contributes ONLY volatile/server-owned fields
      const server = await adapter.get(ctx, id);
      const body = { ...obj };
      if (category && !body.category) body.category = category;
      body.data = { ...server?.data, ...obj.data };
      await ctx.clients.core.post(`/rest/${restPath}/${encodeURIComponent(id)}`, [body]);
    },
    async remove(ctx, id) {
      await ctx.clients.core.del(`/rest/${restPath}/${encodeURIComponent(id)}`);
    },
    async readServer(ctx, id) {
      const obj = await adapter.get(ctx, id);
      return obj ? { obj } : null;
    },
    validate: validate ?? (() => []),
    template: template ?? ((ctx, name) => ({ obj: { id: name } })),
    async scan(ctx, manifest) {
      const all = await adapter.list(ctx);
      const { looksOwned } = await import('../naming.mjs');
      return all
        .filter((o) => looksOwned(manifest, o.id) && (!scanFilter || scanFilter(o)))
        .map((o) => ({ id: o.id, title: o.displayNames?.[0]?.value }));
    },
    ...jsonLayout({ kind, dir }),
  };
  return adapter;
}

/** Upsert-or-create a FlowerDocs *document* carrying content files (Script/GUIConfiguration/handler).
 *  Exists-check FIRST (T00707), fresh tmp per attempt, update-in-place keeps tags. */
export async function pushContentDoc(ctx, { id, name, classId, acl = 'acl-readonly', tags = [], files }) {
  const { core } = ctx.clients;
  const fileSpecs = files.map((f) => ({ bytes: f.bytes, filename: f.filename, mime: f.mime, name: f.name }));
  return core.upsertDoc(
    {
      id, name: name ?? id, category: 'DOCUMENT',
      data: { classId, ACL: acl, owner: ctx.target.user, creationDate: fdTimestamp(), lastUpdateDate: fdTimestamp() },
      tags,
    },
    fileSpecs,
  );
}
