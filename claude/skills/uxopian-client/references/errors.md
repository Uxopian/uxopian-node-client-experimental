# Error knowledge base

`uxc explain <CODE|text>` looks these up; every uxc failure auto-appends the matching
explanation. This table mirrors `lib/explain.mjs` — if you learn a new one, add it THERE
(the file is the source of truth), then here.

| Signature | Meaning → next move |
|---|---|
| `F00903` | Resource already exists — create is NOT an upsert. Update in place: `POST <type>/{id}` with an ARRAY body (id in path). uxc push does this automatically. |
| `F00903` on a taskclass | NEVER delete/recreate a taskclass to change it — breaks ANSWER dispatch permanently. Mint a NEW class id. |
| `T00104` | Search engine couldn't run the request. Causes: orderClause on an INT tag (order by a STRING tag or system `creationDate` TIMESTAMP); nested FieldAggregation inside a search; a criterion with `type:null` (always set `"type":"STRING"`); lowercase `creationdate` (must be camelCase). |
| `F00032` | Tag not declared in the class tagReferences. Declare it on the class — for a taskclass that means a NEW class id. Hits handler marker tags too. |
| `F00033` | Mandatory tag missing at create. Pass it, or relax `mandatory:false` via documentclass full-replace (push the edited local class). |
| `T00707` | Tmp file ref already consumed — a FAILED create eats the tmp id. Exists-check BEFORE upload; fresh tmp per attempt. uxc's upsert does this; seeing it means a hand-rolled call. |
| `T00108` | Id still occupied (deleted task ids stay burned forever). Mint unique ids (timestamp suffix); never reuse. |
| `F00013` | `creationDate` later than server time. Use a safely-past timestamp (uxc generates now-1h). |
| `F00204` | Class create needs top-level `category` ("DOCUMENT"/"TASK") and `active:true`. |
| `F00414` | Taskclass attachments are not REST-declarable (the DTO silently drops every attachment field). Carry the linked doc id in a task TAG instead. |
| `Function calling cannot be required when reasoning is disabled` | Prompt has `requiresFunctionCallingModel:true` but `reasoningDisabled` is absent (Java default = true). Set `reasoningDisabled:false` EXPLICITLY. |
| `Configuration not found with id: X` | LLM provider X not configured on this instance. `uxc ls ai.llm` (and `uxc push` the provider conf); pin the prompt to a configured provider (e.g. openai/gpt-4o). |
| `Merge strategy is not set` | `prompts.yml` tenants[] entries must set `mergeStrategy` (overwrite\|merge\|createIfMissing) or the ai server refuses to start. |
| `HttpTimeout` / `request timed out` | Gateway streamed an UPSTREAM failure as a 200 body (LLM/tool timeout). Retry once (cold start), then check prompt/provider. |
| `Error: java…` in an "answer" | Gateway error-as-body: upstream exceptions stream as 200-status TEXT, not HTTP errors. Treat as failure, retry once. uxc run detects + retries automatically. |
| 400 with unresolved `[[${var}]]` | Goal run with unresolved Thymeleaf variables. Run as a direct PROMPT input with a full payload instead of a GOAL. |

## Gateway stream quirks (uxc run handles all of these — know them for diagnosis)

- Non-stream `POST /api/v1/requests` **404s on the external path** — runs always go through
  `POST /api/v1/requests/stream?conversation=<id>` after `POST /api/v1/conversations {}`.
  (Server-side Graal handlers CAN use the non-stream path — different route.)
- The stream may be SSE `data:`-framed OR **plain raw text with no framing at all**. The parser
  accumulates `content || text || delta.content || answer`, skips `[DONE]`, and falls back to
  the whole blob as the answer.
- **Errors arrive as 200 bodies** (signature `/timed out|HttpTimeout|Error: java/` in the first
  300 chars). uxc retries ONCE (cold start), then reports `error` instead of an answer.
- LLM overrides ride in QUERY PARAMS (`provider`, `model`, `temperature`, `disableReasoning`),
  not the body.
- `--expect` is tested against the FULL answer; `--max-chars` (default 2000) caps display only.

## Standing footnotes (not errors — surprising truths)

- Answered tasks still show `status: NEW` in search rows — status does NOT distinguish answered
  tasks; never build worklist filters on it. (`uxc task ls` footnotes this.)
- Re-answering an already-answered task returns 200 but does NOT dispatch ANSWER handlers —
  always smoke-test on fresh tasks.
- `GET /api/v1/admin/prompts` 500s on this server version — uxc lists prompts via the user
  endpoint; not an auth problem, don't debug it.
- Search rows DO carry a top-level `id` per result (alongside `fields[]`) for documents AND tasks.
- A `pendingCacheClear` line in `uxc status` means a previous run's clear never completed —
  run `uxc cache-clear`.
