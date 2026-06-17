// uxc disable — the handler emergency kill switch: in-place Enabled=false flip on the live
// registration (no version bump, no ~45 s blind window) + cache clear + state note.
import { KINDS } from '../kinds/index.mjs';
import { splitHandlerId } from '../naming.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'disable',
  summary: 'disable a handler in place (Enabled tag flip — no version bump, no blind window)',
  help: 'uxc disable <handlerId>',
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    const arg = ctx.args[0];
    if (!arg) fail('usage: uxc disable <handlerId>');
    const entry = pkg.resolve(arg);
    if (entry && entry.kind !== 'fd.handler') fail(`${entry.kind}/${entry.id} is not a handler — disable applies to fd.handler only`);
    const id = entry ? entry.id : splitHandlerId(arg).logical;
    const adapter = KINDS['fd.handler'];
    if (typeof adapter.disable !== 'function') fail('fd.handler adapter does not expose disable()');
    ctx.connect();

    await adapter.disable(ctx, id);
    await ctx.clients.cacheClear();
    pkg.setResState(ctx.target.name, 'fd.handler', id, { disabled: true });
    out.line(`disabled fd.handler/${id} — Enabled=false flipped in place; caches cleared`);
    out.note('status shows it as disabled, not drift; uxc enable ' + id + ' to restore');
    out.result({ id, disabled: true });
  },
};
