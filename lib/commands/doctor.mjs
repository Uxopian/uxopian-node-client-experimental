// uxc doctor — the connectivity + endpoint gauntlet (DESIGN §17.1):
//   1. Core auth        2. gateway JWT (user prompt list)
//   3. GUI caches probe — GET then DELETE /gui/rest/caches, statuses printed VERBATIM
//      (this is the not-formally-recorded JWT surface: record the verdict in FLOWERDOCS-LEARNINGS.md)
//   4. the five class LIST endpoints (counts)
//   5. --roundtrip: the push-echo leg — create a Zz* template per kind, re-GET, compare canonical
//      hashes, report the FIRST differing canonical line on mismatch, then remove. Every FAIL here
//      is a missing strip/normalize rule for lib/canonical.mjs — that's the point.
// Exit 1 when anything FAILs.
import { KINDS } from '../kinds/index.mjs';
import { canonicalText, hashResource } from '../canonical.mjs';

const CLASS_LISTS = ['documentclass', 'taskclass', 'virtualfolderclass', 'tagcategory', 'tagclass'];

// [kind, probe id, template flags] — Zz* sorts last and screams "throwaway" on a shared instance
const ROUNDTRIP = [
  ['fd.tagclass', 'ZzUxcDoctorTagclass', { type: 'STRING', title: 'uxc doctor probe' }],
  ['fd.tagcategory', 'ZzUxcDoctorTagcategory', { title: 'uxc doctor probe' }],
  ['fd.documentclass', 'ZzUxcDoctorDocumentclass', { title: 'uxc doctor probe' }],
  ['fd.taskclass', 'ZzUxcDoctorTaskclass', { title: 'uxc doctor probe', answers: 'OK' }],
  ['ai.prompt', 'zzUxcDoctorPrompt', {}], // camel form — prompts are camel-prefixed
];

export default {
  name: 'doctor',
  summary: 'connectivity + endpoint gauntlet (--roundtrip adds the Zz* push-echo leg)',
  help: 'uxc doctor [--roundtrip]',
  async run(ctx) {
    const report = [];
    let failures = 0;
    const ok = (check, detail = '') => {
      report.push({ check, ok: true, detail });
      ctx.out.line(`ok   ${check}${detail ? `  ${detail}` : ''}`);
    };
    const bad = (check, detail = '') => {
      failures++;
      report.push({ check, ok: false, detail });
      ctx.out.warn(`FAIL ${check}  ${detail}`);
    };

    ctx.connect();

    // 1. core auth
    try {
      await ctx.clients.auth();
      ok('core auth', `${ctx.target.user} @ ${ctx.target.scope} (${ctx.target.core})`);
    } catch (e) { bad('core auth', e.message); }

    // 2. gateway JWT — user prompt list (the admin GET 500s server-side, learnings §17)
    try {
      const prompts = (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
      ok('gateway JWT', `${prompts.length} prompts (${ctx.target.gateway})`);
    } catch (e) { bad('gateway JWT', e.message); }

    // 3. GUI caches probe — statuses VERBATIM; this surface is the unrecorded one
    try {
      const g = await ctx.clients.gui.raw('GET', '/rest/caches');
      ctx.out.line(`GET /gui/rest/caches -> ${g.status} ${String(g.text ?? '').slice(0, 200)}`);
      const d = await ctx.clients.gui.raw('DELETE', '/rest/caches');
      ctx.out.line(`DELETE /gui/rest/caches -> ${d.status} ${String(d.text ?? '').slice(0, 200)}`);
      ctx.out.note('record this verdict in FLOWERDOCS-LEARNINGS.md');
      report.push({ check: 'gui caches verbatim', ok: null, detail: `GET ${g.status} / DELETE ${d.status}` });
      if (g.status < 400 && d.status < 400) ok('gui caches JWT probe', `GET ${g.status}, DELETE ${d.status}`);
      else bad('gui caches JWT probe', `GET ${g.status}, DELETE ${d.status} — until green, clear caches manually (Administration > caches)`);
    } catch (e) { bad('gui caches JWT probe', e.message); }

    // 4. the five class LIST endpoints
    for (const p of CLASS_LISTS) {
      try {
        const arr = (await ctx.clients.core.get(`/rest/${p}`)) ?? [];
        ok(`GET /rest/${p}`, `${arr.length}`);
      } catch (e) { bad(`GET /rest/${p}`, e.message); }
    }

    // 5. push-echo round-trip on throwaway Zz* templates
    if (ctx.flags.roundtrip) {
      for (const [kind, id, tplFlags] of ROUNDTRIP) {
        const adapter = KINDS[kind];
        let created = false;
        try {
          const local = adapter.template(ctx, id, tplFlags);
          if (kind === 'ai.prompt') local.obj.content = 'uxc doctor probe — reply with OK.';
          await adapter.create(ctx, local);
          created = true;
          const echo = await adapter.readServer(ctx, id);
          if (!echo) throw new Error('created but no server echo');
          const hLocal = hashResource(kind, local.obj, Object.values(local.contents ?? {}));
          const hEcho = hashResource(kind, echo.obj, Object.values(echo.contents ?? {}));
          if (hLocal === hEcho) ok(`roundtrip ${kind}`, id);
          else {
            const a = canonicalText(kind, local.obj).split('\n');
            const b = canonicalText(kind, echo.obj).split('\n');
            let i = 0;
            while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
            bad(`roundtrip ${kind}`, `${id} canonical mismatch at line ${i + 1}: local ${JSON.stringify(a[i] ?? '')} vs server ${JSON.stringify(b[i] ?? '')} — add a normalize rule to lib/canonical.mjs`);
          }
        } catch (e) {
          bad(`roundtrip ${kind}`, `${id}: ${e.message}${e.explanation ? ` — ${e.explanation}` : ''}`);
        } finally {
          if (created) {
            try {
              await adapter.remove(ctx, id);
              if (kind === 'fd.taskclass') {
                ctx.out.note('probe taskclass removed (never answered — safe). NEVER delete/recreate a REAL taskclass: ANSWER dispatch breaks permanently; schema change = mint a NEW id (learnings §14).');
              }
            } catch (e) { ctx.out.warn(`cleanup ${kind}/${id} failed: ${e.message} — remove it manually`); }
          }
        }
      }
    } else {
      ctx.out.note('add --roundtrip for the Zz* push-echo leg (tagclass/tagcategory/documentclass/taskclass/prompt)');
    }

    const checks = report.filter((r) => r.ok !== null).length;
    ctx.out.line(`doctor: ${checks} checks, ${failures} failure(s)`);
    if (ctx.out.json) ctx.out.result({ checks, failures, report });
    if (failures) process.exitCode = 1;
  },
};
