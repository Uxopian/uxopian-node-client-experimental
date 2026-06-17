// uxc status — 3-way drift (local by default, --remote checks the server too) + untracked
// files + handler orphans + pendingCacheClear. Exit 1 on drift.
import { statusAll } from '../sync.mjs';
import { FOOTNOTES } from '../explain.mjs';

const DRIFT = new Set(['local', 'server', 'conflict', 'collision', 'server-missing', 'new']);

/** Boolean flag that may have swallowed the next positional (parser quirk): reclaim it. */
const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'status',
  summary: 'drift vs base/server + untracked + orphans + pendingCacheClear (exit 1 on drift)',
  help: 'uxc status [--remote] [kind|id…]',
  async run(ctx) {
    const { flags, out } = ctx;
    ctx.requirePkg();
    const only = [...ctx.args];
    const remote = reclaim(flags, only, 'remote');
    ctx.connect(); // resolves the target (state key); no network unless --remote triggers reads

    const { rows = [], untracked = [], orphans = [], pendingCacheClear } =
      await statusAll(ctx, { remote, only });

    for (const r of rows.filter((x) => x.state !== 'insync')) {
      out.line(`${String(r.state).padEnd(14)} ${r.kind}/${r.id}${r.detail ? '  ' + r.detail : ''}`);
    }
    for (const u of untracked) out.line(`${'untracked'.padEnd(14)} ${u}`);
    for (const o of orphans) {
      out.line(`${'orphan'.padEnd(14)} ${typeof o === 'string' ? o : `${o.kind ?? 'fd.handler'}/${o.id ?? JSON.stringify(o)}${o.detail ? '  ' + o.detail : ''}`}`);
    }
    if (pendingCacheClear) out.warn(FOOTNOTES.cachePending);

    const counts = {};
    for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
    const parts = Object.entries(counts).sort().map(([s, n]) => `${n} ${s}`);
    if (untracked.length) parts.push(`${untracked.length} untracked`);
    if (orphans.length) parts.push(`${orphans.length} orphan`);
    out.line(parts.length ? `summary: ${parts.join(', ')}${remote ? '' : ' (local only — --remote checks the server)'}` : 'summary: empty registry');

    if (rows.some((r) => DRIFT.has(r.state)) || orphans.length) process.exitCode = 1;
    out.result({ rows, untracked, orphans, pendingCacheClear });
  },
};
