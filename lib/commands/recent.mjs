// uxc recent [classId] — newest components first (order creationDate:desc — the camelCase
// TIMESTAMP form; lowercase 'creationdate' 500s). --since 15m filters client-side when the
// rows actually echo a creationDate field; otherwise you simply get the newest N.
import { parseDuration } from '../util.mjs';

/** FlowerDocs '2026-06-12 01:23:45.678 +0000' (or ISO-ish) -> epoch ms | null. */
function parseFdTs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\s*(?:([+-]\d{2}):?(\d{2})|Z))?/);
  if (m) {
    const zone = m[3] ? `${m[3]}:${m[4]}` : 'Z';
    const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export default {
  name: 'recent',
  summary: 'newest documents/tasks (--category TASK, --since 15m, --max 20)',
  help: 'uxc recent [classId] [--category TASK] [--since 15m] [--max 20]',
  async run(ctx) {
    ctx.connect();
    const classId = ctx.args[0];
    const tasks = String(ctx.flags.category ?? '').toUpperCase() === 'TASK';

    const res = await ctx.clients.core.search({
      classId: classId || undefined,
      fields: ['name', 'classid', 'creationDate'],
      max: Number(ctx.flags.max ?? 20),
      order: 'creationDate:desc',
      category: tasks ? 'tasks' : 'documents',
    });

    let rows = res.results.map((r) => ({
      id: r.id, name: r.fields.name, classid: r.fields.classid, creationDate: r.fields.creationDate,
    }));

    if (ctx.flags.since) {
      const cutoff = Date.now() - parseDuration(ctx.flags.since);
      if (rows.some((r) => r.creationDate)) {
        rows = rows.filter((r) => {
          const t = parseFdTs(r.creationDate);
          return t == null || t >= cutoff; // unparseable dates stay visible rather than vanish
        });
      } else {
        ctx.out.note('creationDate not echoed in rows — showing the newest instead of a strict --since cut');
      }
    }

    if (ctx.out.json) return ctx.out.result({ found: res.found, rows });
    ctx.out.line(`found ${res.found}`);
    ctx.out.table(rows, [{ key: 'id', max: 80 }, { key: 'name' }, { key: 'classid' }]);
  },
};
