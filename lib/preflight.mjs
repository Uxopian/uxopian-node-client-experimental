// Pre-install readiness diagnostics (DESIGN §20, docs/DIAGNOSTICS.md): is this server/scope
// actually OPERATIONAL for a package install or a new project? Two tiers:
//
//   readinessChecks(ctx)  — READ-ONLY, seconds: the layer-gated checklist (base platform classes,
//                           AI provisioning, LLM providers+keys, receipts). `uxc doctor --ready`.
//   sandboxProbe(ctx)     — WRITE-BASED, ~60-120s: deploys a throwaway Zz* handler, fires it with a
//                           probe document, and reads back what the GraalVM sandbox actually allows.
//                           `uxc doctor --sandbox`. THE check that would have caught the fd.demo
//                           2026-07-03 incident (handlers silently dead: sandbox whitelist missing —
//                           redeploying handlers can NEVER fix that; only server config can).
//
// Design notes: the probe script's FIRST tag-write uses NO Java.type at all — if the tag flips,
// the engine runs (engine-ok) even when every network class is blocked; per-class Java.type probes
// then report EXACTLY which classes the sandbox denies. The probe doc is created WITH the tag
// value 'pending', so "handler never ran" (still pending) is distinguishable from "engine broken".
import { fdTimestamp, tag, tagsOf, sleep, nowIso } from './util.mjs';
import { pushContentDoc } from './kinds/base.mjs';
import { capabilities } from './dialects.mjs';
import { readReceipts } from './receipt.mjs';
import { isExistsError } from './http.mjs';

// ---------------------------------------------------------------------------
// Tier 1 — read-only readiness (layers per docs/DIAGNOSTICS.md)
// ---------------------------------------------------------------------------

/** The base-platform objects a scope MUST have before uxc can deploy content kinds (LEARNINGS §23).
 *  All verified by DIRECT id GET (lag-proof, §25). */
const BASE_PLATFORM = [
  ['documentclass', 'Script', 'fd.script pushes fail (F00206) — scripts are Script-class docs'],
  ['documentclass', 'OperationHandlerRegistration', 'fd.handler pushes fail (F00206) — registrations are docs of this class'],
  ['documentclass', 'GUIConfiguration', 'fd.guiconfig pushes fail (F00206)'],
  ['tagclass', 'RegistrationOrder', 'script/handler ordering tags fail (F00205)'],
  ['acl', 'acl-readonly', 'class/doc creates 500 (F00208) — the base ACL every uxc template references'],
];

/**
 * Layer-gated read-only readiness. Returns [{layer, check, ok:true|false|null, detail, fix?}].
 * ok:null = informational. Callers render + decide; nothing here writes.
 */
export async function readinessChecks(ctx, { pkg = null } = {}) {
  const rows = [];
  const add = (layer, check, ok, detail, fix) => rows.push({ layer, check, ok, detail, ...(fix ? { fix } : {}) });

  // L0.platform — the flower-templates base layer (§23: a blank scope lacks all of these)
  let baseMissing = 0;
  for (const [type, id, why] of BASE_PLATFORM) {
    let found = null;
    try { found = await ctx.clients.core.getOne(`/rest/${type}/${encodeURIComponent(id)}`); } catch { found = null; }
    if (found) add('L0.platform', `${type}/${id}`, true, 'present');
    else {
      baseMissing++;
      add('L0.platform', `${type}/${id}`, false, `MISSING — ${why}`,
        'provision the scope base layer with the flower-docs-clm bundle (`update` command, default-scope template) — LEARNINGS §23');
    }
  }
  if (baseMissing === BASE_PLATFORM.length) {
    add('L0.platform', 'scope base layer', false,
      'this looks like a BLANK scope (no flower-templates layer at all) — only the package data model (tagclasses/classes) can deploy; scripts/handlers/guiconfigs cannot',
      'CLM bundle `update` with the default-scope template BEFORE installing any package (LEARNINGS §23)');
  }

  // L0.versions — detected dialects (a too-old server refuses supportedVersions packages)
  try {
    const fd = await capabilities(ctx, 'flowerdocs');
    add('L0.versions', 'flowerdocs dialect', true, `${fd.version ?? '(undetectable)'} -> ${fd.dialect} [${fd.source}]`);
  } catch (e) { add('L0.versions', 'flowerdocs dialect', false, e.message); }

  // L0.ai — gateway provisioned for the scope? (404s until the Uxopian-AI product layer exists)
  let gatewayUp = false;
  try {
    const list = await ctx.clients.gateway.get('/api/v1/prompts');
    gatewayUp = Array.isArray(list);
    const ai = await capabilities(ctx, 'uxopian-ai');
    add('L0.ai', 'uxopian-ai gateway', true, `${list.length} prompts visible — dialect ${ai.dialect} [${ai.source}]`);
  } catch (e) {
    add('L0.ai', 'uxopian-ai gateway', false,
      `unreachable (${String(e.message).slice(0, 80)}) — AI features and ai.* pushes will fail`,
      'provision Uxopian-AI for this scope (separate product layer, NOT in flower-templates) + the FlowerDocsProvider route (docs/DIAGNOSTICS.md L0)');
  }

  // L0.llm — providers configured? NO provider (or empty key) makes every AI call HANG (§A5)
  if (gatewayUp) {
    try {
      const provs = (await ctx.clients.gateway.get('/api/v1/admin/llm/provider-conf')) ?? [];
      if (provs.length) {
        add('L0.llm', 'LLM providers', true,
          `${provs.length}: ${provs.map((p) => p.id ?? p.provider).join(', ')} — API keys are MASKED remotely: verify end-to-end with \`uxc doctor --ai-smoke\` or \`uxc run <prompt>\``);
      } else {
        add('L0.llm', 'LLM providers', false,
          'NONE configured — every AI call (smart upload step 1, prompt runs, chat) HANGS instead of erroring (§A5)',
          'uxc mp install uxopian-ai-default-providers-set (or configure a provider in the admin panel), then SET THE API KEY per instance');
      }
    } catch (e) { add('L0.llm', 'LLM providers', false, String(e.message).slice(0, 100)); }
  }

  // L2.receipts — what is already installed here (upgrade/downgrade context for the deploy)
  try {
    const receipts = await readReceipts(ctx, {});
    add('L2.receipts', 'installed packages', null,
      receipts.length
        ? receipts.map((r) => `${r.code}@${r.version} [${r.surface}]`).join(', ')
        : 'none — fresh scope (receipts appear after uxc import / push --all)');
  } catch { add('L2.receipts', 'installed packages', null, 'unreadable'); }

  // L3.package — when run inside a package: the gates that would block ITS install
  if (pkg) {
    const products = pkg.manifest.products ?? [];
    add('L3.package', 'manifest products', null, products.join(', ') || '(none declared)');
    if (products.includes('uxopian-ai') && !gatewayUp) {
      add('L3.package', 'ai product vs gateway', false, 'the package targets uxopian-ai but the gateway is unreachable — ai.* resources cannot deploy');
    }
    for (const provider of pkg.manifest.requires?.llmProviders ?? []) {
      add('L3.package', `requires.llmProvider ${provider}`, null, 'declared — check it is listed under L0.llm above');
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tier 2 — the sandbox probe (write-based, self-cleaning)
// ---------------------------------------------------------------------------

export const PROBE = {
  cls: 'ZzUxcProbeDoc',
  tagcls: 'ZzUxcProbe',
  handler: 'ZzUxcProbe_onCreate_v1',
  // the classes the GraalVM sandbox must allow for real-world handlers (the fd.demo incident list)
  classes: [
    'java.net.http.HttpClient',
    'java.net.URI',
    'javax.net.ssl.SSLContext',
    'com.flower.docs.security.token.JWTTokenHelper',
    'com.fasterxml.jackson.databind.ObjectMapper',
  ],
};

/** The probe handler script. FIRST write ('engine-ok') needs NO Java.type — engine liveness and
 *  sandbox permissions are separated by construction. Guarded hard on the probe class. */
export function probeScript(classes = PROBE.classes) {
  return `// uxc sandbox probe — deployed by \`uxc doctor --sandbox\`, deleted right after.
try {
  if (('' + RuleUtil.getClassId(component)) === '${PROBE.cls}') {
    var out = ['engine-ok'];
    var probes = ${JSON.stringify(classes)};
    for (var i = 0; i < probes.length; i++) {
      try { Java.type(probes[i]); out.push('ok:' + probes[i]); }
      catch (e) { out.push('blocked:' + probes[i]); }
    }
    RuleUtil.setTagValue(component, '${PROBE.tagcls}', out.join('|'));
    try { util.update(component); } catch (e) { try { util.getComponentService().update(component); } catch (e2) {} }
  }
} catch (e) { /* probe must never break the pipeline */ }
`;
}

/** Parse the probe tag into a verdict. Exported for tests. */
export function probeVerdict(tagValue, { timedOut = false } = {}) {
  const v = String(tagValue ?? '');
  if (!v || v === 'pending') {
    return {
      verdict: 'NOT_FIRING',
      blocked: null,
      detail: timedOut
        ? 'the handler NEVER ran: registration not active yet (~45s propagation — re-run with --wait 180), handlers disabled, or the script engine is broken server-side'
        : 'probe still pending',
    };
  }
  if (!v.startsWith('engine-ok')) return { verdict: 'ENGINE_BROKEN', blocked: null, detail: `unexpected probe output: ${v.slice(0, 120)}` };
  const blocked = v.split('|').filter((x) => x.startsWith('blocked:')).map((x) => x.slice('blocked:'.length));
  if (blocked.length) {
    return {
      verdict: 'NETWORK_BLOCKED',
      blocked,
      detail: `GraalVM runs handlers, but the sandbox DENIES: ${blocked.join(', ')} — every real handler dies at its first Java.type() of these. Redeploying handlers CANNOT fix this: the server team must whitelist them (docs/DIAGNOSTICS.md L0).`,
    };
  }
  return { verdict: 'SANDBOX_OK', blocked: [], detail: 'engine runs, all probed classes allowed' };
}

/**
 * Deploy probe class+tagclass+handler, clear caches, create the probe doc, poll for the handler's
 * verdict, measure search-indexing visibility, then clean everything up. ~60-120s wall clock.
 * Returns { verdict, blocked, detail, firedAfterMs, searchVisibleAfterMs, cleanup: [issues] }.
 */
export async function sandboxProbe(ctx, { waitMs = 120_000, pollMs = 5_000, out } = {}) {
  const { core } = ctx.clients;
  const ts = fdTimestamp();
  const docId = `ZZ_UXC_PROBE_${Date.now().toString(36).toUpperCase()}`;
  const docIds = [];
  const cleanup = [];
  const mkIgnoringExists = async (path, body) => {
    try { await core.post(path, [body]); } catch (e) { if (!isExistsError(e)) throw e; }
  };

  try {
    // 1. probe tagclass + documentclass (id-keyed; exists tolerated from a previous aborted run)
    await mkIgnoringExists('/rest/tagclass', {
      id: PROBE.tagcls, type: 'STRING', searchable: true,
      displayNames: [{ value: 'uxc sandbox probe', language: 'EN' }],
      data: { owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    });
    await mkIgnoringExists('/rest/documentclass', {
      id: PROBE.cls, category: 'DOCUMENT', active: true,
      displayNames: [{ value: 'uxc sandbox probe', language: 'EN' }],
      tagReferences: [{ tagName: PROBE.tagcls, mandatory: false, multivalued: false, technical: false, readonly: false, order: 0 }],
      data: { ACL: 'acl-readonly', owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    });

    // 2. the probe handler registration (direct deploy — deleted after; guarded on the probe class)
    await pushContentDoc(ctx, {
      id: PROBE.handler, name: PROBE.handler, classId: 'OperationHandlerRegistration',
      tags: [
        tag('OperationHandler', 'com.flower.docs.core.tsp.operation.script.ScriptOperationHandler'),
        tag('ExecutionPhase', 'AFTER'),
        tag('Action', 'CREATE'),
        tag('ObjectType', 'DOCUMENT'),
        tag('Enabled', 'true'),
        tag('Asynchronous', 'true'),
        tag('StopOnException', 'false'),
        // LOW order only: registrations with high RegistrationOrder are NEVER EXECUTED —
        // verified live (§27: order 990 never fired; 25 fired in 5s). 29 sits in the proven band;
        // the probe lives ~2 minutes, so a band collision with a package is harmless.
        tag('RegistrationOrder', '29'),
      ],
      files: [{ bytes: Buffer.from(probeScript()), filename: 'handler.js', mime: 'application/javascript' }],
    });
    if (!(await core.getDoc(PROBE.handler))) throw new Error('probe registration did not read back');

    // 3. caches — the ~45 s handler-propagation clock starts here (LEARNINGS §12)
    try { await ctx.clients.cacheClear({ coreToo: true }); } catch (e) { out?.warn?.(`cache clear failed (${e.message}) — the probe may need the full propagation window`); }

    // 4+5. fire-and-poll protocol. CRITICAL (§12, verified live on fd.demo): a CREATE event that
    // fires INSIDE the ~45s registration-propagation window is LOST — the registration never
    // retro-fires. So probe docs are created REPEATEDLY: one immediately (catches an already-warm
    // instance), then a FRESH one shortly after the window and every ~30s until one gets tagged.
    const t0 = Date.now();
    const mkDoc = async (n) => {
      const id = `${docId}_${n}`;
      await core.upsertDoc({
        id, name: 'uxc sandbox probe', category: 'DOCUMENT',
        data: { classId: PROBE.cls, ACL: 'acl-readonly', owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
        tags: [tag(PROBE.tagcls, 'pending')],
      });
      docIds.push(id);
      return id;
    };
    await mkDoc(docIds.length + 1);
    let nextSpawnAt = 55_000; // just past the blind window, then every 30s
    let verdictTag = 'pending';
    let firedAfterMs = null;
    let searchVisibleAfterMs = null;
    while (Date.now() - t0 < waitMs) {
      await sleep(pollMs);
      const elapsed = Date.now() - t0;
      if (elapsed >= nextSpawnAt && elapsed < waitMs - pollMs) {
        await mkDoc(docIds.length + 1); // a fresh CREATE event, now (hopefully) post-propagation
        nextSpawnAt += 30_000;
      }
      for (const id of docIds) {
        const doc = await core.getDoc(id);
        const v = tagsOf(doc ?? {})[PROBE.tagcls] ?? 'pending';
        if (v !== 'pending') { verdictTag = v; firedAfterMs = elapsed; break; }
      }
      if (searchVisibleAfterMs == null) {
        try {
          const { found } = await core.search({ classId: PROBE.cls, fields: ['name'], max: 1 });
          if (found > 0) searchVisibleAfterMs = Date.now() - t0;
        } catch { /* search down is its own finding, not the probe's */ }
      }
      if (firedAfterMs != null) break;
      out?.note?.(`probe pending… ${Math.round(elapsed / 1000)}s (${docIds.length} probe doc(s); registration propagation is ~45s — fresh events are fired past the window)`);
    }

    const verdict = probeVerdict(verdictTag, { timedOut: firedAfterMs == null });
    return { ...verdict, firedAfterMs, searchVisibleAfterMs, probeDocs: docIds.length, cleanup };
  } finally {
    // 6. cleanup — everything by KNOWN id (search lag cannot shield probe objects)
    for (const [what, fn] of [
      ...docIds.map((id) => [`probe doc ${id}`, () => core.del(`/rest/documents/${encodeURIComponent(id)}`)]),
      ['probe handler', () => core.del(`/rest/documents/${encodeURIComponent(PROBE.handler)}`)],
      ['probe class', () => core.del(`/rest/documentclass/${encodeURIComponent(PROBE.cls)}`)],
      ['probe tagclass', () => core.del(`/rest/tagclass/${encodeURIComponent(PROBE.tagcls)}`)],
    ]) {
      try { await fn(); } catch (e) { cleanup.push(`${what}: ${String(e.message).slice(0, 80)}`); }
    }
    try { await ctx.clients.cacheClear({ coreToo: true }); } catch { /* best-effort */ }
    if (cleanup.length) out?.warn?.(`sandbox probe cleanup issues (remove manually): ${cleanup.join('; ')}`);
  }
}
