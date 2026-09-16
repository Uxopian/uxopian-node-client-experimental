// Gateway run mechanics (DESIGN §14, learnings §8 + verified SSE quirks):
//  - non-stream POST /requests 404s on the external path -> ALWAYS /requests/stream?conversation=
//  - the stream may be SSE 'data:'-framed OR plain raw text (no framing at all) — parse tolerantly
//  - upstream failures arrive as 200 BODIES (/timed out|HttpTimeout|Error: java/) -> ONE cold-start
//    retry, then report the error instead of rendering it as the answer
//  - LLM override goes in QUERY PARAMS (provider/model/temperature/disableReasoning)
//  - the payload rides INSIDE inputs[0].content[0].payload; --goal switches type PROMPT -> GOAL
//  - uxopian-ai 2026.0.0-ft5 (AI learnings §A11/§A12): content[0].version pins a prompt VERSION
//    (null = the served one) — an ABSENT version is not an error server-side, the run goes out
//    with an empty prompt and the LLM answers nonsense, so the version is checked first; the GOAL
//    content type is gone (400 "Unknown content type: GOAL"), so --goal is refused up front.
//  - plans run through /admin/plan-executions, not the chat stream (runPlan below, §A14)
import { capabilities } from './dialects.mjs';
import { HttpError } from './http.mjs';
import { sleep } from './util.mjs';

const ERROR_SIG = /timed out|HttpTimeout|Error: java/i;
const RUN_TIMEOUT = 300_000; // LLM runs regularly exceed the 60s default

export async function runPrompt(ctx, idOrGoal, {
  payload = {}, goal = false, provider, model, temperature, disableReasoning, version = null, application = null,
  maxChars = 2000, expect = null, onText = null, timeoutMs = RUN_TIMEOUT,
} = {}) {
  const { gateway } = ctx.clients ?? ctx.connect?.();
  if (goal || version != null) {
    const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
    if (goal && caps.goals === false) {
      throw new Error(`goals were removed in uxopian-ai 2026.0.0-ft5 (dialect ${dialect}) — run the prompt directly: uxc run <promptId>`);
    }
    if (version != null) {
      // strict: a bare `--prompt-version` parses as true, and Number(true) would silently pin v1
      if (!/^\d+$/.test(String(version)) || typeof version === 'boolean') throw new Error(`prompt version must be a non-negative integer, got "${version}"`);
      if (!caps.promptVersioning) {
        throw new Error(`a prompt version pin needs prompt versioning (uxopian-ai 2026.0.0-ft5+) — this gateway resolves to dialect ${dialect}`);
      }
      const v = await gateway.tryGet(`/api/v1/admin/prompts/${encodeURIComponent(idOrGoal)}/versions/${Number(version)}`);
      if (!v) throw new Error(`ai.prompt/${idOrGoal} has no version ${version} on this server (uxc get the prompt's versions in the admin UI)`);
    }
  }
  const t0 = Date.now();
  // ft5 Applications: X-Application-Id selects the calling application — its default provider/model,
  // system prompt and tool whitelist (verified to cross the FlowerDocs gateway plugin, §A15)
  const hdrs = application ? { headers: { 'X-Application-Id': String(application) } } : {};

  const attempt = async () => {
    const conv = await gateway.post('/api/v1/conversations', {}, hdrs);
    const qp = new URLSearchParams({ conversation: String(conv.id) });
    if (provider != null) qp.set('provider', String(provider));
    if (model != null) qp.set('model', String(model));
    if (temperature != null) qp.set('temperature', String(temperature));
    if (disableReasoning != null) qp.set('disableReasoning', String(disableReasoning));
    const body = {
      conversation: conv.id,
      inputs: [{ role: 'USER', content: [{
        type: goal ? 'GOAL' : 'PROMPT', value: idOrGoal, payload, ...(version != null ? { version: Number(version) } : {}),
      }] }],
    };
    let r;
    try {
      r = await gateway.req('POST', `/api/v1/requests/stream?${qp}`, body, { timeout: timeoutMs, ...hdrs });
    } catch (e) {
      if (/TimeoutError|aborted due to timeout/i.test(`${e?.name} ${e?.message}`)) {
        // ft5 can stop a streaming answer: cancel it server-side instead of letting it run on
        // (POST /conversations/{id}/stop, 200; older gateways lack it — best-effort)
        try { await gateway.post(`/api/v1/conversations/${encodeURIComponent(conv.id)}/stop`, undefined, hdrs); } catch { /* no stop endpoint */ }
      }
      throw e;
    }
    return parseStream(r.text, onText);
  };

  // an EMPTY answer is a failure too (classic: provider configured but the key is empty, §A5) —
  // retried once like the 200-body error signatures, then surfaced as an error, never as an answer
  const failed = (t) => ERROR_SIG.test(t.slice(0, 300)) || !t.trim();
  let text = await attempt();
  let error;
  if (failed(text)) {
    text = await attempt(); // one retry: gateway cold starts stream upstream failures as 200 bodies
    if (failed(text)) {
      error = text.trim()
        ? text.slice(0, 300).trim()
        : 'empty answer from the gateway — provider/key/model problem (verify end-to-end: uxc doctor --ai-smoke; a HANG usually means an empty provider key, §A5)';
    }
  }

  const res = {
    answer: text.length > maxChars ? text.slice(0, maxChars) : text,
    elapsedMs: Date.now() - t0,
    // expectation is tested on the FULL answer (the cap is display-only)
    pass: expect ? (expect instanceof RegExp ? expect : new RegExp(expect)).test(text) : null,
  };
  if (error) res.error = error;
  return res;
}

/**
 * Tolerant stream parse: SSE 'data:' frames OR raw text. Frames accumulate
 * content || text || delta.content || answer; '[DONE]' is skipped; a non-JSON data line is taken
 * verbatim. If NO frame yielded text, the whole blob is the answer (plain-text stream), after one
 * attempt to read it as a single JSON body.
 */
function parseStream(raw, onText) {
  const blob = String(raw ?? '');
  let acc = '';
  for (const line of blob.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const tr = line.slice(5).trim();
    if (!tr || tr === '[DONE]') continue;
    let piece;
    try {
      const o = JSON.parse(tr);
      piece = o.content ?? o.text ?? o.delta?.content ?? o.answer ?? '';
      if (typeof piece !== 'string') piece = '';
    } catch {
      piece = line.slice(5); // unparseable data line: keep its text
    }
    if (piece) {
      acc += piece;
      onText?.(piece);
    }
  }
  if (!acc.trim()) {
    let fallback = blob;
    try {
      const o = JSON.parse(blob);
      const v = o.content ?? o.text ?? o.delta?.content ?? o.answer;
      if (typeof v === 'string') fallback = v;
    } catch { /* plain text */ }
    acc = fallback;
    if (acc) onText?.(acc);
  }
  return acc;
}

const PLAN_DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const NODE_BAD = new Set(['FAILED', 'UNSATISFIED']);

/**
 * Run an ai.plan (uxopian-ai 2026.0.0-ft5+, AI learnings §A14): POST /admin/plan-executions/run
 * answers 202 with the execution and its node states; poll GET /admin/plan-executions/{id} until
 * COMPLETED / FAILED / CANCELLED. The engine validates the plan at SUBMIT time (400 "Plan is not
 * executable …", 404 unknown plan) — reported as status REJECTED. A run that outlives `timeoutMs`
 * is STOPPED (it would keep spending tokens) and reported as a timeout.
 * -> { executionId, status, answer, nodes:[{id,type,status,outputKey,output,error}], elapsedMs, pass, error? }
 *    answer = the output of the plan's final nodes (those nothing depends on); --expect is tested
 *    against the outputs of EVERY node.
 */
export async function runPlan(ctx, planId, {
  payload = {}, expect = null, maxChars = 2000, timeoutMs = RUN_TIMEOUT, pollMs = 2000, onProgress = null,
} = {}) {
  const { gateway } = ctx.clients ?? ctx.connect?.();
  const { caps, dialect } = await capabilities(ctx, 'uxopian-ai');
  if (!caps.agenticPlans) {
    throw new Error(`plans need uxopian-ai 2026.0.0-ft5+ (Agentic Plan engine) — this gateway resolves to dialect ${dialect}`);
  }
  const t0 = Date.now();
  const re = expect ? (expect instanceof RegExp ? expect : new RegExp(expect)) : null;

  const summarize = (exec, { timedOut = false } = {}) => {
    const all = exec?.nodeExecutions ?? [];
    const depended = new Set(all.flatMap((n) => n.dependencies ?? []));
    const cap = (s) => (s == null ? null : String(s).length > maxChars ? String(s).slice(0, maxChars) : String(s));
    const nodes = all.map((n) => ({
      id: n.nodeId, type: n.type, status: n.status, outputKey: n.outputKey ?? null,
      output: cap(n.outputData), ...(n.errorMessage ? { error: n.errorMessage } : {}),
    }));
    const finals = all.filter((n) => !depended.has(n.nodeId) && n.outputData != null);
    const full = all.map((n) => n.outputData).filter((x) => x != null).join('\n\n');
    const answer = finals.map((n) => String(n.outputData)).join('\n\n');
    const badText = all.filter((n) => NODE_BAD.has(n.status))
      .map((n) => `${n.nodeId}: ${n.status}${n.errorMessage ? ` — ${n.errorMessage}` : ''}`).join('; ');
    const status = timedOut ? 'TIMEOUT' : exec?.status ?? 'UNKNOWN';
    let error = null;
    if (timedOut) error = `still ${exec?.status ?? 'running'} after ${Math.round(timeoutMs / 1000)}s — execution stopped`;
    else if (status !== 'COMPLETED') error = exec?.failureReason || badText || status;
    else if (badText) error = badText; // e.g. a node whose successCriteria was not met (UNSATISFIED)
    return {
      executionId: exec?.id ?? null, status,
      answer: answer.length > maxChars ? answer.slice(0, maxChars) : answer,
      nodes, elapsedMs: Date.now() - t0,
      pass: re ? (!error && re.test(full)) : null,
      ...(error ? { error } : {}),
    };
  };

  let exec;
  try {
    exec = await gateway.post('/api/v1/admin/plan-executions/run', { planId, inputPayload: payload });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 404)) {
      return {
        executionId: null, status: 'REJECTED', answer: '', nodes: [], elapsedMs: Date.now() - t0,
        pass: re ? false : null, error: e.body?.message ?? e.message,
      };
    }
    throw e;
  }
  if (!exec?.id) throw new Error(`plan-executions/run returned no execution id for ${planId}`);
  const path = `/api/v1/admin/plan-executions/${encodeURIComponent(exec.id)}`;
  let last = '';
  while (!PLAN_DONE.has(exec?.status)) {
    if (Date.now() - t0 > timeoutMs) {
      try { await gateway.post(`${path}/stop`, {}); } catch { /* best-effort: report the timeout anyway */ }
      return summarize(exec, { timedOut: true });
    }
    await sleep(pollMs);
    exec = (await gateway.get(path)) ?? exec;
    const progress = (exec?.nodeExecutions ?? []).map((n) => `${n.nodeId}:${n.status}`).join(' ');
    if (progress !== last) { onProgress?.(progress); last = progress; }
  }
  return summarize(exec);
}
