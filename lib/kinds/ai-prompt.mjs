// ai.prompt — Uxopian AI prompts. Local form: meta JSON (every field EXCEPT content) at
// ai/prompts/<id>.json + the content VERBATIM at ai/prompts/<id>.content.md.
// Reads are DIALECT-AWARE (lib/dialects.mjs): gateways with the `adminPromptList` capability
// (2026-07+) serve GET /api/v1/admin/prompts with FULL objects (role/provider/model/…) — used
// first; 2025-era gateways 500 that endpoint (learnings §8/§17), so reads fall back to the USER
// list. Writes go through a dialect-selected WRITE STRATEGY: flat records (POST, 409 -> PUT with
// id in body) up to 2026.0.0-ft4; version histories (draft -> publish) from 2026.0.0-ft5.
//
// LOSSY-READ HAZARD (user-list dialect): the user list can return a REDUCED projection of a
// prompt — on some gateway builds only id + content, dropping the admin config (role,
// defaultLlmProvider, defaultLlmModel, temperature, reasoningDisabled, requires*, timeSaved).
// The generic echo law ("base = canon(server echo)") would then overwrite the local meta with
// that stub on the push echo-leg writeback (and show false drift in status), silently losing the
// prompt's configuration. Fix: readServer OVERLAYS the echo on the locally-authored meta —
// server-returned fields stay authoritative (drift on them is still detected), fields the
// endpoint omits are preserved from local. Kept even on admin-list gateways (belt & braces).
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stableStringify, sleep } from '../util.mjs';
import { canonicalize, canonicalText } from '../canonical.mjs';
import { prefixForms } from '../naming.mjs';
import { capabilities } from '../dialects.mjs';
import { HttpError } from '../http.mjs';

const DIR = 'ai/prompts';
const contentPathOf = (jsonPath) => jsonPath.replace(/\.json$/, '.content.md');

async function promptList(ctx) {
  if (ctx._promptList) return ctx._promptList;
  const { caps } = await capabilities(ctx, 'uxopian-ai');
  if (caps.adminPromptList) {
    // full objects — the canonical normalizer strips the admin audit fields
    try {
      const admin = await ctx.clients.gateway.get('/api/v1/admin/prompts');
      if (Array.isArray(admin)) return (ctx._promptList = admin);
    } catch { /* fingerprint said yes but the call failed — fall back to the user list */ }
  }
  ctx._promptList = (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
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

/**
 * WRITE STRATEGIES, selected by the dialect capability `caps.promptWrite` (DESIGN §18).
 * This is THE extension point for gateway API changes: a release that changes how prompts are
 * created (working copies, versioned writes) or reshapes the body (a field turning mandatory —
 * or the contrary) gets a NEW strategy here + a dialect range flipping `promptWrite` to it.
 * A strategy = { shape(body) -> body, create(ctx, body, opts), update(ctx, id, body, opts) }.
 * The adapter keeps the strategy-INDEPENDENT safety: exists-check-first + the post-create
 * duplicate assertion.
 */
const WRITE_STRATEGIES = {
  // 2025-era AND 2026-07 (ft4) gateways: POST /admin/prompts (409 -> PUT), PUT with id in BODY.
  'admin-v1': {
    shape: (body) => body,
    async create(ctx, body) {
      try {
        await ctx.clients.gateway.post('/api/v1/admin/prompts', body);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          await ctx.clients.gateway.put('/api/v1/admin/prompts', body); // already exists: same body, id in body
        } else throw e;
      }
    },
    async update(ctx, id, body) {
      await ctx.clients.gateway.put('/api/v1/admin/prompts', { ...body, id }); // id in BODY, not path
    },
  },
  // 2026.0.0-ft5 (AI learnings §A11): a prompt is a HISTORY of version snapshots. Create = POST
  // /admin/prompts (201, published v0; 409 when the id exists). Update = open THE draft (POST
  // …/versions, 409 when one is already open) then publish it (PUT …/versions/{n} with
  // draft:false — the body replaces the draft AND publishes it in one call). Published versions
  // are read-only (409). The bare PUT /admin/prompts is gone and answers a 500.
  'versioned-v1': {
    // server-owned bookkeeping never rides in a snapshot body
    shape: (body) => stripVersionFields(body),
    async create(ctx, body, opts) {
      try {
        await ctx.clients.gateway.post('/api/v1/admin/prompts', body);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          await publishVersion(ctx, body.id, body, opts); // exists after all (race / stale list)
        } else throw e;
      }
    },
    async update(ctx, id, body, opts) {
      await publishVersion(ctx, id, { ...body, id }, opts);
    },
  },
};

const VERSION_FIELDS = ['version', 'draft', 'usage', 'prompt', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];
function stripVersionFields(body) {
  const out = { ...body };
  for (const f of VERSION_FIELDS) delete out[f];
  return out;
}

/** Canonical text of a version snapshot, for "is this draft the same prompt?" comparisons. */
const snapshotText = (v) => canonicalText('ai.prompt', { ...stripVersionFields(v), id: null });

/**
 * Publish `body` as the prompt's next version. An open draft is REUSED — the server allows one —
 * but only when it is harmless to overwrite: identical to what we publish (a half-done earlier
 * push) or identical to the served version (opened, never edited). A draft carrying someone's
 * unpublished admin-UI edits is refused unless `force` (push --force).
 */
async function publishVersion(ctx, id, body, { force = false, retried = false } = {}) {
  const gw = ctx.clients.gateway;
  const base = `/api/v1/admin/prompts/${encodeURIComponent(id)}/versions`;
  const versions = (await gw.get(base)) ?? [];
  let draft = versions.find((v) => v.draft === true) ?? null;
  if (draft && !force) {
    const served = versions.filter((v) => v.draft !== true)
      .reduce((a, v) => ((v.version ?? -1) > (a?.version ?? -1) ? v : a), null);
    const t = snapshotText(draft);
    if (t !== snapshotText(body) && (!served || t !== snapshotText(served))) {
      const e = new Error(
        `an unpublished draft v${draft.version} with different content is open on the server — publishing would discard it`,
      );
      e.explanation = 'someone is editing this prompt in the admin UI. Publish or discard that draft there, then re-run; or push --force to overwrite it with the package version.';
      throw e;
    }
  }
  if (!draft) {
    try {
      draft = await gw.post(base, body);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || retried) throw e;
      // a draft appeared between the read and the POST — take it (same guard as above), once
      return publishVersion(ctx, id, body, { force, retried: true });
    }
  }
  if (!Number.isInteger(draft?.version)) {
    throw new Error(`ai.prompt/${id}: the gateway did not return the draft version number — cannot publish`);
  }
  await gw.put(`${base}/${draft.version}`, { ...body, draft: false });
}

async function writeStrategy(ctx) {
  const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
  const strategy = WRITE_STRATEGIES[caps.promptWrite];
  if (!strategy) {
    throw new Error(
      `ai.prompt: no write strategy "${caps.promptWrite}" for dialect ${dialect} — this uxc is too old for the gateway's prompt API; upgrade uxc (or pin aiVersion on the target to a supported dialect)`,
    );
  }
  return strategy;
}

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
    const id = local?.obj?.id;
    // Exists-check FIRST (the list is cached per ctx): update-in-place instead of trusting the
    // POST-then-409 dance — upcoming gateway versions (prompt versioning / working copies) may
    // answer a POST-on-existing with a NEW copy instead of a 409, silently duplicating.
    if (id && (await adapter.get(ctx, id))) {
      return adapter.update(ctx, id, local);
    }
    const strategy = await writeStrategy(ctx);
    await strategy.create(ctx, strategy.shape(local.obj), { force: !!ctx.flags?.force });
    invalidate(ctx);
    // post-create duplicate assertion: the list must now hold EXACTLY ONE entry with this id —
    // a versioning/working-copy gateway that duplicated instead of erroring fails LOUDLY here.
    const twins = (await promptList(ctx)).filter((p) => p.id === id);
    if (twins.length > 1) {
      throw new Error(
        `ai.prompt/${id}: after create the server holds ${twins.length} entries with this id — the gateway DUPLICATED the prompt (version/working-copy behavior?). Clean the extras in the admin UI, then re-sync; uxc doctor --dups lists them.`,
      );
    }
  },

  async update(ctx, id, local) {
    await maybeLintHelpers(ctx, local);
    const strategy = await writeStrategy(ctx);
    await strategy.update(ctx, id, strategy.shape(local.obj), { force: !!ctx.flags?.force });
    invalidate(ctx);
  },

  // 2026.0.0-ft5: an Application's reference OUTLIVES the application by a couple of seconds — a
  // prompt deleted right after its application answers 409 "referenced by application(s)" once,
  // then 204 (verified fd.demo, AI learnings §A15). Teardown runs applications first, so retry.
  referenceRetry: { attempts: 4, delayMs: 1500 },

  async remove(ctx, id) {
    const path = `/api/v1/admin/prompts/${encodeURIComponent(id)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.clients.gateway.del(path);
        break;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) throw e;
        if (/referenced by application/i.test(JSON.stringify(e.body ?? e.message)) && attempt < adapter.referenceRetry.attempts) {
          await sleep(adapter.referenceRetry.delayMs);
          continue;
        }
        // the base prompt, or a prompt a (still existing) Application uses, cannot be deleted
        e.explanation = 'the gateway refuses to delete the base prompt or a prompt an Application references — remove or repoint the application first (uxc ls ai.application)';
        throw e;
      }
    }
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
    // The FlowerDocs Quick Prompt panel shows every prompt whose displaySettings.enabled !== false
    // (absent displaySettings = SHOWN — AI learnings §A8). Pipeline prompts must therefore ship
    // explicitly hidden; `--quick-prompt` scaffolds one that is MEANT for the panel.
    const quick = !!flags['quick-prompt'];
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
        displaySettings: quick
          ? { enabled: true, label: name, description: '', priority: 0 }
          : { enabled: false },
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

/**
 * Create-or-update ONE prompt through the dialect's write strategy — for uxc's own prompts
 * (installation receipts) that live outside a package sync. Never hand-roll a prompt write:
 * the API changed shape in 2026.0.0-ft5 and will change again.
 */
export async function upsertPrompt(ctx, body, { force = true } = {}) {
  const strategy = await writeStrategy(ctx);
  const shaped = strategy.shape(body);
  if (await adapter.get(ctx, body.id)) await strategy.update(ctx, body.id, shaped, { force });
  else await strategy.create(ctx, shaped, { force });
  invalidate(ctx);
}

async function maybeLintHelpers(ctx, local) {
  if (!ctx.flags?.['lint-helpers']) return;
  for (const w of await adapter.lintHelpers(ctx, local)) ctx.out?.warn?.(w);
}

export default adapter;
