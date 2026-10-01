// uxc f2 status <campaign> [--watch] — a campaign's state and per-step punnet counts (FAST-5878).
// Status is a bare JSON string and stats are keyed by step id; ids are mapped back to step names
// through the map in stats.taskFlowMapRef.mapId (FAST2-LEARNINGS §F9). --watch polls on ONE client,
// so the whole watch uses one login and one token.
import { fail } from '../output.mjs';
import {
  TERMINAL, STARTING_EXPLANATION, campaignSummary, renderSummary, watchCampaign, unknownCampaign,
} from '../f2/campaign.mjs';

const USAGE = 'uxc f2 status <campaign> [--watch] [--interval <s>] [--timeout <s>] [--json]';

export default {
  name: 'f2-status',
  summary: 'show a fast2 campaign\'s state and per-step punnet counts (--watch polls to the end)',
  help: `${USAGE}\n`
    + '  --watch          poll status + stats until Finished|Stopped|Undefined or --timeout\n'
    + '  --interval <s>   seconds between polls (default 5)    --timeout <s>  give up after (default 600)\n'
    + '  exit (--watch): 0 Finished with 0 exceptions · 1 exceptions, Stopped/Undefined or timeout · 2 error',
  async run(ctx) {
    const { flags, out } = ctx;
    const campaign = ctx.args[0];
    if (!campaign) fail(`usage: ${USAGE}`);
    ctx.connect();
    const f2 = ctx.clients.f2;
    if (!f2) fail('this target has no fast2 surface — uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>');

    let summary;
    let timedOut = false;
    try {
      if (flags.watch) {
        const interval = Number(flags.interval ?? 5);
        const timeout = Number(flags.timeout ?? 600);
        if (!(interval > 0) || !(timeout > 0)) fail('--interval and --timeout are seconds, greater than 0');
        ({ summary, timedOut } = await watchCampaign(f2, campaign, {
          intervalMs: interval * 1000,
          timeoutMs: timeout * 1000,
          onTick: (s) => out.line(`${s.status.padEnd(10)} ${s.elapsedSec ?? '?'}s   ok ${s.ok} · exception ${s.exception} · queued ${s.queued} · processing ${s.processing}`),
          onWedged: () => out.warn(STARTING_EXPLANATION),
        }));
      } else {
        ({ summary } = await campaignSummary(f2, campaign));
      }
    } catch (e) {
      const msg = unknownCampaign(e);
      if (msg) fail(`fast2: ${msg}`);
      throw e;
    }

    renderSummary(out, summary);
    if (flags.watch) {
      if (timedOut) {
        out.warn(`campaign ${summary.campaign} still ${summary.status} after ${flags.timeout ?? 600}s`);
        process.exitCode = 1;
      } else if (summary.exception > 0 || !/^Finished$/i.test(summary.status)) {
        if (summary.exception > 0) out.warn(`${summary.exception} punnet(s) ended in exception — uxc f2 exceptions ${summary.campaign}`);
        process.exitCode = 1;
      }
    } else if (!TERMINAL.test(summary.status)) {
      out.note(`still running — uxc f2 status ${summary.campaign} --watch`);
    }
    out.result(summary);
  },
};
