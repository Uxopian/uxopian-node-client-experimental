// uxc task answer <taskId> <answerId> — PUT /rest/tasks/{id}/answer {id: answerId}.
// Re-answering an already-answered task returns 200 but does NOT dispatch ANSWER handlers
// (learnings §13) — said out loud on every call so smoke tests always use fresh tasks.
import { fail } from '../output.mjs';

export default {
  name: 'task answer',
  summary: 'answer a task (ANSWER handlers fire on the FIRST answer only)',
  help: 'uxc task answer <taskId> <answerId>',
  async run(ctx) {
    const [taskId, answerId] = ctx.args;
    if (!taskId || !answerId) fail('usage: uxc task answer <taskId> <answerId>');
    ctx.connect();
    await ctx.clients.core.put(`/rest/tasks/${encodeURIComponent(taskId)}/answer`, { id: answerId });

    if (ctx.out.json) return ctx.out.result({ taskId, answerId, answered: true });
    ctx.out.line(`answered ${taskId} with ${answerId}`);
    ctx.out.note('ANSWER handlers fire only on the FIRST answer — re-answering returns 200 but does not dispatch.');
  },
};
