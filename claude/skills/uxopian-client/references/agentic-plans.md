# Agentic plans: read this before building one (uxopian-ai 2026.0.0-ft5+)

Every point below was verified live on fd.demo in 2026-09. The full detail and measurements are in
`docs/UXOPIAN-AI-LEARNINGS.md`: §A13 CRUD, §A14 runs, §A15 applications and tools, §A16 mechanics and
recommendations, §A17 building a reproducible plan (the negotiation war-room).

## Start from a working example
- `examples/agentic-portfolio`: read, then a SUBPLAN fan-out, then parallel specialist writers. It includes a
  finder agent and a chat Application. `uxc push --all` · `uxc run --plan … --json` · `uxc destroy --confirm pfr`.
- `examples/ct-package` (private): `ctNegotiationWarRoom` is a reproducible design that builds on data already
  stored in FlowerDocs.

## The traps that cost the most time
1. **`[[${x}]]` HTML-escapes payloads.** `'`, `"`, `<` and `&` reach the model as entities and leak into answers.
   Use **`[(${x})]`** for document text and JSON.
2. **Declare every variable a root node's prompt reads in `toolInputParameters`.** The payload alone isn't enough:
   the run is refused with 400 "Plan is not executable". `uxc verify` lints this.
3. **DIRECT_TOOL arguments are strings.** `extractDocumentText`, `getDocumentProperties` and `chunkText` chain
   fine. The search builders (criteria lists) don't, so give search to an agent (~24 k tokens per search).
4. **One failed fan-out element fails the whole run, and nothing retries it.** That covers a transient provider
   error, an invented id (the Core returns 500), or an agent reporting itself "unmet" even without
   `successCriteria`. The prompt must say that returning the object IS success. Serialize heavy runs and retry
   the run.
5. **LLM reducers miscount and drop rows, and `successCriteria` is self-assessed.** Never ask an LLM for counts or
   complete lists. Pass the fan-out output through a DIRECT_TOOL `chunkText` leaf and compute exact numbers from
   it.
6. **Several terminal nodes return a JSON object keyed by `outputKey`.** That holds as a sub-plan output and as a
   chat tool result, so never add an LLM "assembler" (one dropped a section and took 40% of the run time).
7. **Free LLM judgement over raw text isn't reproducible** (5/9 identical verdicts across two runs). Anchor it on
   data FlowerDocs already stores (clause maps, clause documents, assessments): 22/22.
8. **`Application.prompt` had no effect** on REST chat through the FlowerDocs gateway (0 extra tokens). Put
   "how to use this tool" guidance in the plan's **`toolDescription`**.
9. **File exports (`writeExcelAndGetLink`/CSV) only work in chat.** Inside a plan they fail with "Conversation ID
   cannot be null".
10. **Pause and stop only act between nodes.** A stop inside a long node ends the run FAILED (the docs say
    CANCELLED).

## Useful facts
- **Fan-out:** `listKey` accepts a JSON array, a JSON-array string, or an upstream output (including another
  fan-out). Each element is `[[${item}]]`. Default parallelism is 8; lists are capped at 200 and nesting depth at 5.
  A DIRECT_TOOL node can fan out too.
- **Visibility:** a node sees the plan inputs, its DIRECT dependencies' outputs, and `persistOutput` nodes.
  Sub-plans get parent payload values they declare.
- **Models:** each agent's model is its objective prompt's `defaultLlmModel`. Tier them: gpt-4o-mini to map,
  gpt-4o to judge and reduce.
- **Chat:** an Application with `permissions.allowedSubPlans` plus `X-Application-Id` lets the assistant call an
  `exposeAsTool` plan. Streams may arrive as raw text without `data:` frames.
- **Built-in prompts:** `summarizeChunkFacts` and `summarizeCombine` for long-document map-reduce.
- **Admin panel:** Plans offers a flow editor, **Run**, and a **Runs** tab (tokens, tool calls, Pause/Resume/Stop).
