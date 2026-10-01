// uxc destroy — full reverse-order teardown of every non-external resource:
// unsurface -> disable handlers -> delete in reverse PUSH_ORDER -> cache clear.
// --dry-run prints the ordered kill list; otherwise requires --confirm <project code>.
// createOnly entries are KEPT unless --force — the same delete gate rm/prune honor (deleting a
// live taskclass breaks ANSWER dispatch permanently, LEARNINGS §14).
// Files, registry and state are left UNTOUCHED (DESIGN §9) — status will show 'deleted remotely'.
// The package's installation receipts on the target (FD doc + AI prompt, DESIGN §19) are deleted
// LAST, once every step succeeded — a receipt must not claim a package that is gone; after a failed
// step it is kept (the package is still partly installed) and the output says so.
import { KINDS, PUSH_ORDER } from '../kinds/index.mjs';
import { fail } from '../output.mjs';
import { removeReceipts } from '../receipt.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'destroy',
  summary: 'tear down EVERY non-external resource on the target (reverse order; --dry-run first; createOnly kept unless --force)',
  help: 'uxc destroy [--dry-run] [--force]   |   uxc destroy --confirm <project-code> [--force]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const dryRun = reclaim(flags, args, 'dry-run');
    const force = reclaim(flags, args, 'force');

    const candidates = pkg.entries().filter((e) => e.policy !== 'external' && !e.retired);
    // the createOnly delete gate (same as rm --server / prune): kept unless --force
    const kept = force ? [] : candidates.filter((e) => e.policy === 'createOnly');
    const entries = force ? candidates : candidates.filter((e) => e.policy !== 'createOnly');
    for (const e of kept) out.line(`kept       ${e.kind}/${e.id} (createOnly — delete is gated, §14; --force includes it)`);
    if (!entries.length) {
      out.line(kept.length
        ? `nothing else to destroy — only createOnly-gated resources remain (${kept.length}; re-run with --force to delete them)`
        : 'nothing to destroy (no non-external, non-retired resources)');
      out.result([]);
      return;
    }

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
      out.line(`${'delete'.padEnd(10)} the ${pkg.manifest.code} installation receipts on the target (last, once every step succeeded)`);
      out.line(`${steps.length} steps (dry run — nothing touched)${kept.length ? ` · ${kept.length} createOnly kept (--force includes them)` : ''}`);
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
    // the receipts go last, and only when the teardown is complete
    let receipts = [];
    if (failures) {
      out.warn(`receipts KEPT on ${ctx.target.name} — ${failures} step(s) failed, ${pkg.manifest.code} is still partly installed (re-run destroy to finish)`);
    } else {
      receipts = await removeReceipts(ctx, pkg.manifest.code);
      for (const r of receipts) {
        if (!r.ok) out.warn(`receipt ${r.surface}: could not delete (${r.error}) — uxc installed still lists ${pkg.manifest.code}`);
        else if (r.action === 'deleted') out.line(`${'delete'.padEnd(10)} receipt ${r.surface} (${pkg.manifest.code})`);
      }
    }
    out.line(`destroy: ${steps.length - failures}/${steps.length} steps ok — caches cleared (files/registry/state untouched)${kept.length ? ` · ${kept.length} createOnly kept` : ''}`);
    if (failures) process.exitCode = 1;
    out.result({ steps: steps.length, failures, kept: kept.length, receipts });
  },
};
