// ai.plan — Agentic Plans (uxopian-ai 2026.0.0-ft5+): a DAG of nodes run by the plan engine.
// CRUD /api/v1/admin/plans[/{id}] — mechanics in ai-agentic.mjs (AI learnings §A13); runs go
// through /api/v1/admin/plan-executions (lib/run.mjs runPlan, AI learnings §A14).
// A node = { id, name, description, type: AGENT|SUBPLAN|DIRECT_TOOL, agentConfId (AGENT),
// subPlanId (SUBPLAN), toolName + toolArgumentBindings {arg: payloadKey} (DIRECT_TOOL), outputKey,
// dependencies [nodeIds], persistOutput, listKey + maxParallelElements (fan-out: one run per
// element of a payload JSON array, exposed to the node as `item`) }.
// A plan exposed as a tool (exposeAsTool) needs a toolDescription and a tool-name-safe id.
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { agenticCrud, agenticSupport, idErrors, toolWarnings } from './ai-agentic.mjs';

const KIND = 'ai.plan';
const DIR = 'ai/plans';
const layout = jsonLayout({ kind: KIND, dir: DIR });
const crud = agenticCrud({ kind: KIND, base: '/api/v1/admin/plans' });

export const NODE_TYPES = ['AGENT', 'SUBPLAN', 'DIRECT_TOOL'];
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** First dependency cycle among `nodes` as a list of node ids, or null. */
export function findCycle(nodes) {
  const deps = new Map(); // first node wins on a duplicate id (the duplicate is reported on its own)
  for (const n of nodes) if (!deps.has(n.id)) deps.set(n.id, Array.isArray(n.dependencies) ? n.dependencies : []);
  const state = new Map(); // id -> 1 visiting, 2 done
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id)) {
      if (!deps.has(d)) continue; // dangling dependency: reported separately
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

/** Structural errors of a plan object — each one a 400 from the gateway or a plan that cannot run. */
export function planErrors(o) {
  const nodes = Array.isArray(o.nodes) ? o.nodes : null;
  if (!nodes) return ['nodes must be an array of plan nodes'];
  const errs = [];
  if (!nodes.length) errs.push('nodes is empty — a plan needs at least one node');
  const ids = new Set();
  for (const [i, n] of nodes.entries()) {
    const at = `nodes[${i}]${n?.id ? ` "${n.id}"` : ''}`;
    if (!n || typeof n !== 'object') { errs.push(`${at}: not an object`); continue; }
    if (!n.id) errs.push(`${at}: id is required`);
    else if (ids.has(n.id)) errs.push(`${at}: duplicate node id`);
    else ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) errs.push(`${at}: type must be one of ${NODE_TYPES.join('|')}`);
    if (n.type === 'AGENT' && !n.agentConfId) errs.push(`${at}: AGENT nodes need agentConfId`);
    if (n.type === 'SUBPLAN' && !n.subPlanId) errs.push(`${at}: SUBPLAN nodes need subPlanId`);
    if (n.type === 'DIRECT_TOOL' && !n.toolName) errs.push(`${at}: DIRECT_TOOL nodes need toolName`);
    if (n.dependencies != null && !Array.isArray(n.dependencies)) errs.push(`${at}: dependencies must be an array of node ids`);
  }
  for (const n of nodes) {
    for (const d of Array.isArray(n?.dependencies) ? n.dependencies : []) {
      if (!ids.has(d)) errs.push(`node "${n.id}": dependency "${d}" is not a node of this plan`);
    }
  }
  const cycle = findCycle(nodes.filter((n) => n && typeof n === 'object' && n.id));
  if (cycle) errs.push(`circular dependency ${cycle.join(' -> ')} (the gateway answers 400 "Circular dependency detected")`);
  if (o.exposeAsTool === true) {
    if (!o.toolDescription) errs.push('exposeAsTool:true needs a toolDescription');
    if (o.id && !TOOL_NAME_RE.test(o.id)) errs.push(`exposeAsTool:true needs a tool-name-safe id ([A-Za-z0-9_-], at most 64) — "${o.id}" is not`);
  }
  return errs;
}

const adapter = {
  kind: KIND,
  dir: DIR,
  layout: 'json',
  defaultPolicy: 'managed',
  cacheAffecting: false,

  pathFor: (pkg, id) => join(DIR, `${id}.json`),
  serverSupport: (ctx) => agenticSupport(ctx, KIND),

  list: crud.list,
  get: crud.get,

  async readServer(ctx, id) {
    const plan = await crud.get(ctx, id);
    return plan ? { obj: plan } : null;
  },

  readLocal: layout.readLocal,
  writeLocal: layout.writeLocal,
  removeLocal: layout.removeLocal,

  async create(ctx, { obj }) { await crud.create(ctx, obj); },
  async update(ctx, id, { obj }) { await crud.update(ctx, id, obj); },
  remove: crud.remove,

  validate(pkg, entry, local) {
    const o = local?.obj ?? {};
    return [...idErrors(entry, o), ...planErrors({ ...o, id: o.id ?? entry.id })];
  },

  /** Network lint (warnings): DIRECT_TOOL node tool names the gateway does not register. */
  async lintHelpers(ctx, local) {
    const nodes = Array.isArray(local?.obj?.nodes) ? local.obj.nodes : [];
    return toolWarnings(ctx, null, nodes.filter((n) => n?.type === 'DIRECT_TOOL').map((n) => n.toolName));
  },

  template(ctx, name, flags = {}) {
    const agent = typeof flags.agent === 'string' ? flags.agent : '';
    return {
      obj: {
        id: name,
        description: typeof flags.title === 'string' ? flags.title : '',
        nodes: [{ id: 'step1', name: 'step1', type: 'AGENT', agentConfId: agent, outputKey: 'result' }],
        // variables the first nodes' prompts read must be declared here, or the run is refused
        // (400 "Plan is not executable … not provided by any dependency" — AI learnings §A14)
        toolInputParameters: [],
      },
    };
  },

  scan: crud.scan,
};

export default adapter;
