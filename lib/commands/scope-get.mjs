// uxc scope get <id> — read a FlowerDocs scope over Core REST. Exists-check + summary.
// `--json` prints the full scope object (use it to clone: `uxc scope get <src> --json > src.json`).
import { createScopeClient } from '../scope.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'scope-get',
  summary: 'read a FlowerDocs scope by id (Core REST /core/rest/scope)',
  help: 'uxc scope get <scopeId> [--target name]',
  async run(ctx) {
    const { args, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc scope get <scopeId>');
    ctx.connect();
    const s = await createScopeClient(ctx.clients).get(id);
    if (!s) {
      out.line(`scope ${id}: not found on ${ctx.target.name}`);
      out.result({ id, exists: false });
      process.exit(1);
    }
    const profiles = s.people?.profiles ?? [];
    out.line(`${s.id}  ${s.description || ''}`);
    out.note(`languages ${(s.languages ?? []).join(',') || '—'} · ${profiles.length} profile(s)`);
    for (const p of profiles) {
      out.note(`  profile ${p.id || '?'}: principals ${(p.principals ?? []).join(', ') || '—'}${p.properties?.length ? ` · ${p.properties.length} prop(s)` : ''}`);
    }
    out.result(s); // full scope object — reusable as a `--from` clone source
  },
};
