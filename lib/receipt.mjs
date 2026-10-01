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
import { upsertPrompt } from './kinds/ai-prompt.mjs';
import { receiptDeps } from './compat.mjs';

export const FD_CLASS = 'UxcPackage';
export const FD_TAGS = ['UxcPackageCode', 'UxcPackageVersion', 'UxcClientVersion', 'UxcInstalledAt', 'UxcArtifactSha', 'UxcResources',
  // test stamp (DESIGN §24): a green `uxc test` run marks the receipt — "when did it last prove itself?"
  'UxcTestsPassedAt', 'UxcTestsResult'];
// what this package needs from others ({dependencies, requires} JSON, DESIGN §26): lets a product
// upgrade be judged against the extensions installed on top of it. NOT in FD_TAGS on purpose: the
// tagclass (and the UxcPackage class reference) is created only when a receipt actually carries
// it, so a package declaring no dependencies/compat writes exactly what it wrote before §26.
export const FD_COMPAT_TAG = 'UxcCompat';
// per-resource content hashes of what this install left on the server (DESIGN §19, issue #52):
// the BASE an upgrade compares against, so a same-id object this package installed and nobody
// touched upgrades cleanly instead of classifying as a no-base collision. Same opt-in pattern as
// FD_COMPAT_TAG: the tagclass exists only once a receipt carries hashes. Value:
// `kind/id=<16 hex>,…` (sorted) — older uxc never read it, so it is backward compatible.
export const FD_HASHES_TAG = 'UxcResourceHashes';

/** The receipt form of a sync hash: the first 16 hex chars of the sha256 (64 bits — ample to
 *  tell "unchanged since install" from "edited", and keeps the FD tag value compact). */
export const shortHash = (h) => (h ? String(h).replace(/^sha256:/, '').slice(0, 16) : null);

/** {"kind/id": shortHash} for the listed resources from the package's sync state on `targetName`
 *  (the base each resource was last synced at = what the server holds after this deploy).
 *  Resources without a recorded base are left out (their base is unknown). */
export function resourceHashesFromState(pkg, targetName, resources) {
  const out = {};
  for (const k of resources ?? []) {
    const i = String(k).indexOf('/');
    if (i < 0) continue;
    let h = null;
    try { h = pkg.resState(targetName, k.slice(0, i), k.slice(i + 1))?.syncedHash ?? null; } catch { h = null; }
    if (h) out[k] = shortHash(h);
  }
  return out;
}

const encodeHashes = (m) => Object.keys(m).sort().map((k) => `${k}=${m[k]}`).join(',');
function decodeHashes(v) {
  if (!v) return null;
  const m = {};
  for (const part of String(v).split(',')) {
    const i = part.lastIndexOf('=');
    if (i > 0) m[part.slice(0, i)] = part.slice(i + 1);
  }
  return Object.keys(m).length ? m : null;
}

export const fdReceiptId = (code) => `UXC_PKG_${String(code).toUpperCase()}`;
export const aiReceiptId = (code) => `uxcPkg${String(code).charAt(0).toUpperCase()}${String(code).slice(1)}`;

/** The portable receipt payload (also the AI prompt content, pretty-printed). */
export function buildReceipt(manifest, { artifactSha = null, when = nowIso(), variables = null, resources = null, resourceHashes = null, compat = null } = {}) {
  const deps = receiptDeps(manifest, compat);
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
    // per-resource short hashes of what this deploy left on the server (issue #52): the upgrade
    // base — "ours and untouched" upgrades without --force, "ours but edited" is a named conflict
    ...(resourceHashes && Object.keys(resourceHashes).length
      ? { resourceHashes: Object.fromEntries(Object.keys(resourceHashes).sort().map((k) => [k, resourceHashes[k]])) }
      : {}),
    // what this package depends on / requires of its dependencies (DESIGN §26) — only when declared
    ...(deps.dependencies ? { dependencies: deps.dependencies } : {}),
    ...(deps.requires ? { requires: deps.requires } : {}),
  };
}

/** Idempotent marker infra on FlowerDocs: the Uxc* tagclasses + the UxcPackage documentclass.
 *  Existence checks are direct GETs (id-keyed); creates heal exists-races (T00108/F00903).
 *  compat: true also ensures FD_COMPAT_TAG (only when the receipt being written carries it). */
export async function ensureFdInfra(ctx, { compat = false, hashes = false } = {}) {
  const { core } = ctx.clients;
  const ts = fdTimestamp();
  const wanted = [...FD_TAGS, ...(compat ? [FD_COMPAT_TAG] : []), ...(hashes ? [FD_HASHES_TAG] : [])];
  const mk = async (path, body) => {
    try { await core.post(path, [body]); }
    catch (e) { if (!isExistsError(e)) throw e; /* concurrent install — fine */ }
  };
  for (const t of wanted) {
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
      tagReferences: wanted.map((tagName, order) => ({
        tagName, mandatory: false, multivalued: false, technical: false, readonly: false, order,
      })),
      data: { ACL: 'acl-readonly', owner: ctx.target.user, creationDate: ts, lastUpdateDate: ts },
    });
  } else {
    // schema upgrade: a class created by an older uxc lacks newer receipt tags (UxcResources) —
    // add the missing tagReferences in place (full-replace update, documentclass semantics)
    const have = new Set((cls.tagReferences ?? []).map((r) => r.tagName));
    const missing = wanted.filter((t) => !have.has(t));
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
  const r = buildReceipt(manifest, info);
  if (!r.resourceHashes) return writeFdReceiptDoc(ctx, r);
  try { return await writeFdReceiptDoc(ctx, r); }
  catch (e) {
    // the hash tag is the newest, largest value: a server refusing it (tag value length is not
    // verified live) must not cost the whole receipt — retry without it, say so. The next upgrade
    // then takes the unknown-base path (warned, not refused) for these resources.
    const { resourceHashes, ...bare } = r;
    const kept = await writeFdReceiptDoc(ctx, bare);
    return { ...kept, warning: `per-resource hashes not recorded on flowerdocs (${String(e?.message ?? e).slice(0, 120)})` };
  }
}

async function writeFdReceiptDoc(ctx, r) {
  const withCompat = !!(r.dependencies || r.requires);
  await ensureFdInfra(ctx, { compat: withCompat, hashes: !!r.resourceHashes });
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
      ...(withCompat ? [tag(FD_COMPAT_TAG, JSON.stringify({ dependencies: r.dependencies, requires: r.requires }))] : []),
      ...(r.resourceHashes ? [tag(FD_HASHES_TAG, encodeHashes(r.resourceHashes))] : []),
    ],
  });
  return r;
}

/** Upsert the uxopian-ai receipt prompt through the dialect's prompt write strategy (exists-check
 *  first — duplicate-proof; on 2026.0.0-ft5 each receipt write publishes a new prompt version). */
export async function writeAiReceipt(ctx, manifest, info = {}) {
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
  await upsertPrompt(ctx, body);
  return r;
}

/** Write receipts on every surface the package targets. Best-effort per surface: returns
 *  [{surface, ok, receipt|error}] — callers warn on failures, never abort a deploy over them. */
export async function writeReceipts(ctx, manifest, info = {}) {
  // per-resource hashes default to the open package's sync state (push --all, installed --write):
  // every caller records them without having to know about them (issue #52)
  if (info.resourceHashes === undefined && info.resources?.length && ctx.pkg?.resState && ctx.target?.name) {
    info = { ...info, resourceHashes: resourceHashesFromState(ctx.pkg, ctx.target.name, info.resources) };
  }
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
      await upsertPrompt(ctx, {
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
  let compat = {};
  try { compat = t.UxcCompat ? JSON.parse(t.UxcCompat) : {}; } catch { compat = {}; }
  return {
    surface: 'flowerdocs',
    code: t.UxcPackageCode ?? doc?.id ?? '?',
    version: t.UxcPackageVersion ?? '?',
    uxcVersion: t.UxcClientVersion ?? '?',
    installedAt: t.UxcInstalledAt ?? '?',
    artifactSha: t.UxcArtifactSha ?? null,
    resources: t.UxcResources ? String(t.UxcResources).split(',').filter(Boolean) : null,
    resourceHashes: decodeHashes(t[FD_HASHES_TAG]),
    testsPassedAt: t.UxcTestsPassedAt ?? null,
    testsResult: t.UxcTestsResult ?? null,
    dependencies: compat.dependencies ?? null,
    requires: compat.requires ?? null,
  };
}

/** Parse a receipt out of an AI receipt prompt (JSON content) — null when not a receipt. */
export function receiptFromAiPrompt(p) {
  if (!/^uxcPkg/.test(p?.id ?? '')) return null;
  try {
    const r = JSON.parse(p.content ?? '');
    if (r?.kind !== 'uxc-package-receipt/1') return null;
    return { surface: 'uxopian-ai', code: r.code, version: r.version, uxcVersion: r.uxcVersion, installedAt: r.installedAt, artifactSha: r.artifactSha ?? null, resources: r.resources ?? null, resourceHashes: r.resourceHashes ?? null, testsPassedAt: r.testsPassedAt ?? null, testsResult: r.testsResult ?? null, dependencies: r.dependencies ?? null, requires: r.requires ?? null };
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
 * readReceipts for callers that must tell "no receipts" from "could not read them" (DESIGN §31:
 * a prune deciding whose rows it may delete). readReceipts swallows every error into [] — kept as
 * is for its other callers. Here only PROVEN absence counts as "no receipts":
 *   FD  search error -> the UxcPackage class is probed; absent (null) = no FD receipts, anything
 *       else (class present, probe error) = unreadable; a getDoc error = unreadable.
 *   AI  a 404 (tryGet null) = no AI receipts; any other error = unreadable.
 * -> { receipts, readable: bool, errors: [string] }   never throws.
 */
export async function readReceiptsChecked(ctx) {
  const receipts = []; const errors = [];
  const { core, gateway } = ctx.clients ?? {};
  try {
    let results = null;
    try { ({ results } = await core.search({ classId: FD_CLASS, fields: ['name'], max: 200 })); } catch (e) {
      let cls;
      try { cls = await core.getOne(`/rest/documentclass/${encodeURIComponent(FD_CLASS)}`); } catch { cls = undefined; }
      if (cls !== null) throw e; // the class exists (or the probe failed): the search error is real
    }
    for (const r of results ?? []) {
      const doc = await core.getDoc(r.id);
      if (doc) receipts.push(receiptFromFdDoc(doc));
    }
  } catch (e) { errors.push(`flowerdocs: ${String(e?.message ?? e).slice(0, 160)}`); }
  try {
    const list = (gateway.tryGet ? await gateway.tryGet('/api/v1/prompts') : await gateway.get('/api/v1/prompts')) ?? [];
    for (const p of list) {
      const r = receiptFromAiPrompt(p);
      if (r) receipts.push(r);
    }
  } catch (e) { errors.push(`uxopian-ai: ${String(e?.message ?? e).slice(0, 160)}`); }
  return { receipts, readable: errors.length === 0, errors };
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
/**
 * What THIS package already owns on the target (issue #52), merged over its receipts on every
 * surface: `keys` = the kind/id list a previous install deployed, `hashes` = the per-resource
 * short hashes it recorded (null when every receipt predates them). null = no receipt (fresh, or
 * a receipt written before resource lists existed — nothing can be claimed as ours).
 * -> { code, version, keys: Set, hashes: {key: short}|null } | null
 */
export function ownedByReceipt(receipts, code) {
  const mine = (receipts ?? []).filter((r) => r?.code === code && r.resources?.length);
  if (!mine.length) return null;
  const keys = new Set(mine.flatMap((r) => r.resources));
  let hashes = null;
  for (const r of mine) if (r.resourceHashes) hashes = { ...(hashes ?? {}), ...r.resourceHashes };
  const version = mine.find((r) => r.version && r.version !== '?')?.version ?? '?';
  return { code, version, keys, hashes };
}

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
