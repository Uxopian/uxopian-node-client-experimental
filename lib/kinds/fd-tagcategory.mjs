// fd.tagcategory — /rest/tagcategory (learnings §6: tags[] is the membership; a category
// not listed in the class's tagCategories does NOT render).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

export default classKindAdapter({
  kind: 'fd.tagcategory',
  dir: 'fd/tagcategories',
  restPath: 'tagcategory',
  template(ctx, name, flags) {
    return {
      obj: {
        id: name,
        tags: [],
        icon: 'flower-button header-icon fas fa-file flat-purple',
        visible: true,
        inline: false,
        reduced: false,
        displayNames: dn(flags.title ?? name, flags.fr),
      },
    };
  },
});
