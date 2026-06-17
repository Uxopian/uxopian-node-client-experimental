// uxc task ls — list tasks (category TASK search). Footnoted: status NEW does not mean unanswered.
import { FOOTNOTES } from '../explain.mjs';

export default {
  name: 'task ls',
  summary: 'list tasks (--class <taskClassId>)',
  help: 'uxc task ls [--class CtDeviationReview] [--max n]',
  async run(ctx) {
    ctx.connect();
    const res = await ctx.clients.core.search({
      classId: ctx.flags.class || undefined,
      fields: ['name', 'classid'],
      max: Number(ctx.flags.max ?? 20),
      category: 'tasks',
    });
    const rows = res.results.map((r) => ({ id: r.id, name: r.fields.name, classid: r.fields.classid }));

    if (ctx.out.json) return ctx.out.result({ found: res.found, rows });
    ctx.out.line(`found ${res.found}`);
    ctx.out.table(rows, [{ key: 'id', max: 80 }, { key: 'name' }, { key: 'classid' }]);
    ctx.out.note(FOOTNOTES.taskStatus);
  },
};
