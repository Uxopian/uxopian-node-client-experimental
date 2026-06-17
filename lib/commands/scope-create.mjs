// uxc scope create <id> — create (or update) a FlowerDocs scope remotely over SOAP.
// Default builds a minimal blank scope; --from <scope.xml> uses an exported scope (id re-targeted).
import { createScopeClient } from '../scope.mjs';
import { fail } from '../output.mjs';

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export default {
  name: 'scope-create',
  summary: 'create (or update) a FlowerDocs scope remotely (SOAP); blank by default, or --from a scope.xml',
  help: 'uxc scope create <scopeId> [--blank] [--from scope.xml] [--description "…"] [--display-en "…"] [--display-fr "…"] [--lang EN,FR] [--admin system,admin] [--target name] [--auth-scope s]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc scope create <scopeId> [--blank|--from scope.xml]');
    ctx.connect();
    const sc = createScopeClient(ctx.clients, ctx.target);

    const opts = {
      fromFile: typeof flags.from === 'string' ? flags.from : undefined,
      description: typeof flags.description === 'string' ? flags.description : undefined,
      displayEn: typeof flags['display-en'] === 'string' ? flags['display-en'] : undefined,
      displayFr: typeof flags['display-fr'] === 'string' ? flags['display-fr'] : undefined,
      languages: csv(flags.lang),
      admins: csv(flags.admin),
      authScope: typeof flags['auth-scope'] === 'string' ? flags['auth-scope'] : undefined,
    };

    const existed = await sc.get(id, { authScope: opts.authScope }).catch(() => null);
    const s = await sc.create(id, opts);
    out.line(`${existed ? 'updated' : 'created'} scope ${s.id} on ${ctx.target.name}${opts.fromFile ? `  (from ${opts.fromFile})` : ''}`);
    out.note(`sign in: ${ctx.target.url}/gui/signin?scope=${encodeURIComponent(s.id)}`);
    out.result({ action: existed ? 'updated' : 'created', ...s });
  },
};
