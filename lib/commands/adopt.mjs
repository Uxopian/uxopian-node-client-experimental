// uxc adopt — bring live server resources under registry ownership.
//   single:  uxc adopt <kind> <server-id> [--external]   (readServer -> writeLocal -> base hash)
//   bulk:    uxc adopt --scan [--kind k1,k2] [--yes]     (prefix-driven discovery -> checklist)
// Prefix scanning is the sanctioned BOOTSTRAP only — ownership lives in the registry.
import { KINDS, PUSH_ORDER, kindOf } from '../kinds/index.mjs';
import { splitHandlerId } from '../naming.mjs';
import { hashResource } from '../canonical.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

function entryPath(adapter, pkg, id) {
  if (typeof adapter.pathFor === 'function') return adapter.pathFor(pkg, id);
  return adapter.layout === 'dir' ? `${adapter.dir}/${id}` : `${adapter.dir}/${id}.json`;
}

async function adoptOne(ctx, pkg, adapter, serverId, { external = false, warnNoSuffix = false } = {}) {
  let id = serverId;
  if (adapter.kind === 'fd.handler') {
    const { logical, n } = splitHandlerId(serverId);
    if (n == null && warnNoSuffix) ctx.out.warn(`handler id "${serverId}" carries no _vN suffix — adopting it as the logical name`);
    id = logical; // registry key is the LOGICAL name; live N comes from the server
  }
  const server = await adapter.readServer(ctx, id);
  if (!server) throw new Error(`${adapter.kind}/${id} not found on server`);
  const entry = pkg.addEntry({
    kind: adapter.kind,
    id,
    title: server.obj?.displayNames?.[0]?.value ?? server.obj?.name ?? undefined,
    path: entryPath(adapter, pkg, id),
    policy: external ? 'external' : adapter.defaultPolicy,
  });
  adapter.writeLocal(pkg, entry, server);
  // base = hash(canon(server echo)) — the file just written IS that echo
  const patch = { syncedHash: hashResource(adapter.kind, server.obj, Object.values(server.contents ?? {})) };
  if (adapter.kind === 'ai.goal' && server.obj?.id) patch.serverId = server.obj.id; // per-target row id
  pkg.setResState(ctx.target.name, adapter.kind, id, patch);
  return entry;
}

export default {
  name: 'adopt',
  summary: 'adopt live server resources into the registry (single id, or --scan bulk discovery)',
  help: 'uxc adopt <kind> <server-id> [--external]   |   uxc adopt --scan [--kind k1,k2] [--yes]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    ctx.connect();

    // ---- bulk: --scan ----
    if (flags.scan !== undefined && flags.scan !== false) {
      const args = [...ctx.args];
      const yes = reclaim(flags, args, 'yes');
      const kindsFilter = [];
      if (typeof flags.scan === 'string') kindsFilter.push(flags.scan); // --scan swallowed a kind
      if (typeof flags.kind === 'string') kindsFilter.push(...flags.kind.split(',').map((s) => s.trim()).filter(Boolean));
      kindsFilter.push(...args.filter((a) => KINDS[a]));
      const scanKinds = PUSH_ORDER.filter((k) => !kindsFilter.length || kindsFilter.includes(k));

      const candidates = [];
      for (const k of scanKinds) {
        const a = KINDS[k];
        if (typeof a?.scan !== 'function') continue;
        try {
          for (const c of await a.scan(ctx, pkg.manifest)) {
            if (!c?.id || pkg.entry(k, c.id)) continue; // already registered
            candidates.push({ kind: k, id: c.id, title: c.title ?? '' });
          }
        } catch (e) {
          out.warn(`scan ${k}: ${e.message}`);
        }
      }
      if (!candidates.length) { out.line('nothing new to adopt'); out.result([]); return; }
      if (!yes) {
        for (const c of candidates) out.line(`[ ] ${c.kind}/${c.id}${c.title ? '  ' + c.title : ''}`);
        out.line(`${candidates.length} candidates — re-run with --yes to adopt all`);
        out.result(candidates);
        return;
      }
      const adopted = [];
      let i = 0;
      for (const c of candidates) {
        i++;
        try {
          await adoptOne(ctx, pkg, KINDS[c.kind], c.id);
          out.line(`adopt ${String(i).padStart(String(candidates.length).length)}/${candidates.length}  ${c.kind}/${c.id}`);
          adopted.push(c);
        } catch (e) {
          out.warn(`adopt ${c.kind}/${c.id}: ${e.message}`);
        }
      }
      out.line(`adopted ${adopted.length}/${candidates.length}`);
      if (adopted.length < candidates.length) process.exitCode = 1;
      out.result(adopted);
      return;
    }

    // ---- single: <kind> <server-id> ----
    const args = [...ctx.args];
    const external = reclaim(flags, args, 'external');
    const [kindName, serverId] = args;
    if (!kindName || !serverId) fail('usage: uxc adopt <kind> <server-id> [--external]   |   uxc adopt --scan [--kind k1,k2] [--yes]');
    const adapter = kindOf(kindName);
    if (pkg.entry(adapter.kind, adapter.kind === 'fd.handler' ? splitHandlerId(serverId).logical : serverId)) {
      fail(`${adapter.kind}/${serverId} is already registered`);
    }
    const entry = await adoptOne(ctx, pkg, adapter, serverId, { external, warnNoSuffix: true });
    out.line(`adopted ${adapter.kind}/${entry.id} -> ${entry.path}${external ? '  (external: never written, never deleted)' : ''}`);
    out.result({ kind: adapter.kind, id: entry.id, path: entry.path, policy: entry.policy });
  },
};
