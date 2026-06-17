// uxc search [classId] — the core.search wrapper. --where 'Tag=a|b' is REPEATABLE
// (the dispatcher's flag parser keeps only the last value, so repeats are re-collected
// from process.argv here); '|' in a value = multi-value EQUALS_TO (OR).
import { FOOTNOTES } from '../explain.mjs';
import { fail } from '../output.mjs';

/** Collect EVERY occurrence of --<name> from argv (the shared parser keeps only the last). */
function collectFlag(name) {
  const argv = process.argv.slice(2);
  const vals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    } else if (argv[i].startsWith(`--${name}=`)) vals.push(argv[i].slice(name.length + 3));
  }
  return vals;
}

export default {
  name: 'search',
  summary: 'REST search (--where Tag=a|b … --category TASK --order f:desc --fields --max 20)',
  help: "uxc search [classId] [--where 'Tag=a|b']… [--category TASK] [--order field:desc] [--fields a,b] [--max n]",
  async run(ctx) {
    ctx.connect();
    const classId = ctx.args[0];

    const where = {};
    for (const w of collectFlag('where')) {
      const eq = w.indexOf('=');
      if (eq < 1) fail(`bad --where "${w}" — expected Tag=value or Tag=a|b`);
      const v = w.slice(eq + 1);
      where[w.slice(0, eq)] = v.includes('|') ? v.split('|') : v;
    }

    const tasks = String(ctx.flags.category ?? '').toUpperCase() === 'TASK';
    const fields = ctx.flags.fields
      ? String(ctx.flags.fields).split(',').map((s) => s.trim()).filter(Boolean)
      : ['name', 'classid', ...Object.keys(where)];
    const max = Number(ctx.flags.max ?? 20);

    const res = await ctx.clients.core.search({
      classId, where, fields, max,
      order: ctx.flags.order || undefined,
      category: tasks ? 'tasks' : 'documents',
    });

    const rows = res.results.map((r) => ({ id: r.id, ...Object.fromEntries(fields.map((f) => [f, r.fields[f]])) }));
    if (ctx.out.json) return ctx.out.result({ found: res.found, rows });

    ctx.out.line(`found ${res.found}`);
    ctx.out.table(rows, [{ key: 'id', max: 80 }, ...fields.map((f) => ({ key: f }))]);
    if (tasks) ctx.out.note(FOOTNOTES.taskStatus);
  },
};
