// uxc doc rm <id…> — delete documents in batches of 20 (comma-joined ids in the DELETE path);
// on a batch failure, fall back to per-id deletes so one bad id doesn't sink its 19 neighbours.
import { fail } from '../output.mjs';

const BATCH = 20;

export default {
  name: 'doc rm',
  summary: 'delete documents by id (batched 20/call, per-id fallback)',
  help: 'uxc doc rm <id> [id…]',
  async run(ctx) {
    const ids = ctx.args;
    if (!ids.length) fail('usage: uxc doc rm <id> [id…]');
    ctx.connect();
    const { core } = ctx.clients;

    const ok = [];
    const failed = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        await core.del(`/rest/documents/${batch.map(encodeURIComponent).join(',')}`);
        ok.push(...batch);
      } catch {
        for (const id of batch) { // per-id fallback isolates the bad one(s)
          try {
            await core.del(`/rest/documents/${encodeURIComponent(id)}`);
            ok.push(id);
          } catch (e) {
            failed.push({ id, error: e.message });
          }
        }
      }
    }

    if (ctx.out.json) ctx.out.result({ ok, failed });
    else {
      ctx.out.line(`ok ${ok.length}  fail ${failed.length}`);
      for (const f of failed) ctx.out.warn(`${f.id}: ${f.error}`);
    }
    if (failed.length) process.exitCode = 2;
  },
};
