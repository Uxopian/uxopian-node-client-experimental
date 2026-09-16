// uxc versions <promptId> — a prompt's version history on uxopian-ai 2026.0.0-ft5+ (read-only).
// GET /api/v1/admin/prompts/{id}/versions -> every snapshot (version, draft, …); the SERVED version is
// the highest non-draft one (AI learnings §A11). --stats adds GET …/versions/{n}/statistics per row.
// Statistics answer 200 with zeros for ANY id or version (even absent ones), so they can never
// prove existence — and requests made before the ft5 upgrade count only in the prompt-wide
// aggregate (GET …/{id}/statistics), not per version (verified fd.demo, 2026-09-16).
// When run inside a package that owns the prompt, each row says whether it matches the local file.
import { capabilities } from '../dialects.mjs';
import { hashResource } from '../canonical.mjs';
import { KINDS } from '../kinds/index.mjs';
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';
import { fail } from '../output.mjs';

const SNAPSHOT_ONLY = ['version', 'draft', 'usage', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];
const snapshotHash = (v, id) => {
  const o = { ...v, id };
  for (const f of SNAPSHOT_ONLY) delete o[f];
  return hashResource('ai.prompt', o);
};

function localPrompt(ctx, id) {
  const dir = ctx.flags.dir ?? findPackageDir();
  if (!dir) return null;
  try {
    const pkg = ctx.pkg ?? openPackage(dir);
    const entry = pkg.entry('ai.prompt', id);
    return entry ? KINDS['ai.prompt'].readLocal(pkg, entry)?.obj ?? null : null;
  } catch { return null; }
}

export default {
  name: 'versions',
  summary: 'a prompt\'s version history + per-version statistics (uxopian-ai ft5+, read-only)',
  help: 'uxc versions <promptId> [--stats]',
  lock: 'read',
  async run(ctx) {
    const id = ctx.args[0];
    if (!id) fail('usage: uxc versions <promptId> [--stats]');
    ctx.connect();
    const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
    if (!caps.promptVersioning) {
      fail(`prompt versions need uxopian-ai 2026.0.0-ft5+ — this gateway resolves to dialect ${dialect} (prompts are single records there)`);
    }
    const base = `/api/v1/admin/prompts/${encodeURIComponent(id)}`;
    const versions = await ctx.clients.gateway.tryGet(`${base}/versions`);
    if (!Array.isArray(versions)) fail(`ai.prompt/${id} not found on ${ctx.target.name}`);

    const served = versions.filter((v) => v.draft !== true).reduce((a, v) => (v.version > (a ?? -1) ? v.version : a), null);
    const local = localPrompt(ctx, id);
    const localHash = local ? hashResource('ai.prompt', local) : null;

    const rows = [];
    for (const v of [...versions].sort((a, b) => b.version - a.version)) {
      const row = {
        version: v.version,
        state: v.draft === true ? 'draft' : v.version === served ? 'served' : 'published',
        'provider/model': `${v.defaultLlmProvider ?? '-'}/${v.defaultLlmModel ?? '-'}`,
        size: String(v.content ?? '').length, // never echo prompt content
        ...(localHash ? { local: snapshotHash(v, id) === localHash ? '= local' : '' } : {}),
      };
      if (ctx.flags.stats) {
        const s = (await ctx.clients.gateway.tryGet(`${base}/versions/${v.version}/statistics`)) ?? {};
        Object.assign(row, {
          uses: s.nbUsage ?? 0,
          'feedback +/-': `${s.goodFeedback ?? 0}/${s.badFeedback ?? 0}`,
          'saved (h)': Math.round(((s.timeSavedInSeconds ?? 0) / 3600) * 10) / 10,
        });
      }
      rows.push(row);
    }
    let total = null;
    if (ctx.flags.stats) total = (await ctx.clients.gateway.tryGet(`${base}/statistics`)) ?? null;

    if (ctx.out.json) return ctx.out.result({ id, served, versions: rows, ...(total ? { statistics: total } : {}) });
    ctx.out.table(rows, Object.keys(rows[0] ?? { version: 1 }).map((key) => ({ key, max: 40 })));
    ctx.out.line(`${rows.length} version(s) of ${id} on ${ctx.target.name} — served v${served ?? '?'}`
      + `${rows.some((r) => r.state === 'draft') ? ' · an unpublished draft is open (uxc push refuses to overwrite it without --force)' : ''}`);
    if (total) {
      ctx.out.note(`all versions: ${total.nbUsage ?? 0} uses, feedback ${total.goodFeedback ?? 0}+/${total.badFeedback ?? 0}- `
        + '(per-version counts start at the ft5 upgrade; earlier requests only count here)');
    }
    if (local && !rows.some((r) => r.local)) ctx.out.note('no server version matches the local file — uxc push publishes it as the next version');
  },
};
