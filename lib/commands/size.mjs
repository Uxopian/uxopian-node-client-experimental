// uxc size [id…] — the push-body budget, before the push (BACKLOG-AGENTIC #17).
// A composed fd.script/fd.handler grows a part at a time until nginx answers a bare
// `413 Request Entity Too Large` on /core/rest/files/tmp with no hint (LEARNINGS §30/§33).
// This prints what each resource composes to, what is left of the budget, and what
// `// @include <file> strip` would still save — so the ceiling is visible before it is hit.
import { resourceSizes, sizeWarnings, kb, DEFAULT_SIZE_WARN_BYTES, HARD_LIMIT_BYTES } from '../lint.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'size',
  summary: 'composed push-body size per resource + what --strip would save (413 budget)',
  help: 'uxc size [id…] [--warn-at bytes] [--json]',
  async run(ctx) {
    const { out, flags } = ctx;
    const pkg = ctx.requirePkg();
    const entries = ctx.args.length
      ? ctx.args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`))
      : pkg.entries().filter((e) => !e.retired);

    const warnAt = Number(flags['warn-at'] ?? DEFAULT_SIZE_WARN_BYTES);
    const rows = resourceSizes(pkg, entries);
    if (!rows.length) { out.line('no content-bearing resources in scope'); return out.result([]); }
    const warnings = sizeWarnings(rows, warnAt);

    if (out.json) return out.result({ limitBytes: HARD_LIMIT_BYTES, warnAtBytes: warnAt, rows, warnings });

    out.table(
      rows.map((r) => ({
        resource: `${r.kind}/${r.id}`,
        file: r.file,
        size: kb(r.bytes),
        'of limit': `${Math.round((r.bytes / HARD_LIMIT_BYTES) * 100)}%`,
        'strip saves': r.saved > 0 ? kb(r.saved) : '',
      })),
      [{ key: 'resource', max: 46 }, { key: 'file', max: 30 }, { key: 'size' }, { key: 'of limit' }, { key: 'strip saves' }],
    );
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    out.line(`${rows.length} file(s), ${kb(total)} total · server body limit ~${kb(HARD_LIMIT_BYTES)} per resource`);
    for (const w of warnings) out.warn(w.message);
    if (warnings.some((w) => w.over)) process.exitCode = 1;
  },
};
