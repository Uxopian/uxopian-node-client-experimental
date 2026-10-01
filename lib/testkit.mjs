// Package-embedded functional tests (DESIGN §24, #27): the `t` harness handed to a package's
// tests/*.test.mjs and the per-test pre-flight. A test exercises the DEPLOYED customization on a
// live target (upload -> handler fires -> clauses/tasks appear -> prompt answers); the knowledge
// of WHAT to test travels with the package, like the templates carry the mechanics.
//
// Safety by construction:
//   - every fixture id is minted through t.id() -> `ZZTEST_<CODE>_<HINT>_<run8>` — visible,
//     namespaced, doctor-scannable; t.doc.create REFUSES ids outside the namespace;
//   - teardown deletes ONLY what the harness tracked (LIFO); raw t.core writes are possible but
//     never cleaned — you own them;
//   - the runner refuses to run at all unless the target opts in (allowTests) or --yes is passed.
//
// waitFor is the primitive for the two live-timing realities (LEARNINGS §12/§25): handler
// pipelines are asynchronous, and search is eventually consistent — poll by DIRECT GET wherever
// an id is deterministic; reserve search-based waits for ids you cannot know.
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, basename, join, dirname } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { expandIncludes } from './include.mjs';
import { runPrompt, runPlan } from './run.mjs';
import { serverOf } from './sync.mjs';
import { capabilities } from './dialects.mjs';
import { declaredDependencies } from './dependencies.mjs';
import { readReceiptsChecked } from './receipt.mjs';
import { splitRowOwnership } from './ownership.mjs';
import { prefixForms } from './naming.mjs';
import { sleep, tag } from './util.mjs';

// model-output JSON for package tests (#122): strict first, repaired only as a fallback
export { parseLooseJson, matchLoose } from './jsonloose.mjs';
import { parseLooseJson, matchLoose } from './jsonloose.mjs';

export const TEST_ID_PREFIX = 'ZZTEST';

/** One run id per `uxc test` invocation — every fixture of the run carries it. */
export const makeRunId = () => randomBytes(4).toString('hex');

/** Fixture id: ZZTEST_<CODE>_<HINT>_<run8>. Hint is sanitized, never empty. */
export function mintId(code, hint, runId) {
  const h = String(hint ?? 'fx').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'fx';
  return `${TEST_ID_PREFIX}_${String(code).toUpperCase()}_${h}_${runId}`;
}

/** Assertion failures are distinguishable from infrastructure errors in the report. */
export class TestFail extends Error {
  constructor(msg) { super(msg); this.testFail = true; }
}

/** Mid-run skip (t.skip): for preconditions `requires` cannot express — e.g. an instance config
 *  doc exists but lacks the value the feature under test needs. */
export class TestSkip extends Error {
  constructor(reason) { super(reason); this.testSkip = true; }
}

const asTags = (tags) => Array.isArray(tags)
  ? tags
  : Object.entries(tags ?? {}).map(([name, v]) => tag(name, v));

/** Content type from the filename — a wrong mime routes server-side text extraction down
 *  slow/stalling paths (verified live: octet-stream .txt stalled the gateway extractor). */
const MIME_BY_EXT = {
  txt: 'text/plain', md: 'text/plain', json: 'application/json', xml: 'application/xml',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html', csv: 'text/csv',
};
const mimeOf = (filename) => MIME_BY_EXT[String(filename ?? '').split('.').pop().toLowerCase()] ?? 'application/octet-stream';

/**
 * Build the `t` harness for one test. `testsDir` anchors relative `file:` fixture paths.
 * Returns { t, teardown(keep) } — teardown is LIFO, per-item try/catch, and reports survivors.
 */
export function createHarness(ctx, { runId, testsDir, log = () => {} }) {
  const { core, gateway, gui } = ctx.clients;
  const pkg = ctx.pkg;
  const stack = []; // LIFO: {kind:'doc'|'task', id} | {fn, label}
  const hintUses = new Map(); // same hint twice in one test -> Contract, Contract2, Contract3…

  const t = {
    core, gateway, gui,
    target: { name: ctx.target?.name, scope: ctx.target?.scope },
    pkg: { manifest: pkg.manifest, resources: pkg.registry?.resources ?? pkg.manifest?.resources ?? [] },
    runId,
    json: parseLooseJson,   // t.json(text) -> { value, repaired: [...] } — model output with fences/prose
    matchJson: matchLoose,

    id: (hint) => {
      const n = (hintUses.get(hint) ?? 0) + 1;
      hintUses.set(hint, n);
      return mintId(pkg.manifest?.code ?? 'PKG', `${hint ?? 'fx'}${n > 1 ? n : ''}`, runId);
    },

    /** Register teardown work. kind: 'doc' | 'task' (+ custom fn via t.cleanup). */
    track(kind, id) {
      if (!['doc', 'task'].includes(kind)) throw new TestFail(`t.track: unknown kind "${kind}" (doc|task)`);
      stack.push({ kind, id });
      return id;
    },
    cleanup(fn, label = 'cleanup fn') { stack.push({ fn, label }); },

    doc: {
      /**
       * Create (upsert) a fixture document with a MINTED id — auto-tracked for teardown.
       * { classId, name?, id?, tags?, data?, acl?, file?, mime? }
       *   tags: object {Tag: value|[values]} or ready-made array
       *   file: 'relative/path' (vs tests/) | {bytes, filename, mime}
       *   mime: overrides the extension-derived content type (a wrong mime can route server-side
       *         extractors down slow/stalling paths — .txt/.pdf/.docx are inferred)
       * An explicit id must stay inside the ZZTEST_ namespace — that is the deletion warrant.
       */
      async create({ classId, name, id, tags = {}, data = {}, acl, file, mime } = {}) {
        if (!classId) throw new TestFail('t.doc.create: classId is required');
        const docId = id ?? t.id(classId.replace(/^[A-Z][a-z]+/, '')); // CtContract -> Contract
        if (!docId.startsWith(`${TEST_ID_PREFIX}_`)) {
          throw new TestFail(`t.doc.create: id "${docId}" is outside the ${TEST_ID_PREFIX}_ namespace — the harness only ever deletes namespaced fixtures`);
        }
        const files = [];
        if (file) {
          const f = typeof file === 'string'
            ? { bytes: readFileSync(isAbsolute(file) ? file : resolve(testsDir, file)), filename: basename(file) }
            : file;
          files.push({ bytes: f.bytes, filename: f.filename ?? 'fixture.bin', mime: f.mime ?? mime ?? mimeOf(f.filename) });
        }
        const body = {
          id: docId,
          name: name ?? docId,
          category: 'DOCUMENT',
          data: { classId, ...(acl ? { ACL: acl } : {}), ...data },
          tags: asTags(tags),
        };
        t.track('doc', docId);
        await core.upsertDoc(body, files);
        const echo = await core.getDoc(docId);
        return echo ?? body;
      },
    },

    /** Poll until fn() is truthy. Throws TestFail on timeout (with the label). Returns fn's value. */
    async waitFor(fn, { timeoutMs = 120_000, everyMs = 3_000, label = 'condition' } = {}) {
      const t0 = Date.now();
      let lastErr = null;
      for (;;) {
        try {
          const v = await fn();
          if (v) return v;
          lastErr = null;
        } catch (e) { lastErr = e; } // a probe that throws counts as "not yet"
        if (Date.now() - t0 > timeoutMs) {
          throw new TestFail(`timed out after ${Math.round((Date.now() - t0) / 1000)}s waiting for: ${label}${lastErr ? ` (last probe error: ${String(lastErr.message).slice(0, 140)})` : ''}`);
        }
        await sleep(everyMs);
      }
    },
    sleep,

    /** Answer a task — ANSWER handlers dispatch on the FIRST answer only (LEARNINGS §13). */
    async answerTask(taskId, answerId) {
      await core.put(`/rest/tasks/${encodeURIComponent(taskId)}/answer`, { id: answerId });
    },

    /** Run a prompt/goal through the gateway (lib/run.mjs: SSE quirks + cold-start retry). */
    runPrompt: (idOrGoal, payload = {}, opts = {}) => runPrompt(ctx, idOrGoal, { payload, ...opts }),
    /** Run an ai.plan to completion (uxopian-ai 2026.0.0-ft5+) — { status, answer, nodes, error? }. */
    runPlan: (planId, payload = {}, opts = {}) => runPlan(ctx, planId, { payload, ...opts }),

    expect(cond, msg = 'expectation failed') { if (!cond) throw new TestFail(msg); return cond; },
    fail(msg) { throw new TestFail(msg); },
    skip(reason) { throw new TestSkip(reason); },
    log,
  };

  /** LIFO teardown. keep:true skips deletion and reports what was kept. */
  async function teardown({ keep = false } = {}) {
    const result = { deleted: [], failed: [], kept: [] };
    for (const item of [...stack].reverse()) {
      const key = item.fn ? item.label : `${item.kind}/${item.id}`;
      if (keep) { result.kept.push(key); continue; }
      try {
        if (item.fn) await item.fn();
        else if (item.kind === 'task') await core.del(`/rest/tasks/${encodeURIComponent(item.id)}`);
        else await core.del(`/rest/documents/${encodeURIComponent(item.id)}`);
        result.deleted.push(key);
      } catch (e) {
        // absent already = clean (a handler or the test itself removed it)
        if (e?.status === 404 || /F00012|F00206|T00103/.test(`${e?.body?.code ?? ''} ${e?.message ?? ''}`)) result.deleted.push(key);
        else result.failed.push({ key, error: String(e.message).slice(0, 120) });
      }
    }
    return result;
  }

  return { t, teardown };
}

/**
 * OFFLINE harness (BACKLOG-AGENTIC #13). A package's handler logic is ordinary JavaScript: rule
 * evaluation, SLA arithmetic, payload shaping. Exercising it needs no server, and a suite that
 * needs no server should not queue behind an e2e campaign holding the write lock — the POC's 80
 * offline books run in 0.5 s.
 *
 * A test opts in with `offline: true`; it gets `t` WITHOUT core/gateway/gui (touching a server
 * from an offline test would be a lie about what the tier guarantees) plus t.loadShared().
 */
export function createOfflineHarness(ctx, { testsDir, log = () => {} }) {
  const pkg = ctx.pkg;
  const t = {
    offline: true,
    pkg: { dir: pkg?.dir, manifest: pkg?.manifest, resources: pkg?.registry?.resources ?? [] },
    expect(cond, msg = 'expectation failed') { if (!cond) throw new TestFail(msg); return cond; },
    fail(msg) { throw new TestFail(msg); },
    skip(reason) { throw new TestSkip(reason); },
    log,
    sleep,

    /**
     * Evaluate a shared handler library in a sandbox and hand back its globals.
     *   const lib = t.loadShared('../fd/handlers/_shared/po-lib.js', { core: fakeCore });
     *   t.expect(lib.slaDue('P1') === 4);
     * `@include` directives are expanded exactly as a push would, so what runs here is what the
     * server runs. `globals` seeds the sandbox — that is where a fake Core goes. Handler scripts
     * run on GraalJS where `String` is java.lang.String (LEARNINGS §32): Node cannot reproduce
     * that, so a green offline book is necessary, never sufficient.
     */
    loadShared(relPath, globals = {}) {
      const abs = isAbsolute(relPath) ? relPath : resolve(testsDir, relPath);
      if (!existsSync(abs)) throw new TestFail(`t.loadShared: ${relPath} not found (resolved to ${abs})`);
      const src = expandIncludes(readFileSync(abs), abs, resolve(pkg?.dir ?? dirname(abs)));
      const sandbox = { console, JSON, Math, Date, RegExp, Error, parseInt, parseFloat, isNaN, ...globals };
      sandbox.globalThis = sandbox;
      const context = createContext(sandbox);
      try {
        runInContext(String(src), context, { filename: abs, timeout: 10_000 });
      } catch (e) {
        throw new TestFail(`t.loadShared(${relPath}): ${e.message}`);
      }
      return context;
    },
  };
  return { t, teardown: async () => ({ deleted: [], failed: [], kept: [] }) };
}

/**
 * A read that THROWS (429 / 503 / timeout) is not an answer: retry with a short backoff
 * (fd.demo allows ~25 req/s per IP), then rethrow so the caller says "could not check", never
 * "not deployed". A definite absent (null result) is returned untouched. ctx.requiresBackoffMs
 * overrides the schedule (tests).
 */
async function withRetry(ctx, fn) {
  const waits = ctx?.requiresBackoffMs ?? [400, 1200];
  for (let i = 0; ; i++) {
    try { return (await fn()) ?? null; }
    catch (e) {
      // a definite 4xx answer (auth, bad request) will not change on retry — only 429, 5xx and
      // failures without an HTTP status (network, timeout) are worth waiting for
      const s = e?.status;
      if (i >= waits.length || (s >= 400 && s < 500 && s !== 429)) throw e;
      await sleep(waits[i]);
    }
  }
}

/** The target's receipts, read ONCE per run (a suite of N tests must not cost N receipt scans).
 *  A partial read (one surface unreadable) is retried like any other throwing read. */
const receiptCache = new WeakMap();
async function receiptsFor(ctx) {
  if (receiptCache.has(ctx)) return receiptCache.get(ctx);
  let last = null;
  try {
    await withRetry(ctx, async () => {
      last = await readReceiptsChecked(ctx);
      if (!last.readable) throw new Error(last.errors.join('; '));
      return last;
    });
  } catch { /* `last` carries what WAS readable + the errors */ }
  receiptCache.set(ctx, last);
  return last;
}

/**
 * A `requires.resources` key the package does not carry may belong to a declared DEPENDENCY
 * (#115: an extension's tests need the product's handlers). Resolved through the dependency's
 * installation receipt — its resource list (DESIGN §23) is the record of what it deployed.
 * -> { ok:true, via:'code@version' } | { ok:false, reason }   (a receipt without a resource list,
 * written before lists existed, is trusted: the server check that follows is the real answer)
 */
async function viaDependency(ctx, pkg, key) {
  const deps = declaredDependencies(pkg.manifest).filter((d) => d.code !== pkg.manifest?.code);
  if (!deps.length) return { ok: false, reason: `requires ${key}: not in this package's registry (and it declares no dependencies)` };
  const { receipts, errors } = await receiptsFor(ctx);
  const why = [];
  for (const d of deps) {
    const mine = receipts.filter((r) => r.code === d.code && r.version && r.version !== '?');
    if (!mine.length) { why.push(`dependency ${d.code} not installed on ${ctx.target?.name}`); continue; }
    const hit = mine.find((r) => !Array.isArray(r.resources) || r.resources.includes(key));
    if (hit) return { ok: true, via: `${d.code}@${hit.version}`, code: d.code, receipts: mine, all: receipts };
    why.push(`dependency ${d.code}@${mine[0].version} is installed but does not list it`);
  }
  // an unreadable surface may hide the receipt that lists it: that is "could not check", not absent
  if (errors.length) return { ok: false, reason: `could not check ${key} on ${ctx.target?.name}: receipts unreadable (${errors.join('; ').slice(0, 120)})` };
  return { ok: false, reason: `requires ${key}: ${why.join('; ')}` };
}

/**
 * `requires: fd.dataset/<Name>` owned by a dependency (#125). The definition (classId) comes from the
 * dependency's installed receipt (`dataSets`, uxc >= 0.25.1); then the server must hold the class AND at
 * least one row of the dependency in it — split with the §31 rule (another installed package's prefix,
 * this package's included, is not the dependency's row; an unprefixed row is). A receipt written by an
 * older uxc carries no definition: skip, saying how to record it.
 * -> { ok:true } | { ok:false, reason }
 */
async function dependencyDataset(ctx, pkg, key, name, dep) {
  const withDefs = dep.receipts.filter((r) => Array.isArray(r.dataSets));
  const ds = withDefs.flatMap((r) => r.dataSets).find((d) => d.name === name) ?? null;
  if (!withDefs.length) {
    return { ok: false, reason: `requires ${key}: dependency ${dep.via} installed by a uxc older than 0.25.1: re-push it to record its datasets` };
  }
  if (!ds?.classId) return { ok: false, reason: `requires ${key}: dependency ${dep.via} defines no dataset "${name}" in its receipt` };
  const { core } = ctx.clients;
  const target = ctx.target?.name;
  let cls;
  try { cls = await withRetry(ctx, () => core.getOne(`/rest/documentclass/${encodeURIComponent(ds.classId)}`)); }
  catch (e) { return { ok: false, reason: `could not check ${key} on ${target}: ${String(e.message).slice(0, 120)}` }; }
  if (!cls) return { ok: false, reason: `requires ${key}: class ${ds.classId} (dataset of dependency ${dep.via}) is not on ${target} — re-install the dependency` };
  const self = pkg.manifest?.code;
  const owners = [...new Set([self, ...dep.all.map((r) => r?.code)])]
    .filter((c) => c && c !== '?' && c !== dep.code)
    .map((code) => ({ code, forms: prefixForms(code) }));
  try {
    for (let start = 0; ;) {
      const { found, results } = await withRetry(ctx, () => core.search({ classId: ds.classId, fields: ['name'], max: 200, start }));
      const ids = (results ?? []).map((r) => String(r.id));
      if (splitRowOwnership(ids, { code: dep.code }, owners, { receiptsReadable: true }).own.length) return { ok: true };
      start += ids.length;
      if (!ids.length || start >= (found ?? 0)) break;
    }
  } catch (e) { return { ok: false, reason: `could not check ${key} on ${target}: ${String(e.message).slice(0, 120)}` }; }
  return { ok: false, reason: `requires ${key}: class ${ds.classId} holds no rows of dependency ${dep.via} on ${target} — push the dependency's dataset` };
}

/**
 * Per-test pre-flight (`requires`): unmet -> SKIP with the reason, never a failure — a package
 * must be testable on partial targets (FD-only, no LLM key, older server).
 * A resource outside the package's registry resolves through its declared dependencies' receipts (#115).
 *   requires: { resources: ['fd.handler/X'], docs: ['CT_CONFIG'], products: ['uxopian-ai'],
 *               llmProvider: true, caps: { 'uxopian-ai': { adminPromptList: true } } }
 * -> { ok: true } | { ok: false, reason }
 */
export async function checkRequires(ctx, pkg, requires = {}) {
  for (const key of requires.resources ?? []) {
    const [kind, ...rest] = String(key).split('/');
    const id = rest.join('/');
    let entry = (pkg.registry?.resources ?? []).find((r) => r.kind === kind && r.id === id);
    let via = null; // the dependency whose receipt lists it (#115)
    if (!entry) {
      const dep = await viaDependency(ctx, pkg, key);
      if (!dep.ok) return dep;
      entry = { kind, id };
      via = dep.via;
      // a dependency's dataset has no definition in THIS manifest (#125): resolve it through the
      // dependency's receipt, then check its class and rows directly
      if (kind === 'fd.dataset' && !(pkg.manifest?.dataSets ?? []).some((d) => d?.name === id)) {
        const r = await dependencyDataset(ctx, pkg, key, id, dep);
        if (!r.ok) return r;
        continue;
      }
    }
    let server;
    try { server = await withRetry(ctx, () => serverOf(ctx, entry)); }
    catch (e) { return { ok: false, reason: `could not check ${key} on ${ctx.target?.name}: ${String(e.message).slice(0, 120)}` }; }
    if (!server) {
      return { ok: false, reason: via
        ? `requires ${key}: listed by dependency ${via} but not deployed on ${ctx.target?.name} — re-install the dependency`
        : `requires ${key}: not deployed on ${ctx.target?.name} — install the package first` };
    }
  }
  for (const docId of requires.docs ?? []) {
    let doc;
    try { doc = await withRetry(ctx, () => ctx.clients.core.getDoc(docId)); }
    catch (e) { return { ok: false, reason: `could not check document ${docId} on ${ctx.target?.name}: ${String(e.message).slice(0, 120)}` }; }
    if (!doc) return { ok: false, reason: `requires document ${docId} on the target (instance configuration?) — absent` };
  }
  for (const product of requires.products ?? []) {
    if (product === 'uxopian-ai') {
      try { await ctx.clients.gateway.get('/api/v1/prompts'); }
      catch (e) { return { ok: false, reason: `requires uxopian-ai: gateway unreachable (${String(e.message).slice(0, 80)})` }; }
    }
    // 'flowerdocs' reachability is proven by connect() itself (auth round-trip)
  }
  if (requires.llmProvider) {
    try {
      const providers = await ctx.clients.gateway.get('/api/v1/admin/llm/provider-conf');
      if (!Array.isArray(providers) || providers.length === 0) {
        return { ok: false, reason: 'requires an LLM provider: none configured (uxc ls ai.llm)' };
      }
    } catch (e) {
      return { ok: false, reason: `requires an LLM provider: cannot list providers (${String(e.message).slice(0, 80)})` };
    }
  }
  for (const [product, want] of Object.entries(requires.caps ?? {})) {
    let caps;
    try { ({ caps } = await capabilities(ctx, product)); }
    catch (e) { return { ok: false, reason: `requires ${product} capabilities: ${String(e.message).slice(0, 80)}` }; }
    for (const [cap, expected] of Object.entries(want)) {
      if ((caps?.[cap] ?? false) !== expected) {
        return { ok: false, reason: `requires ${product} capability ${cap}=${expected} — server dialect says ${caps?.[cap] ?? false}` };
      }
    }
  }
  return { ok: true };
}
