// ai.llm — LLM provider configurations. CRUD /api/v1/admin/llm/provider-conf[/{id}].
// A conf = { id/provider, defaultLlmModelConfName, globalConf:{apiSecret,…}, llModelConfs:[…] }.
// Secret masking (same contract as ai.mcp): the server echoes apiSecret as a run of asterisks
// ('********'); any 8+-asterisk string is normalized to '__masked__' in the canonical/local form
// (so pull/push hash identically AND no API key is ever written to the package). On push,
// '__masked__' resolves back to the LIVE server value at the same path — so a placeholder never
// overwrites a real stored secret, and a brand-new install ships NO key (operator sets it after).
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { prefixForms } from '../naming.mjs';

const BASE = '/api/v1/admin/llm/provider-conf';
const MASKED = '__masked__';
const MASK_RE = /^\*{8,}$/;

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

// server-managed audit fields — never part of the portable config
const STRIP = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy'];

const maskNormalize = (obj) => mapStrings(obj, (s) => (MASK_RE.test(s) ? MASKED : s));

// canonical, portable form: id-normalized, audit fields dropped, secrets masked
function canonical(conf) {
  const c = withId(conf) ?? {};
  const out = {};
  for (const [k, v] of Object.entries(c)) if (!STRIP.includes(k)) out[k] = v;
  return maskNormalize(out);
}

// the conf id: the server keys by provider; keep whichever the object carries
const idOf = (conf) => conf?.id ?? conf?.provider;
const withId = (conf) => (conf && idOf(conf) != null ? { id: idOf(conf), ...conf } : conf);

function getPath(obj, path) {
  let cur = obj;
  for (const k of path) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

function resolveMasks(obj, live, id) {
  const missing = [];
  const out = mapStrings(obj, (s, path) => {
    if (s !== MASKED && !MASK_RE.test(s)) return s;
    const liveVal = getPath(live ?? {}, path);
    if (typeof liveVal === 'string' && liveVal.length) return liveVal;
    missing.push(path.join('.'));
    return '';   // no live secret (fresh install): ship an EMPTY key — operator sets it post-install
  });
  if (missing.length) out.__maskedSecrets = missing; // informational; server ignores unknown field? — strip below
  delete out.__maskedSecrets;
  return out;
}

async function llmList(ctx) {
  if (ctx._llmList != null) return ctx._llmList;
  let list = null;
  try { list = await ctx.clients.gateway.tryGet(BASE); } catch { list = null; }
  ctx._llmList = Array.isArray(list) ? list.map(withId) : [];
  return ctx._llmList;
}
const invalidate = (ctx) => { ctx._llmList = null; };

const layout = jsonLayout({ kind: 'ai.llm', dir: 'ai/llm' });

const adapter = {
  kind: 'ai.llm',
  dir: 'ai/llm',
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join('ai/llm', `${id}.json`),

  async list(ctx) { return llmList(ctx); },

  async get(ctx, id) {
    try {
      const one = await ctx.clients.gateway.tryGet(`${BASE}/${encodeURIComponent(id)}`);
      if (one) return withId(one);
    } catch { /* fall back to the list */ }
    return (await llmList(ctx)).find((c) => idOf(c) === id) ?? null;
  },

  async readServer(ctx, id) {
    const conf = await adapter.get(ctx, id);
    return conf ? { obj: canonical(conf) } : null;
  },

  readLocal: layout.readLocal,
  removeLocal: layout.removeLocal,
  writeLocal(pkg, entry, { obj }) {
    layout.writeLocal(pkg, entry, { obj: canonical(obj) });
  },

  async create(ctx, { obj }) {
    await ctx.clients.gateway.post(BASE, resolveMasks(withId(obj), null, idOf(obj)));
    invalidate(ctx);
  },

  async update(ctx, id, { obj }) {
    const live = await adapter.get(ctx, id);
    const body = resolveMasks(withId(obj), live, id);
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
    const oid = idOf(o);
    if (oid && oid !== entry.id) errs.push(`id mismatch: file says "${oid}", registry says "${entry.id}"`);
    if (!o.provider) errs.push(`${entry.id}: missing "provider" (the LLM provider type, e.g. openai / mistral-ai)`);
    if (!Array.isArray(o.llModelConfs) || o.llModelConfs.length === 0) errs.push(`${entry.id}: no llModelConfs (models) defined`);
    return errs;
  },

  template(ctx, name, flags = {}) {
    return {
      obj: {
        id: name,
        provider: flags.provider ?? name,
        defaultLlmModelConfName: flags.default ?? '',
        globalConf: { apiSecret: '', timeout: 60000, temperature: 0.7, maxRetries: 3 },
        llModelConfs: [],
      },
    };
  },

  async scan(ctx, manifest) {
    // provider ids (openai / mistral-ai) don't follow a package prefix; surface all confs
    const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
    return (await llmList(ctx))
      .filter((c) => !forms.camel || true)
      .map((c) => ({ id: idOf(c), title: c.name ?? c.provider ?? idOf(c) }));
  },
};

export default adapter;
