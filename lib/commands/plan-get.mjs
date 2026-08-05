// uxc plan get <id> — read a Plan over the gateway's admin REST API.
import { createPlanClient } from '../plan.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'plan-get',
  summary: 'read a Plan by id (gateway REST /api/v1/admin/plans/{id})',
  help: 'uxc plan get <planId> [--json]',
  async run(ctx) {
    const { args, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc plan get <planId>');
    ctx.connect();

    const plan = await createPlanClient(ctx.clients).get(id);
    if (!plan) {
      out.line(`plan ${id}: not found on ${ctx.target.name}`);
      out.result({ id, exists: false });
      process.exit(1);
    }
    out.line(`${plan.id}  ${plan.description || ''}`);
    out.note(`${(plan.nodes ?? []).length} node(s)${plan.exposeAsTool ? ' · exposed as tool' : ''}`);
    if (plan.exposeAsTool) out.note(`tool: ${plan.toolDescription || '(no description set)'}`);
    for (const n of plan.nodes ?? []) {
      const dep = (n.dependencies ?? []).length ? ` <- ${n.dependencies.join(',')}` : '';
      out.note(`  ${n.id} [${n.type}]${dep}`);
    }
    out.result(plan); // full object — reusable as `--file` for `plan update`
  },
};
