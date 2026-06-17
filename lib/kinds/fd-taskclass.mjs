// fd.taskclass — /rest/taskclass. Policy createOnly (learnings §14: NEVER delete/recreate a
// taskclass on deploy — ANSWER dispatch breaks; schema change => mint a NEW id).
import { classKindAdapter } from './base.mjs';
import { dn } from '../util.mjs';

/** 'APPROVE' -> 'Approve', 'REQUEST_CHANGES' -> 'Request changes'. */
const answerLabel = (id) =>
  id.charAt(0).toUpperCase() + id.slice(1).toLowerCase().replace(/_/g, ' ');

export default classKindAdapter({
  kind: 'fd.taskclass',
  dir: 'fd/taskclasses',
  restPath: 'taskclass',
  category: 'TASK',
  defaultPolicy: 'createOnly',
  validate(pkg, entry, local) {
    const errs = [];
    if (local?.obj && local.obj.category !== 'TASK') {
      errs.push(`${entry.id}: category must be "TASK" (got "${local.obj.category}")`);
    }
    return errs;
  },
  template(ctx, name, flags) {
    const obj = {
      id: name,
      category: 'TASK',
      active: true,
      data: { ACL: 'acl-readonly' },
      autoAssign: false,
      icon: 'fa fa-gavel',
      displayNames: dn(flags.title ?? name, flags.fr),
      answers: flags.answers
        ? String(flags.answers).split(',').map((s) => s.trim()).filter(Boolean)
            .map((id) => ({ id, displayNames: dn(answerLabel(id)) }))
        : [],
      tagReferences: [],
    };
    if (flags.workflow) obj.workflow = flags.workflow;
    return { obj };
  },
});
