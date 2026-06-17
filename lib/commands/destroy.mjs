// uxc destroy — full reverse-order teardown of every non-external resource:
// unsurface -> disable handlers -> delete in reverse PUSH_ORDER -> cache clear.
// --dry-run prints the ordered kill list; otherwise requires --confirm <project code>.
// Files, registry and state are left UNTOUCHED (DESIGN §9) — status will show 'deleted remotely'.
import { KINDS, PUSH_ORDER } from '../kinds/index.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'destroy',
  summary: 'tear down EVERY non-external resource on the target (reverse order; --dry-run first)',
  help: 'uxc destroy [--dry-run]   |   uxc destroy --confirm <project-code>',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const dryRun = reclaim(flags, args, 'dry-run');

    const entries = pkg.entries().filter((e) => e.policy !== 'external' && !e.retired);
    if (!entries.length) { out.line('nothing to destroy (no non-external, non-retired resources)'); out.result([]); return; }

    // ordered kill list: unsurface, then disable handlers, then delete in reverse topo order
    const steps = [];
    for (const e of entries.filter((x) => x.kind === 'fd.surfacing')) steps.push({ op: 'unsurface', kind: e.kind, id: e.id });
    for (const e of entries.filter((x) => x.kind === 'fd.handler')) steps.push({ op: 'disable', kind: e.kind, id: e.id });
    for (const k of [...PUSH_ORDER].reverse()) {
      if (k === 'fd.surfacing') continue; // already unsurfaced above
      for (const e of entries.filter((x) => x.kind === k)) steps.push({ op: 'delete', kind: k, id: e.id });
    }

    if (dryRun) {
      for (const s of steps) out.line(`${s.op.padEnd(10)} ${s.kind}/${s.id}`);
      out.line(`${steps.length} steps (dry run — nothing touched)`);
      out.result(steps);
      return;
    }
    if (flags.confirm !== pkg.manifest.code) {
      fail(`destroy tears down ${steps.length} server resources of "${pkg.manifest.name}" — confirm by typing the project code:\n  uxc destroy --confirm ${pkg.manifest.code}\n(or preview with --dry-run)`);
    }

    ctx.connect();
    pkg.setPendingCacheClear(ctx.target.name, true);
    let failures = 0;
    for (const s of steps) {
      const adapter = KINDS[s.kind];
      try {
        if (s.op === 'disable') {
          if (typeof adapter.disable === 'function') await adapter.disable(ctx, s.id);
        } else {
          await adapter.remove(ctx, s.id); // unsurface = the surfacing adapter's remove
        }
        out.line(`${s.op.padEnd(10)} ${s.kind}/${s.id}`);
      } catch (e) {
        failures++;
        out.warn(`${s.op} ${s.kind}/${s.id}: ${e.message}`);
      }
    }
    await ctx.clients.cacheClear();
    pkg.setPendingCacheClear(ctx.target.name, false);
    out.line(`destroy: ${steps.length - failures}/${steps.length} steps ok — caches cleared (files/registry/state untouched)`);
    if (failures) process.exitCode = 1;
    out.result({ steps: steps.length, failures });
  },
};
