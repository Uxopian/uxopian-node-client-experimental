// Gateway run mechanics (DESIGN §14, learnings §8 + verified SSE quirks):
//  - non-stream POST /requests 404s on the external path -> ALWAYS /requests/stream?conversation=
//  - the stream may be SSE 'data:'-framed OR plain raw text (no framing at all) — parse tolerantly
//  - upstream failures arrive as 200 BODIES (/timed out|HttpTimeout|Error: java/) -> ONE cold-start
//    retry, then report the error instead of rendering it as the answer
//  - LLM override goes in QUERY PARAMS (provider/model/temperature/disableReasoning)
//  - the payload rides INSIDE inputs[0].content[0].payload; --goal switches type PROMPT -> GOAL

const ERROR_SIG = /timed out|HttpTimeout|Error: java/i;
const RUN_TIMEOUT = 300_000; // LLM runs regularly exceed the 60s default

export async function runPrompt(ctx, idOrGoal, {
  payload = {}, goal = false, provider, model, temperature, disableReasoning,
  maxChars = 2000, expect = null, onText = null, timeoutMs = RUN_TIMEOUT,
} = {}) {
  const { gateway } = ctx.clients ?? ctx.connect?.();
  const t0 = Date.now();

  const attempt = async () => {
    const conv = await gateway.post('/api/v1/conversations', {});
    const qp = new URLSearchParams({ conversation: String(conv.id) });
    if (provider != null) qp.set('provider', String(provider));
    if (model != null) qp.set('model', String(model));
    if (temperature != null) qp.set('temperature', String(temperature));
    if (disableReasoning != null) qp.set('disableReasoning', String(disableReasoning));
    const body = {
      conversation: conv.id,
      inputs: [{ role: 'USER', content: [{ type: goal ? 'GOAL' : 'PROMPT', value: idOrGoal, payload }] }],
    };
    const r = await gateway.req('POST', `/api/v1/requests/stream?${qp}`, body, { timeout: timeoutMs });
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
