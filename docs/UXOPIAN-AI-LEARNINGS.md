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

## §A2 — Versioning: NO version surface (as of the 2026-07 build)
- `/actuator` exposes links but `info` is EMPTY `{}` and `health` is 401; no `/api/v1/version`.
  uxc resolves the dialect by CAPABILITY FINGERPRINT: `GET /api/v1/admin/prompts` → 200-array on
  2026-07+ builds, 500 on 2025-era (FD §25). Ask the AI team to populate actuator info.
- Releases are MONTHLY and the API may still change pre-GA — uxc absorbs differences via
  `lib/dialects.mjs` capability flags + per-kind write strategies (DESIGN §18). The announced
  prompt versioning / working copies will be a new dialect range + a `promptWrite` strategy.

## §A3 — Prompts
- READ: the **user list** `GET /api/v1/prompts` can be a REDUCED projection (id + content only —
  FD §8/§17); the **admin list** `GET /api/v1/admin/prompts` 500'd on 2025-era gateways but
  returns FULL objects on 2026-07+ (role, defaultLlmProvider/Model, temperature, flags, audit
  fields). uxc reads the admin list when the dialect allows, else user list + local-meta overlay.
- WRITE (`admin-v1` strategy): `POST /api/v1/admin/prompts` (object body), on 409 → `PUT` same
  path; updates = `PUT` with **id in the BODY, not the path**. Content is verbatim (templating
  helpers `[[${service.method(…)}]]` lintable against `GET /api/v1/admin/templating/completion`).
- Canonical strips: `temperature` normalizes to a string; `role` echoes lowercase; audit fields
  (`createdAt/createdBy/updatedAt/updatedBy`, null `displaySettings`) dropped.
- `requiresFunctionCallingModel: true` REQUIRES explicit `reasoningDisabled: false` (Java default
  true → "Function calling cannot be required when reasoning is disabled").
- Duplicate-proofing: exists-check FIRST, then a post-create assertion that the list holds
  exactly ONE entry with the id — a duplicating (versioning) gateway fails loudly (FD §25).

## §A4 — Goals
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
