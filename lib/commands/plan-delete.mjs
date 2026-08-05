// uxc plan delete <id> — delete a Plan (gateway REST DELETE /api/v1/admin/plans/{id}).
import { createPlanClient } from '../plan.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'plan-delete',
  summary: 'delete a Plan by id',
  help: 'uxc plan delete <planId>',
  async run(ctx) {
    const { args, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc plan delete <planId>');
    ctx.connect();
    const res = await createPlanClient(ctx.clients).delete(id);
    out.line(`deleted plan ${id} on ${ctx.target.name}`);
    out.result(res);
  },
};
