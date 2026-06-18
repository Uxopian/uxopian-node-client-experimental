// uxc scope create <id> — create (or update) a FlowerDocs scope remotely over Core REST.
// Default builds a minimal blank scope; --from <scope.json> clones an existing scope (id re-targeted),
// e.g. `uxc scope get IRIS --json > iris.json` then `uxc scope create Acme --from iris.json`.
import { createScopeClient, blankScope, retargetScope, readScopeFile } from '../scope.mjs';
import { fail } from '../output.mjs';

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export default {
  name: 'scope-create',
  summary: 'create (or update) a FlowerDocs scope remotely (Core REST); blank by default, or --from a scope.json',
  help: 'uxc scope create <scopeId> [--blank] [--from scope.json] [--description "…"] [--display-en "…"] [--display-fr "…"] [--lang EN,FR] [--admin system,admin] [--target name]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc scope create <scopeId> [--blank|--from scope.json]');
    ctx.connect();
    const sc = createScopeClient(ctx.clients);

    const scopeObj = typeof flags.from === 'string'
      ? retargetScope(readScopeFile(flags.from), id)
      : blankScope(id, {
          description: typeof flags.description === 'string' ? flags.description : undefined,
          displayEn: typeof flags['display-en'] === 'string' ? flags['display-en'] : undefined,
          displayFr: typeof flags['display-fr'] === 'string' ? flags['display-fr'] : undefined,
          languages: csv(flags.lang),
          admins: csv(flags.admin),
        });

    // POST /rest/scope creates a NEW id; an existing id must be updated via POST /rest/scope/{id}.
    const existed = await sc.get(id);
    const res = existed ? await sc.update(scopeObj) : await sc.create(scopeObj);
    out.line(`${existed ? 'updated' : 'created'} scope ${res.id ?? id} on ${ctx.target.name}${typeof flags.from === 'string' ? `  (from ${flags.from})` : ''}`);
    out.note(`sign in: ${ctx.target.url}/gui/signin?scope=${encodeURIComponent(res.id ?? id)}`);
    out.result({ action: existed ? 'updated' : 'created', scope: res });
  },
};
