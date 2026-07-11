// Installation receipts (DESIGN §19): marker objects that record WHICH package, at WHICH version,
// is installed on a server — so anyone (and any uxc) can ask "what's deployed here?" without the
// package checkout. One receipt per package per surface:
//
//   FlowerDocs  — a document of the uxc-owned class `UxcPackage` (created on demand with its five
//                 Uxc* tagclasses), id `UXC_PKG_<CODE>` — DETERMINISTIC, so the per-package check
//                 is a direct GET (lag-proof, LEARNINGS §25); list-all uses the class search.
//   uxopian-ai  — a SYSTEM prompt `uxcPkg<Code>` whose content is the receipt JSON. Inert (never
//                 invoked by goals), visible in the admin UI — which is a feature, not a leak.
//
// Receipts are written automatically after `uxc import` and after a FULL `uxc push --all`
// (partial pushes don't bump them), best-effort: a receipt failure warns, never fails a deploy.
import { CLIENT_VERSION } from './version.mjs';
import { fdTimestamp, tag, tagsOf, nowIso } from './util.mjs';
import { isExistsError } from './http.mjs';

export const FD_CLASS = 'UxcPackage';
export const FD_TAGS = ['UxcPackageCode', 'UxcPackageVersion', 'UxcClientVersion', 'UxcInstalledAt', 'UxcArtifactSha', 'UxcResources',
  // test stamp (DESIGN §24): a green `uxc test` run marks the receipt — "when did it last prove itself?"
  'UxcTestsPassedAt', 'UxcTestsResult'];

export const fdReceiptId = (code) => `UXC_PKG_${String(code).toUpperCase()}`;
export const aiReceiptId = (code) => `uxcPkg${String(code).charAt(0).toUpperCase()}${String(code).slice(1)}`;

/** The portable receipt payload (also the AI prompt content, pretty-printed). */
export function buildReceipt(manifest, { artifactSha = null, when = nowIso(), variables = null, resources = null } = {}) {
  return {
    kind: 'uxc-package-receipt/1',
    code: manifest.code,
    name: manifest.name ?? manifest.code,
    version: manifest.version ?? '0.0.0',
    products: manifest.products ?? [],
    uxcVersion: CLIENT_VERSION,
    installedAt: when,
    ...(artifactSha ? { artifactSha } : {}),
    // the variable values this install was rendered with (sensitive ones masked) — DESIGN §21;
    // `uxc installed` + the receipt prompt then answer "HOW was this instance parameterized?"
    ...(variables && Object.keys(variables).length ? { variables } : {}),
    // the kind/id list this version DEPLOYED (DESIGN §23): the exact prune source for the next
    // upgrade — marketplace-independent, works for plain-import upgrades, never guesses.
    ...(resources?.length ? { resources: [...resources].sort() } : {}),
  };
}

/** Idempotent marker infra on FlowerDocs: five Uxc* tagclasses + the UxcPackage documentclass.
 *  Existence checks are direct GETs (id-keyed); creates heal exists-races (T00108/F00903). */
export async function ensureFdInfra(ctx) {
  const { core } = ctx.clients;
  const ts = fdTimestamp();
  const mk = async (path, body) => {
    try { await core.post(path, [body]); }
    catch (e) { if (!isExistsError(e)) throw e; /* concurrent install — fine */ }
  };
  for (const t of FD_TAGS) {
    if (await core.getOne(`/rest/tagclass/${encodeURIComponent(t)}`)) continue;
    await mk('/rest/tagclass', {
      id: t, type: 'STRING', searchable: true,
      displayNames: [{ value: t.replace(/^Uxc/, 'uxc '), language: 'EN' }],
      data: { owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    });
  }
  const cls = await core.getOne(`/rest/documentclass/${encodeURIComponent(FD_CLASS)}`);
  if (!cls) {
    await mk('/rest/documentclass', {
      id: FD_CLASS, category: 'DOCUMENT', active: true,
      displayNames: [{ value: 'uxc installed packages', language: 'EN' }],
      tagReferences: FD_TAGS.map((tagName, order) => ({
        tagName, mandatory: false, multivalued: false, technical: false, readonly: false, order,
      })),
      data: { ACL: 'acl-readonly', owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    });
  } else {
    // schema upgrade: a class created by an older uxc lacks newer receipt tags (UxcResources) —
    // add the missing tagReferences in place (full-replace update, documentclass semantics)
    const have = new Set((cls.tagReferences ?? []).map((r) => r.tagName));
    const missing = FD_TAGS.filter((t) => !have.has(t));
    if (missing.length) {
      const refs = [...(cls.tagReferences ?? [])];
      for (const tagName of missing) {
        refs.push({ tagName, mandatory: false, multivalued: false, technical: false, readonly: false, order: refs.length });
      }
      await core.post(`/rest/documentclass/${encodeURIComponent(FD_CLASS)}`, [{ ...cls, tagReferences: refs }]);
    }
  }
}

/** Upsert the FlowerDocs receipt document (id-keyed via upsertDoc — duplicate-proof). */
export async function writeFdReceipt(ctx, manifest, info = {}) {
  await ensureFdInfra(ctx);
  const r = buildReceipt(manifest, info);
  const ts = fdTimestamp();
  await ctx.clients.core.upsertDoc({
    id: fdReceiptId(r.code),
    name: `uxc package ${r.code}`,
    category: 'DOCUMENT',
    data: { classId: FD_CLASS, ACL: 'acl-readonly', owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    tags: [
      tag('UxcPackageCode', r.code),
      tag('UxcPackageVersion', r.version),
      tag('UxcClientVersion', r.uxcVersion),
      tag('UxcInstalledAt', r.installedAt),
      ...(r.artifactSha ? [tag('UxcArtifactSha', r.artifactSha)] : []),
      ...(r.resources ? [tag('UxcResources', r.resources.join(','))] : []),
    ],
  });
  return r;
}

/** Upsert the uxopian-ai receipt prompt (exists-check first, PUT when present — duplicate-proof). */
export async function writeAiReceipt(ctx, manifest, info = {}) {
  const { gateway } = ctx.clients;
  const r = buildReceipt(manifest, info);
  const id = aiReceiptId(r.code);
  const body = {
    id,
    role: 'system',
    content: JSON.stringify(r, null, 2),
    // never a real prompt: no provider pin, nothing to execute — goals must not reference it
    timeSaved: 0,
    // keep receipts out of the Quick Prompt panel (absent displaySettings = SHOWN — AI learnings §A8)
    displaySettings: { enabled: false },
  };
  const list = (await gateway.get('/api/v1/prompts')) ?? [];
  if (list.some((p) => p.id === id)) await gateway.put('/api/v1/admin/prompts', body);
  else await gateway.post('/api/v1/admin/prompts', body);
  return r;
}

/** Write receipts on every surface the package targets. Best-effort per surface: returns
 *  [{surface, ok, receipt|error}] — callers warn on failures, never abort a deploy over them. */
export async function writeReceipts(ctx, manifest, info = {}) {
  const products = manifest.products ?? [];
  const out = [];
  if (products.includes('flowerdocs')) {
    try { out.push({ surface: 'flowerdocs', ok: true, receipt: await writeFdReceipt(ctx, manifest, info) }); }
    catch (e) { out.push({ surface: 'flowerdocs', ok: false, error: e.message }); }
  }
  if (products.includes('uxopian-ai')) {
    try { out.push({ surface: 'uxopian-ai', ok: true, receipt: await writeAiReceipt(ctx, manifest, info) }); }
    catch (e) { out.push({ surface: 'uxopian-ai', ok: false, error: e.message }); }
  }
  return out;
}

/**
 * Stamp a GREEN `uxc test` run onto the existing receipts (DESIGN §24). A targeted tag/JSON
 * merge — installedAt/version/resources are NOT rewritten (the stamp is not an install).
 * No receipt on a surface -> {ok:false, reason} (stamping never creates receipts).
 * -> [{surface, ok, reason?}]
 */
export async function stampTestReceipt(ctx, code, { passed, skipped = 0, total, when = nowIso() } = {}) {
  const result = `${passed}/${total} pass${skipped ? ` (${skipped} skip)` : ''}`;
  const out = [];
  // FlowerDocs: merge the two Uxc* tags into the existing receipt doc (full-replace tags update)
  try {
    const doc = await ctx.clients.core.getDoc(fdReceiptId(code));
    if (!doc) out.push({ surface: 'flowerdocs', ok: false, reason: 'no receipt' });
    else {
      await ensureFdInfra(ctx); // self-upgrade: pre-0.13 UxcPackage class lacks the test tagclasses
      const tags = (doc.tags ?? []).filter((x) => x.name !== 'UxcTestsPassedAt' && x.name !== 'UxcTestsResult');
      tags.push(tag('UxcTestsPassedAt', when), tag('UxcTestsResult', result));
      await ctx.clients.core.post(`/rest/documents/${encodeURIComponent(doc.id)}`, [{ ...doc, tags }]);
      out.push({ surface: 'flowerdocs', ok: true });
    }
  } catch (e) { out.push({ surface: 'flowerdocs', ok: false, reason: String(e.message).slice(0, 120) }); }
  // uxopian-ai: merge into the receipt prompt's JSON content
  try {
    const id = aiReceiptId(code);
    const list = (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
    const p = list.find((x) => x.id === id);
    const r = p ? receiptFromAiPrompt(p) : null;
    if (!r) out.push({ surface: 'uxopian-ai', ok: false, reason: 'no receipt' });
    else {
      const content = JSON.stringify({ ...JSON.parse(p.content), testsPassedAt: when, testsResult: result }, null, 2);
      // rebuild the CANONICAL receipt-prompt body (writeAiReceipt's shape) — echoing the list
      // object back is a 400 (server-side fields the admin PUT rejects, verified fd.demo)
      await ctx.clients.gateway.put('/api/v1/admin/prompts', {
        id, role: 'system', content, timeSaved: 0, displaySettings: { enabled: false },
      });
      out.push({ surface: 'uxopian-ai', ok: true });
    }
  } catch (e) { out.push({ surface: 'uxopian-ai', ok: false, reason: String(e.message).slice(0, 120) }); }
  return out;
}

/** Parse a receipt out of an FD receipt document (tags) — tolerant of missing tags. */
export function receiptFromFdDoc(doc) {
  const t = tagsOf(doc);
  return {
    surface: 'flowerdocs',
    code: t.UxcPackageCode ?? doc?.id ?? '?',
    version: t.UxcPackageVersion ?? '?',
    uxcVersion: t.UxcClientVersion ?? '?',
    installedAt: t.UxcInstalledAt ?? '?',
    artifactSha: t.UxcArtifactSha ?? null,
    resources: t.UxcResources ? String(t.UxcResources).split(',').filter(Boolean) : null,
    testsPassedAt: t.UxcTestsPassedAt ?? null,
    testsResult: t.UxcTestsResult ?? null,
  };
}

/** Parse a receipt out of an AI receipt prompt (JSON content) — null when not a receipt. */
export function receiptFromAiPrompt(p) {
  if (!/^uxcPkg/.test(p?.id ?? '')) return null;
  try {
    const r = JSON.parse(p.content ?? '');
    if (r?.kind !== 'uxc-package-receipt/1') return null;
    return { surface: 'uxopian-ai', code: r.code, version: r.version, uxcVersion: r.uxcVersion, installedAt: r.installedAt, artifactSha: r.artifactSha ?? null, resources: r.resources ?? null, testsPassedAt: r.testsPassedAt ?? null, testsResult: r.testsResult ?? null };
  } catch { return null; }
}

/** All receipts on the connected target: FD (class search + per-code direct GET) + AI (prompt list).
 *  `code` narrows to one package — resolved by DIRECT GET on FD (lag-proof). */
export async function readReceipts(ctx, { code = null } = {}) {
  const out = [];
  // FlowerDocs
  try {
    if (code) {
      const doc = await ctx.clients.core.getDoc(fdReceiptId(code));
      if (doc) out.push(receiptFromFdDoc(doc));
    } else {
      const { results } = await ctx.clients.core.search({ classId: FD_CLASS, fields: ['name'], max: 200 });
      for (const r of results) {
        const doc = await ctx.clients.core.getDoc(r.id);
        if (doc) out.push(receiptFromFdDoc(doc));
      }
    }
  } catch { /* class absent = no receipts on FD */ }
  // uxopian-ai
  try {
    const list = (await ctx.clients.gateway.get('/api/v1/prompts')) ?? [];
    for (const p of list) {
      const r = receiptFromAiPrompt(p);
      if (r && (!code || r.code === code)) out.push(r);
    }
  } catch { /* gateway absent = no receipts on AI */ }
  return out;
}

/**
 * Receipts are FLOW INPUT, not decoration (DESIGN §19): before a deploy, compare the package
 * version against the receipt already on the target.
 *   downgrade (installed > deploying) -> REFUSE unless force (--force), loud override when forced
 *   reinstall (==)                    -> note
 *   upgrade  (<)                      -> note from -> to
 *   fresh    (no receipt)             -> silent
 * Returns { kind: 'fresh'|'upgrade'|'reinstall'|'downgrade', prev }.
 */
export async function assertReceiptFlow(ctx, manifest, { force = false, out, action = 'deploy' } = {}) {
  const { compareSemver } = await import('./version.mjs');
  let prev = null;
  try {
    prev = (await readReceipts(ctx, { code: manifest.code }))
      .find((r) => r.version && r.version !== '?') ?? null;
  } catch { /* unreadable receipts never block a deploy */ }
  if (!prev) return { kind: 'fresh', prev: null };

  const next = manifest.version ?? '0.0.0';
  const c = compareSemver(next, prev.version);
  if (c < 0) {
    const msg = `downgrade: ${manifest.code}@${prev.version} is installed on ${ctx.target?.name ?? 'the target'} (uxc ${prev.uxcVersion}, ${prev.installedAt}) and this ${action} carries ${next}`;
    if (!force) {
      const e = new Error(`${msg} — refusing to downgrade`);
      e.explanation = `deploy the newer package checkout, or ${action} with --force to downgrade deliberately.`;
      throw e;
    }
    out?.warn?.(`${msg} — DOWNGRADING (--force)`);
    return { kind: 'downgrade', prev };
  }
  if (c === 0) {
    out?.note?.(`reinstalling ${manifest.code}@${next} (already on the target)`);
    return { kind: 'reinstall', prev };
  }
  out?.line?.(`upgrading ${manifest.code}: ${prev.version} -> ${next}`);
  return { kind: 'upgrade', prev };
}
