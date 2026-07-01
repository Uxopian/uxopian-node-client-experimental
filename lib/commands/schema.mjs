// uxc schema <classId> — the joined tagReferences × tagclass × tagcategory table, in 3 GETs:
// class single-get (documentclass else taskclass) + ONE tagclass list + ONE tagcategory list.
// --tag T = full single-tag detail incl. ALL choicelist values.
import { canonicalText } from '../canonical.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'schema',
  summary: 'class schema: tagReferences × tagclass × categories table (--tag T for one-tag detail)',
  help: 'uxc schema <classId> [--tag T]',
  async run(ctx) {
    const classId = ctx.args[0];
    if (!classId) fail('usage: uxc schema <classId> [--tag T]');
    ctx.connect();
    const { core } = ctx.clients;
    const enc = encodeURIComponent(classId);

    let category = 'DOCUMENT';
    let cls = await core.getOne(`/rest/documentclass/${enc}`);
    if (!cls) { cls = await core.getOne(`/rest/folderclass/${enc}`); category = 'FOLDER'; }
    if (!cls) { cls = await core.getOne(`/rest/taskclass/${enc}`); category = 'TASK'; }
    if (!cls) fail(`class ${classId} not found (tried documentclass, folderclass, taskclass)`);

    const tagclasses = (await core.get('/rest/tagclass')) ?? [];
    const categories = (await core.get('/rest/tagcategory')) ?? [];
    const tcById = new Map(tagclasses.map((t) => [t.id, t]));
    const catOf = new Map();
    for (const c of categories) for (const t of c.tags ?? []) if (!catOf.has(t)) catOf.set(t, c.id);

    const refs = cls.tagReferences ?? [];

    if (ctx.flags.tag) {
      const tagId = ctx.flags.tag;
      const tc = tcById.get(tagId);
      if (!tc) fail(`tagclass ${tagId} not found`);
      const ref = refs.find((r) => r.tagName === tagId) ?? null;
      if (ctx.out.json) return ctx.out.result({ classId, tagclass: tc, reference: ref, category: catOf.get(tagId) ?? null });
      ctx.out.line(`${tagId}  type=${tc.type}  category=${catOf.get(tagId) ?? '-'}  ` +
        `${ref ? `on ${classId}: ${[ref.mandatory ? 'mandatory' : null, ref.readonly ? 'readonly' : null, ref.multivalued ? 'multivalued' : null].filter(Boolean).join(',') || 'optional'}` : `NOT referenced by ${classId}`}`);
      process.stdout.write(canonicalText('fd.tagclass', tc)); // full detail incl. ALL choicelist values
      return;
    }

    const rows = refs.map((ref) => {
      const tc = tcById.get(ref.tagName);
      const vals = (tc?.allowedValues ?? []).map((v) => v.symbolicName ?? v.id ?? '');
      return {
        tag: ref.tagName,
        type: tc?.type ?? '?',
        'M/RO': [ref.mandatory ? 'M' : null, ref.readonly ? 'RO' : null].filter(Boolean).join(',') || '-',
        category: catOf.get(ref.tagName) ?? '',
        values: vals.slice(0, 8).join(',') + (vals.length > 8 ? ` (+${vals.length - 8})` : ''),
      };
    });

    if (ctx.out.json) return ctx.out.result({ classId, category, tagCategories: cls.tagCategories ?? [], rows });
    ctx.out.table(rows, [
      { key: 'tag' }, { key: 'type' }, { key: 'M/RO' }, { key: 'category' }, { key: 'values', max: 100 },
    ]);
    ctx.out.line(`${classId} (${category}): ${rows.length} tags, categories: ${(cls.tagCategories ?? []).join(', ') || '-'}`);
  },
};
