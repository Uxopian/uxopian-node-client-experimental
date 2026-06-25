// fd.taskclass — /rest/taskclass. Policy createOnly + inPlaceUpdate (learnings §14/§20):
//   - in-place UPDATE is binding-SAFE — a same-id POST /rest/taskclass/{id} full-replace (e.g. to
//     add/maintain attachment slots in `children`) leaves the ANSWER-handler binding untouched, so
//     push UPDATES taskclasses in place (inPlaceUpdate: true);
//   - DELETE+recreate is NOT — it breaks ANSWER dispatch permanently, so policy stays `createOnly`
//     and rm.mjs gates the server delete behind --force. A schema change that needs a delete = NEW id.
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
  inPlaceUpdate: true, // same-id POST update is safe; delete stays gated (§14/§20)
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
