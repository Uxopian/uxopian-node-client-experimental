# UXOPIAN-AI-LEARNINGS — verified gateway mechanics

Same contract as [FLOWERDOCS-LEARNINGS.md](./FLOWERDOCS-LEARNINGS.md): every entry was VERIFIED
live before being written; never guess an API shape — prove it on a throwaway object, then append
here (numbered §, date, instance). One file per product (`FAST2-LEARNINGS.md` will follow when
fast2 support lands). Historical note: early uxopian-ai findings were recorded inside the
FlowerDocs file — cross-references below point at them; NEW uxopian-ai findings belong HERE.

## §A1 — Surface + auth
- Gateway base: `https://<host>/gui/plugins/<SCOPE>/gateway/uxopian-ai` (the `/gui/gateway/…`
  no-plugin form also routes on 2026-07 builds). Auth = the FlowerDocs Core JWT in the `token:`
  header (FD §, live-verified 2026-06-12). Single JSON objects (no array wrapping, unlike Core).
- The gateway 404s until Uxopian-AI is provisioned for the scope — a SEPARATE product layer, NOT
  in flower-templates (FD §23).

## §A2 — Versioning: NO version surface (as of the 2026-07 build — still true on 2026.0.0-ft5)
- `/actuator` exposes links but `info` is EMPTY `{}` and `health` is 401; no `/api/v1/version`.
  uxc resolves the dialect by CAPABILITY FINGERPRINT: `GET /api/v1/admin/prompts` → 200-array on
  2026-07+ builds, 500 on 2025-era (FD §25); on ft5 its rows carry a `version` number (§A11).
  Ask the AI team to populate actuator info.
- Releases are MONTHLY and the API may still change pre-GA — uxc absorbs differences via
  `lib/dialects.mjs` capability flags + per-kind write strategies (DESIGN §18). Product versions
  are `2026.0.0-ftN` (ft2 Feb, ft3 Apr, ft4 Jun, ft5 Aug 2026); the "2026-07 build" of §A3-§A10 is
  ft4. Dialects: `ai-2025` < `2026.0.0-ft1` ≤ `ai-2026-07` < `2026.0.0-ft5` ≤ `ai-2026-ft5`.

## §A3 — Prompts
- READ: the **user list** `GET /api/v1/prompts` can be a REDUCED projection (id + content only —
  FD §8/§17); the **admin list** `GET /api/v1/admin/prompts` 500'd on 2025-era gateways but
  returns FULL objects on 2026-07+ (role, defaultLlmProvider/Model, temperature, flags, audit
  fields). uxc reads the admin list when the dialect allows, else user list + local-meta overlay.
- WRITE (`admin-v1` strategy, ≤ ft4): `POST /api/v1/admin/prompts` (object body), on 409 → `PUT`
  same path; updates = `PUT` with **id in the BODY, not the path** (ft5 replaced this — §A11).
  Content is verbatim (templating helpers `[[${service.method(…)}]]` lintable against
  `GET /api/v1/admin/templating/completion`).
- Canonical strips: `temperature` normalizes to a string; `role` echoes lowercase; audit fields
  (`createdAt/createdBy/updatedAt/updatedBy`, null `displaySettings`) dropped.
- `requiresFunctionCallingModel: true` REQUIRES explicit `reasoningDisabled: false` (Java default
  true → "Function calling cannot be required when reasoning is disabled").
- Duplicate-proofing: exists-check FIRST, then a post-create assertion that the list holds
  exactly ONE entry with the id — a duplicating (versioning) gateway fails loudly (FD §25).

## §A4 — Goals (REMOVED in 2026.0.0-ft5 — §A12)
- `GET/POST /api/v1/admin/goals`; a goal row's natural key is **(goalName, promptId, filter)**;
  the server row id is PER-TARGET (state, not content). Only rows whose promptId belongs to the
  package are ever touched by uxc.

## §A5 — MCP + LLM provider configurations (secrets)
- MCP confs: CRUD `/api/v1/admin/mcp/mcp-conf[/{id}]`, hot-reload server-side.
- LLM provider confs: CRUD `/api/v1/admin/llm/provider-conf[/{id}]`; a conf =
  `{id/provider, defaultLlmModelConfName, globalConf:{apiSecret,…}, llModelConfs:[…]}`.
- SECRET MASKING (both kinds): the server echoes secrets as `********` (8+ asterisks) → uxc
  normalizes to `__masked__` locally (never a real key in a package); on push the placeholder
  resolves to the LIVE server value; a fresh keyless install ships an EMPTY `apiSecret`
  (operator sets it). Provider ids are GLOBAL (`openai`, `mistral-ai`) — never project-prefixed.
- No/empty provider conf ⇒ every AI call (smart upload step 1, prompt runs) HANGS rather than
  erroring — a wizard "stuck on the first step" means: check `uxc ls ai.llm` and the API key.

## §A6 — Running prompts / goals
- `POST /api/v1/conversations` then `POST /api/v1/conversations/{id}/requests/stream`; responses
  stream as SSE `data:` frames OR raw text (accumulate `content||text||delta.content||answer`,
  skip `[DONE]`); errors can arrive AS BODY TEXT (`timed out`, `Error: java…`) — uxc retries once
  on cold-start signatures. LLM pin via query params (provider/model/temperature).

## §A7 — Installation receipts (uxc convention on this surface)
- uxc records deployed packages as an inert SYSTEM prompt `uxcPkg<Code>` whose content is the
  receipt JSON (`uxc-package-receipt/1`) — admin-visible by design; goals must never reference it
  (DESIGN §19).

## §A8 — Quick Prompt panel display semantics (displaySettings)
- The FlowerDocs-embedded Quick Prompt panel (web component served by the gateway at
  `/api/web-components/quick-prompt/script`; wired by the uxoai-flowerdocs scripts) lists prompts
  from `GET /prompts/display` and filters CLIENT-SIDE:
  `displaySettings?.enabled !== false && eval(displaySettings?.displayConditions)`, sorted by
  `displaySettings?.priority` (verified 2026-07-10 by reading the bundle on fd.demo).
- **A prompt with NO `displaySettings` is therefore SHOWN, unconditionally** — pipeline/internal
  prompts leak into the assistant view unless every prompt that is not meant for the panel
  carries an explicit `displaySettings: { "enabled": false }`.
- `displaySettings` fields: `enabled`, `label`, `description` (markdown), `displayConditions`
  (JS expression over `{documents, tasks, folders, user, …}` context), `priority` (asc sort),
  `categoryId` (panel grouping), `aiReferenceInfo` (info tooltip). Hiding a prompt does NOT
  affect invocation by id (goals, scripts, `uxc run` still work).
- uxc consequences (2026-07-10): `uxc add ai.prompt` scaffolds `{enabled:false}` by default,
  `--quick-prompt` scaffolds a panel-visible one; `writeAiReceipt` ships receipts hidden (§A7).
  Existing packages must add the block to each prompt JSON themselves (ct + po done 2026-07-10).

## §A9 — Stream stalls are PROMPT-SHAPED: `extractTextualContent` is the slow leg (verified fd.demo/IRIS, 2026-07-11)

- `/api/v1/requests/stream` responses for **payload-only prompts** (all variables carried in the
  request payload) return in seconds — verified with ctGenSampleClauses (~5 s), ctIngestOutline,
  ctVerdict.
- Prompts whose template calls **`[[${flowerDocsService.extractTextualContent(documentId)}]]`**
  can stall the SAME endpoint for **minutes** (> 300 s observed, plain-text 2-page doc, mime
  text/plain — mime is NOT the cause): the chat-side extraction service is the slow leg. This is
  the root of the earlier "uxc run may hang" note in FLOWERDOCS-LEARNINGS §34 — it is not random,
  it keys on the prompt's use of document extraction.
- uxc buffers the whole stream (fetch): a stalled stream surfaces as
  `The operation was aborted due to timeout` (AbortSignal), NOT as a gateway error body.
- Consequences: (a) smoke tests should exercise payload-only prompts — the extraction leg is
  better proven by handler-side (in-JVM) pipelines or the assistant UI; (b) when a user reports
  "the prompt hangs", first ask whether its template extracts document content; (c) server-side
  `callPrompt` from handlers is unaffected (handlers extract text themselves in-JVM precisely to
  bypass this — see ct-ingest.js "approach B").

## §A10 — Admin prompt echoes project displaySettings VERBOSELY (incl. `aiReferenceInfo`, 2026-07 build) (verified fd.demo/IRIS, 2026-07-16)

- `GET /api/v1/admin/prompts` echoes `displaySettings` fully projected: unset keys as `null`
  (categoryId, description, displayConditions, label), `priority: 0`, and — new in the 2026-07
  gateway — **`aiReferenceInfo: false`**. A terse hand-authored `{"enabled": false}` is the SAME
  configuration.
- uxc ≥ 0.13.1 canonicalization strips those DEFAULTS symmetrically (null keys, priority 0,
  aiReferenceInfo false; a displaySettings that empties out is dropped) so hand-authored
  packages don't show phantom drift against 2026-07+ gateways. Real values (enabled flags,
  labels, non-zero priority, aiReferenceInfo:true) survive and still diff.
- The USER list `GET /api/v1/prompts` can be a reduced projection (id+content only — §A2/§A6
  family): the ai-prompt adapter overlays it on local meta; the ADMIN list is the full read.

## §A11 — 2026.0.0-ft5: prompts are VERSION HISTORIES (verified fd.demo/IRIS, 2026-09-16)

- The gateway is self-describing: **`GET /v3/api-docs`** (through the FlowerDocs plugin path, JWT
  `token:` header) returns the full OpenAPI 3.1 spec. Read it before guessing a new endpoint.
- `GET /api/v1/admin/prompts/{id}` → `{id, versions:[…], createdAt, createdBy, updatedAt, updatedBy}`
  (the old flat object is gone). Each snapshot: the prompt fields + `version` (0 = baseline) and
  `draft` (true on THE open draft; absent on v0, `false` once a later version was published).
- **Create**: `POST /api/v1/admin/prompts` → **201**, echo WITHOUT `version`; an existing id → **409**
  `CONFLICT "Prompt with id 'x' already exists"`.
- **The bare `PUT /api/v1/admin/prompts` answers 500 INTERNAL_ERROR** (not 404/405) — a pre-0.18
  uxc fails opaquely on every prompt UPDATE against ft5.
- **Update** = `POST …/prompts/{id}/versions` with a FULL snapshot body → **201**
  `{…, id, version: n+1, draft: true}`; a second draft → **409** `"A draft already exists … Publish or
  discard it"`; an empty body → 400 `Prompt role is empty`. Then `PUT …/versions/{n}` with the full
  body + `draft:false` → **200**: the body REPLACES the draft AND publishes it in one call.
  `PUT` on a published version → **409** `"is published and read-only. Edit the draft instead."`;
  unknown version → 404. `DELETE …/versions/{n}` discards the draft (409 on a published one).
- The ADMIN list serves each prompt's ACTIVE (highest published) version, now with `version`,
  `draft` and `usage {deletable, basePrompt, referencedBy[]}` — an open draft is invisible there.
  The USER list `GET /api/v1/prompts` is `{id, content}` of the served version.
- Runs: `inputs[].content[].version` pins a version (null = served). The request history
  (`GET /api/v1/requests?conversation=`) records the resolved `promptId`, `version` and the
  RENDERED `value`. **An absent version is NOT an error**: the request goes out with an empty prompt
  and the LLM answers nonsense — check `GET …/versions/{n}` first. `type` is case-insensitive
  (`PROMPT` still works).
- A prompt created without provider/model echoes `temperature: "1"` (default) and no
  `defaultLlm*` keys.
- Statistics: `GET …/{id}/statistics` (all versions) and `GET …/{id}/versions/{n}/statistics` →
  `{nbUsage, totalCost, costAverage, good/bad/neutralFeedback, timeSavedInSeconds}`. They answer
  **200 with zeros for ANY id or version, even absent ones** — never an existence check. Requests
  made before the ft5 upgrade count in the prompt-wide aggregate only (ctAssessBatch: 200 uses
  overall, 0 on v0). `uxc versions <id> [--stats]` shows the history (served/draft/published,
  `= local`) read-only.
- uxc (0.18.0): dialect `ai-2026-ft5`, strategy `versioned-v1` — an open draft is REUSED only when it
  equals the package content (a push that died between POST and PUT) or the served version (opened,
  never edited); a draft carrying other edits (someone in the admin UI) is REFUSED unless
  `push --force`. Canonical drops `version`/`draft`/`usage`. Receipts go through the same strategy
  (each receipt write publishes a version).

## §A12 — 2026.0.0-ft5: goals REMOVED (verified fd.demo/IRIS, 2026-09-16)

- `GET /api/v1/admin/goals` → **404** `RESOURCE_NOT_FOUND`; a request content `type: GOAL` → **400**
  `"Unknown content type: GOAL"` (Content.type enum is now `text|prompt|image`).
- uxc: dialect cap `goals:false` → every `ai.goal` resource classifies **`unsupported`** (status,
  pull, push, verify skip it with the reason; exit code unaffected) so ONE package still deploys
  its goals on ≤ ft4 and everything else on ft5. `uxc run --goal` is refused up front.

## §A13 — 2026.0.0-ft5: Agentic Plan engine — agents + plans CRUD (verified fd.demo/IRIS, 2026-09-16)

- Agents: CRUD `/api/v1/admin/agent/agent-conf[/{id}]`; plans: `/api/v1/admin/plans[/{id}]`.
  Create **201 with an EMPTY body**; an existing id → **400** `"… already exists for id"` (NOT 409);
  `PUT /{id}` → 200 empty, **FULL replace** (a field left out comes back null; id in path suffices);
  `DELETE` → 204, 404 when absent. Client-supplied ids are honored.
- Ids may not hold whitespace, control characters, `/` or `\` (400 "contains an illegal character").
- **No referential integrity**: an agent whose `objective` prompt does not exist → 201; a plan
  node naming a missing agent → 201; deleting an agent a plan uses → 204. Failures surface only
  when the plan RUNS. uxc lints references offline (`lintAgentic`, warnings).
- Plan save-time validation exists for cycles: `400 "Invalid plan: Circular dependency detected
  involving node: a"`.
- Echo projection: every unset field as `null`; agents add `permissions {allowAllTools:false,
  allowAllMcpServers:false, …null}` even when none was sent, `createdBy`/`updatedAt`/`updatedBy`
  null (audit bug); plans add `exposeAsTool:false` and per node `persistOutput:false`,
  `dependencies:[]`. An `allowedTools: []` sent echoes `[]` (kept distinct from absent).
- Agent `secrets {NAME:{value, description}}`: value echoes `********`; a PUT sending `********`
  is accepted and keeps the stored secret (same contract as MCP/LLM confs, §A5).
- uxc kinds `ai.agent` (`ai/agents/<id>.json`) and `ai.plan` (`ai/plans/<id>.json`), cap
  `agenticPlans`, push order after ai.prompt/ai.mcp; `uxc ls ai.tool` lists native tool names.

## §A14 — 2026.0.0-ft5: running plans (verified fd.demo/IRIS, 2026-09-16)

- `POST /api/v1/admin/plan-executions/run {planId, inputPayload}` → **202** with the execution
  (`status RUNNING`, `nodeExecutions[]` snapshot, `tenantId`, `roles`); poll
  `GET /api/v1/admin/plan-executions/{id}` → `status COMPLETED|FAILED|CANCELLED`, per node `status`,
  `outputData`, `errorMessage`, `toolCalls`, tokens. A one-node gpt-4o agent completed in ~2.5 s.
  `DELETE /{id}` → 204; `POST /{id}/stop|pause|resume` exist.
- **Static validation at SUBMIT**: a node's prompt variable must be provided by a dependency's
  `outputKey`, a `persistOutput:true` node, or the plan's **`toolInputParameters`** (the declared
  initial payload) — `inputPayload` alone is NOT enough: `400 "Plan is not executable: Node 'ask'
  (agent: 'x'): prompt references variable 'word' which is not provided by any dependency …"`.
  Unknown plan → 404.
- An AGENT node runs its agent's `objective` prompt with the payload variables; an unmet
  `successCriteria` marks the node **`UNSATISFIED`** (with the agent's reason in `errorMessage`)
  and the execution **`FAILED`**.
- uxc: `uxc run --plan <id> --payload k=v [--expect re]` (lib `runPlan`) — REJECTED on a 400/404
  submit, STOPS the execution on timeout, `--expect` over every node output.

## §A15 — 2026.0.0-ft5: Applications, native tools, stop (verified fd.demo/IRIS, 2026-09-16)

- Applications: CRUD `/api/v1/admin/application/application-conf[/{id}]`; create **201** empty;
  an existing name → **409** `"Application already exists for name"`; `PUT /{id}` full replace.
  **The id is DERIVED from `name`** — a client `id` that differs is silently ignored. `provider`
  was NOT enforced by the API (a provider-less app saved). The gateway auto-creates one app per
  connection provider (IRIS: `default`, `FlowerDocs` with `allowAllMcpServers:true`,
  `allowedToolTags [flowerdocs, files, interaction]`).
- **`X-Application-Id` crosses the FlowerDocs gateway plugin**: the same provider-less prompt ran
  on gpt-5.1 (system default) without the header and on the app's `gpt-4o-mini` with it.
- A prompt an application references: `GET /prompts/{id}/usage` → `{deletable:false,
  referencedBy:[app]}`, `DELETE` → **409** `"Prompt 'x' is referenced by application(s): [app]"`.
  **The reference OUTLIVES the application by ~2 s**: deleting the app then the prompt immediately
  → one 409, then 204. uxc's prompt remove retries (4 × 1.5 s).
- `GET /api/v1/admin/tools` → 51 native tools `{name, description, params[], tags[]}` tagged
  `alfresco|flowerdocs|filenet|interaction|text|files` — push warns on unknown tool names/tags in
  agent/application permissions and DIRECT_TOOL nodes.
- `POST /api/v1/conversations/{id}/stop` → 200 (even idle) — uxc stops the conversation when a
  prompt run times out.
- Conversation listing pages with `offset`/`limit`/`orderBy`/`ascending` (not page/size); titles
  are LLM-generated from the first answer.

## §A16 — Agentic plans in practice: verified mechanics (fd.demo/IRIS, gpt-4o, 2026-09-16)

Probed with throwaway `zz*` plans over the 15 `CtContract` documents of IRIS (#69). Timings are
wall-clock from `uxc run --plan`-style polling; tokens are the node's `inputTokens/outputTokens`.

**Payload & wiring**
- `DIRECT_TOOL` nodes call a native tool with NO LLM (0 tokens): `toolArgumentBindings`
  `{toolArg: payloadKey}`. **Payload values are passed as STRINGS** — tools whose argument is a
  string chain fine (`extractDocumentText {documentId}` ~1.5–3 s, `chunkText {content}` 5 ms), but
  a tool expecting structured JSON (`buildAndClause {criteria: [Criterion]}`) fails:
  `Cannot deserialize value of type ArrayList<Criterion> from String value`. The FlowerDocs
  search tools therefore can NOT be chained as DIRECT_TOOLs — use an agent for search. (Correction, §A18: `doSearch`
  DOES run as a DIRECT_TOOL when its `filters` value is real JSON in the run payload; only strings fail.)
- `chunkText` returns a JSON array string (a 6.7 k-char contract = 1 chunk) — directly usable as a
  `listKey`.
- A node sees: the plan inputs (`toolInputParameters`), the `outputKey` of its DIRECT
  dependencies, and the `outputKey` of any `persistOutput:true` node — nothing transitive. The
  submit-time 400 lists exactly what is available: `Available outputKeys from dependencies:
  [outB, seed]`.

**Fan-out (`listKey`)**
- The list can be a real JSON array in `inputPayload`, a JSON-array STRING, or the output of an
  upstream node (DIRECT_TOOL `chunkText`, an agent returning `["a","b"]`, or another fan-out —
  a fan-out's output IS a JSON array of its per-element outputs, so fan-outs chain).
- Each element reaches the node as `[[${item}]]`; for a `SUBPLAN` node the sub-plan receives
  `item` in its payload and must declare `toolInputParameters: [{name: "item"}]`.
- Parallelism is real: 15 trivial elements 2.4 s; 3 contract reads+extractions 6.4 s vs 3.3 s
  for one. Tokens and `toolCalls` of all elements are AGGREGATED on the parent node.
- **One failed element fails the whole node and the plan** (`Failed elements: [1] Sub-plan … [read]
  Error: Failed to get document info for ID: Id{value=NO-SUCH-DOC}`) — no partial output is
  exposed. Clean the list upstream; don't put a `successCriteria` gate inside a fan-out unless
  one bad element SHOULD sink the batch.

**Agents**
- An agent runs its objective prompt with the payload variables; `permissions.allowedTools`
  lets it call FlowerDocs tools itself (the `toolCalls` trace names them). A finder agent with
  `buildCriterionClass, buildAndClause, doSearch` returned the 15 contract ids as a clean JSON
  array in 9 s — but **24 k input tokens** (search results are fed back to the model).
- A tool-using agent's output inside a fan-out came back wrapped in an envelope
  `{"status":"SUCCESS","output":"…","reason":null}` (sometimes nested twice); tool-less agents
  return plain text. Prefer DIRECT_TOOL reads + tool-less agents inside fan-outs.
- File tools (`writeExcelAndGetLink`, `writeCsvAndGetLink`) FAIL as plan DIRECT_TOOLs:
  `Conversation ID cannot be null or empty` — they only work in a chat conversation.

**Control**
- `pause`/`stop` are cooperative and read at node FRONTIERS: pausing during one long fan-out
  node leaves the run `RUNNING` (controlSignal `PAUSE`; `resume` → 409 "Only a PAUSED execution
  can be resumed"); `stop` mid-node ended the run **`FAILED`**, node output empty — the product
  docs say stop → `CANCELLED` (observed on fd.demo ft5: FAILED; don't branch on the distinction).
- Product limits (docs, Aug 2026): fan-out list ≤ **200** elements; SUBPLAN nesting depth ≤ **5**.
- A `SUBPLAN` node's output is the sub-plan's FINAL output (a nested brief came back as 4.8 k
  chars of markdown). Nested runs are not in `GET /admin/plan-executions` (depth-0 runs only);
  the parent node aggregates their tokens and `toolCalls`.
- `toolCalls[]` keep the full `arguments` AND `result` of every tool call (15 extracted contract
  texts sit in the trace) — great for audit, heavy to fetch: project node fields, never dump it.

**Plans as chat tools**
- `exposeAsTool:true` + `toolDescription` + `toolInputParameters`, and an Application whose
  `permissions.allowedSubPlans` lists the plan: a chat turn sent with `X-Application-Id` ("compare
  contracts A, B and C: table with parties, dates, law, top risk") made gpt-4o CALL the plan and
  answer with the table in 10.1 s. The follow-up "export that table to Excel" returned a
  `…/uxopian-ai/temp-files/<uuid>` download link (file tools work in chat, via
  `allowedToolTags: ["files"]`). Plan runs started from chat do NOT appear in
  `GET /admin/plan-executions`.

**Built-ins & the admin UI**
- ai-standalone ships map-reduce prompts `summarizeChunkFacts` (reads `item`) and
  `summarizeCombine` (reads `chunkSummaries`), no provider/model pinned — reuse them as agent
  objectives for long-document summaries instead of writing new prompts.
- Admin panel > Plans: visual flow editor (drag edges = dependencies; per-node variable
  highlighting; DIRECT_TOOL arguments auto-bound when one source exists), **Run** button (asks for
  the input parameters), **Runs** tab (status, tokens, tool calls, Pause/Resume/Stop). Point
  business users there; build with uxc.
- The model of an AGENT node = its objective prompt's `defaultLlmProvider/defaultLlmModel`: tier
  cheap map (gpt-4o-mini) vs strong reduce (gpt-4o) per prompt.

**Measured: examples/agentic-portfolio on 15 contracts (fd.demo, 2026-09-16)**
- `uxc run --plan pfrPortfolioReview --payload classId=CtContract` → COMPLETED in **36.8 s**:
  finder agent 6.9 s (24.3 k/0.4 k tokens, 3 tool calls) + nested `pfrContractsBrief` 29.6 s
  (15 DIRECT_TOOL reads, 15 gpt-4o-mini fact sheets, 1 gpt-4o brief; 31.7 k/3.8 k tokens).
- Same 15-contract review, `maxParallelElements` 8 vs 1: fan-out node **20.2 s vs 50.2 s** (2.5×),
  identical tokens — the gain is real but NOT linear (one element alone ≈ 3.3 s; the text
  extraction service and provider latency bound concurrency).
- Chat through application `pfrAssistant` (allowedTools: read-only search + file exports,
  allowedSubPlans: `pfrContractsBrief`): "which Banque Horizon contracts need attention first?
  review all CtContract documents" → searched, called the plan, answered with a prioritized list
  and FlowerDocs deep links `#/documents/edit:<id>` in **22.8 s**; "export the full table to Excel"
  → download link in 3.6 s.
- LLM judgments drift between runs: the gpt-4o-mini map rated 8/15 HIGH in one run and 0 HIGH for
  the 4 Banque Horizon contracts in the chat run. Present risk levels as TRIAGE, and anchor the
  rating rules in the prompt (done in `pfrContractFacts`) or use a stronger map model when the
  rating drives a decision.
- Prompt pitfall: asked for "null" in a JSON template, gpt-4o wrote the STRING `"null"` — say
  "the JSON literal null (never the string \"null\")".
- **`[[${var}]]` HTML-ESCAPES the value** (Thymeleaf text inlining): `Borrower's "x" <y> & z` reaches
  the model as `Borrower&#39;s &quot;x&quot; &lt;y&gt; &amp; z` and leaks into answers. **`[(${var})]`**
  renders it raw (request history shows the unescaped text). Use `[(${…})]` for document text and
  JSON payloads in agent prompts; uxc's variable lints read both forms.
- **LLM reduce steps are approximate — and `successCriteria` does not fix that.** One gpt-4o brief
  over 15 fact sheets: "At a glance" claimed 8 HIGH while its own table held 5; after an explicit
  "count the table rows" rule plus a successCriteria demanding matching counts, it claimed 7 vs 5
  and the gate still PASSED — the criteria are self-assessed by the same agent, so they catch
  missing sections, not the agent's own arithmetic. Splitting the reduce into three parallel narrow
  specialists (table / act-now filter / watch list) + an assembler made "Act now" match the HIGH
  rows (6 = 6) but the table agent still merged one of three near-identical documents (14/15 rows);
  cost +8 s (45 s vs 37 s). Design rule: never ask an LLM reduce for counts; keep per-item decisions
  in the map; when a number or a complete set matters, compute it from the fan-out output
  (`factSheets`, via `uxc run --plan --json` or the chat caller), not from the brief.
- **No per-element retry**: one transient provider error on 1 of 15 gpt-4o-mini calls
  (`[facts] java.lang.reflect.UndeclaredThrowableException`) failed the whole 15-contract run after
  30.7 s; the identical rerun completed. Callers should retry the RUN (uxc does not yet).

**Recommendations (design)**
1. Read documents with a DIRECT_TOOL (`extractDocumentText`), then give the text to a TOOL-LESS
   agent through `[(${contractText})]`: deterministic, cheaper, no envelope, no HTML escaping, and
   the prompt stays payload-only (the §A9 chat extraction stall does not apply).
2. Per-item work = a small SUBPLAN (`item` in) fanned out from the parent; reduce with one agent
   that depends on the fan-out node.
3. Declare every root variable in `toolInputParameters` (§A14) and run `uxc verify` — the
   unprovided-variable lint catches the 400 before a push.
4. Let search happen where tokens are cheapest: in chat the assistant already has the ids; in a
   standalone plan a finder agent costs ~24 k tokens per run.
5. Keep fan-out lists clean (one bad id = whole run FAILED) and keep file exports in chat.
6. Expose the reusable core (ids in → brief out) as a tool and grant it through an Application
   with an explicit read-only `allowedTools` list — the chat assistant then does the search, the
   plan does the heavy parallel reading, and exports stay in the conversation.
7. Start from `examples/agentic-portfolio` (read → SUBPLAN fan-out → reduce, finder, application):
   `uxc push --all`, `uxc run --plan …`, `uxc destroy` — no hand-written HTTP needed.
8. Probing a plan: `uxc run --plan <id> --json` gives statuses and outputs; per-node timing and
   tokens are in `GET /admin/plan-executions/{id}` (`startedAt/completedAt`, `inputTokens`) —
   project those fields, the tool-call results can be megabytes.

## §A17 — Building a trustworthy plan: the negotiation war-room (fd.demo/IRIS, gpt-4o, 2026-09-16)

Built in the private contract-management package (`ctNegotiationWarRoom`: answer a counterparty's V2 of a
credit-insurance contract, clause family by clause family, against the live playbook). Most lessons are general.

**Reproducibility is the hard requirement — and free LLM judgement from raw text fails it**
- v1 let agents pick the playbook families from both raw texts and quote/judge each: two back-to-back runs on
  identical inputs agreed on the response for **5 of 9** shared families, and picked different family sets
  (16 each, 23 in the union). A negotiation tool that changes its advice on a rerun is not credible.
- v2 builds on data FlowerDocs already STORED at ingestion — the per-contract clause→family map (`CtClauseMap`,
  `clauseDocId:FAMILY:DEVIATION`), the clause documents (verbatim `ClauseText`) and their stored `CtDeviation` —
  and tells the judge to START from the stored assessment. Two runs then agreed on **18/18**, and after the fixes
  below **22/22** families. Design rule: let an agentic plan orchestrate over reviewed, persisted judgements;
  keep fresh LLM judgement for what is genuinely new (counter-wording, the email, the memo).
- The family list still came from an LLM parsing the stored map: gpt-4o-mini dropped 2/20 entries, gpt-4o was
  stable across runs but **systematically omitted the `CT_MISS_…:family:MISSING` entries** until the prompt said
  they must be included (they are the most important negotiation points). Residual variation: 23 vs 25 for a true
  union of 24. A deterministic list/JSON transform tool in the gateway would remove this last LLM step.

**Plan outputs**
- A plan with SEVERAL terminal nodes returns a JSON object keyed by their `outputKey`s — both as a SUBPLAN node's
  output (`{"secA":"…","secB":"…"}`) and as the tool result a chat assistant receives. With ONE terminal node the
  output is that node's raw value. So never add an LLM "assembler": a gpt-4o-mini node told to copy five sections
  verbatim DROPPED a whole section and spent 12 of 29 s re-typing text; removing it cut the run to 20.6 s.
- Exact data out without an LLM: a DIRECT_TOOL `chunkText` leaf bound to the fan-out output (`judgements`) passes
  it through unchanged (one chunk for ~17 k chars) — consumers compute exact counts from it (`clauseData`).
- A DIRECT_TOOL node can itself fan out: `getDocumentProperties` with `listKey` over 22 clause ids, 0 tokens.
- Sub-plans receive parent payload values (`previousProps`, `receivedClauses`…) once they declare them in their own
  `toolInputParameters` and the fan-out node depends on the producers.

**Failure modes met (each one failed a whole run)**
- An AGENT can mark ITSELF failed with no `successCriteria`: a judge that concluded "this family is absent, a
  deviation" answered "the goal of this task is unmet" and the element FAILED. Say in the prompt that returning the
  object IS success, whatever the verdict.
- An invented id in a fan-out list (`CtFam_CREDIT_INSURANCE_benefits_calculation`, not in the playbook) made the
  DIRECT_TOOL `getDocumentProperties` hit a Core 500. Embed the exact list of valid ids and require verbatim copies.
- Two runs launched concurrently (~16 gpt-4o calls at once) → one transient `UndeclaredThrowableException` → run
  FAILED. Serialize heavy runs; retry the RUN.
- Verbatim clause text copied into JSON strings breaks the JSON about 1 time in 20 (raw double quotes): ask for
  « » and parse tolerantly (LLM downstream nodes don't care, code consumers do).

**Chat integration**
- **`Application.prompt` had no effect** on the REST chat path through the FlowerDocs gateway plugin: the same
  "Hello" cost 571 input tokens with and without a ~420-token application prompt, and the model ignored its
  content (fresh and updated applications alike). Put the "how to use this tool" guidance (how to find the ids,
  what to present) in the plan's **`toolDescription`** — that worked: a French request found V1/V2 through the
  search tools, called the plan and answered with the memo, counter-proposals and full reply email in 44.7 s.
- Streams from an Application conversation came back as raw text without `data:` frames — parse both forms.

**Measured:** v2 runs in 20.7–27 s (engine 25.9 s for 25 families: fan-out 8.2 s, five writers in parallel,
the counter-proposals writer is the slowest at 13 s). Stability costs tokens: each v2 judge receives ALL stored
clauses as context, so the fan-out used **223 k input / 4.5 k output tokens** (v1, raw texts only: 61.8 k for 18
families). Next optimization: give each judge only its own clause (e.g. a per-family SUBPLAN that fetches the
clause ids of its family from the map) instead of the whole clause array.

**uxc workflow note:** a template checkout (unrendered `{{uxc:…}}` in `data/config.jsonl`) refuses every push, even
of resources without placeholders. To iterate on a subset, render a scratch copy (dummy values for files that are
not pushed) and `uxc push <ids…>` from it; the template stays the source of truth.

## §A18 — Mining an archive: clause-library mining over 33 families (fd.demo/IRIS, gpt-4.1, 2026-09-17)

Built in the private contract-management package (`ctClauseMining`: for each playbook clause family, find the clause
documents stored for a set of contracts, group them by position, recommend a playbook action). Probed with throwaway `zz*`
plans first; every number below comes from `uxc run --plan` or plan-execution reads.

**Search without an LLM, and its limits**
- **`doSearch` runs as a DIRECT_TOOL (0 tokens) when `filters` is REAL JSON in `inputPayload`**, e.g.
  `{"filters":[{"operator":"AND","criteria":[{"name":"classid","operator":"EQUALS_TO","type":"STRING","values":["CtClause"]},…],"subFilters":[]}]}`,
  and also as a DIRECT_TOOL fan-out whose `listKey` is a real JSON array of filter arrays. The same filter sent as a JSON
  STRING is refused at submit with a **500** `INTERNAL_ERROR`. An upstream node's output is always a string, so a plan can
  still not BUILD a filter and run it: the structured value must come from the caller (`uxc run --payload-json`).
- A SUBPLAN fan-out over OBJECTS fails before running: the execution store maps `inputPayload.item` as text
  (`OpenSearchException … mapper_parsing_exception … failed to parse field [inputPayload.item] of type [text]`). Sub-plan
  items must be strings (an array of arrays of strings works: each sub-plan gets a JSON-array string usable as `listKey`).
- A chat assistant could not pass a structured `filters` array to a plan tool (the call errored); plan tool parameters
  behave as strings.
- `doSearch` over 186 hits failed: the tool fetches every hit with one Core `GET /core/rest/documents/<id,id,…>` →
  **400 Bad Request** (URL too long). 123 hits worked (237 KB of output). Keep searches narrow (one family: ≤ 10 hits).
- **Thymeleaf utility objects work in prompt templates**: `[(${#strings.replace(item,'CtFam_CREDIT_INSURANCE_','')})]`
  rendered `waiting_period`. Use it to render EXACT tool arguments into an agent prompt (the whole `doSearch` filter JSON with
  the family code and `[(${sourceContractIds})]` spliced in) and tell the agent to copy it verbatim: over 10 full runs
  (≈ 360 family searches) every search that ran returned the exact clause set. The same agent building criteria with the builder tools produced
  a wrong class criterion 1 time in 4 (`{"name":"CtClause",…}`) and silently got `[]`.
- Nested fan-out works: a SUBPLAN fan-out whose sub-plan runs its own DIRECT_TOOL fan-out (1.8 s for 2 × 3 reads).

**Traces**
- `toolCalls[].result` in `GET /admin/plan-executions/{id}` is CUT at 4,000 characters with `... (truncated)`. The model
  receives the full result (input tokens match the full 17 KB), so the trace cannot be used to re-check what the model saw.
- Chat requests (`GET /api/v1/requests?conversation=`) keep only the answer and token counts, no tool arguments, and
  plan runs started from chat are not listed (§A16). Asked afterwards, the assistant misreported its own tool arguments.

**Where LLM list-building failed (measured against the stored data)**
- Partition of 122 clause ids into 33 families in ONE gpt-4o call: 9 groups returned, 8 ids dropped from those.
- One gpt-4o-mini id-filter call per family (6 k tokens each, 33 elements, 8 in parallel): 3+ elements failed with
  `UndeclaredThrowableException` within 11 s (195 k tokens) → run FAILED. At 4 in parallel with gpt-4.1 (≈ 220 k tokens per
  run) 10 full runs completed.
- Enumerating the documents of a 9-hit search: gpt-4o and gpt-5.4-mini each dropped 1 clause; gpt-4.1 and gpt-5.4 listed
  all. None of gpt-4o, gpt-4.1, gpt-5.4-mini, gpt-5.4 evaluated set conditions reliably (« in at least half of the
  contracts », « none of them CONFORM » fired when false). Keep thresholds and counts out of the model: return per-item
  facts and let the consumer compute.
- LLM section writers over the 33 family results: a single brief dropped the only fallback proposal; four parallel
  writers covered 41/44 positions (hold-the-line), 8–10/11 (absent clauses), 11/11 (data issues), and fell to 29–34/45 when
  asked for one bullet per position with document lists; one mapped a clause to the wrong document. Shipped design: exact
  `familyData` pass-through (DIRECT_TOOL `chunkText`) + one short « highlights » writer that does not claim completeness
  (it still wrote « missing from most documents » for a clause absent from 2 of 6).

**What made it reproducible**
- Anchor on stored data again (§A17): each clause's assessment is COPIED from its stored `CtDeviation`, and two clauses
  may share a position only when stored assessment AND stored extracted value are equal; the model only groups within
  that, describes, quotes and recommends (KEEP / HOLD_THE_LINE / ACCEPT_AS_FALLBACK / ADD_CLAUSE). Result over the final
  runs: clause sets exact 33/33, stored values copied exactly 33/33, grouping rule respected 33/33; run-to-run grouping
  identical on 30/33 families (the model lumps or splits same-assessment clauses without a value), per-clause
  recommendation identical 121/123.
- Residual per-family failure rate ≈ 1.5 % (5 of ≈ 360): the tool-using agent SKIPPED the search twice (silent `"clauses":[]`; a closing
  « your answer is only valid if you called doSearch first » reminder was added) and broke its JSON 3 times (a raw quote
  around a cited rule field name, a trailing `"` after the object). Parse tolerantly (cut after the last `}`); treat an
  empty family that the maps say exists as « not searched, rerun ».
- Map ids to names INSIDE the per-family agent (≤ 10 clauses: 98/98 and 94/94 exact once told « the text after = , never a
  SourceContractId »), not in a reducer.

**Chat**
- Scope selection by the assistant failed: told how to de-duplicate a CtContract search (skip annotated copies, ZZ test
  documents, same-name duplicates), gpt-4.1 instead took 13 SourceContractIds from clause documents (one existed only on
  orphaned clauses), sent ids as names, and described the rules as applied. Pinning a DEFAULT PORTFOLIO (the 6 distinct
  contracts) in `toolDescription` fixed it: « Comment avons-nous réellement accepté la franchise… » → correct contracts,
  positions and recommendations in **17.3 s**. Real fix: store the portfolio of record in FlowerDocs (a tag or a virtual
  folder) so the assistant never has to de-duplicate.
- Recommendation codes need their meaning in `toolDescription`: without it the assistant presented HOLD_THE_LINE as
  « toléré ». With it, a 10-family chat request completed in 38.3 s but the assistant's summary still invented « add as a
  fallback » items absent from `familyData`. A full review (62 families) failed in chat after ~10 s with no visible error,
  while the same run through the admin API completed in **63.3 s**. Keep chat to a few families; run full reviews from the
  admin panel Run button or `uxc run --plan --payload-json`.

**Measured:** 33 families × 6 contracts (123 clauses): 45–49 s end to end; the family fan-out 39.6–43.3 s at 4 in
parallel, 219.5 k input / 25 k output tokens; highlights 3.7 s, 19.4 k / 0.4 k. 62 families (catalogue): 63.3 s.

**The archive itself (what mining surfaced before any playbook change):** 16 CtContract documents were 6 distinct
credit-insurance contracts (V1 ingested three times, annotated copies, a DPA typed CREDIT_INSURANCE, a ZZ test contract);
17 clause documents of a deleted contract; a re-ingested contract with 186 stored clauses for 63 in its map; one contract
whose clause texts were truncated to one character (« L », « U »); a clause map entry holding a clause NAME instead of an
id (an id-driven fan-out on it would 500); required clauses (effective date, legal notice, complaints) absent from 5 of 6
contracts — more likely a classification gap at ingestion than missing wording. Mine an archive only after de-duplicating
it, and report data issues next to the findings.
