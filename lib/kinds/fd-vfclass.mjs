// fd.vfclass — /rest/virtualfolderclass (learnings §15). The VF DTO uses 'type' discriminators;
// '@class' is the /rest/documents/search dialect and silently breaks here. Aggregation: every
// level with nested children MUST also carry 'field' (stores OK otherwise, yields NO buckets).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

function findKey(v, key, report, path = '$') {
  if (Array.isArray(v)) v.forEach((x, i) => findKey(x, key, report, `${path}[${i}]`));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === key) report(`${path}.${k}`);
      findKey(x, key, report, `${path}.${k}`);
    }
  }
}

function checkAgg(agg, where, errs) {
  if (!agg || typeof agg !== 'object') return;
  if (Array.isArray(agg.nested) && agg.nested.length && !agg.field) {
    errs.push(`${where}: aggregation has nested levels but no outer "field" — parses+stores but yields NO buckets`);
  }
  for (const n of agg.nested ?? []) checkAgg(n, where, errs);
}

export default classKindAdapter({
  kind: 'fd.vfclass',
  dir: 'fd/vfclasses',
  restPath: 'virtualfolderclass',
  category: 'VIRTUAL_FOLDER',
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return errs;
    findKey(o, '@class', (path) =>
      errs.push(`${entry.id}: '@class' at ${path} — VF class DTO uses "type" discriminators, not '@class'`));
    for (const s of o.searches ?? []) {
      checkAgg(s?.request?.aggregation, `${entry.id} search "${s?.id}"`, errs);
    }
    return errs;
  },
  template(ctx, name, flags) {
    return {
      obj: {
        id: name,
        category: 'VIRTUAL_FOLDER',
        active: true,
        displayNames: dn(flags.title ?? name, flags.fr),
        searches: [],
      },
    };
  },
});
