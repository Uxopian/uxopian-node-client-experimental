// Kind registry + adapter interface.
//
// An adapter is a plain object:
// {
//   kind: 'fd.tagclass',
//   dir: 'fd/tagclasses',          // storage location inside a package
//   layout: 'json' | 'dir' | 'file',  // json = single <id>.json; dir = <id>/meta.json + content files
//   defaultPolicy: 'managed' | 'createOnly' | 'external',
//   cacheAffecting: false,          // true => push sets pendingCacheClear
//   inPlaceUpdate: false,           // createOnly kinds only: true => push UPDATES in place (same-id
//                                   // POST /{id}); DELETE stays policy-gated in rm.mjs (fd.taskclass §20)
//
//   async list(ctx)                          -> [{ id, ...full server objects }]   (server enumeration)
//   async get(ctx, id)                       -> server object | null
//   async create(ctx, local)                 -> void   (local = { obj, contents? })
//   async update(ctx, id, local)             -> void
//   async remove(ctx, id)                    -> void
//   async readServer(ctx, id)                -> { obj, contents? } | null   (obj = canonical-izable; contents = {relName: Buffer})
//   readLocal(pkg, entry)                    -> { obj, contents? } | null
//   writeLocal(pkg, entry, { obj, contents })-> void  (writes canonical form to disk)
//   validate(pkg, entry, local)              -> [ 'error…' ]    (refuse push on non-empty)
//   template(ctx, name, flags)               -> { obj, contents? }  (uxc add scaffold, mechanics included)
//   async scan(ctx, manifest)                -> [{ id, title? }]  (adopt --scan candidates, prefix-driven)
// }
//
// ctx = { clients: {core, gateway, gui, cacheClear}, pkg, target, out, flags }
//
// hashing: lib/sync.mjs computes hashResource(kind, obj, Object.values(contents)) for both sides.

import tagclass from './fd-tagclass.mjs';
import tagcategory from './fd-tagcategory.mjs';
import documentclass from './fd-documentclass.mjs';
import taskclass from './fd-taskclass.mjs';
import folderclass from './fd-folderclass.mjs';
import vfclass from './fd-vfclass.mjs';
import vfinstance from './fd-vfinstance.mjs';
import workflow from './fd-workflow.mjs';
import acl from './fd-acl.mjs';
import script from './fd-script.mjs';
import guiconfig from './fd-guiconfig.mjs';
import handler from './fd-handler.mjs';
import surfacing from './fd-surfacing.mjs';
import dataset from './fd-dataset.mjs';
import aiPrompt from './ai-prompt.mjs';
import aiGoal from './ai-goal.mjs';
import aiMcp from './ai-mcp.mjs';

/** Topological push order. Delete runs in reverse. */
export const PUSH_ORDER = [
  // acl first (classes reference it via data.ACL); workflow after the classes (a workflow lists
  // taskClasses) — the taskclass.workflow back-reference is a forward ref at push time (§7 #7).
  'fd.acl', 'fd.tagclass', 'fd.tagcategory', 'fd.documentclass', 'fd.taskclass', 'fd.folderclass',
  'fd.workflow', 'fd.vfclass', 'fd.dataset', 'fd.script', 'fd.guiconfig', 'fd.handler', 'fd.vfinstance',
  'fd.surfacing', 'ai.prompt', 'ai.goal', 'ai.mcp',
];

export const KINDS = Object.fromEntries(
  [tagclass, tagcategory, documentclass, taskclass, folderclass, vfclass, vfinstance, workflow, acl,
   script, guiconfig, handler, surfacing, dataset, aiPrompt, aiGoal, aiMcp]
    .map((a) => [a.kind, a]),
);

export function kindOf(name) {
  const k = KINDS[name];
  if (!k) throw new Error(`unknown kind "${name}" — kinds: ${Object.keys(KINDS).join(', ')}`);
  return k;
}
