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
//   7. --ready: the layer-gated PRE-INSTALL readiness checklist (docs/DIAGNOSTICS.md) — base
//      platform classes (§23), dialects, AI provisioning, LLM providers, receipts. Read-only.
//   8. --sandbox [--wait s]: the GraalVM sandbox probe (~60-120s, self-cleaning Zz* writes) —
//      SANDBOX_OK / NETWORK_BLOCKED(classes) / NOT_FIRING. Catches the fd.demo-class incident.
//   9. --ai-smoke: create a throwaway prompt, RUN it through the LLM, delete it — the only way to
//      verify the provider API KEY end-to-end (keys are masked on every read surface).
// Exit 1 when anything FAILs.
import { KINDS } from '../kinds/index.mjs';
import { capabilities } from '../dialects.mjs';
import { readinessChecks, sandboxProbe } from '../preflight.mjs';
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
  summary: 'connectivity gauntlet (--ready: pre-install checklist; --sandbox: GraalVM probe; --dups; --roundtrip; --ai-smoke)',
  help: 'uxc doctor [--ready] [--sandbox [--wait s]] [--ai-smoke] [--roundtrip] [--dups]',
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

    // 7. --ready: the layer-gated pre-install readiness checklist (read-only)
    if (ctx.flags.ready) {
      let pkg = null;
      try { pkg = ctx.requirePkg(); } catch { /* readiness works without a package */ }
      const rows = await readinessChecks(ctx, { pkg });
      let lastLayer = null;
      for (const r of rows) {
        if (r.layer !== lastLayer) { ctx.out.line(`-- ${r.layer} --`); lastLayer = r.layer; }
        if (r.ok === true) ok(`ready ${r.check}`, r.detail);
        else if (r.ok === false) bad(`ready ${r.check}`, `${r.detail}${r.fix ? `  FIX: ${r.fix}` : ''}`);
        else { ctx.out.note(`${r.check}: ${r.detail}`); report.push({ check: `ready ${r.check}`, ok: null, detail: r.detail }); }
      }
      const failed = rows.filter((r) => r.ok === false).length;
      ctx.out.line(failed
        ? `READINESS: ${failed} gate(s) failing — fix before installing a package (docs/DIAGNOSTICS.md)`
        : 'READINESS: all gates green — safe to install (consider --sandbox before the first handler deploy)');
    }

    // 8. --sandbox: the GraalVM sandbox probe (write-based, self-cleaning, ~60-120s)
    if (ctx.flags.sandbox) {
      const waitMs = (Number(ctx.flags.wait) || 120) * 1000;
      ctx.out.line(`sandbox probe: deploying throwaway Zz* handler + doc (self-cleaning; up to ${waitMs / 1000}s)…`);
      try {
        const r = await sandboxProbe(ctx, { waitMs, out: ctx.out });
        const line = `${r.verdict}${r.firedAfterMs ? ` (handler fired after ${Math.round(r.firedAfterMs / 1000)}s)` : ''}${r.searchVisibleAfterMs != null ? `; search indexed the probe doc after ${Math.round(r.searchVisibleAfterMs / 1000)}s` : '; search NEVER saw the probe doc (index lag/rebuild — LEARNINGS §25)'}`;
        if (r.verdict === 'SANDBOX_OK') ok('sandbox probe', line);
        else bad('sandbox probe', `${line} — ${r.detail}`);
      } catch (e) { bad('sandbox probe', `${e.message}${e.explanation ? ` — ${e.explanation}` : ''}`); }
    }

    // 9. --ai-smoke: prove the LLM provider KEY works end-to-end (one real LLM call)
    if (ctx.flags['ai-smoke']) {
      const id = 'zzUxcDoctorSmoke';
      const adapter = KINDS['ai.prompt'];
      let created = false;
      try {
        const local = adapter.template(ctx, id, {});
        local.obj.content = 'Reply with exactly: OK';
        await adapter.create(ctx, local);
        created = true;
        const { runPrompt } = await import('../run.mjs');
        const r = await runPrompt(ctx, id, { expect: /ok/i });
        if (r.pass) ok('ai smoke', `LLM answered in ${Math.round((r.elapsedMs ?? 0) / 1000)}s — provider + API key work end-to-end`);
        else bad('ai smoke', `no usable answer (${(r.error ?? String(r.answer).slice(0, 80)) || 'empty'}) — provider/key/model problem (uxc ls ai.llm; set the key in the admin panel)`);
      } catch (e) {
        bad('ai smoke', `${e.message} — an AI call that HANGS usually means no/empty provider key (§A5)`);
      } finally {
        if (created) { try { await adapter.remove(ctx, id); } catch { ctx.out.warn(`cleanup: remove ai.prompt/${id} manually`); } }
      }
    }

    const checks = report.filter((r) => r.ok !== null).length;
    ctx.out.line(`doctor: ${checks} checks, ${failures} failure(s)`);
    if (ctx.out.json) ctx.out.result({ checks, failures, report });
    if (failures) process.exitCode = 1;
  },
};
