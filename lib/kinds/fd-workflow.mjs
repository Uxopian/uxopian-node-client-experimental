// fd.workflow — /rest/workflow. Full write support (docs pp.983-987).
//   create POST /rest/workflow            ARRAY body
//   get    GET  /rest/workflow/{id}        array-of-1
//   update POST /rest/workflow/{id}        ARRAY body, FULL-REPLACE (docs p.986: unset fields cleared)
//   delete DELETE /rest/workflow/{id}      (docs p.987: NO active-instance check — caller's job)
// DTO: { id, startTaskClass, taskClasses:[...] } — no category/data/displayNames.
//
// VERIFIED LIVE (2026-07-01, iris): `GET /rest/workflow` (get-ALL) returns 500 T00303 "All
// workflows cannot be fetched" — there is NO working list endpoint. So (like fd.vfinstance) reads
// are BY ID only: list()/scan() return [] and adoption is by explicit id. create/update/delete are
// DOCUMENTED but the round-trip was NOT live-verified (no server available at implementation time) —
// run `uxc doctor --roundtrip` / `uxc push` against a workflow-provisioned scope to confirm, then
// upgrade DESIGN §7 #7 to ✅. Canonicalization uses the generic cleanData (no data block to strip).
//
// Push-order caveat: a taskclass carries a `workflow` field and a workflow lists `taskClasses` — a
// mutual reference. uxc pushes taskclasses first, then workflows; if the server validates the
// taskclass->workflow ref at create, revisit PUSH_ORDER (verify live).
import { jsonLayout } from './base.mjs';

const kind = 'fd.workflow';
const dir = 'fd/workflows';

const adapter = {
  kind, dir, layout: 'json', restPath: 'workflow', defaultPolicy: 'managed', cacheAffecting: false,
  // GET /rest/workflow (get-all) 500s (T00303) — no list; adopt by id, like fd.vfinstance.
  async list() { return []; },
  async scan() { return []; },
  async get(ctx, id) {
    return ctx.clients.core.getOne(`/rest/workflow/${encodeURIComponent(id)}`);
  },
  async create(ctx, { obj }) {
    await ctx.clients.core.post('/rest/workflow', [obj]);
  },
  async update(ctx, id, { obj }) {
    // full-replace: send the whole workflow (unset fields are cleared server-side)
    await ctx.clients.core.post(`/rest/workflow/${encodeURIComponent(id)}`, [{ ...obj, id }]);
  },
  async remove(ctx, id) {
    await ctx.clients.core.del(`/rest/workflow/${encodeURIComponent(id)}`);
  },
  async readServer(ctx, id) {
    const obj = await adapter.get(ctx, id);
    return obj ? { obj } : null;
  },
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return errs;
    if (!o.startTaskClass) errs.push(`${entry.id}: startTaskClass is required`);
    if (!Array.isArray(o.taskClasses) || o.taskClasses.length === 0) {
      errs.push(`${entry.id}: taskClasses must be a non-empty array`);
    } else if (o.startTaskClass && !o.taskClasses.includes(o.startTaskClass)) {
      errs.push(`${entry.id}: taskClasses must include startTaskClass "${o.startTaskClass}"`);
    }
    return errs;
  },
  template(ctx, name, flags = {}) {
    // '--steps A,B,C [--start A]' -> { startTaskClass, taskClasses } (start defaults to the first step)
    const steps = flags.steps
      ? String(flags.steps).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const start = flags.start || steps[0] || '';
    const taskClasses = [...steps];
    if (start && !taskClasses.includes(start)) taskClasses.unshift(start);
    return { obj: { id: name, startTaskClass: start, taskClasses } };
  },
  ...jsonLayout({ kind, dir }),
};

export default adapter;
