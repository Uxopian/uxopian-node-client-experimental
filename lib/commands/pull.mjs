// uxc pull — bring server-side edits into the package (canonical echo written to disk,
// base recorded). Refuses conflicts unless --force.
import { pullResources } from '../sync.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'pull',
  summary: 'pull server-side edits into the package (canonical echo + base hash)',
  help: 'uxc pull <id…> | --all [--force]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const all = reclaim(flags, args, 'all');
    const force = reclaim(flags, args, 'force');

    let entries;
    if (all) {
      entries = pkg.entries().filter((e) => !e.retired);
    } else {
      if (!args.length) fail('usage: uxc pull <id…> | --all [--force]');
      entries = args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`));
    }
    if (!entries.length) { out.line('nothing to pull'); out.result([]); return; }
    ctx.connect();

    const actions = await pullResources(ctx, entries, { force });
    for (const a of actions) out.line(`${String(a.action ?? '').padEnd(12)} ${a.id}${a.detail ? '  ' + a.detail : ''}`);
    out.line(`pull: ${actions.length} resources`);
    if (actions.some((a) => /conflict|refus|collision/i.test(String(a.action ?? '')))) process.exitCode = 1;
    out.result(actions);
  },
};
