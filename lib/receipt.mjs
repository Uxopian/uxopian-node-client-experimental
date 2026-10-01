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
import aiPrompt, { upsertPrompt } from './kinds/ai-prompt.mjs';
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
// per-resource content hashes of what this install left on the server (DESIGN §19, issue #52): the
// BASE an upgrade compares against, so a same-id object this package installed and nobody touched
// upgrades cleanly instead of classifying as a no-base collision. On FlowerDocs they ride as a JSON
// CONTENT FILE of the receipt document — never a tag: a document accepts a file without any class
// change, so recording hashes costs ZERO schema writes (no tagclass, no UxcPackage class update) and
// has no tag-value length limit. On uxopian-ai they live in the receipt JSON (`resourceHashes`).
// Older receipts carry no file: readers tolerate its absence (hashes = null -> unknown base).
export const FD_CONTENT_KIND = 'uxc-receipt-content/1';
export const FD_CONTENT_FILE = 'uxc-receipt.json';

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

const sortedHashes = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
const strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The package's manifest dataSets as a receipt records them (#125): the DEFINITION a dependent
 *  package needs to read the rows on a server (name, classId, path, content) — never row data.
 *  Sorted by name; [] when the manifest declares none. PURE. */
export function receiptDataSets(manifest) {
  return (Array.isArray(manifest?.dataSets) ? manifest.dataSets : [])
    .filter((d) => d && typeof d.name === 'string' && d.name && typeof d.classId === 'string' && d.classId)
    .map((d) => ({ name: d.name, classId: d.classId, ...(d.path ? { path: d.path } : {}), ...(d.content ? { content: true } : {}) }))
    .sort((a, b) => strCmp(a.name, b.name));
}

/**
 * The values each fd.tagclass-delta of the package CONTRIBUTED on `targetName` (#126, DESIGN §28):
 * [{tagClass, values:[symbolicName…]}] = the delta's own PREFIXED values + the legacy values its push
 * ADDED (state `legacyAdded`) — never a declared legacy value that was already on the server. Names
 * come from the delta file (else the state's recorded ownValues). Sorted; [] when the package has none.
 */
export async function tagContributionsFromPkg(pkg, targetName) {
  if (!pkg?.entries) return [];
  const [{ default: delta }, { valuePrefix }] = await Promise.all([
    import('./kinds/fd-tagclass-delta.mjs'), import('./tagdelta.mjs'),
  ]);
  const prefix = valuePrefix(pkg.manifest);
  const out = [];
  for (const e of pkg.entries('fd.tagclass-delta')) {
    if (e.retired) continue;
    let st = null;
    try { st = targetName ? pkg.resState(targetName, 'fd.tagclass-delta', e.id) : null; } catch { st = null; }
    let names = null;
    try { names = (delta.readLocal(pkg, e)?.obj?.allowedValues ?? []).map((v) => v?.symbolicName).filter((n) => typeof n === 'string' && n); } catch { names = null; }
    if (!names?.length) names = Array.isArray(st?.ownValues) ? st.ownValues : [];
    const added = new Set(Array.isArray(st?.legacyAdded) ? st.legacyAdded : []);
    const values = [...new Set(names.filter((n) => (prefix && n.startsWith(prefix)) || added.has(n)))].sort(strCmp);
    if (values.length) out.push({ tagClass: e.id, values });
  }
  return out.sort((a, b) => strCmp(a.tagClass, b.tagClass));
}

/** A receipt's tagContributions, validated (old/unknown shapes -> null). PURE. */
function contributionsOf(v) {
  if (!Array.isArray(v)) return null;
  const ok = v.filter((c) => c && typeof c.tagClass === 'string' && Array.isArray(c.values))
    .map((c) => ({ tagClass: c.tagClass, values: c.values.filter((n) => typeof n === 'string' && n) }));
  return ok;
}
const dataSetsOf = (v) => (Array.isArray(v) ? v.filter((d) => d && typeof d.name === 'string' && typeof d.classId === 'string') : null);

/** The JSON content file of an FD receipt document -> object, or null (no file / unreadable /
 *  not JSON). Tolerant: a receipt without the file is an older receipt, never an error. */
export async function readFdReceiptContent(core, doc) {
  const fid = doc?.files?.[0]?.id;
  if (!fid || typeof core?.getContent !== 'function') return null;
  try {
    const buf = await core.getContent(doc.id, fid);
    const j = buf ? JSON.parse(String(buf)) : null;
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

export const fdReceiptId = (code) => `UXC_PKG_${String(code).toUpperCase()}`;
export const aiReceiptId = (code) => `uxcPkg${String(code).charAt(0).toUpperCase()}${String(code).slice(1)}`;

/** The portable receipt payload (also the AI prompt content, pretty-printed). */
export function buildReceipt(manifest, { artifactSha = null, when = nowIso(), variables = null, resources = null, resourceHashes = null, compat = null, tagContributions = null } = {}) {
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
    // the dataset DEFINITIONS (#125): a dependent package's `uxc test` resolves a required dataset
    // of this package through them — never row data
    ...(receiptDataSets(manifest).length ? { dataSets: receiptDataSets(manifest) } : {}),
    // the values this package's tag-class deltas contributed (#126): the product's fd.tagclass view
    // leaves them out of its hash, pull and push-replace
    ...(tagContributions?.length ? { tagContributions } : {}),
  };
}

/** The receipt keys carried by the FD content file (never tags — zero schema writes). */
const CONTENT_KEYS = ['resourceHashes', 'dataSets', 'tagContributions'];
const hasContent = (r) => CONTENT_KEYS.some((k) => r[k] != null);

/** Idempotent marker infra on FlowerDocs: the Uxc* tagclasses + the UxcPackage documentclass.
 *  Existence checks are direct GETs (id-keyed); creates heal exists-races (T00108/F00903).
 *  compat: true also ensures FD_COMPAT_TAG (only when the receipt being written carries it). */
export async function ensureFdInfra(ctx, { compat = false } = {}) {
  const { core } = ctx.clients;
  const ts = fdTimestamp();
  const wanted = [...FD_TAGS, ...(compat ? [FD_COMPAT_TAG] : [])];
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
  if (!hasContent(r)) return writeFdReceiptDoc(ctx, r);
  try { return await writeFdReceiptDoc(ctx, r); }
  catch (e) {
    // the content file is the newest part of the receipt: a server refusing the upload must not
    // cost the whole receipt — retry without it, say so. The next upgrade then takes the
    // unknown-base path (warned, not refused) for these resources; readers treat the missing
    // dataSets/tagContributions as an older receipt.
    const bare = { ...r };
    for (const k of CONTENT_KEYS) delete bare[k];
    const kept = await writeFdReceiptDoc(ctx, bare);
    const what = r.resourceHashes ? 'per-resource hashes' : 'receipt content';
    return { ...kept, warning: `${what} not recorded on flowerdocs (${String(e?.message ?? e).slice(0, 120)})` };
  }
}

async function writeFdReceiptDoc(ctx, r) {
  const withCompat = !!(r.dependencies || r.requires);
  await ensureFdInfra(ctx, { compat: withCompat });
  const { core } = ctx.clients;
  const id = fdReceiptId(r.code);
  // the content file: written when this receipt carries hashes, or when the doc already holds one
  // (merged — its other keys kept — so stale hashes of a previous install never survive). A plain
  // receipt on a doc without content attaches nothing: byte-for-byte the pre-#52 write.
  const files = [];
  let prev = null;
  try { prev = await core.getDoc(id); } catch { prev = null; }
  const hadFile = !!prev?.files?.length;
  if (hasContent(r) || hadFile) {
    const content = { ...((hadFile ? await readFdReceiptContent(core, prev) : null) ?? {}), kind: FD_CONTENT_KIND };
    if (r.resourceHashes) content.resourceHashes = sortedHashes(r.resourceHashes);
    else delete content.resourceHashes;
    // #125/#126: same merge rule — written when carried, dropped otherwise (never a stale copy)
    for (const k of ['dataSets', 'tagContributions']) {
      if (r[k]) content[k] = r[k];
      else delete content[k];
    }
    files.push({ bytes: Buffer.from(JSON.stringify(content, null, 2)), filename: FD_CONTENT_FILE, mime: 'application/json' });
  }
  const ts = fdTimestamp();
  await core.upsertDoc({
    id,
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
    ],
  }, files);
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
  // tag-class delta contributions (#126) likewise default from the open package's files + state
  if (info.tagContributions === undefined && ctx.pkg?.entries && ctx.target?.name) {
    let tc = [];
    try { tc = await tagContributionsFromPkg(ctx.pkg, ctx.target.name); } catch { tc = []; }
    info = { ...info, tagContributions: tc };
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
 * Delete THIS package's receipts on the connected target (`uxc destroy`, DESIGN §19): the FD receipt
 * document (direct GET by its deterministic id, then DELETE — its content file goes with it) and the
 * AI receipt prompt (listed, then removed through the ai.prompt adapter — its 409 retry included).
 * Every surface is tried; absence is not an error. -> [{surface, ok, action:'deleted'|'absent', error?}]
 */
export async function removeReceipts(ctx, code) {
  const out = [];
  try {
    const id = fdReceiptId(code);
    const doc = await ctx.clients.core.getDoc(id);
    if (!doc) out.push({ surface: 'flowerdocs', ok: true, action: 'absent' });
    else {
      await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(id)}`);
      out.push({ surface: 'flowerdocs', ok: true, action: 'deleted' });
    }
  } catch (e) { out.push({ surface: 'flowerdocs', ok: false, error: String(e?.message ?? e).slice(0, 160) }); }
  try {
    const id = aiReceiptId(code);
    const gw = ctx.clients.gateway;
    const list = (gw.tryGet ? await gw.tryGet('/api/v1/prompts') : await gw.get('/api/v1/prompts')) ?? [];
    if (!list.some((p) => p?.id === id)) out.push({ surface: 'uxopian-ai', ok: true, action: 'absent' });
    else {
      await aiPrompt.remove(ctx, id);
      out.push({ surface: 'uxopian-ai', ok: true, action: 'deleted' });
    }
  } catch (e) { out.push({ surface: 'uxopian-ai', ok: false, error: String(e?.message ?? e).slice(0, 160) }); }
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

/** Parse a receipt out of an FD receipt document (tags + the optional JSON content file, already
 *  read — see fdReceipt) — tolerant of missing tags and of a missing file. */
export function receiptFromFdDoc(doc, content = null) {
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
    resourceHashes: content?.resourceHashes && typeof content.resourceHashes === 'object' && Object.keys(content.resourceHashes).length
      ? content.resourceHashes : null,
    testsPassedAt: t.UxcTestsPassedAt ?? null,
    testsResult: t.UxcTestsResult ?? null,
    dependencies: compat.dependencies ?? null,
    requires: compat.requires ?? null,
    // #125/#126 (uxc >= 0.25.1): null = an older receipt (or no file) — readers tolerate it
    dataSets: dataSetsOf(content?.dataSets),
    tagContributions: contributionsOf(content?.tagContributions),
  };
}

/** Parse a receipt out of an AI receipt prompt (JSON content) — null when not a receipt. */
export function receiptFromAiPrompt(p) {
  if (!/^uxcPkg/.test(p?.id ?? '')) return null;
  try {
    const r = JSON.parse(p.content ?? '');
    if (r?.kind !== 'uxc-package-receipt/1') return null;
    return { surface: 'uxopian-ai', code: r.code, version: r.version, uxcVersion: r.uxcVersion, installedAt: r.installedAt, artifactSha: r.artifactSha ?? null, resources: r.resources ?? null, resourceHashes: r.resourceHashes ?? null, testsPassedAt: r.testsPassedAt ?? null, testsResult: r.testsResult ?? null, dependencies: r.dependencies ?? null, requires: r.requires ?? null, dataSets: dataSetsOf(r.dataSets), tagContributions: contributionsOf(r.tagContributions) };
  } catch { return null; }
}

/** Read an FD receipt document's receipt, content file included (tolerant: no file = no hashes). */
async function fdReceipt(core, doc) {
  return receiptFromFdDoc(doc, await readFdReceiptContent(core, doc));
}

/** All receipts on the connected target: FD (class search + per-code direct GET) + AI (prompt list).
 *  `code` narrows to one package — resolved by DIRECT GET on FD (lag-proof). */
export async function readReceipts(ctx, { code = null } = {}) {
  const out = [];
  // FlowerDocs
  try {
    if (code) {
      const doc = await ctx.clients.core.getDoc(fdReceiptId(code));
      if (doc) out.push(await fdReceipt(ctx.clients.core, doc));
    } else {
      const { results } = await ctx.clients.core.search({ classId: FD_CLASS, fields: ['name'], max: 200 });
      for (const r of results) {
        const doc = await ctx.clients.core.getDoc(r.id);
        if (doc) out.push(await fdReceipt(ctx.clients.core, doc));
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
      if (doc) receipts.push(await fdReceipt(core, doc));
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
