// ai.mcp — MCP server configurations. CRUD /api/v1/admin/mcp/mcp-conf[/{id}] (hot-reload server-side).
// Secret masking: the server may echo secret header values as runs of asterisks ('********').
// Any string value of 8+ asterisks is normalized to '__masked__' in the canonical/local form (so
// pull/push echoes hash identically), and push resolves '__masked__' back to the LIVE server's
// current value at the same path — a placeholder is NEVER stored over a non-empty server secret.
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { prefixForms } from '../naming.mjs';

const BASE = '/api/v1/admin/mcp/mcp-conf';
const MASKED = '__masked__';
const MASK_RE = /^\*{8,}$/;

/** Deep string map preserving structure; fn(value, path) -> replacement. */
function mapStrings(v, fn, path = []) {
  if (typeof v === 'string') return fn(v, path);
  if (Array.isArray(v)) return v.map((x, i) => mapStrings(x, fn, [...path, i]));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = mapStrings(val, fn, [...path, k]);
    return out;
  }
  return v;
}

export const maskNormalize = (obj) => mapStrings(obj, (s) => (MASK_RE.test(s) ? MASKED : s));

function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Replace placeholder values ('__masked__' or asterisk runs) with the live server's value at the
 * same path. The live value may itself be the server's mask string — the server round-trips its
 * own mask as "keep the stored secret", which is exactly what we want. No live value -> hard error.
 */
function resolveMasks(obj, live, id) {
  const missing = [];
  const out = mapStrings(obj, (s, path) => {
    if (s !== MASKED && !MASK_RE.test(s)) return s;
    const liveVal = getPath(live ?? {}, path);
    if (typeof liveVal === 'string' && liveVal.length) return liveVal;
    missing.push(path.join('.'));
    return s;
  });
  if (missing.length) {
    throw new Error(`ai.mcp/${id}: masked secret(s) at [${missing.join(', ')}] have no live server value — put the real secret in the local file before pushing`);
  }
  return out;
}

async function mcpList(ctx) {
  ctx._mcpList ??= (await ctx.clients.gateway.get(BASE)) ?? [];
  return ctx._mcpList;
}
const invalidate = (ctx) => { ctx._mcpList = null; };

const layout = jsonLayout({ kind: 'ai.mcp', dir: 'ai/mcp' });

const adapter = {
  kind: 'ai.mcp',
  dir: 'ai/mcp',
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join('ai/mcp', `${id}.json`),

  async list(ctx) { return mcpList(ctx); },

  async get(ctx, id) {
    try {
      const one = await ctx.clients.gateway.tryGet(`${BASE}/${encodeURIComponent(id)}`);
      if (one) return one;
    } catch { /* single-get unsupported on some versions: fall back to the list */ }
    return (await mcpList(ctx)).find((c) => c.id === id) ?? null;
  },

  async readServer(ctx, id) {
    const conf = await adapter.get(ctx, id);
    return conf ? { obj: maskNormalize(conf) } : null;
  },

  readLocal: layout.readLocal,
  removeLocal: layout.removeLocal,
  writeLocal(pkg, entry, { obj }) {
    layout.writeLocal(pkg, entry, { obj: maskNormalize(obj) });
  },

  async create(ctx, { obj }) {
    // no live conf to merge from: a placeholder secret in a brand-new conf is a hard error
    await ctx.clients.gateway.post(BASE, resolveMasks(obj, null, obj.id));
    invalidate(ctx);
  },

  async update(ctx, id, { obj }) {
    const live = await adapter.get(ctx, id);
    const body = resolveMasks(obj, live, id);
    await ctx.clients.gateway.put(`${BASE}/${encodeURIComponent(id)}`, { ...body, id });
    invalidate(ctx);
  },

  async remove(ctx, id) {
    await ctx.clients.gateway.del(`${BASE}/${encodeURIComponent(id)}`);
    invalidate(ctx);
  },

  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj ?? {};
    if (o.id && o.id !== entry.id) errs.push(`id mismatch: file says "${o.id}", registry says "${entry.id}"`);
    return errs;
  },

  template(ctx, name, flags = {}) {
    return {
      obj: {
        id: name,
        name,
        url: flags.url ?? '',
        headers: {},
      },
    };
  },

  async scan(ctx, manifest) {
    const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
    return (await mcpList(ctx))
      .filter((c) => String(c.id ?? '').startsWith(forms.camel))
      .map((c) => ({ id: c.id, title: c.name }));
  },
};

export default adapter;
