// uxc scope get <id> — read a FlowerDocs scope over the SOAP scope service. Exists-check + summary.
import { createScopeClient } from '../scope.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'scope-get',
  summary: 'read a FlowerDocs scope by id (SOAP /core/services/scope)',
  help: 'uxc scope get <scopeId> [--target name] [--auth-scope s]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc scope get <scopeId>');
    ctx.connect();
    const sc = createScopeClient(ctx.clients, ctx.target);
    const s = await sc.get(id, { authScope: flags['auth-scope'] });
    if (!s) {
      out.line(`scope ${id}: not found on ${ctx.target.name}`);
      out.result({ id, exists: false });
      process.exit(1);
    }
    out.line(`${s.id}  ${s.description || ''}`);
    out.note(`languages ${s.languages.join(',') || '—'} · ${s.profiles.length} profile(s)`);
    for (const p of s.profiles) {
      out.note(`  profile ${p.id || '?'}: principals ${p.principals.join(', ') || '—'}${p.properties ? ` · ${p.properties} prop(s)` : ''}`);
    }
    out.result({ exists: true, ...s });
  },
};
