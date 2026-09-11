// uxc pull — bring server-side edits into the package (canonical echo written to disk,
// base recorded). Refuses conflicts unless --force, and composed @include sources unless
// --flatten (BACKLOG #1: flattening one is a silent, hard-to-notice loss, not a merge).
import { pullResources } from '../sync.mjs';
import { partitionProtected } from '../agent.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'pull',
  summary: 'pull server-side edits into the package (canonical echo + base hash)',
  help: 'uxc pull <id…> | --all [--force] [--flatten]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const all = reclaim(flags, args, 'all');
    const force = reclaim(flags, args, 'force');
    const flatten = reclaim(flags, args, 'flatten');

    let entries;
    if (all) {
      entries = pkg.entries().filter((e) => !e.retired);
    } else {
      if (!args.length) fail('usage: uxc pull <id…> | --all [--force]');
      entries = args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`));
    }
    // agent.neverPull (BACKLOG #12): the server copy of these is older ON PURPOSE. Naming one
    // explicitly is an error worth stopping; a --all sweep just skips them.
    const never = partitionProtected(ctx.policy?.neverPull ?? [], entries);
    if (never.blocked.length) {
      if (all) for (const b of never.blocked) out.line(`${'skipped'.padEnd(12)} ${b.entry.kind}/${b.entry.id}  agent.neverPull "${b.pattern}"`);
      else {
        fail(`refused: ${never.blocked.map((b) => `${b.entry.kind}/${b.entry.id}`).join(', ')} — listed in uxopian-project.json agent.neverPull`
          + ' (the server version is older on purpose). Remove it from that list to pull anyway.');
      }
      entries = never.allowed;
    }
    if (!entries.length) { out.line('nothing to pull'); out.result([]); return; }
    ctx.connect();

    const actions = await pullResources(ctx, entries, { force, flatten });
    for (const a of actions) out.line(`${String(a.action ?? '').padEnd(12)} ${a.id}${a.detail ? '  ' + a.detail : ''}`);
    out.line(`pull: ${actions.length} resources`);
    if (actions.some((a) => /conflict|refus|collision/i.test(String(a.action ?? '')))) process.exitCode = 1;
    out.result(actions);
  },
};
