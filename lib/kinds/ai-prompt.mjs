// ai.prompt — Uxopian AI prompts. Local form: meta JSON (every field EXCEPT content) at
// ai/prompts/<id>.json + the content VERBATIM at ai/prompts/<id>.content.md.
// Reads go through the USER list endpoint (admin GET /prompts 500s — learnings §8/§17);
// writes go through the admin endpoints (POST, 409 -> PUT with id in body).
//
// LOSSY-READ HAZARD: the user list endpoint can return a REDUCED projection of a prompt — on some
// gateway builds only id + content, dropping the admin config (role, defaultLlmProvider,
// defaultLlmModel, temperature, reasoningDisabled, requires*, timeSaved). The generic echo law
// ("base = canon(server echo)") would then overwrite the local meta with that stub on the push
// echo-leg writeback (and show false drift in status), silently losing the prompt's configuration.
// Fix: readServer OVERLAYS the echo on the locally-authored meta — server-returned fields stay
// authoritative (drift on them is still detected), fields the endpoint omits are preserved from
// local. So push/pull/status never reduce a prompt below what was authored.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stableStringify } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';
import { prefixForms } from '../naming.mjs';
import { HttpError } from '../http.mjs';

const DIR = 'ai/prompts';
const contentPathOf = (jsonPath) => jsonPath.replace(/\.json$/, '.content.md');

async function promptList(ctx) {
  ctx._promptList ??= (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
  return ctx._promptList;
}
const invalidate = (ctx) => { ctx._promptList = null; };

/** The locally-authored prompt object ({...meta, content}) for `id`, or null if there's no package
 *  / no local file. Used by readServer to backfill fields a lossy read endpoint omits. */
function readLocalMeta(ctx, id) {
  const entry = ctx.pkg?.entry?.('ai.prompt', id);
  if (!entry) return null;
  return adapter.readLocal(ctx.pkg, entry)?.obj ?? null;
}

const HELPER_CALL_RE = /\[\[\$\{\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

const adapter = {
  kind: 'ai.prompt',
  dir: DIR,
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join(DIR, `${id}.json`),

  async list(ctx) { return promptList(ctx); },
  async get(ctx, id) { return (await promptList(ctx)).find((p) => p.id === id) ?? null; },

  async readServer(ctx, id) {
    const p = await adapter.get(ctx, id);
    if (!p) return null;
    // Overlay the (possibly reduced) server echo on the local meta so a lossy projection can't drop
    // authored config. Server-present keys win (drift detection intact); omitted keys fall back to
    // local. obj INCLUDES content — both sides hash the joined form.
    const local = readLocalMeta(ctx, id);
    return { obj: local ? { ...local, ...p } : p };
  },

  readLocal(pkg, entry) {
    const metaPath = join(pkg.dir, entry.path);
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const cPath = join(pkg.dir, contentPathOf(entry.path));
    const content = existsSync(cPath) ? readFileSync(cPath, 'utf8') : '';
    return { obj: { ...meta, content } };
  },

  writeLocal(pkg, entry, { obj }) {
    const { content = '', ...meta } = canonicalize(adapter.kind, obj);
    const metaPath = join(pkg.dir, entry.path);
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, stableStringify(meta));
    writeFileSync(join(pkg.dir, contentPathOf(entry.path)), content); // verbatim — no normalization
  },

  removeLocal(pkg, entry) {
    for (const p of [join(pkg.dir, entry.path), join(pkg.dir, contentPathOf(entry.path))]) {
      if (existsSync(p)) unlinkSync(p);
    }
  },

  async create(ctx, local) {
    await maybeLintHelpers(ctx, local);
    try {
      await ctx.clients.gateway.post('/api/v1/admin/prompts', local.obj);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        await ctx.clients.gateway.put('/api/v1/admin/prompts', local.obj); // already exists: same body, id in body
      } else throw e;
    }
    invalidate(ctx);
  },

  async update(ctx, id, local) {
    await maybeLintHelpers(ctx, local);
    await ctx.clients.gateway.put('/api/v1/admin/prompts', { ...local.obj, id }); // id in BODY, not path
    invalidate(ctx);
  },

  async remove(ctx, id) {
    await ctx.clients.gateway.del(`/api/v1/admin/prompts/${encodeURIComponent(id)}`);
    invalidate(ctx);
  },

  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj ?? {};
    if (o.id && o.id !== entry.id) errs.push(`id mismatch: file says "${o.id}", registry says "${entry.id}"`);
    if (!o.role) errs.push('role is required (USER|SYSTEM)');
    if (o.requiresFunctionCallingModel === true && o.reasoningDisabled !== false) {
      errs.push('requiresFunctionCallingModel:true needs EXPLICIT reasoningDisabled:false (absent = Java default true -> "Function calling cannot be required when reasoning is disabled")');
    }
    return errs;
  },

  /**
   * Best-effort helper-call lint: extract [[${service.method(…)}]] tokens from the content and
   * check them against the live templating catalogue. Returns WARNING strings (never blocks).
   */
  async lintHelpers(ctx, local) {
    const calls = [...String(local?.obj?.content ?? '').matchAll(HELPER_CALL_RE)].map((m) => `${m[1]}.${m[2]}`);
    if (!calls.length) return [];
    if (ctx._templatingCatalog === undefined) {
      try {
        ctx._templatingCatalog = JSON.stringify((await ctx.clients.gateway.get('/api/v1/admin/templating/completion')) ?? '');
      } catch { ctx._templatingCatalog = null; } // endpoint unavailable: skip the lint
    }
    if (!ctx._templatingCatalog) return [];
    return [...new Set(calls)]
      .filter((c) => !ctx._templatingCatalog.includes(c) && !ctx._templatingCatalog.includes(c.split('.')[1]))
      .map((c) => `unknown helper call [[\${${c}(…)}]] — not found in templating completion`);
  },

  template(ctx, name, flags = {}) {
    const fcm = !!flags.fcm;
    return {
      obj: {
        id: name,
        role: 'USER',
        content: '',
        defaultLlmProvider: 'openai',
        defaultLlmModel: 'gpt-4o',
        temperature: '0',
        reasoningDisabled: fcm ? false : true, // tool-use REQUIRES the explicit false (learnings §11)
        requiresFunctionCallingModel: fcm,
        requiresMultiModalModel: false,
        timeSaved: 60,
      },
    };
  },

  async scan(ctx, manifest) {
    const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
    return (await promptList(ctx))
      .filter((p) => p.id.startsWith(forms.camel) && /^[a-z]+[A-Z]/.test(p.id))
      .map((p) => ({ id: p.id }));
  },
};

async function maybeLintHelpers(ctx, local) {
  if (!ctx.flags?.['lint-helpers']) return;
  for (const w of await adapter.lintHelpers(ctx, local)) ctx.out?.warn?.(w);
}

export default adapter;
