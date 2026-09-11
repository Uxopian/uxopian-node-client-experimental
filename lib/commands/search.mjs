// uxc search [classId] — the core.search wrapper. --where 'Tag=a|b' is REPEATABLE
// (the dispatcher's flag parser keeps only the last value, so repeats are re-collected
// from process.argv here); '|' in a value = multi-value EQUALS_TO (OR).
//
// --category picks the COMPONENT CATEGORY, and picking the wrong one is silent: FlowerDocs gives
// each category its own endpoint, and searching documents for a virtual folder answers `found 0`
// rather than an error (BACKLOG #18 — `uxc search PoOrder` reported 0 against 39 PoOrder folders).
// When a categoryless search finds nothing, we say which OTHER categories do have hits instead of
// leaving the caller to conclude the instance is empty.
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
  summary: 'REST search (--where Tag=a|b … --category TASK|VIRTUAL_FOLDER --order f:desc --max 20)',
  help: "uxc search [classId] [--where 'Tag=a|b']… [--category DOCUMENT|TASK|VIRTUAL_FOLDER|FOLDER] [--order field:desc] [--fields a,b] [--max n]",
  lock: 'read',
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

    const asked = String(ctx.flags.category ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    const CATEGORY = {
      TASK: 'tasks', TASKS: 'tasks',
      DOCUMENT: 'documents', DOCUMENTS: 'documents',
      VIRTUALFOLDER: 'virtualfolder', VF: 'virtualfolder', VFINSTANCE: 'virtualfolder',
      FOLDER: 'folders', FOLDERS: 'folders',
    };
    if (asked && !CATEGORY[asked]) {
      fail(`unknown --category "${ctx.flags.category}" — DOCUMENT (default), TASK, VIRTUAL_FOLDER, FOLDER`);
    }
    const category = CATEGORY[asked] ?? 'documents';
    const tasks = category === 'tasks';
    const fields = ctx.flags.fields
      ? String(ctx.flags.fields).split(',').map((s) => s.trim()).filter(Boolean)
      : ['name', 'classid', ...Object.keys(where)];
    const max = Number(ctx.flags.max ?? 20);

    const query = { classId, where, fields, max, order: ctx.flags.order || undefined };
    const res = await ctx.clients.core.search({ ...query, category });

    const rows = res.results.map((r) => ({ id: r.id, ...Object.fromEntries(fields.map((f) => [f, r.fields[f]])) }));

    // A bare `found 0` is the wrong answer when the thing exists in another category: probe the
    // others (cheap, max 1) and name where the hits actually are.
    let elsewhere = [];
    if (!res.found && !asked) {
      for (const other of ['virtualfolder', 'tasks', 'folders']) {
        try {
          const probe = await ctx.clients.core.search({ ...query, max: 1, category: other });
          if (probe.found) elsewhere.push({ category: other, found: probe.found });
        } catch { /* a category this server does not serve — nothing to report */ }
      }
    }

    if (ctx.out.json) return ctx.out.result({ found: res.found, category, rows, elsewhere });

    ctx.out.line(`found ${res.found}${asked ? '' : ' (documents)'}`);
    ctx.out.table(rows, [{ key: 'id', max: 80 }, ...fields.map((f) => ({ key: f }))]);
    for (const e of elsewhere) {
      ctx.out.note(`but ${e.found} match(es) exist as ${e.category === 'virtualfolder' ? 'VIRTUAL FOLDERS' : e.category.toUpperCase()}`
        + ` — re-run with --category ${e.category === 'virtualfolder' ? 'VIRTUAL_FOLDER' : e.category.toUpperCase().replace(/S$/, '')}`);
    }
    if (tasks) ctx.out.note(FOOTNOTES.taskStatus);
  },
};
