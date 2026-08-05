// uxc plan run <id> — submit a Plan execution and (by default) poll until it reaches a terminal
// status. The run endpoint is fire-and-forget: it returns the INITIAL execution, not the result.
import { readFileSync } from 'node:fs';
import { createPlanClient } from '../plan.mjs';
import { fail } from '../output.mjs';

function collectFlag(name) {
  const argv = process.argv.slice(2);
  const vals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    } else if (argv[i].startsWith(`--${name}=`)) vals.push(argv[i].slice(name.length + 3));
  }
  return vals;
}

export default {
  name: 'plan-run',
  summary: 'submit a Plan execution (--payload k=v… --payload-json f) and wait for a terminal status',
  help: 'uxc plan run <planId> [--payload k=v]… [--payload-json f] [--no-wait] [--timeout ms]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const planId = args[0];
    if (!planId) fail('usage: uxc plan run <planId> [--payload k=v]…');
    ctx.connect();

    let inputPayload = {};
    if (flags['payload-json']) {
      Object.assign(inputPayload, JSON.parse(readFileSync(String(flags['payload-json']), 'utf8')));
    }
    for (const kv of collectFlag('payload')) {
      const eq = kv.indexOf('=');
      if (eq < 1) fail(`bad --payload "${kv}" — expected k=v`);
      inputPayload[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    const pc = createPlanClient(ctx.clients);
    const submitted = await pc.executions.run(planId, inputPayload);
    out.line(`submitted execution ${submitted.id} for plan ${planId} (status: ${submitted.status})`);

    if (flags['no-wait']) return out.result(submitted);

    const timeoutMs = Number(flags.timeout ?? 120_000);
    const exec = await pc.executions.waitFor(submitted.id, { timeoutMs });
    out.line(`final status: ${exec.status}${exec.failureReason ? ` — ${exec.failureReason}` : ''}`);
    for (const ne of exec.nodeExecutions ?? []) {
      out.note(`  ${ne.nodeId ?? ne.id ?? '?'}: ${ne.status ?? '?'}`);
    }
    out.result(exec);
  },
};
