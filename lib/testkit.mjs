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
import { readFileSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { runPrompt } from './run.mjs';
import { serverOf } from './sync.mjs';
import { capabilities } from './dialects.mjs';
import { sleep, tag } from './util.mjs';

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
 * Per-test pre-flight (`requires`): unmet -> SKIP with the reason, never a failure — a package
 * must be testable on partial targets (FD-only, no LLM key, older server).
 *   requires: { resources: ['fd.handler/X'], docs: ['CT_CONFIG'], products: ['uxopian-ai'],
 *               llmProvider: true, caps: { 'uxopian-ai': { adminPromptList: true } } }
 * -> { ok: true } | { ok: false, reason }
 */
export async function checkRequires(ctx, pkg, requires = {}) {
  for (const key of requires.resources ?? []) {
    const [kind, ...rest] = String(key).split('/');
    const id = rest.join('/');
    const entry = (pkg.registry?.resources ?? []).find((r) => r.kind === kind && r.id === id);
    if (!entry) return { ok: false, reason: `requires ${key}: not in this package's registry` };
    let server = null;
    try { server = await serverOf(ctx, entry); } catch { server = null; }
    if (!server) return { ok: false, reason: `requires ${key}: not deployed on ${ctx.target?.name} — install the package first` };
  }
  for (const docId of requires.docs ?? []) {
    let doc = null;
    try { doc = await ctx.clients.core.getDoc(docId); } catch { doc = null; }
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
