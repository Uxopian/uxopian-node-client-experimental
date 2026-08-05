// uxc plan update <id> --file plan.json — update an existing Plan (PUT, id in path).
import { createPlanClient, readPlanFile } from '../plan.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'plan-update',
  summary: 'update an existing Plan (--file plan.json --description … --expose-as-tool --tool-description …)',
  help: 'uxc plan update <planId> --file plan.json [--description "…"] [--expose-as-tool] [--tool-description "…"]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc plan update <planId> --file plan.json');
    if (!flags.file) fail('--file plan.json is required');
    ctx.connect();

    const pc = createPlanClient(ctx.clients);
    const existing = await pc.get(id);
    if (!existing) fail(`plan "${id}" does not exist on ${ctx.target.name} — use "uxc plan create" instead`);

    const plan = { ...readPlanFile(String(flags.file)), id };
    if (typeof flags.description === 'string') plan.description = flags.description;
    if (flags['expose-as-tool']) plan.exposeAsTool = true;
    if (typeof flags['tool-description'] === 'string') plan.toolDescription = flags['tool-description'];

    const updated = await pc.update(plan);
    out.line(`updated plan ${id} on ${ctx.target.name}`);
    out.note(`${(updated?.nodes ?? []).length} node(s)`);
    out.result(updated);
  },
};
