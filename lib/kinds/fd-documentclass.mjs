// fd.documentclass — /rest/documentclass (learnings §6: needs category DOCUMENT + active:true
// or F00204; update is FULL-REPLACE — resend every tagReference or they clear).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

/** 'CtFoo:mandatory,SourceContractId:readonly' -> tagReference objects (qualifiers combinable). */
function parseTagRefs(spec) {
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((item, i) => {
    const [tagName, ...quals] = item.split(':').map((s) => s.trim());
    return {
      tagName,
      mandatory: quals.includes('mandatory'),
      multivalued: false,
      technical: false,
      readonly: quals.includes('readonly'),
      order: i,
    };
  });
}

export default classKindAdapter({
  kind: 'fd.documentclass',
  dir: 'fd/classes',
  restPath: 'documentclass',
  category: 'DOCUMENT',
  validate(pkg, entry, local) {
    const errs = [];
    if (local?.obj && !local.obj.category) {
      errs.push(`${entry.id}: category is required (F00204) — expected "DOCUMENT"`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    return {
      obj: {
        id: name,
        category: 'DOCUMENT',
        active: true,
        data: { ACL: 'acl-readonly' },
        tagReferences: flags.tags ? parseTagRefs(flags.tags) : [],
        tagCategories: flags['category-ids']
          ? String(flags['category-ids']).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        displayNames: dn(flags.title ?? name, flags.fr),
      },
    };
  },
});
