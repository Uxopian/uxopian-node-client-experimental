// fd.vfinstance — virtual folder INSTANCES are components, not classes (learnings §15):
//   create POST /rest/virtualFolder       (capital F, ARRAY body). FD 2026 needs NO trailing slash
//                                           (it 404s the slash form, verified fd.demo); FD 2025 used
//                                           the trailing-slash form. create() tries no-slash then
//                                           falls back to the slash form on 404/405 — one client,
//                                           both versions (we can't retest FD 2025, so don't assume).
//   get    GET  /rest/virtualFolder/{id}  (array-of-1)
//   update POST /rest/virtualFolder/{id}  (ARRAY body, same pattern as other components)
//   delete DELETE /rest/virtualFolder/{id}
import { jsonLayout } from './base.mjs';
import { fdTimestamp } from '../util.mjs';

const kind = 'fd.vfinstance';
const dir = 'fd/vfinstances';

const adapter = {
  kind, dir, layout: 'json', defaultPolicy: 'createOnly', cacheAffecting: false,
  // VF instances have no verified list — adopt by id.
  async list() { return []; },
  async scan() { return []; },
  async get(ctx, id) {
    return ctx.clients.core.getOne(`/rest/virtualFolder/${encodeURIComponent(id)}`);
  },
  async create(ctx, { obj }) {
    const body = { ...obj };
    if (!body.category) body.category = 'VIRTUAL_FOLDER';
    body.data = { owner: ctx.target.user, creationDate: fdTimestamp(), lastUpdateDate: fdTimestamp(), ...body.data };
    // FD 2026 wants the no-slash path (404s the slash form); FD 2025 used the slash form. Try 2026,
    // fall back to 2025 on 404/405 — dual-compatible without knowing the server version.
    try {
      await ctx.clients.core.post('/rest/virtualFolder', [body]);
    } catch (e) {
      if (e?.status !== 404 && e?.status !== 405) throw e;
      await ctx.clients.core.post('/rest/virtualFolder/', [body]);
    }
  },
  async update(ctx, id, { obj }) {
    const server = await adapter.get(ctx, id);
    const body = { ...obj };
    if (!body.category) body.category = 'VIRTUAL_FOLDER';
    body.data = { ...server?.data, ...obj.data };
    await ctx.clients.core.post(`/rest/virtualFolder/${encodeURIComponent(id)}`, [body]);
  },
  async remove(ctx, id) {
    await ctx.clients.core.del(`/rest/virtualFolder/${encodeURIComponent(id)}`);
  },
  async readServer(ctx, id) {
    const obj = await adapter.get(ctx, id);
    return obj ? { obj } : null;
  },
  validate(pkg, entry, local) {
    const errs = [];
    if (local?.obj && !local.obj.data?.classId) {
      errs.push(`${entry.id}: data.classId (the VF class id) is required`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    return {
      obj: {
        id: name,
        name: flags.name ?? name,
        category: 'VIRTUAL_FOLDER',
        data: { classId: flags.class ?? '' },
        tags: [],
      },
    };
  },
  ...jsonLayout({ kind, dir }),
};

export default adapter;
