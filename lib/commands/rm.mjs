// uxc rm — the DESIGN §9 deletion matrix. Bare rm errors: choose a side.
//   --local  : file deleted, registry entry removed, state removed; server untouched (-> foreign)
//   --server : file KEPT, registry tombstoned (retired:true), base cleared, server deleted
//   --both   : file + registry + state removed, server deleted
// createOnly/external policies gate the server delete behind --force (test teardown only).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { KINDS } from '../kinds/index.mjs';
import { resourceKey } from '../registry.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

function removeLocalOf(adapter, pkg, entry) {
  if (typeof adapter.removeLocal === 'function') return adapter.removeLocal(pkg, entry);
  if (entry.path) rmSync(join(pkg.dir, entry.path), { recursive: true, force: true });
}

function clearStateAllTargets(pkg, kind, id) {
  const key = resourceKey(kind, id);
  for (const t of Object.values(pkg.state.targets ?? {})) delete t.resources?.[key];
  pkg.saveState();
}

export default {
  name: 'rm',
  summary: 'remove a resource: --local (file+registry) | --server (tombstone+delete) | --both',
  help: 'uxc rm <id> --local | --server | --both  [--force]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const local = reclaim(flags, args, 'local');
    const server = reclaim(flags, args, 'server');
    const both = reclaim(flags, args, 'both');
    const force = reclaim(flags, args, 'force');
    const arg = args[0];
    if (!arg) fail('usage: uxc rm <id> --local | --server | --both  [--force]');
    if ([local, server, both].filter(Boolean).length !== 1) {
      fail('uxc rm: choose exactly one of --local (keep server), --server (keep file, tombstone), --both');
    }
    const entry = pkg.resolve(arg);
    if (!entry) fail(`unknown resource "${arg}" — registered ids: uxc status`);
    const adapter = KINDS[entry.kind];
    const key = resourceKey(entry.kind, entry.id);

    const deleteServer = server || both;
    if (deleteServer) {
      if ((entry.policy === 'createOnly' || entry.policy === 'external') && !force) {
        fail(`${key}: policy ${entry.policy} — server delete refused (use --force ONLY for test teardown${entry.kind === 'fd.taskclass' ? '; recreating a taskclass breaks ANSWER dispatch permanently — schema change = NEW id' : ''})`);
      }
      ctx.connect();
      if (adapter.cacheAffecting) pkg.setPendingCacheClear(ctx.target.name, true);
      await adapter.remove(ctx, entry.id);
      out.line(`server: deleted ${key}`);
      if (adapter.cacheAffecting) {
        await ctx.clients.cacheClear();
        pkg.setPendingCacheClear(ctx.target.name, false);
        out.note('caches cleared (gui + core)');
      }
    }

    if (local || both) {
      removeLocalOf(adapter, pkg, entry);
      pkg.removeEntry(entry.kind, entry.id);
      clearStateAllTargets(pkg, entry.kind, entry.id);
      out.line(`local: removed ${key} (file + registry entry + state)${local ? ' — server untouched (now foreign)' : ''}`);
    } else {
      // --server: keep the file, tombstone the entry, clear the base for this target
      entry.retired = true;
      pkg.saveRegistry();
      pkg.setResState(ctx.target.name, entry.kind, entry.id, null);
      out.line(`registry: ${key} tombstoned (retired: true) — file kept; excluded from push (uxc push ${entry.id} --revive to undo)`);
    }
    out.result({ id: key, local: local || both, server: deleteServer, retired: server && !both });
  },
};
