// uxc doctor — the connectivity + endpoint gauntlet (DESIGN §17.1):
//   1. Core auth        2. gateway JWT (user prompt list)
//   3. GUI caches probe — GET then DELETE /gui/rest/caches, statuses printed VERBATIM
//      (this is the not-formally-recorded JWT surface: record the verdict in FLOWERDOCS-LEARNINGS.md)
//   4. the five class LIST endpoints (counts)
//   5. --roundtrip: the push-echo leg — create a Zz* template per kind, re-GET, compare canonical
//      hashes, report the FIRST differing canonical line on mismatch, then remove. Every FAIL here
//      is a missing strip/normalize rule for lib/canonical.mjs — that's the point.
//   6. --dups: duplicate-object scan (LEARNINGS §25) — duplicate prompt ids, multiple live _vN
//      registrations per handler (they FIRE MULTIPLE TIMES), same-name docs per package class
//      (report-only: may be legitimate re-uploads), dataset local-vs-server row counts.
// Exit 1 when anything FAILs.
import { KINDS } from '../kinds/index.mjs';
import { capabilities } from '../dialects.mjs';
import { canonicalText, hashResource } from '../canonical.mjs';

/** Group rows by keyFn -> [[key, count], …] for keys occurring more than once. */
export function dupBy(rows, keyFn) {
  const counts = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
}

const CLASS_LISTS = ['documentclass', 'folderclass', 'taskclass', 'virtualfolderclass', 'tagcategory', 'tagclass'];

// [kind, probe id, template flags] — Zz* sorts last and screams "throwaway" on a shared instance
const ROUNDTRIP = [
  ['fd.tagclass', 'ZzUxcDoctorTagclass', { type: 'STRING', title: 'uxc doctor probe' }],
  ['fd.tagcategory', 'ZzUxcDoctorTagcategory', { title: 'uxc doctor probe' }],
  ['fd.documentclass', 'ZzUxcDoctorDocumentclass', { title: 'uxc doctor probe' }],
  ['fd.folderclass', 'ZzUxcDoctorFolderclass', { title: 'uxc doctor probe' }],
  ['fd.taskclass', 'ZzUxcDoctorTaskclass', { title: 'uxc doctor probe', answers: 'OK' }],
  ['fd.acl', 'ZzUxcDoctorAcl', {}], // self-contained ({id,name,entries}); default entry from the template
  ['ai.prompt', 'zzUxcDoctorPrompt', {}], // camel form — prompts are camel-prefixed
  // fd.workflow is NOT probed here: its create references real taskClasses, which a throwaway probe
  // can't supply — verify it with a real `uxc push` on a workflow-provisioned scope instead.
];

export default {
  name: 'doctor',
  summary: 'connectivity + endpoint gauntlet (--roundtrip: Zz* push-echo leg; --dups: duplicate scan)',
  help: 'uxc doctor [--roundtrip] [--dups]',
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

    // 2b. server dialects (lib/dialects.mjs): detected version + the capability set uxc will use
    for (const product of ['flowerdocs', 'uxopian-ai']) {
      try {
        const d = await capabilities(ctx, product);
        ok(`dialect ${product}`,
          `${d.version ?? '(no version surface)'}${d.build ? ` build ${d.build}` : ''} -> ${d.dialect ?? '?'} [${d.source}]  caps ${JSON.stringify(d.caps)}`);
      } catch (e) { bad(`dialect ${product}`, e.message); }
    }

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
      ctx.out.note('add --roundtrip for the Zz* push-echo leg (tagclass/tagcategory/documentclass/folderclass/taskclass/acl/prompt)');
    }

    // 6. --dups: duplicate-object scan. Mechanic duplicates (prompt ids, handler registrations)
    // FAIL; same-name documents are report-only (may be legitimate user re-uploads).
    if (ctx.flags.dups) {
      let pkg = null;
      try { pkg = ctx.requirePkg(); } catch { /* no package here — server-only checks */ }

      // 6a. prompts: duplicate ids in the user list; count drift vs the admin list when it answers
      try {
        const user = (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
        const dupIds = dupBy(user, (p) => p.id);
        if (dupIds.length) bad('dups ai.prompt', `${dupIds.map(([k, n]) => `${k} x${n}`).join(', ')} — multiple prompts share an id (clean the extras in the admin UI, then re-sync)`);
        else ok('dups ai.prompt', `${user.length} entries, ids unique`);
        const admin = await ctx.clients.gateway.tryGet('/api/v1/admin/prompts').catch(() => null);
        if (Array.isArray(admin) && admin.length !== user.length) {
          ctx.out.warn(`note: admin prompt list holds ${admin.length} entries vs ${user.length} user-visible — hidden versions/working copies may exist on this gateway`);
        }
      } catch (e) { bad('dups ai.prompt', e.message); }

      // 6b. handler registrations: >1 live _vN per logical name fires the handler MULTIPLE times
      try {
        const { results } = await ctx.clients.core.search({ classId: 'OperationHandlerRegistration', fields: ['name'], max: 200 });
        const byLogical = new Map();
        for (const r of results) {
          const m = String(r.id).match(/^(.*)_v(\d+)$/);
          const logical = m ? m[1] : String(r.id);
          byLogical.set(logical, [...(byLogical.get(logical) ?? []), String(r.id)]);
        }
        // state-known deployedIds invisible to search: verify by direct GET and merge (index lag)
        if (pkg && ctx.target?.name) {
          for (const e of pkg.entries('fd.handler')) {
            const dep = pkg.resState(ctx.target.name, 'fd.handler', e.id)?.deployedId;
            if (!dep) continue;
            const seen = byLogical.get(e.id) ?? [];
            if (!seen.includes(dep) && (await ctx.clients.core.getDoc(dep))) {
              byLogical.set(e.id, [...seen, dep]);
              ctx.out.warn(`note: ${dep} is live but INVISIBLE to search — index lag/rebuild (LEARNINGS §25)`);
            }
          }
        }
        const multi = [...byLogical.entries()].filter(([, ids]) => ids.length > 1);
        if (multi.length) bad('dups fd.handler', `${multi.map(([lg, ids]) => `${lg} [${ids.join(', ')}]`).join('; ')} — each registration fires per event (duplicated downstream objects); uxc push <logical> rotates + sweeps`);
        else ok('dups fd.handler', `${byLogical.size} logical names, one registration each`);
      } catch (e) { bad('dups fd.handler', e.message); }

      // 6e. scope surfacing: same-name properties on ONE profile whose values share the same
      // leading identifier token = the same link surfaced twice ('X()' vs 'X' vs arg variants) —
      // each renders a duplicate GUI link (LEARNINGS §26)
      try {
        const scope = await ctx.clients.core.getOne(`/rest/scope/${encodeURIComponent(ctx.target.scope)}`);
        const hits = [];
        for (const p of scope?.people?.profiles ?? []) {
          const byKey = new Map();
          for (const q of p.properties ?? []) {
            const tok = String(q.value ?? '').match(/^[A-Za-z][A-Za-z0-9_-]*/)?.[0] ?? '';
            const k = `${q.name} ${tok}`;
            byKey.set(k, [...(byKey.get(k) ?? []), String(q.value)]);
          }
          for (const [k, vals] of byKey) {
            if (vals.length > 1) hits.push(`[${p.name ?? p.id}] ${k}: ${vals.map((v) => v.slice(0, 44)).join(' | ')}`);
          }
        }
        if (hits.length) bad('dups fd.surfacing', `${hits.join('; ')} — duplicated GUI links; re-push the package surfacing (uxc rm surfacing --server, then uxc push surfacing --revive) to re-normalize`);
        else ok('dups fd.surfacing', 'no per-profile duplicate surfacing values');
      } catch { /* scope unreadable on this target */ }

      // 6c. per-package document classes: same-name docs (report-only — often legitimate)
      if (pkg) {
        for (const e of pkg.entries('fd.documentclass')) {
          try {
            const { found, results } = await ctx.clients.core.search({ classId: e.id, fields: ['name'], max: 200 });
            const dups = dupBy(results, (r) => r.fields?.name);
            if (dups.length) {
              ctx.out.warn(`dups? ${e.id}: ${dups.slice(0, 6).map(([n, c]) => `"${n}" x${c}`).join(', ')}${found > 200 ? ` (first 200 of ${found})` : ''} — same-name documents; often legitimate re-uploads, review in the GUI`);
            }
          } catch { /* class may not exist on this target yet */ }
        }
        // 6d. datasets: local row count vs server count
        for (const d of pkg.manifest.dataSets ?? []) {
          try {
            const local = (pkg.entries('fd.dataset').some((x) => x.id === d.name) && KINDS['fd.dataset'].readLocal(pkg, { kind: 'fd.dataset', id: d.name, path: d.path })?.rows?.size) || 0;
            const { found } = await ctx.clients.core.search({ classId: d.classId, fields: ['name'], max: 1 });
            if (found !== local) ctx.out.warn(`dups? dataset ${d.name}: local ${local} rows vs server ${found} docs (class ${d.classId}) — drift or foreign docs in the class`);
            else ok(`dups dataset ${d.name}`, `${local} rows = ${found} docs`);
          } catch { /* dataset class may not exist yet */ }
        }
      } else {
        ctx.out.note('--dups: no package here — per-class and dataset scans skipped (run inside a package for those)');
      }
    }

    const checks = report.filter((r) => r.ok !== null).length;
    ctx.out.line(`doctor: ${checks} checks, ${failures} failure(s)`);
    if (ctx.out.json) ctx.out.result({ checks, failures, report });
    if (failures) process.exitCode = 1;
  },
};
