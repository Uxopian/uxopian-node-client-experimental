// uxc refs — which package files mention this id (token-boundary scan). Capped at 50 lines.
import { findRefs } from '../refs.mjs';
import { fail } from '../output.mjs';

const CAP = 50;

export default {
  name: 'refs',
  summary: 'list package files/lines mentioning an id (token-boundary, capped at 50)',
  help: 'uxc refs <id>',
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    const arg = ctx.args[0];
    if (!arg) fail('usage: uxc refs <id>');
    let id = arg;
    try {
      const entry = pkg.resolve(arg);
      if (entry) id = entry.id;
    } catch { /* ambiguous bare id: scan the raw token as given */ }

    const hits = findRefs(pkg, id) ?? [];
    for (const h of hits.slice(0, CAP)) out.line(`${h.path}:${h.line}  ${h.text}`);
    if (hits.length > CAP) out.line(`(… ${hits.length - CAP} more lines)`);
    out.line(`${hits.length} reference${hits.length === 1 ? '' : 's'} to ${id} in ${new Set(hits.map((h) => h.path)).size} file(s)`);
    out.result(hits);
  },
};
