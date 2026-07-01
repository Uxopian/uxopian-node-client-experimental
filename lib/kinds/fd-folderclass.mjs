// fd.folderclass — /rest/folderclass. A FOLDER-category componentclass with PHYSICAL parent-child
// containment (docs pp.17, 49, 237): `children[]` constrains which component classes may be added as
// children — one entry per allowed category, shape `{ category, id }` where `id` is the allowed child
// class id ('*' = any class of that category), mirroring the base `Folder` class. This is DISTINCT
// from the taskclass attachment-slot `children` (§20), which carry per-slot classId/displayNames/
// multivalued. Same verb pattern as documentclass (array body, id-in-path, FULL-REPLACE update);
// folder classes use the base `acl-folder` security (F00208 if data.ACL is missing/invalid).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

/** 'PoFoo:mandatory,Bar:readonly' -> tagReference objects (same qualifiers as documentclass). */
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

/**
 * '--children DOCUMENT:*,DOCUMENT:PoEmail,FOLDER:*' -> [{ category, id }].
 * Each item is "<CATEGORY>[:<childClassId>]"; the class id defaults to '*' (any class of that
 * category); the category defaults to DOCUMENT. Matches the base `Folder` class containment shape.
 */
function parseChildren(spec) {
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [category, id] = item.split(':').map((s) => s.trim());
    return { category: (category || 'DOCUMENT').toUpperCase(), id: id || '*' };
  });
}

export default classKindAdapter({
  kind: 'fd.folderclass',
  dir: 'fd/folderclasses',
  restPath: 'folderclass',
  category: 'FOLDER',
  validate(pkg, entry, local) {
    const errs = [];
    if (local?.obj && !local.obj.category) {
      errs.push(`${entry.id}: category is required (F00204) — expected "FOLDER"`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    return {
      obj: {
        id: name,
        category: 'FOLDER',
        active: true,
        data: { ACL: 'acl-folder' },
        tagReferences: flags.tags ? parseTagRefs(flags.tags) : [],
        tagCategories: flags['category-ids']
          ? String(flags['category-ids']).split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        children: flags.children ? parseChildren(flags.children) : [{ category: 'DOCUMENT', id: '*' }],
        displayNames: dn(flags.title ?? name, flags.fr),
      },
    };
  },
});
