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
// VERIFIED LIVE (2026-07-15/16, fd.demo — LEARNINGS §37): create/update/delete work; a missing
// ACL GETs as 500 T01002 (in ABSENT_CODES so it classifies as create). BUT the GET echo is a
// lazy `ACLProxy` {type, rules:[], id, name} — the ENTRIES ARE NEVER ECHOED (write-only over
// Core REST). readServer therefore OVERLAYS the echo onto the locally-authored entries (same
// pattern as ai-prompt's lossy user-list): server is authoritative for existence/id/name, the
// package for entries. Consequences: (a) the push echo-leg cannot strip entries from the local
// file; (b) server-side ENTRY drift is undetectable — sync sees id/name only; (c) adopting a
// foreign ACL yields a stub whose entries must be authored (validate flags it).
import { jsonLayout } from './base.mjs';

const kind = 'fd.acl';
const dir = 'fd/acls';
const GRANTS = ['ALLOW', 'DENY'];

const adapter = {
  kind, dir, layout: 'json', restPath: 'acl', defaultPolicy: 'managed', cacheAffecting: false,
  // GET /rest/acl (get-all) 500s (T01006) — no list; adopt by id, like fd.vfinstance.
  async list() { return []; },
  async scan() { return []; },
  async get(ctx, id) {
    return ctx.clients.core.getOne(`/rest/acl/${encodeURIComponent(id)}`);
  },
  async create(ctx, { obj }) {
    await ctx.clients.core.post('/rest/acl', [obj]);
  },
  async update(ctx, id, { obj }) {
    await ctx.clients.core.post(`/rest/acl/${encodeURIComponent(id)}`, [{ ...obj, id }]);
  },
  async remove(ctx, id) {
    await ctx.clients.core.del(`/rest/acl/${encodeURIComponent(id)}`);
  },
  async readServer(ctx, id) {
    const echo = await adapter.get(ctx, id);
    if (!echo) return null;
    // entries are write-only (§37): backfill them from the local file so echo-leg writes and
    // hash comparisons operate on the full object. No local (doctor/adopt) -> proxy as-is.
    const local = ctx.pkg?.entry?.('fd.acl', id)
      ? adapter.readLocal(ctx.pkg, ctx.pkg.entry('fd.acl', id))?.obj ?? null
      : null;
    return { obj: local?.entries ? { ...echo, entries: local.entries } : echo };
  },
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
            principal: principal || '*',
            permission: permission || 'READ',
            grant: (grant || 'ALLOW').toUpperCase(),
          };
        })
      : [{ principal: '*', permission: 'READ', grant: 'ALLOW' }];
    return { obj: { id: name, name: flags.title ?? name, entries } };
  },
  ...jsonLayout({ kind, dir }),
};

export default adapter;
