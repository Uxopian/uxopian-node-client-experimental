// uxc plan create <planId> --file plan.json — create a Plan over the gateway's admin REST API.
// The file carries the full shape (nodes, exposeAsTool, toolDescription, toolInputParameters);
// --description/--expose-as-tool/--tool-description override the file's top-level fields, so a
// common tweak doesn't require re-editing the JSON each time.
import { createPlanClient, readPlanFile } from '../plan.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'plan-create',
  summary: 'create a Plan (--file plan.json --description … --expose-as-tool --tool-description …)',
  help: 'uxc plan create <planId> --file plan.json [--description "…"] [--expose-as-tool] [--tool-description "…"]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const id = args[0];
    if (!id) fail('usage: uxc plan create <planId> --file plan.json');
    if (!flags.file) fail('--file plan.json is required (a Plan is a node graph — write it once, version it)');
    ctx.connect();

    const plan = { ...readPlanFile(String(flags.file)), id };
    if (typeof flags.description === 'string') plan.description = flags.description;
    if (flags['expose-as-tool']) plan.exposeAsTool = true;
    if (typeof flags['tool-description'] === 'string') plan.toolDescription = flags['tool-description'];

    const pc = createPlanClient(ctx.clients);
    const existing = await pc.get(id);
    if (existing) fail(`plan "${id}" already exists on ${ctx.target.name} — use "uxc plan update" instead`);

    const created = await pc.create(plan);
    out.line(`created plan ${id} on ${ctx.target.name}${plan.exposeAsTool ? ' (exposed as tool)' : ''}`);
    out.note(`${(created?.nodes ?? []).length} node(s)`);
    out.result(created);
  },
};
