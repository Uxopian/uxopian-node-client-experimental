// ai.agent — Agentic Plan engine agent configurations (uxopian-ai 2026.0.0-ft5+).
// CRUD /api/v1/admin/agent/agent-conf[/{id}] — mechanics in ai-agentic.mjs (AI learnings §A13).
// An agent = { id, description, objective (a PROMPT id — what the agent does), successCriteria
// (self-assessed; unmet -> the node reports UNSATISFIED), secrets {NAME: {value, description}},
// permissions {allowedTools, allowedToolTags, deniedTools, allowedMcpServers, allowedSubPlans,
// allowAllTools, allowAllMcpServers} }.
// SECRETS: same contract as ai.mcp — the server echoes every secret value as '********' (verified);
// uxc stores '__masked__' locally and a push resolves it back to the live value, so no secret
// ever lands in a package and a masked value never overwrites a stored one.
import { join } from 'node:path';
import { jsonLayout } from './base.mjs';
import { maskNormalize, resolveMasks } from './ai-mcp.mjs';
import { agenticCrud, agenticSupport, idErrors, toolWarnings } from './ai-agentic.mjs';

const KIND = 'ai.agent';
const DIR = 'ai/agents';
const layout = jsonLayout({ kind: KIND, dir: DIR });
const crud = agenticCrud({ kind: KIND, base: '/api/v1/admin/agent/agent-conf' });

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
    const conf = await crud.get(ctx, id);
    return conf ? { obj: maskNormalize(conf) } : null;
  },

  readLocal: layout.readLocal,
  removeLocal: layout.removeLocal,
  writeLocal(pkg, entry, { obj }) {
    layout.writeLocal(pkg, entry, { obj: maskNormalize(obj) });
  },

  async create(ctx, { obj }) {
    await crud.create(ctx, resolveMasks(obj, null, obj.id, KIND));
  },

  async update(ctx, id, { obj }) {
    const live = await crud.get(ctx, id);
    await crud.update(ctx, id, resolveMasks({ ...obj, id }, live, id, KIND));
  },

  remove: crud.remove,

  validate(pkg, entry, local) {
    const o = local?.obj ?? {};
    const errs = idErrors(entry, o);
    if (!o.objective) errs.push('objective is required — the id of the ai.prompt this agent executes');
    return errs;
  },

  /** Network lint (warnings): tool names / tags the gateway does not register. */
  async lintHelpers(ctx, local) { return toolWarnings(ctx, local?.obj?.permissions); },

  template(ctx, name, flags = {}) {
    const str = (v) => (typeof v === 'string' ? v : '');
    return {
      obj: {
        id: name,
        description: str(flags.title),
        objective: str(flags.objective) || str(flags.prompt),
      },
    };
  },

  scan: crud.scan,
};

export default adapter;
