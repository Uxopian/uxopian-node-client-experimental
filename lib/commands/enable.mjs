// uxc enable — re-enable a disabled handler: in-place Enabled=true flip on the live
// registration + cache clear + state note. (In-place: no version bump, no blind window.)
import { KINDS } from '../kinds/index.mjs';
import { splitHandlerId } from '../naming.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'enable',
  summary: 're-enable a disabled handler in place (Enabled tag flip)',
  help: 'uxc enable <handlerId>',
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    const arg = ctx.args[0];
    if (!arg) fail('usage: uxc enable <handlerId>');
    const entry = pkg.resolve(arg);
    if (entry && entry.kind !== 'fd.handler') fail(`${entry.kind}/${entry.id} is not a handler — enable applies to fd.handler only`);
    const id = entry ? entry.id : splitHandlerId(arg).logical;
    const adapter = KINDS['fd.handler'];
    if (typeof adapter.enable !== 'function') fail('fd.handler adapter does not expose enable()');
    ctx.connect();

    await adapter.enable(ctx, id);
    await ctx.clients.cacheClear();
    pkg.setResState(ctx.target.name, 'fd.handler', id, { disabled: false });
    out.line(`enabled fd.handler/${id} — Enabled=true flipped in place; caches cleared`);
    out.result({ id, disabled: false });
  },
};
