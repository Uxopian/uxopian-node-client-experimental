// Uxopian AI "Plan" (agentic DAG) lifecycle over the gateway REST API — verified against
// rest/src/main/java/com/uxopian/ai/rest/controller/admin/{PlanController,PlanExecutionController}.java.
// Reuses uxc's existing `gateway` client (same JWT auth as `uxc run`), no separate transport.
//
//   Plans:
//     list   : GET    /api/v1/admin/plans              -> Plan[]
//     get    : GET    /api/v1/admin/plans/{id}          -> Plan; 404 -> null
//     create : POST   /api/v1/admin/plans        Plan   -> 201, EMPTY body (re-GET for the object)
//     update : PUT    /api/v1/admin/plans/{id}   Plan    -> re-GET for the object
//     delete : DELETE /api/v1/admin/plans/{id}          -> 204
//
//   Executions (a run is always async — POST returns the initial PlanExecution, poll GET for status):
//     run    : POST /api/v1/admin/plan-executions/run   {planId, inputPayload} -> 202 PlanExecution
//     get    : GET  /api/v1/admin/plan-executions/{id}                        -> PlanExecution
//     list   : GET  /api/v1/admin/plan-executions       (main runs only)      -> PlanExecution[]
//     pause/resume/stop : POST /api/v1/admin/plan-executions/{id}/<verb>
//     delete : DELETE /api/v1/admin/plan-executions/{id}

import { readFileSync } from 'node:fs';
import { HttpError } from './http.mjs';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Build a minimal AGENT node (PlanNode.agentNode in Java). */
export function agentNode({ id, name, description, agentConfId, outputKey, dependencies = [], persistOutput }) {
  return { id, name: name ?? id, description, type: 'AGENT', agentConfId, outputKey, dependencies, persistOutput };
}

/** Build a minimal DIRECT_TOOL node (PlanNode.directToolNode in Java).
 *  toolArgumentBindings maps a tool argument name -> a key already present in the run payload. */
export function directToolNode({ id, name, description, toolName, toolArgumentBindings = {}, outputKey, dependencies = [], persistOutput }) {
  return { id, name: name ?? id, description, type: 'DIRECT_TOOL', toolName, toolArgumentBindings, outputKey, dependencies, persistOutput };
}

/** Build a minimal SUBPLAN node (PlanNode.subPlanNode in Java). */
export function subPlanNode({ id, name, description, subPlanId, outputKey, dependencies = [], persistOutput }) {
  return { id, name: name ?? id, description, type: 'SUBPLAN', subPlanId, outputKey, dependencies, persistOutput };
}

/** Read a Plan object from a JSON file (`uxc plan get <id> --json` dump, or hand-authored). */
export function readPlanFile(path) {
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`--file: cannot read a JSON Plan object from ${path}: ${e.message}`); }
  return obj;
}

/** Plan + PlanExecution client over the gateway REST client (clients.gateway). */
export function createPlanClient(clients) {
  const gw = clients.gateway;
  const planPath = (id) => `/api/v1/admin/plans/${encodeURIComponent(id)}`;
  const execPath = (id) => `/api/v1/admin/plan-executions/${encodeURIComponent(id)}`;

  const tryGetPlan = async (id) => {
    const r = await gw.raw('GET', planPath(id));
    if (r.status === 404) return null;
    if (r.status >= 400) throw new HttpError(r.status, r.json ?? r.text, planPath(id), 'GET');
    return r.json;
  };

  return {
    list: () => gw.get('/api/v1/admin/plans'),
    get: (id) => tryGetPlan(id),
    /** Create a NEW plan. The API returns 201 with no body, so this re-GETs the created object. */
    async create(planObj) {
      await gw.post('/api/v1/admin/plans', planObj);
      return tryGetPlan(planObj.id);
    },
    /** Update an existing plan (PUT, id in path). Re-GETs for the same reason as create. */
    async update(planObj) {
      await gw.put(planPath(planObj.id), planObj);
      return tryGetPlan(planObj.id);
    },
    async delete(id) {
      await gw.del(planPath(id));
      return { id, deleted: true };
    },

    executions: {
      /** Submit a run. Always async: the response is the INITIAL execution, not the final result. */
      run: (planId, inputPayload = {}) => gw.post('/api/v1/admin/plan-executions/run', { planId, inputPayload }),
      get: (id) => gw.get(execPath(id)),
      list: () => gw.get('/api/v1/admin/plan-executions'),
      pause: (id) => gw.post(`${execPath(id)}/pause`, {}),
      resume: (id) => gw.post(`${execPath(id)}/resume`, {}),
      stop: (id) => gw.post(`${execPath(id)}/stop`, {}),
      delete: (id) => gw.del(execPath(id)).then(() => ({ id, deleted: true })),
      /** Poll GET until a terminal status (COMPLETED/FAILED/CANCELLED) or timeoutMs elapses. */
      async waitFor(id, { timeoutMs = 120_000, intervalMs = 1500 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const exec = await gw.get(execPath(id));
          if (TERMINAL_STATUSES.has(exec.status)) return exec;
          if (Date.now() > deadline) return exec; // caller decides what a non-terminal timeout means
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      },
    },
  };
}

export { TERMINAL_STATUSES };
