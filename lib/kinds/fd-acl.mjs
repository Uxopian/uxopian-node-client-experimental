// fd.acl — /rest/acl. Full write support (docs pp.978-982).
//   create POST /rest/acl                  ARRAY body
//   get    GET  /rest/acl/{id}              array-of-1
//   update POST /rest/acl/{id}              ARRAY body, FULL-REPLACE
//   delete DELETE /rest/acl/{id}
// DTO: { id, name, entries:[{ principal, permission, grant }] } — no category/data block.
// `principal` '*' = everyone; `grant` = ALLOW | DENY.
//
// VERIFIED LIVE (2026-07-01, iris): `GET /rest/acl` (get-ALL) returns 500 T01006 "Could not get
// all ACLs" — there is NO working list endpoint. So (like fd.vfinstance) reads are BY ID only:
// list()/scan() return [] and adoption is by explicit id.
//
// VERIFIED LIVE (2026-07-15/16, fd.demo — LEARNINGS §37; re-verified 2026-10-01, fd.demo/IRIS — §48):
// create/update/delete work; a missing ACL GETs as 500 T01002 (in ABSENT_CODES so it classifies as
// create). The GET echo comes in TWO shapes:
//   - right after a REST write: a lazy `ACLProxy` {type, rules:[], id, name} — NO entries;
//   - an ACL the server has loaded from storage (CLM-imported, or a REST-created one later on):
//     a full `AccessControlList` {type, entries:[{principal:[…], permission:[…], grant}], id, name}
//     — principal and permission ALWAYS arrays.
// readServer therefore: (a) a full echo is authoritative (entries normalized to arrays);
// (b) a proxy echo is completed with the entries uxc LAST WROTE to this target (recorded in
// state at push, §48) — NOT the current local file: overlaying the local file made every local
// entry edit look like a server edit too, so status said `conflict` and push refused (#12).
// Only with no recorded entries (doctor/adopt, or a base recorded before uxc 0.25) does it fall
// back to the local file. Both sides normalize principal/permission to arrays (the local file may
// carry scalars — the server accepts both and echoes arrays).
import { jsonLayout } from './base.mjs';

const kind = 'fd.acl';
const dir = 'fd/acls';
const GRANTS = ['ALLOW', 'DENY'];

const arr = (v) => (v == null ? v : Array.isArray(v) ? v : [v]);
/** principal/permission scalar -> [scalar] (the server echoes arrays, accepts either). */
const normEntries = (entries) => (Array.isArray(entries)
  ? entries.map((e) => (e && typeof e === 'object' ? { ...e, principal: arr(e.principal), permission: arr(e.permission) } : e))
  : entries);
const normObj = (obj) => (obj && Array.isArray(obj.entries) ? { ...obj, entries: normEntries(obj.entries) } : obj);

/** Record the entries just written to this target, BEFORE the push echo leg re-reads (§48). */
function recordWritten(ctx, id, obj) {
  const patch = { entries: normEntries(obj?.entries) ?? null };
  try { if (ctx.pkg && ctx.target?.name) ctx.pkg.setResState(ctx.target.name, kind, id, patch); } catch { /* best-effort */ }
  return patch;
}

const files = jsonLayout({ kind, dir });

const adapter = {
  // NO `restPath` on purpose (#116): sync.statusAll batch-prefetches every kind carrying one with a
  // single list() call, and an empty list from a kind with no get-all (T01006) read as "every
  // resource deleted" -> status --remote said server-missing while diff said identical. Without
  // it, status reads per id through readServer — the same path as diff/push.
  kind, dir, layout: 'json', defaultPolicy: 'managed', cacheAffecting: false,
  // GET /rest/acl (get-all) 500s (T01006) — no list; adopt by id, like fd.vfinstance.
  async list() { return []; },
  async scan() { return []; },
  async get(ctx, id) {
    return ctx.clients.core.getOne(`/rest/acl/${encodeURIComponent(id)}`);
  },
  async create(ctx, { obj }) {
    await ctx.clients.core.post('/rest/acl', [obj]);
    return recordWritten(ctx, obj.id, obj);
  },
  async update(ctx, id, { obj }) {
    await ctx.clients.core.post(`/rest/acl/${encodeURIComponent(id)}`, [{ ...obj, id }]);
    return recordWritten(ctx, id, obj);
  },
  async remove(ctx, id) {
    await ctx.clients.core.del(`/rest/acl/${encodeURIComponent(id)}`);
  },
  async readServer(ctx, id) {
    const echo = await adapter.get(ctx, id);
    if (!echo) return null;
    // a full AccessControlList echo carries the entries: the server is authoritative
    if (Array.isArray(echo.entries) && echo.entries.length) return { obj: normObj(echo) };
    // ACLProxy echo (entries not readable): complete it with what uxc last wrote here; only
    // without a record fall back to the local file; no local either (doctor/adopt) -> as-is.
    const written = ctx.pkg?.resState?.(ctx.target?.name, kind, id)?.entries;
    if (Array.isArray(written)) return { obj: { ...echo, entries: normEntries(written) } };
    const local = ctx.pkg?.entry?.('fd.acl', id)
      ? adapter.readLocal(ctx.pkg, ctx.pkg.entry('fd.acl', id))?.obj ?? null
      : null;
    return { obj: local?.entries ? { ...echo, entries: normEntries(local.entries) } : echo };
  },
  /** adopt/rebase/pull record a base without pushing: record the entries it stands for (§48). */
  baseState: (local) => (Array.isArray(local?.obj?.entries) ? { entries: normEntries(local.obj.entries) } : {}),
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return errs;
    if (!Array.isArray(o.entries) || o.entries.length === 0) {
      errs.push(`${entry.id}: entries[] is required (non-empty)`);
      return errs;
    }
    o.entries.forEach((e, i) => {
      if (!e || !e.principal) errs.push(`${entry.id}: entries[${i}].principal is required ('*' = everyone)`);
      if (!e || !e.permission) errs.push(`${entry.id}: entries[${i}].permission is required`);
      if (e && e.grant && !GRANTS.includes(e.grant)) {
        errs.push(`${entry.id}: entries[${i}].grant must be ALLOW or DENY (got "${e.grant}")`);
      }
    });
    return errs;
  },
  template(ctx, name, flags = {}) {
    // '--entries "*:UPDATE_CONTENT:ALLOW,role_x:READ:DENY"' -> [{ principal, permission, grant }]
    const entries = flags.entries
      ? String(flags.entries).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
          const [principal, permission, grant] = item.split(':').map((s) => s.trim());
          return {
            principal: [principal || '*'],
            permission: [permission || 'READ'],
            grant: (grant || 'ALLOW').toUpperCase(),
          };
        })
      : [{ principal: ['*'], permission: ['READ'], grant: 'ALLOW' }];
    return { obj: { id: name, name: flags.title ?? name, entries } };
  },
  ...files,
  readLocal(pkg, entry) {
    const r = files.readLocal(pkg, entry);
    return r ? { ...r, obj: normObj(r.obj) } : r;
  },
};

export default adapter;
