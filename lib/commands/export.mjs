// uxc export — zip the package (minus .uxc/) into a .uxpkg. Refuses when status vs the
// default target is dirty unless --allow-dirty; ai.mcp secrets are scrubbed by packageio.
import { exportPackage } from '../packageio.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'export',
  summary: 'export the package as a .uxpkg (no .uxc/, secrets scrubbed; refuses dirty unless --allow-dirty)',
  help: 'uxc export [-o file.uxpkg] [--allow-dirty]',
  async run(ctx) {
    const { flags, out } = ctx;
    ctx.requirePkg();
    const args = [...ctx.args];
    const allowDirty = reclaim(flags, args, 'allow-dirty');

    // -o is positional to the parser (single-dash flags are not parsed)
    let output = typeof flags.output === 'string' ? flags.output : typeof flags.o === 'string' ? flags.o : null;
    const i = args.indexOf('-o');
    if (i >= 0) { output = args[i + 1] ?? output; args.splice(i, 2); }
    if (!output && args[0]) output = args[0];

    if (!allowDirty) ctx.connect(); // the dirty check runs against the default target

    const res = await exportPackage(ctx, { output, allowDirty });
    const file = res?.file ?? res?.output ?? output;
    out.line(`exported ${file ?? '(package)'}${res?.entries != null ? `  (${res.entries} entries${res.bytes != null ? `, ${res.bytes} bytes` : ''})` : ''}`);
    out.result(res ?? { file });
  },
};
