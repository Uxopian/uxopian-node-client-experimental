// uxc data push — upsert changed rows only. NEVER deletes server documents except via
// local tombstone rows ({"_id":…,"_deleted":true}) or --prune, which prints the exact kill
// list and requires --yes.
import { pushRows } from '../kinds/fd-dataset.mjs';
import { fail } from '../output.mjs';
import { resolveDataset, printRowResult } from './data-pull.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'data-push',
  summary: 'push changed dataset rows (deletes only via tombstones or --prune --yes)',
  help: 'uxc data push <name> [--prune [--yes]] [--force]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const prune = reclaim(flags, args, 'prune');
    const yes = reclaim(flags, args, 'yes');
    // --force recreates rows that exist locally but were deleted on the server (base still
    // recorded) — e.g. re-installing a dataset after a teardown left stale per-row state.
    const force = reclaim(flags, args, 'force');
    const name = args[0];
    if (!name) fail('usage: uxc data push <name> [--prune [--yes]] [--force]');
    const entry = resolveDataset(pkg, name);
    if (!entry) {
      fail(`unknown dataset "${name}" — datasets: ${pkg.entries('fd.dataset').map((e) => e.id).join(', ') || '(none — declare in manifest.dataSets and register)'}`);
    }
    ctx.connect();
    const res = await pushRows(ctx, pkg, entry, { prune, yes, force });
    printRowResult(out, `data push ${entry.id}`, res);
    if (prune && !yes) out.warn('prune kill list printed above — re-run with --yes to actually delete');
    out.result(res ?? { dataset: entry.id });
  },
};
