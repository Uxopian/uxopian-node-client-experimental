// uxc explain <CODE|text> — look a code/signature up in the error knowledge base.
import { explainCode, KB_ENTRIES } from '../explain.mjs';

export default {
  name: 'explain',
  summary: 'look up an error code/signature in the knowledge base',
  help: 'uxc explain <CODE|text>   e.g. uxc explain F00903',
  async run(ctx) {
    const q = ctx.args.join(' ').trim();
    const hits = q ? explainCode(q) : [];

    if (ctx.out.json) {
      return ctx.out.result(hits.length ? hits : { query: q, match: null, knownSignatures: KB_ENTRIES.map((e) => e.signature) });
    }
    if (hits.length) {
      for (const h of hits) {
        ctx.out.line(h.signature);
        ctx.out.note(h.explanation);
      }
      return;
    }
    ctx.out.line(q ? `no knowledge-base match for "${q}" — known signatures:` : 'known signatures:');
    for (const e of KB_ENTRIES) ctx.out.note(e.signature);
  },
};
