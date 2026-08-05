// Uxopian AI Plan EXECUTIONS — the one action that isn't part of the ai.plan "kind" lifecycle
// (create/get/list/update/delete are generic: `uxc add ai.plan`, `uxc push`/`pull`, `uxc ls ai.plan`,
// `uxc get ai.plan <id>`, `uxc rm ai.plan <id>` — see lib/kinds/ai-plan.mjs). Running a plan has no
// local file counterpart, same reasoning as `uxc f2 run` sitting beside the f2.map kind.
//
//   run    : POST /api/v1/admin/plan-executions/run   {planId, inputPayload} -> 202 PlanExecution
//            (always async: the response is the INITIAL execution, poll GET for the outcome)
//   get    : GET  /api/v1/admin/plan-executions/{id}                        -> PlanExecution
//   list   : GET  /api/v1/admin/plan-executions       (main runs only)      -> PlanExecution[]
//   pause/resume/stop : POST /api/v1/admin/plan-executions/{id}/<verb>
//   delete : DELETE /api/v1/admin/plan-executions/{id}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** PlanExecution client over the gateway REST client (clients.gateway). */
export function createPlanExecutionClient(clients) {
  const gw = clients.gateway;
  const path = (id) => `/api/v1/admin/plan-executions/${encodeURIComponent(id)}`;

  return {
    /** Submit a run. Always async: the response is the INITIAL execution, not the final result. */
    run: (planId, inputPayload = {}) => gw.post('/api/v1/admin/plan-executions/run', { planId, inputPayload }),
    get: (id) => gw.get(path(id)),
    list: () => gw.get('/api/v1/admin/plan-executions'),
    pause: (id) => gw.post(`${path(id)}/pause`, {}),
    resume: (id) => gw.post(`${path(id)}/resume`, {}),
    stop: (id) => gw.post(`${path(id)}/stop`, {}),
    delete: (id) => gw.del(path(id)).then(() => ({ id, deleted: true })),
    /** Poll GET until a terminal status (COMPLETED/FAILED/CANCELLED) or timeoutMs elapses. */
    async waitFor(id, { timeoutMs = 120_000, intervalMs = 1500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const exec = await gw.get(path(id));
        if (TERMINAL_STATUSES.has(exec.status)) return exec;
        if (Date.now() > deadline) return exec; // caller decides what a non-terminal timeout means
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
}

export { TERMINAL_STATUSES };
