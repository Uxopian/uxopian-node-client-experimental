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
import { capabilities } from '../dialects.mjs';

const kind = 'fd.vfinstance';
const dir = 'fd/vfinstances';

const adapter = {
  kind, dir, layout: 'json', defaultPolicy: 'createOnly', cacheAffecting: false,
  // Enumeration goes through POST /rest/virtualFolder/search — the SAME body shape as the
  // document search (verified fd.demo/default 2026-09-10: 98 folders, criteria + paging + order
  // all behave). Until then list() returned [] unconditionally, so `uxc ls fd.vfinstance` printed
  // "0 fd.vfinstance" on a scope full of them while `status --remote` listed fourteen as drifting
  // — an agent trusting `ls` concluded the instance was empty (BACKLOG #19).
  async list(ctx) {
    const { results } = await ctx.clients.core.searchAll({
      fields: ['name', 'classid'], category: 'virtualfolder', max: 2000,
    });
    return results.map((r) => ({ id: r.id, name: r.fields.name, classId: r.fields.classid }));
  },
  async scan(ctx, manifest) {
    const { looksOwned } = await import('../naming.mjs');
    return (await adapter.list(ctx))
      .filter((r) => r.id && looksOwned(manifest, r.id))
      .map((r) => ({ id: r.id, title: r.name }));
  },
  async get(ctx, id) {
    return ctx.clients.core.getOne(`/rest/virtualFolder/${encodeURIComponent(id)}`);
  },
  async create(ctx, { obj }) {
    const body = { ...obj };
    if (!body.category) body.category = 'VIRTUAL_FOLDER';
    body.data = { owner: ctx.target.user, creationDate: fdTimestamp(), lastUpdateDate: fdTimestamp(), ...body.data };
    // The create path differs per FD version: 2025 wants the trailing slash, 2026 404s it. The
    // DIALECT picks the first attempt (lib/dialects.mjs: caps.vfInstanceCreatePath); the 404/405
    // fallback to the sibling form stays as the safety net for misdetected versions.
    const { caps } = await capabilities(ctx, 'flowerdocs');
    const first = caps.vfInstanceCreatePath ?? '/rest/virtualFolder';
    const other = first.endsWith('/') ? first.slice(0, -1) : `${first}/`;
    try {
      await ctx.clients.core.post(first, [body]);
    } catch (e) {
      if (e?.status !== 404 && e?.status !== 405) throw e;
      await ctx.clients.core.post(other, [body]);
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
