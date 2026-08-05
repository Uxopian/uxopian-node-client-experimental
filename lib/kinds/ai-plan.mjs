// ai.plan — Uxopian AI agentic Plans (DAG of AGENT/DIRECT_TOOL/SUBPLAN nodes).
// CRUD /api/v1/admin/plans[/{id}] — a plain REST resource, no dialect/write-strategy quirks
// (unlike ai.prompt): POST create, PUT update (id in path AND body), DELETE, single-GET 404s
// cleanly. Local form: single JSON file, same shape the API accepts verbatim (jsonLayout).
//
// Running a plan is a separate action, not part of this CRUD lifecycle — see `uxc plan run`
// (the agentic analogue of `uxc f2 run` for fast2 maps: same split between "kind" sync and a
// bespoke execution command with its own polling/reporting).
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { prefixForms } from '../naming.mjs';

const BASE = '/api/v1/admin/plans';
const TOOL_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

async function planList(ctx) {
  ctx._planList ??= (await ctx.clients.gateway.get(BASE)) ?? [];
  return ctx._planList;
}
const invalidate = (ctx) => { ctx._planList = null; };

const layout = jsonLayout({ kind: 'ai.plan', dir: 'ai/plans' });

const adapter = {
  kind: 'ai.plan',
  dir: 'ai/plans',
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join('ai/plans', `${id}.json`),

  async list(ctx) { return planList(ctx); },

  async get(ctx, id) {
    const one = await ctx.clients.gateway.tryGet(`${BASE}/${encodeURIComponent(id)}`);
    if (one) return one;
    return (await planList(ctx)).find((p) => p.id === id) ?? null;
  },

  async readServer(ctx, id) {
    const p = await adapter.get(ctx, id);
    return p ? { obj: p } : null;
  },

  readLocal: layout.readLocal,
  writeLocal: layout.writeLocal,
  removeLocal: layout.removeLocal,

  async create(ctx, { obj }) {
    await ctx.clients.gateway.post(BASE, obj);
    invalidate(ctx);
  },

  async update(ctx, id, { obj }) {
    await ctx.clients.gateway.put(`${BASE}/${encodeURIComponent(id)}`, { ...obj, id });
    invalidate(ctx);
  },

  async remove(ctx, id) {
    await ctx.clients.gateway.del(`${BASE}/${encodeURIComponent(id)}`);
    invalidate(ctx);
  },

  // Mirrors PlanValidator.checkExposure server-side (agent/.../helpers/PlanValidator.java) so a
  // bad exposeAsTool config fails fast on push instead of a round-trip 400.
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj ?? {};
    if (o.id && o.id !== entry.id) errs.push(`id mismatch: file says "${o.id}", registry says "${entry.id}"`);
    if (o.exposeAsTool) {
      if (!o.toolDescription?.trim()) errs.push('exposeAsTool:true needs a non-blank toolDescription');
      if (!TOOL_SAFE_ID.test(entry.id)) errs.push(`exposeAsTool:true needs a tool-name-safe id ([a-zA-Z0-9_-]+) — "${entry.id}" is not`);
    }
    const ids = new Set((o.nodes ?? []).map((n) => n.id));
    for (const n of o.nodes ?? []) {
      for (const dep of n.dependencies ?? []) {
        if (!ids.has(dep)) errs.push(`node "${n.id}": dependency "${dep}" is not a node id in this plan`);
      }
    }
    return errs;
  },

  template(ctx, name, flags = {}) {
    // A stub AGENT node needs a real, pre-existing agentConfId to be executable (server-side
    // validation rejects a blank one) — a DIRECT_TOOL scaffold using a built-in tool works
    // out of the box instead, so `uxc push` right after `uxc add` has something that runs.
    return {
      obj: {
        id: name,
        description: flags.description ?? name,
        exposeAsTool: !!flags['expose-as-tool'],
        toolDescription: flags['tool-description'] ?? '',
        toolInputParameters: [
          { name: 'text', description: 'Input text', required: true },
        ],
        nodes: [
          {
            id: 'n1', name: 'n1', type: 'DIRECT_TOOL', toolName: 'chunkText',
            toolArgumentBindings: { content: 'text' }, outputKey: 'result', dependencies: [],
          },
        ],
      },
    };
  },

  async scan(ctx, manifest) {
    const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
    return (await planList(ctx))
      .filter((p) => String(p.id ?? '').startsWith(forms.camel))
      .map((p) => ({ id: p.id, title: p.description }));
  },
};

export default adapter;
