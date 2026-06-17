// fd.handler — server-side operation handler = an OperationHandlerRegistration-class DOCUMENT
// running Graal JS in the Core JVM. The registry key is the LOGICAL id (CtIngest_onCreate);
// the deployed doc id is <logical>_v<N> because in-place re-edits go STALE (Core keeps the old
// subscription) — every push deploys a FRESH _v(max+1), verifies it reads back, then deletes
// every older _v* (the rotation IS the update). The SERVER is the source of truth for N:
// state.deployedId is a cache, never the input to N+1. After a push the caller must clear
// /core + /gui caches and respect the ~45 s blind window (events in it are LOST).
// Storage: fd/handlers/<logical>/meta.json + handler.js [+ request.xml]; meta.script/meta.filter
// may point to ../shared/ (two registrations sharing one source) — hashes run over RESOLVED bytes.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { stableStringify, tagsOf, tag, nowIso } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';
import { pushContentDoc } from './base.mjs';
import { looksOwned, splitHandlerId, deployedHandlerId, parseHandlerName } from '../naming.mjs';

const KIND = 'fd.handler';
const DIR = 'fd/handlers';
const CLASS_ID = 'OperationHandlerRegistration';
const SCRIPT_HANDLER = 'com.flower.docs.core.tsp.operation.script.ScriptOperationHandler';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Server-truth _vN discovery: ONE search over all OperationHandlerRegistration docs, then match
 * ids against ^<logical>_v(\d+)$. live = the max-N id; every other survivor is an orphan.
 * -> { live: id|null, n: maxN|null, orphans: [ids] }
 */
export async function liveRegistrations(ctx, logical) {
  const { results } = await ctx.clients.core.search({ classId: CLASS_ID, fields: ['name'], max: 200 });
  const re = new RegExp(`^${escapeRe(logical)}_v(\\d+)$`);
  const matches = [];
  for (const r of results) {
    const m = re.exec(r.id ?? '');
    if (m) matches.push({ id: r.id, n: Number(m[1]) });
  }
  if (!matches.length) return { live: null, n: null, orphans: [] };
  matches.sort((a, b) => b.n - a.n);
  return { live: matches[0].id, n: matches[0].n, orphans: matches.slice(1).map((x) => x.id) };
}

/** Best-effort read of the LOCAL meta (readServer uses it to key contents by local filenames). */
function localMetaOf(ctx, logical) {
  try {
    const pkg = ctx.pkg;
    if (!pkg) return null;
    const entry = pkg.entry(KIND, logical);
    const p = join(pkg.dir, entry?.path ?? join(DIR, logical), 'meta.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch { return null; }
}

/**
 * Push = the version rotation: deploy _v(max+1) via pushContentDoc, verify it reads back,
 * delete every other _v* survivor (tolerating failures with a warning).
 * Returns the state patch { deployedId, deployedAt } (also best-effort written to state here,
 * so a sync engine that ignores the return still resumes correctly).
 */
async function push(ctx, logicalOrEntry, local) {
  const logical = typeof logicalOrEntry === 'string'
    ? splitHandlerId(logicalOrEntry).logical
    : (logicalOrEntry?.id ?? null);
  if (!logical) throw new Error(`${KIND}: cannot push without a logical id`);
  const meta = local?.obj;
  if (!meta) throw new Error(`${KIND}/${logical}: meta.json missing`);
  const { core } = ctx.clients;

  const scriptKey = basename(meta.script ?? 'handler.js');
  const scriptBytes = local.contents?.[scriptKey];
  if (scriptBytes == null) throw new Error(`${KIND}/${logical}: script ${meta.script ?? 'handler.js'} missing (resolved relative to the handler dir)`);
  let filterBytes = null;
  if (meta.filter) {
    filterBytes = local.contents?.[basename(meta.filter)];
    if (filterBytes == null) throw new Error(`${KIND}/${logical}: filter ${meta.filter} missing`);
  }

  const reg = await liveRegistrations(ctx, logical);
  const n = (reg.n ?? 0) + 1;
  const deployedId = deployedHandlerId(logical, n);

  await pushContentDoc(ctx, {
    id: deployedId, name: deployedId, classId: CLASS_ID,
    tags: [
      tag('OperationHandler', SCRIPT_HANDLER),
      tag('ExecutionPhase', meta.phase ?? 'AFTER'),
      tag('Action', meta.action),
      tag('ObjectType', meta.objectType),
      tag('Enabled', String(meta.enabled ?? true)),
      tag('Asynchronous', String(meta.asynchronous ?? true)),
      tag('StopOnException', String(meta.stopOnException ?? false)),
      tag('RegistrationOrder', String(meta.order)),
    ],
    files: [
      { bytes: scriptBytes, filename: 'handler.js', mime: 'application/javascript' },
      // the filter file must be NAMED exactly 'request' on the doc or it is ignored
      ...(filterBytes ? [{ bytes: filterBytes, filename: 'request', mime: 'application/xml', name: 'request' }] : []),
    ],
  });

  if (!(await core.getDoc(deployedId))) {
    throw new Error(`${KIND}/${logical}: deployed ${deployedId} but it does not read back — registration NOT live (older _v* left untouched)`);
  }

  // the new registration serves — every other survivor (incl. the old live one) is now an orphan
  for (const id of [reg.live, ...reg.orphans].filter((x) => x && x !== deployedId)) {
    try { await core.del(`/rest/documents/${encodeURIComponent(id)}`); }
    catch (e) { (ctx.out?.warn ?? console.error)(`${KIND}/${logical}: could not delete old registration ${id}: ${e.message}`); }
  }

  const statePatch = { deployedId, deployedAt: nowIso() };
  try {
    if (ctx.pkg && ctx.target?.name) ctx.pkg.setResState(ctx.target.name, KIND, logical, statePatch);
  } catch { /* best-effort */ }
  return statePatch;
}

/** Emergency kill switch: in-place Enabled flip on the live registration — no version bump,
 *  no blind window. (cacheClear + state notes beyond `disabled` are the CALLER's job.) */
export async function setEnabled(ctx, logicalOrId, enabled) {
  const logical = splitHandlerId(logicalOrId).logical;
  const { live } = await liveRegistrations(ctx, logical);
  if (!live) throw new Error(`${KIND}/${logical}: no live _vN registration on the server`);
  const doc = await ctx.clients.core.getDoc(live);
  if (!doc) throw new Error(`${KIND}/${logical}: ${live} matched the search but does not GET`);
  doc.tags = doc.tags ?? [];
  const en = doc.tags.find((t) => t.name === 'Enabled');
  if (en) en.value = [String(enabled)];
  else doc.tags.push(tag('Enabled', String(enabled)));
  await ctx.clients.core.post(`/rest/documents/${encodeURIComponent(live)}`, [doc]);
  try {
    if (ctx.pkg && ctx.target?.name) ctx.pkg.setResState(ctx.target.name, KIND, logical, { disabled: !enabled });
  } catch { /* best-effort */ }
  return live;
}

const adapter = {
  kind: KIND, dir: DIR, layout: 'dir', defaultPolicy: 'managed', cacheAffecting: true,

  /** One row per logical name; foreign non-_vN registrations pass through as-is. */
  async list(ctx) {
    const { results } = await ctx.clients.core.search({ classId: CLASS_ID, fields: ['name'], max: 200 });
    const byLogical = new Map();
    for (const r of results) {
      const { logical, n } = splitHandlerId(r.id ?? '');
      const g = byLogical.get(logical) ?? { id: logical, deployedId: null, n: null, orphans: [] };
      if (n == null) g.deployedId ??= r.id; // unversioned registration (foreign convention)
      else if (g.n == null || n > g.n) {
        if (g.deployedId && g.n != null) g.orphans.push(g.deployedId);
        g.deployedId = r.id; g.n = n;
      } else g.orphans.push(r.id);
      byLogical.set(logical, g);
    }
    return [...byLogical.values()];
  },

  /** Accepts logical or deployed _vN id; returns the live registration doc. */
  async get(ctx, id) {
    const { logical, n } = splitHandlerId(id);
    if (n != null) return ctx.clients.core.getDoc(id);
    const { live } = await liveRegistrations(ctx, logical);
    return live ? ctx.clients.core.getDoc(live) : null;
  },

  // create and update are BOTH the rotation — there is no in-place handler update (stale subs)
  create: (ctx, local) => push(ctx, local.id ?? local.obj?.id, local),
  update: (ctx, id, local) => push(ctx, id, local),
  push,
  setEnabled,
  enable: (ctx, id) => setEnabled(ctx, id, true),
  disable: (ctx, id) => setEnabled(ctx, id, false),

  /** Delete ALL _v* registrations of the logical name. */
  async remove(ctx, id) {
    const logical = splitHandlerId(id).logical;
    const reg = await liveRegistrations(ctx, logical);
    for (const rid of [reg.live, ...reg.orphans].filter(Boolean)) {
      await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(rid)}`);
    }
  },

  /** Orphan visibility for status/verify: { deployedId, n, orphans }. */
  async extras(ctx, id) {
    const { live, n, orphans } = await liveRegistrations(ctx, splitHandlerId(id).logical);
    return { deployedId: live, n, orphans };
  },

  async readServer(ctx, logical) {
    const { live } = await liveRegistrations(ctx, logical);
    if (!live) return null;
    const doc = await ctx.clients.core.getDoc(live);
    if (!doc) return null;
    const t = tagsOf(doc);
    const localMeta = localMetaOf(ctx, logical);
    const files = doc.files ?? [];
    const requestFile = files.find((f) => f.name === 'request') ?? null;
    const scriptFile = files.find((f) => f !== requestFile) ?? null;
    // reconstruct OUR meta shape from the registration tags (proper types — tags are strings);
    // script/filter PATHS are a local layout choice, inherited from the local meta so the two
    // sides hash identically (../shared/ indirection stays invisible to drift)
    const obj = {
      action: t.Action ?? null,
      objectType: t.ObjectType ?? null,
      phase: t.ExecutionPhase ?? 'AFTER',
      asynchronous: t.Asynchronous !== 'false',
      stopOnException: t.StopOnException === 'true',
      order: t.RegistrationOrder != null ? Number(t.RegistrationOrder) : null,
      script: localMeta?.script ?? 'handler.js',
      filter: requestFile ? (localMeta?.filter ?? 'request.xml') : null,
      enabled: t.Enabled !== 'false',
    };
    if (localMeta?.name != null) obj.name = localMeta.name; // purely-local annotation
    const contents = {}; // INSERTION ORDER matters for hashResource — script first, filter second
    if (scriptFile) {
      contents[basename(obj.script)] = (await ctx.clients.core.getContent(live, scriptFile.id)) ?? Buffer.alloc(0);
    }
    if (requestFile && obj.filter) {
      contents[basename(obj.filter)] = (await ctx.clients.core.getContent(live, requestFile.id)) ?? Buffer.alloc(0);
    }
    return { obj, contents };
  },

  // ---- dir layout: <pkg>/fd/handlers/<logical>/meta.json + handler.js [+ request.xml];
  // meta.script/meta.filter resolve RELATIVE TO THE HANDLER DIR (../shared/… allowed) ----
  pathFor: (pkg, id) => join(DIR, id),
  readLocal(pkg, entry) {
    const d = join(pkg.dir, entry.path);
    const metaPath = join(d, 'meta.json');
    if (!existsSync(metaPath)) return null;
    const obj = JSON.parse(readFileSync(metaPath, 'utf8'));
    const contents = {}; // script first, filter second (hash key order)
    const scriptRel = obj.script ?? 'handler.js';
    const sp = join(d, scriptRel);
    if (existsSync(sp)) contents[basename(scriptRel)] = readFileSync(sp);
    if (obj.filter) {
      const fp = join(d, obj.filter);
      if (existsSync(fp)) contents[basename(obj.filter)] = readFileSync(fp);
    }
    return { id: entry.id, obj, contents };
  },
  writeLocal(pkg, entry, { obj, contents = {} }) {
    const d = join(pkg.dir, entry.path);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'meta.json'), stableStringify(canonicalize(KIND, obj)));
    const relOf = {}; // content key (basename) -> declared relative path
    const scriptRel = obj.script ?? 'handler.js';
    relOf[basename(scriptRel)] = scriptRel;
    if (obj.filter) relOf[basename(obj.filter)] = obj.filter;
    for (const [key, bytes] of Object.entries(contents)) {
      const target = join(d, relOf[key] ?? key);
      const inside = !relative(resolve(d), resolve(target)).startsWith('..');
      if (!inside && existsSync(target)) {
        // shared source (../shared/…): only write when bytes differ — sibling handlers sharing
        // the file must not churn it on every pull
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        if (Buffer.compare(readFileSync(target), buf) === 0) continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  },
  removeLocal(pkg, entry) {
    rmSync(join(pkg.dir, entry.path), { recursive: true, force: true }); // shared sources stay
  },

  validate(pkg, entry, local) {
    if (!local) return [`${entry.id}: meta.json missing`];
    const errs = [];
    const o = local.obj ?? {};
    if (!o.action) errs.push(`${entry.id}: meta.action missing (CREATE/UPDATE/DELETE/ANSWER/… — the _on<Action> suffix)`);
    if (!o.objectType) errs.push(`${entry.id}: meta.objectType missing (DOCUMENT/TASK/FOLDER)`);
    if (o.phase != null && o.phase !== 'AFTER' && o.phase !== 'BEFORE') {
      errs.push(`${entry.id}: meta.phase must be BEFORE or AFTER (only a BEFORE script can throw to abort)`);
    }
    if (!Number.isInteger(o.order)) {
      errs.push(`${entry.id}: meta.order must be an integer (RegistrationOrder — allocate from the manifest band)`);
    }
    if (local.contents?.[basename(o.script ?? 'handler.js')] == null) {
      errs.push(`${entry.id}: script file ${o.script ?? 'handler.js'} missing (resolved relative to the handler dir)`);
    }
    if (o.filter && local.contents?.[basename(o.filter)] == null) {
      errs.push(`${entry.id}: filter file ${o.filter} missing`);
    }
    return errs;
  },

  template(ctx, name, flags = {}) {
    const { component, action } = parseHandlerName(name);
    if (!action) {
      throw new Error(`handler name "${name}" must follow <Component>_on<Action> (e.g. ${name}_onCreate) — the suffix sets the Action tag`);
    }
    const filterClass = flags['filter-class'] || component;
    const meta = {
      action,
      objectType: flags.object || 'DOCUMENT',
      phase: flags.phase || 'AFTER',
      asynchronous: !flags.sync,
      stopOnException: false,
      order: flags.order !== undefined ? Number(flags.order) : undefined, // allocated by `uxc add`
      script: 'handler.js',
      filter: 'request.xml',
      enabled: true,
    };
    return {
      obj: meta,
      contents: {
        'handler.js': Buffer.from(handlerJs(name, meta, filterClass, ctx?.target ?? null)),
        'request.xml': Buffer.from(requestXml(filterClass)),
      },
    };
  },

  async scan(ctx, manifest) {
    const { results } = await ctx.clients.core.search({ classId: CLASS_ID, fields: ['name'], max: 200 });
    const seen = new Set();
    const out = [];
    for (const r of results) {
      const { logical } = splitHandlerId(r.id ?? '');
      if (!logical || seen.has(logical) || !looksOwned(manifest, logical)) continue;
      seen.add(logical);
      out.push({ id: logical });
    }
    return out;
  },
};

// ---------------- template emitters (the PROVEN Graal mechanics, §10/§12/§14) ----------------

/** Serialized SearchRequest filter — keeps the handler shared-safe (fires ONLY on this class). */
const requestXml = (classId) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SearchRequest xmlns="http://flower.com/docs/domain/search">
    <selectClause/>
    <filterClauses xsi:type="AndClause" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <criteria>
            <name>classid</name>
            <operator>EQUALS_TO</operator>
            <type>STRING</type>
            <values>${classId}</values>
        </criteria>
    </filterClauses>
    <start>0</start>
    <max>0</max>
    <aggregation xsi:type="FieldAggregation" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
</SearchRequest>
`;

function handlerJs(logical, meta, filterClass, target) {
  const core = target?.core ?? 'https://<host>/core';
  const gateway = target?.gateway ?? 'https://<host>/gui/plugins/<SCOPE>/gateway/uxopian-ai';
  const statusTag = `${filterClass}Status`;
  const errorTag = `${filterClass}Error`;
  const answerNote = meta.action === 'ANSWER'
    ? `
    // ANSWER handlers: component IS the answered task; the answer id is
    //   '' + component.getAnswer().getId().getValue()
    // Do NOT mutate the answered task in AFTER phase (writes don't stick once the answer
    // finalizes it) — mutate the OTHER document instead (minted-JWT REST GET -> patch -> POST).
` : '';
  return `// ${logical} — FlowerDocs server-side operation handler (Graal JS in the Core JVM).
// Registration: ${meta.phase}/${meta.action}/${meta.objectType}, async=${meta.asynchronous}, filter request.xml (classid=${filterClass}).
// PROVEN MECHANICS (FLOWERDOCS-LEARNINGS §10/§12/§14) baked in:
//  - AFTER-phase tag writes only persist via util.update(component) (BEFORE persists with the op).
//  - logger goes to the Core log (unreadable without server access) — observability = MARKER TAGS
//    (${statusTag}/${errorTag} below; they must be DECLARED tagclasses referenced by the class,
//    or writes are rejected with F00032).
//  - Redeploys need a FRESH registration id (_vN+1) + /core + /gui cache clears + ~45 s settle;
//    events fired inside that window are LOST — design a retry path (uxc push --settle waits).
//  - Graal conventions: == not .equals, '' + x string coercion, IIFE so early returns are legal.
'use strict';

const HttpClient = Java.type('java.net.http.HttpClient');
const HttpRequest = Java.type('java.net.http.HttpRequest');
const URI = Java.type('java.net.URI');
const HttpResponse = Java.type('java.net.http.HttpResponse');
const Duration = Java.type('java.time.Duration');
const ObjectMapper = Java.type('com.fasterxml.jackson.databind.ObjectMapper');
const mapper = new ObjectMapper();

const CORE = '${core}';
// the PROVEN runtime gateway path (the legacy /gui/gateway/... path returns no usable answer):
const GW = '${gateway}';
const STATUS_TAG = '${statusTag}';   // idempotency guard + progress marker
const ERROR_TAG = '${errorTag}';     // error marker — tags are the only readable log

// ---- http(): the SAFE helper. NOTE the noBody fix — the old \`else b.GET()\` silently sent
// every bodyless non-GET (DELETE!) as a GET ("DELETE returns 200 but the resource survives").
function http(method, uri, token, body, timeoutSec) {
  const b = HttpRequest.newBuilder().uri(URI.create(uri)).timeout(Duration.ofSeconds(timeoutSec || 60))
    .header('token', token).header('Accept', 'application/json');
  if (body != null) b.method(method, HttpRequest.BodyPublishers.ofString(body)).header('Content-Type', 'application/json');
  else if (method == 'GET') b.GET();
  else b.method(method, HttpRequest.BodyPublishers.noBody()); // keep the verb on bodyless DELETE/PUT/POST
  // connectTimeout + request timeout so a bad route can NEVER hang the JVM handler thread
  const client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
  return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
}

// ---- mint a JWT server-side (authenticates BOTH Core REST and the uxopian-ai gateway;
// send it in the 'token' header). Fill in the instance JWT secret — never commit a real one.
function jwt(context, util) {
  const JWTTokenHelper = Java.type('com.flower.docs.security.token.JWTTokenHelper');
  const AuthenticatedUser = Java.type('com.flower.docs.domain.security.AuthenticatedUser');
  const ArrayList = Java.type('java.util.ArrayList');
  const ids = new ArrayList(); ids.add(context.getUser().getValue());
  const user = util.getUserService().get(ids, true).get(0);
  const au = new AuthenticatedUser();
  au.setScope(context.getScope()); au.setId(context.getUser()); au.setProfiles(user.getProfiles());
  const h = new JWTTokenHelper();
  h.setSecretKey('REPLACE_WITH_INSTANCE_JWT_SECRET'); // <-- the instance JWT secret
  return h.generate(au).getValue();
}

// persist tag writes — AFTER phase: in-memory setTagValue alone does NOT stick
function setTags(component, util, kv) {
  for (var k in kv) RuleUtil.setTagValue(component, k, '' + kv[k]);
  try { util.update(component); } catch (e) { try { util.getComponentService().update(component); } catch (e2) { } }
}

// the gateway streams upstream failures as 200-status BODY TEXT — detect them before trusting
function gatewayErrorOf(s) {
  if (s == null) return 'empty answer';
  const head = ('' + s).substring(0, 300).toLowerCase();
  if (head.length == 0) return 'empty answer';
  if (head.indexOf('httptimeoutexception') >= 0 || head.indexOf('request timed out') >= 0) return 'gateway timeout';
  if (head.indexOf('error: java.') >= 0) return 'gateway java error';
  return null;
}
// One prompt call with ONE retry on transient/gateway failure. Returns the answer string or null.
function callPrompt(token, promptId, payloadObj, timeoutSec) {
  const body = JSON.stringify({ inputs: [{ role: 'USER', content: [{ type: 'PROMPT', value: promptId, payload: payloadObj }] }] });
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = http('POST', GW + '/api/v1/requests', token, body, timeoutSec || 120);
      if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
        const node = mapper.readTree('' + resp.body());
        if (node != null && node.has('answer')) {
          const ans = '' + node.get('answer').asText();
          if (gatewayErrorOf(ans) == null) return ans;
        }
      }
    } catch (e) { /* retry once */ }
  }
  return null;
}

(function main() {
  try {
    // scope guard — defense-in-depth on top of the request.xml filter
    if (('' + RuleUtil.getClassId(component)) != '${filterClass}') return;
${answerNote}
    // idempotency guard on the status tag: re-fires/retries skip already-processed components
    const status = '' + RuleUtil.getTagValue(component, STATUS_TAG);
    if (status != 'null' && status != '' && status != 'NEW') return;
    setTags(component, util, (function () { var p = {}; p[STATUS_TAG] = 'PROCESSING'; p[ERROR_TAG] = ''; return p; })());

    const docId = '' + component.getId().getValue(); // server-side id shape (client JSAPI differs)
    const token = jwt(context, util);

    // ---- your logic. Example: one prompt call, answer stored as a tag ----
    // const answer = callPrompt(token, 'myPromptId', { documentId: docId }, 120);
    // if (answer == null) { throw 'myPromptId returned no usable answer (after retry)'; }
    // RuleUtil.setTagValue(component, 'MyAnswerTag', answer.substring(0, 3900));
    // Core REST from here: http('GET'|'POST'|'DELETE', CORE + '/rest/…', token, bodyOrNull, 30)

    setTags(component, util, (function () { var p = {}; p[STATUS_TAG] = 'DONE'; return p; })());
  } catch (e) {
    // never throw out of an AFTER handler — write the error marker so it's diagnosable via REST
    try {
      setTags(component, util, (function () { var p = {}; p[STATUS_TAG] = 'FAILED'; p[ERROR_TAG] = ('' + e).substring(0, 400); return p; })());
    } catch (e2) { }
  }
})();
`;
}

export default adapter;
