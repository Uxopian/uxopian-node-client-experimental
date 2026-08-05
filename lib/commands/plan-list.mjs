// uxc plan list — enumerate Plans over the gateway's admin REST API.
import { createPlanClient } from '../plan.mjs';

export default {
  name: 'plan-list',
  summary: 'list Plans (gateway REST /api/v1/admin/plans)',
  help: 'uxc plan list [--json]',
  async run(ctx) {
    const { out } = ctx;
    ctx.connect();
    const plans = await createPlanClient(ctx.clients).list();
    if (ctx.out.json) return out.result(plans);
    out.table(
      (plans ?? []).map((p) => ({
        id: p.id,
        description: p.description ?? '',
        nodes: (p.nodes ?? []).length,
        tool: p.exposeAsTool ? 'yes' : '',
      })),
      [{ key: 'id' }, { key: 'description', max: 50 }, { key: 'nodes' }, { key: 'tool', label: 'exposeAsTool' }],
    );
    out.note(`${(plans ?? []).length} plan(s) on ${ctx.target.name}`);
  },
};
