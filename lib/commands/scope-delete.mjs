// uxc scope delete <id> — delete a FlowerDocs scope remotely over Core REST. Destructive; gated by --yes.
import { createScopeClient } from '../scope.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'scope-delete',
  summary: 'delete a FlowerDocs scope remotely (Core REST); destructive, requires --yes',
  help: 'uxc scope delete <scopeId> --yes [--target name]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc scope delete <scopeId> --yes');
    if (!flags.yes) {
      fail(`refusing to delete scope "${id}" without --yes — this removes the scope and ALL its data on ${ctx.flags.target ?? 'the default target'}.`);
    }
    ctx.connect();
    await createScopeClient(ctx.clients).delete(id);
    out.line(`deleted scope ${id} on ${ctx.target.name}`);
    out.result({ id, deleted: true });
  },
};
