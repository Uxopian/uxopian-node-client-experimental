// The error knowledge base: every code/signature met in the field, its meaning, and the next move.
// Sources: FLOWERDOCS-LEARNINGS.md §1-§17 + the Ct build log. Auto-appended to failures.

const KB = [
  ['F00903', 'Resource already exists — create is NOT an upsert. Update in place instead: POST <type>/{id} with an ARRAY body (id in path).'],
  ['T00104', "Search engine couldn't run that request. Known causes: orderClauses on an INT tag (order by STRING or system creationDate TIMESTAMP), nested FieldAggregation inside a search, a criterion with type:null (always set \"type\":\"STRING\"), or lowercase 'creationdate' (use camelCase creationDate)."],
  ['F00032', 'Tag not allowed: the tag is not declared in the class tagReferences. Declare it on the (once-created) class — for taskclasses that means a NEW class id.'],
  ['F00033', 'A mandatory tag is missing at create. Either pass it, or relax mandatory:false via documentclass full-replace.'],
  ['T00707', 'Temp file ref already consumed — a FAILED create eats the tmp id. Check existence BEFORE uploading; upload a fresh tmp per attempt.'],
  ['T00108', 'Id still occupied (deleted task ids stay burned). Mint unique ids (suffix timestamp) instead of reusing.'],
  ['F00013', 'creationDate is later than server time. Use a safely-past timestamp (uxc generates now-1h).'],
  ['F00204', 'Class create needs top-level category ("DOCUMENT"/"TASK") and active:true.'],
  ['F00206', "Class not found — note this is how class GETs signal absence (500 F00206, NOT a 404)."],
  ['F00208', 'Class create needs data.ACL referencing a valid security object (e.g. "acl-readonly") — null ACL is rejected.'],
  ['F00414', 'Task class does not accept attachments — they cannot be declared via REST. Carry the linked doc id in a task TAG instead.'],
  ['F00903 taskclass', 'NEVER delete/recreate a taskclass to change it — that breaks ANSWER dispatch permanently. Mint a NEW class id.'],
  ['Function calling cannot be required when reasoning is disabled', 'The prompt has requiresFunctionCallingModel:true but reasoningDisabled is absent (Java default = true). Set reasoningDisabled:false EXPLICITLY.'],
  ['Configuration not found with id', 'That LLM provider is not configured on this instance. Check `uxc ls ai.llm` (and `uxc push` the provider conf); pin the prompt to a configured provider (e.g. openai/gpt-4o).'],
  ['Merge strategy is not set', 'prompts.yml tenants[] entries must set mergeStrategy (overwrite|merge|createIfMissing) or the server refuses to start.'],
  ['HttpTimeout', 'Gateway streamed an UPSTREAM failure as a 200 body (LLM/tool timeout). Retry once (cold start), then check the prompt/provider.'],
  ['Error: java', 'Gateway error-as-body: upstream exceptions stream as 200-status text, not HTTP errors. Treat as failure, retry once.'],
  ['unresolved Thymeleaf', 'Goals 400 on unresolved [[${var}]] variables. Run as a direct PROMPT input with a full payload instead of a GOAL.'],
];

export function explainError(text) {
  const t = String(text ?? '');
  for (const [sig, expl] of KB) if (t.includes(sig)) return expl;
  return null;
}

export function explainCode(code) {
  const c = String(code ?? '').trim();
  const hits = KB.filter(([sig]) => sig.toLowerCase().includes(c.toLowerCase()));
  return hits.map(([sig, expl]) => ({ signature: sig, explanation: expl }));
}

export const KB_ENTRIES = KB.map(([signature, explanation]) => ({ signature, explanation }));

// Standing facts surfaced contextually by commands (not error-triggered):
export const FOOTNOTES = {
  taskStatus: 'note: answered tasks still show status NEW in search rows — status does not distinguish answered tasks.',
  handlerWindow: (secLeft) => `handler activation window: events in the next ~${secLeft}s may be MISSED entirely (no retro-fire).`,
  cachePending: 'a cache clear is still pending from a previous run — run `uxc cache-clear`.',
};
