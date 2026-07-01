// uxc ls <kind> — server enumeration with compact per-kind projections (DESIGN §12).
// Special cases: fd.handler = registry-less live view (search OperationHandlerRegistration,
// group by logical name); ai.llmconf = inspect-only GET /api/v1/admin/llm/provider-conf.
import { KINDS, kindOf } from '../kinds/index.mjs';
import { looksOwned, splitHandlerId } from '../naming.mjs';
import { findPackageDir } from '../config.mjs';
import { openPackage } from '../registry.mjs';
import { fail } from '../output.mjs';

const title = (o) => o?.displayNames?.[0]?.value ?? o?.name ?? '';
const classRow = (o) => ({ id: o.id, title: title(o), '#tags': (o.tagReferences ?? []).length });

const PROJECTIONS = {
  'ai.prompt': (p) => ({
    id: p.id,
    role: p.role ?? '',
    'provider/model': `${p.defaultLlmProvider ?? '?'}/${p.defaultLlmModel ?? '?'}`,
    fcm: p.requiresFunctionCallingModel ? 'y' : '',
    size: String(p.content ?? '').length, // never echo prompt content
  }),
  'fd.documentclass': classRow,
  'fd.folderclass': classRow,
  'fd.taskclass': classRow,
  'fd.vfclass': classRow,
  'fd.tagclass': (o) => ({ id: o.id, type: o.type ?? '', title: title(o), values: (o.allowedValues ?? []).length || '' }),
  'fd.tagcategory': (o) => ({ id: o.id, title: title(o), '#tags': (o.tags ?? []).length }),
  'fd.workflow': (o) => ({ id: o.id, start: o.startTaskClass ?? '', steps: (o.taskClasses ?? []).length }),
  'fd.acl': (o) => ({ id: o.id, name: o.name ?? '', entries: (o.entries ?? []).length }),
  'ai.goal': (r) => ({ goalName: r.goalName ?? '', promptId: r.promptId ?? '', index: r.index ?? 0, filter: r.filter ?? '' }),
  'ai.mcp': (c) => ({ id: c.id ?? '', name: c.name ?? '', url: c.url ?? '' }),
};

/** Live handler view: one row per LOGICAL name, current vN + Enabled. */
async function handlerRows(ctx) {
  const { results } = await ctx.clients.core.search({
    classId: 'OperationHandlerRegistration', fields: ['name', 'Enabled'], max: 200,
  });
  const byLogical = new Map();
  for (const r of results) {
    const { logical, n } = splitHandlerId(r.id);
    const cur = byLogical.get(logical);
    if (!cur || (n ?? -1) > (cur.n ?? -1)) byLogical.set(logical, { logical, n, enabled: r.fields.Enabled ?? '' });
  }
  return [...byLogical.values()]
    .sort((a, b) => a.logical.localeCompare(b.logical))
    .map((h) => ({ id: h.logical, logical: h.logical, v: h.n == null ? '' : `v${h.n}`, enabled: h.enabled }));
}

async function llmconfRows(ctx) {
  const confs = (await ctx.clients.gateway.get('/api/v1/admin/llm/provider-conf')) ?? [];
  return confs.map((c) => ({
    id: c.id ?? c.name ?? '',
    provider: c.provider ?? c.providerName ?? c.type ?? '',
    models: (Array.isArray(c.models) ? c.models : [])
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? '')).filter(Boolean).join(','),
  }));
}

export default {
  name: 'ls',
  summary: 'list server resources of a kind (--mine, --fields)',
  help: 'uxc ls <kind> [--mine] [--fields a,b]   (kinds: uxc help; ai.llmconf is inspect-only)',
  async run(ctx) {
    const kindName = ctx.args[0] ?? (typeof ctx.flags.mine === 'string' ? ctx.flags.mine : null);
    if (!kindName) fail('usage: uxc ls <kind> [--mine] [--fields a,b] — kinds: uxc help');
    ctx.connect();

    let rows;
    if (kindName === 'ai.llmconf') rows = await llmconfRows(ctx);
    else if (kindName === 'fd.handler') rows = await handlerRows(ctx);
    else {
      const adapter = kindOf(kindName); // throws with the kind list on unknown
      if (typeof adapter.list !== 'function') fail(`${kindName} has no server enumeration — use uxc status / uxc get`);
      rows = (await adapter.list(ctx)) ?? [];
    }

    if (ctx.flags.mine) {
      const dir = ctx.flags.dir ?? findPackageDir();
      if (!dir) fail('--mine needs a package (uxopian-project.json) to know the project prefixes');
      const manifest = openPackage(dir).manifest;
      rows = rows.filter((r) => looksOwned(manifest, String(r.id ?? r.logical ?? r.promptId ?? '')));
    }

    let projected;
    if (ctx.flags.fields) {
      const fields = String(ctx.flags.fields).split(',').map((s) => s.trim()).filter(Boolean);
      projected = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    } else if (kindName === 'fd.handler') {
      projected = rows.map(({ logical, v, enabled }) => ({ logical, v, enabled }));
    } else {
      const proj = PROJECTIONS[kindName] ?? ((o) => ({ id: o.id ?? '', title: title(o) }));
      projected = rows.map(proj);
    }

    if (ctx.out.json) return ctx.out.result(projected);
    const cols = Object.keys(projected[0] ?? { id: 1 }).map((k) => ({ key: k, max: k === 'id' || k === 'logical' ? 80 : 60 }));
    ctx.out.table(projected, cols);
    ctx.out.line(`${projected.length} ${kindName}`);
  },
};
