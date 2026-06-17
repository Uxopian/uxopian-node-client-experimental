// fd.tagclass — /rest/tagclass (learnings §6: array bodies, id-in-path update, F00903 on re-create).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

const TYPES = ['STRING', 'TEXT', 'INT', 'CHOICELIST', 'DATE', 'BOOLEAN', 'ICON']; // NOT 'INTEGER'

/** 'Credit insurance' | 'CreditInsurance' -> 'CREDIT_INSURANCE' (choicelist symbolicName convention). */
const upperSnake = (s) =>
  String(s).trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

export default classKindAdapter({
  kind: 'fd.tagclass',
  dir: 'fd/tagclasses',
  restPath: 'tagclass',
  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return errs;
    if (!TYPES.includes(o.type)) errs.push(`${entry.id}: type "${o.type}" — must be one of ${TYPES.join('/')}`);
    if (o.type === 'CHOICELIST' && !(Array.isArray(o.allowedValues) && o.allowedValues.length)) {
      errs.push(`${entry.id}: CHOICELIST requires non-empty allowedValues`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    const obj = {
      id: name,
      type: flags.type || 'STRING',
      searchable: true,
      displayNames: dn(flags.title ?? name, flags.fr),
    };
    if (flags.values) {
      obj.allowedValues = String(flags.values).split(',').map((v) => v.trim()).filter(Boolean)
        .map((v) => ({ symbolicName: upperSnake(v), displayNames: dn(v) }));
    }
    return { obj };
  },
});
