// uxc diff — canonical local vs server, meta and content diffed separately for
// content-bearing kinds. Capped at 80 lines per section (--full lifts the cap). Exit 1 on diff.
import { localOf, serverOf } from '../sync.mjs';
import { canonicalText } from '../canonical.mjs';
import { diffLines, fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'diff',
  summary: 'canonical local-vs-server diff (meta + content separately), capped at 80 lines',
  help: 'uxc diff <id> [--full]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const full = reclaim(flags, args, 'full');
    reclaim(flags, args, 'base');
    const arg = args[0];
    if (!arg) fail('usage: uxc diff <id> [--full]');
    const entry = pkg.resolve(arg);
    if (!entry) fail(`unknown resource "${arg}" — registered ids: uxc status`);
    ctx.connect();
    if (flags.base) out.note('(--base: the base is a hash, not content — showing local vs server)');

    const key = `${entry.kind}/${entry.id}`;
    const local = localOf(pkg, entry);
    const server = await serverOf(ctx, entry);
    if (!local && !server) {
      out.line(`${key}: absent locally AND on server`);
      process.exitCode = 1;
      out.result({ id: key, meta: [], content: {}, localMissing: true, serverMissing: true });
      return;
    }
    if (!local) out.warn(`${key}: local file missing`);
    if (!server) out.warn(`${key}: missing on server`);

    const result = { id: key, meta: [], content: {} };
    const cap = 80;
    let changed = !local || !server;

    // meta: canonical text, server on the '-' side, local on the '+' side (what push would do)
    const sText = server ? canonicalText(entry.kind, server.obj) : '';
    const lText = local ? canonicalText(entry.kind, local.obj) : '';
    if (sText !== lText) {
      result.meta = diffLines(sText, lText);
      changed = true;
      out.diff(`--- ${key} meta (server)  +++ local  [±${result.meta.length} lines]`, result.meta, { cap, full });
    } else {
      out.line(`${key} meta: identical`);
    }

    // content: line diff of the content buffers as utf8, one section per file
    const files = [...new Set([
      ...Object.keys(local?.contents ?? {}),
      ...Object.keys(server?.contents ?? {}),
    ])].sort();
    for (const f of files) {
      const a = (server?.contents?.[f] ?? Buffer.alloc(0)).toString('utf8');
      const b = (local?.contents?.[f] ?? Buffer.alloc(0)).toString('utf8');
      if (a === b) { out.line(`${key} content ${f}: identical`); continue; }
      const d = diffLines(a, b);
      result.content[f] = d;
      changed = true;
      out.diff(`--- ${key} ${f} (server)  +++ local  [±${d.length} lines]`, d, { cap, full });
    }

    if (changed) process.exitCode = 1;
    out.result(result);
  },
};
