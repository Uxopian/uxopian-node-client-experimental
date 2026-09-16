// Shared plumbing for the Agentic Plan engine kinds — ai.agent and ai.plan (uxopian-ai
// 2026.0.0-ft5+, dialect cap `agenticPlans`). Verified CRUD, AI learnings §A13 (fd.demo, 2026-09-16):
//   list   GET    <base>        -> array of FULL objects
//   get    GET    <base>/{id}   -> object; 404 when absent
//   create POST   <base>        -> 201 with an EMPTY body; an existing id is a 400 "already exists"
//                                  (NOT a 409 like prompts)
//   update PUT    <base>/{id}   -> 200, FULL REPLACE: a field left out comes back null
//   delete DELETE <base>/{id}   -> 204; 404 when absent
// The gateway checks NO references: an agent may name a prompt that does not exist, a plan an
// agent that does not exist, and deleting an agent a plan still uses succeeds. Reference lints are
// therefore uxc's job (lib/lint.mjs lintAgentic) — the server only fails when the plan RUNS.
import { capabilities } from '../dialects.mjs';
import { HttpError } from '../http.mjs';
import { prefixForms } from '../naming.mjs';

/** The gateway refuses ids holding whitespace, control characters, '/' or '\' (400, verified). */
export const ILLEGAL_ID_RE = /[\s\x00-\x1f\x7f/\\]/;

/** Dialect gate: null when this gateway runs the Agentic Plan engine, else the reason it does not. */
export async function agenticSupport(ctx, kind) {
  const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
  if (caps.agenticPlans) return null;
  return `${kind} needs uxopian-ai 2026.0.0-ft5+ (Agentic Plan engine) — this gateway resolves to dialect ${dialect}`;
}

/**
 * The CRUD half of an admin-conf kind adapter (agents, plans, applications). Lists are cached per
 * ctx and dropped on every write. `support(ctx)` is the kind's dialect gate; `conflictStatus` is
 * how the endpoint refuses an existing id on create (agents/plans 400, applications 409).
 */
export function agenticCrud({ kind, base, support = (ctx) => agenticSupport(ctx, kind), conflictStatus = 400 }) {
  const cacheKey = `_${kind.replace('.', '_')}List`;
  const path = (id) => `${base}/${encodeURIComponent(id)}`;
  const invalidate = (ctx) => { ctx[cacheKey] = null; };
  const assertSupported = async (ctx) => {
    const reason = await support(ctx);
    if (reason) throw new Error(reason);
  };

  const crud = {
    async list(ctx) {
      await assertSupported(ctx);
      ctx[cacheKey] ??= (await ctx.clients.gateway.get(base)) ?? [];
      return ctx[cacheKey];
    },
    async get(ctx, id) {
      await assertSupported(ctx);
      return (await ctx.clients.gateway.tryGet(path(id))) ?? null;
    },
    async create(ctx, body) {
      try {
        await ctx.clients.gateway.post(base, body);
      } catch (e) {
        // exists after all (stale read, or a concurrent push): the same body as a full replace
        if (e instanceof HttpError && e.status === conflictStatus && /already exists/i.test(JSON.stringify(e.body ?? e.message))) {
          await ctx.clients.gateway.put(path(body.id), body);
        } else throw e;
      }
      invalidate(ctx);
    },
    async update(ctx, id, body) {
      await ctx.clients.gateway.put(path(id), { ...body, id });
      invalidate(ctx);
    },
    async remove(ctx, id) {
      if (await support(ctx)) return; // no such concept on this server: nothing to delete
      try {
        await ctx.clients.gateway.del(path(id));
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e; // already gone
      }
      invalidate(ctx);
    },
    async scan(ctx, manifest) {
      const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
      return (await crud.list(ctx))
        .filter((o) => String(o.id ?? '').startsWith(forms.camel) && /^[a-z]+[A-Z]/.test(String(o.id)))
        .map((o) => ({ id: o.id, title: o.description ?? undefined }));
    },
  };
  return crud;
}

/** Shared id checks: registry/file agreement + the gateway's illegal characters. */
export function idErrors(entry, obj) {
  const errs = [];
  if (obj.id && obj.id !== entry.id) errs.push(`id mismatch: file says "${obj.id}", registry says "${entry.id}"`);
  if (ILLEGAL_ID_RE.test(entry.id)) errs.push(`id "${entry.id}" holds whitespace, a control character, '/' or '\\' — the gateway rejects it (400)`);
  return errs;
}

/**
 * Network lint (WARNINGS, never blocking): tool names and tool tags a permissions block names that
 * the gateway does not register (GET /api/v1/admin/tools -> [{name, description, params, tags}],
 * 51 tools tagged alfresco/flowerdocs/filenet/interaction/text/files on fd.demo). A typo there is
 * silent: the tool is simply never exposed. `extraToolNames` = DIRECT_TOOL node tool names.
 */
export async function toolWarnings(ctx, permissions, extraToolNames = []) {
  const p = permissions ?? {};
  const names = [...(p.allowedTools ?? []), ...(p.deniedTools ?? []), ...extraToolNames].filter(Boolean);
  const tags = (p.allowedToolTags ?? []).filter(Boolean);
  if (!names.length && !tags.length) return [];
  if (ctx._nativeTools === undefined) {
    try { ctx._nativeTools = (await ctx.clients.gateway.get('/api/v1/admin/tools')) ?? null; } catch { ctx._nativeTools = null; }
  }
  if (!Array.isArray(ctx._nativeTools)) return []; // endpoint unavailable: skip the lint
  const known = new Set(ctx._nativeTools.map((t) => t.name));
  const knownTags = new Set(ctx._nativeTools.flatMap((t) => t.tags ?? []));
  return [
    ...[...new Set(names)].filter((n) => !known.has(n)).map((n) => `tool "${n}" is not a native tool on this gateway (uxc ls ai.tool)`),
    ...[...new Set(tags)].filter((t) => !knownTags.has(t)).map((t) => `tool tag "${t}" matches no native tool on this gateway (known: ${[...knownTags].sort().join(', ')})`),
  ];
}
