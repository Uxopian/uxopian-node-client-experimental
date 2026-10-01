# uxopian-client — design (v2, post-review)

`uxc` is a zero-dependency Node CLI (plus an importable library) that makes building, packaging,
and syncing **FlowerDocs + Uxopian AI customizations** productive and token-cheap. It generalizes
the hand-written deploy scripts of the Ct contract-management build into one tool, and defines a
**package format** — a project directory with a manifest, a resource registry, and content
hashes — so a whole customization can be exported, shared, imported into another instance, and
kept in sync with a live server **in both directions**.

Status: v2 design, 2026-06-12 — v1 draft revised after a three-lens adversarial review
(DX/API-shape, sync correctness, token economy). Sources: `flowerdocs-ref/FLOWERDOCS-LEARNINGS.md`
(verified API mechanics §1–§17), the Ct build (`contracts_management/demo/ct/`), uxopian-ai
controller source, and a live read-only probe of IRIS (2026-06-12: list endpoints, gateway JWT).

---

## 1. Goals

1. **Token economy for the customization experience.** Claude is the primary user. All the
   hard-won mechanics (array bodies, id-in-path updates, full-replace merges, tmp-file ordering,
   cache clears, handler version rotation, error-code meanings, create-once taskclasses, scope
   additive writes…) live *inside* the client. Outputs are compact, deterministic, answer-shaped,
   and **capped** (§12).
2. **An exchange format** to bundle a project and share it across instances and Uxopian products:
   a plain directory (`.uxpkg` = zip of it), no credentials inside, kinds namespaced (`fd.*`,
   `ai.*`).
3. **Project naming convention**: a short project code prefixes every owned server object —
   unique and findable on a shared instance, still human-readable. Ownership lives in the
   **registry**; prefix scanning is sanctioned only as the *bootstrap* mechanism (`adopt --scan`).
4. **Bidirectional hash sync**: detect local vs server drift since last sync; `pull` server-side
   edits into the package, `push` local edits to the server; conflicts surfaced, never silently
   clobbered.
5. **Claude skills + slash commands** for the full flow.

Non-goals (v1): no RAG, no GUI, no daemon. Java `@HelperService`/`@ToolService` plugins are code —
packages *require* them, not deploy them. LLM provider confs are inspect-only (secrets masked on
GET — can't round-trip). In-browser verification (screenshots, GWT interaction) stays with
Puppeteer/iris-session — `uxc` covers the API surfaces, and the skill says so explicitly.

## 2. Placement & runtime

- Standalone repo (its own git repo).
- Node ≥ 18, zero runtime dependencies (`fetch`, `crypto`, `zlib` built in; minimal zip
  reader/writer in `lib/zip.mjs`).
- `bin/uxc.mjs` CLI + `lib/` importable modules (§15).

## 3. Auth model — JWT everywhere

| Surface | Base | Auth |
|---|---|---|
| Core REST | `https://<host>/core` | `POST /rest/authentication` `{user,password,scope}` → `{value: JWT}`; header `token: <JWT>`; ~1 h expiry, transparent re-auth on expiry/401 |
| uxopian-ai gateway | `https://<host>/gui/plugins/<scope>/gateway/uxopian-ai` | same JWT, `token:` header — **live-verified 2026-06-12** incl. admin endpoints (`admin/goals`, `admin/llm/*`); the OpenAPI spec is served at `/v3/api-docs` (2026.0.0-ft5) |
| GUI caches | `https://<host>/gui/rest/caches` | same JWT `token:` header — *strong evidence* (deploy-handlers.mjs cleared caches this way through v13 with working handler chains) but **not formally recorded**: `uxc doctor` probes it first and records the verdict in FLOWERDOCS-LEARNINGS; until green, push prints the manual-clear fallback instead of claiming success |

No Puppeteer, no cookies. The HTTP layer (`lib/http.mjs`):
- explicit `BodyPublishers`-equivalent: every non-GET without a body sends an **explicit empty
  body** (the §14 DELETE-as-GET bug class is structurally impossible);
- timeouts on every call; single retry on token expiry;
- per-surface wrappers: Core speaks **arrays** (single-GETs return array-of-1 → unwrap `[0]`),
  gateway speaks **single objects** — callers can't get it wrong;
- REST search criteria always carry `"type"` (null type → 500 T00104).

## 4. Targets & credentials (outside the package)

`~/.uxopian/targets.json` (chmod 600), env-overridable (`UXC_TARGET`, `UXC_CORE_URL`, `UXC_AI_URL`,
`UXC_GUI_URL`, `UXC_SCOPE`, `UXC_USER`, `UXC_PASSWORD`):

```json
{ "default": "iris",
  "targets": { "iris": { "core": "https://iris.demos.uxopian.com/core",
                          "ai": "https://iris.demos.uxopian.com/gui/plugins/IRIS/gateway/uxopian-ai",
                          "scope": "IRIS", "user": "system", "password": "…" } } }
```

The **Core REST** base (`core`, up to and including `/core`) and the **Uxopian AI** base (`ai`, up
to and including `uxopian-ai`) are configured explicitly; `gui` (cache-clear / script content)
defaults to `<host>/gui`. A **legacy** single `url` host still derives all three from `url` + `scope`
(`{ "url": "https://host", "scope": … }`); explicit `core`/`ai`/`gui` win over derivation. `scope`
is always required (it authenticates). JWT cached in memory per run only.

## 5. Project & naming convention

A package = human `name` ("Contract Management") + short **code** (`ct`). The manifest records the
four derived prefix forms; `lib/naming.mjs` is the single authority for them:

| Form | Derivation | Used by |
|---|---|---|
| pascal `Ct` | classes, tagclasses, taskclasses, VF classes/instances, tagcategories, workflows, handler logical names | `CtContract`, `CtIngest_onCreate` |
| camel `ct` | prompts, goal names, GUIConfig bean ids | `ctSummary`, `ctContractSearch` |
| kebab `ct-` | Script / GUIConfiguration doc ids | `ct-widgets`, `ct-home` |
| upper `CT_` | runtime instance ids minted by handlers (tasks, docs) | `CT_DEVREV_…` |

Other conventions: handler **logical** name `Ct<Name>_on<Action>` → deployed registration
`…_v<N>` (N managed by the tool, §7.11); taskclass schema change = **new id**; choicelist
symbolicNames UPPER_SNAKE; displayNames authored EN+FR; RegistrationOrder bands per kind recorded
in the manifest. **Band allocation** = lowest free integer in band *from the registry*; exhaustion
is a hard error ("widen `registrationOrderBands` in the manifest"); `doctor`/`import` scan live
RegistrationOrder values and warn on foreign occupants inside the package's bands.

Shared/native resources are *referenced* with `policy: external` (never written, never deleted).

**Id namespace in commands**: every command accepts `kind/id` (e.g. `fd.handler/CtIngest_onCreate`)
and bare `id` when unique across the registry (otherwise: error listing candidates). Goals:
`ai.goal/<goalName>+<promptId>[+<filterHash8>]`. Handler commands take the logical name and
transparently accept a deployed `_vN` id by stripping the suffix.

## 6. Package format

A package is a plain directory; `.uxpkg` is a zip of its own files (export excludes `.uxc/`,
tooling dirs and `.gitignore`'d files — §10).

```
<package>/
  uxopian-project.json            # manifest
  registry.json                   # resource catalog (committed, exported)
  .uxc/state.json                 # per-target sync state (committed, NOT exported)
  fd/
    workflows/CtApproval.json
    tagclasses/CtTypeCode.json
    tagcategories/CtConIdentity.json
    classes/CtContract.json
    taskclasses/CtDeviationReview.json
    vfclasses/CtReview.json
    vfinstances/CtContractsReview.json
    scripts/ct-widgets/meta.json + ct-widgets.js
    guiconfig/ct-home/meta.json + ct-home.xml
    handlers/CtIngest_onCreate/meta.json [+ handler.js + request.xml]
    handlers/shared/…               # shared sources referenced by meta paths (see below)
    surfacing.json
  ai/
    prompts/ctSummary.json + ctSummary.content.md
    goals/goals.json
    mcp/<id>.json
  data/playbook.jsonl
  README.md
```

**Shared handler sources**: `meta.json` may reference its files by relative path
(`"script": "../shared/ingest-handler.js"`, `"filter": "../shared/request.xml"`); the handler
hash is computed over the **resolved bytes**, so two registrations sharing one source can never
silently diverge (the real CtIngest_onCreate/_onUpdate pair shares both files).

`uxopian-project.json`:

```json
{
  "format": "uxopian-package/1",
  "name": "Contract Management",
  "code": "ct",
  "idPrefixes": { "pascal": "Ct", "camel": "ct", "kebab": "ct-", "upper": "CT_" },
  "version": "1.0.0",
  "description": "Playbook-driven contract intelligence (NDA + credit insurance)",
  "products": ["flowerdocs", "uxopian-ai"],
  "requires": { "llmProviders": ["openai"], "helpers": ["flowerDocsService.extractTextualContent"] },
  "registrationOrderBands": { "fd.handler": [20, 29], "fd.guiconfig": [30, 49], "fd.script": [930, 949] },
  "dataSets": [{ "name": "playbook", "classId": "CtFamily", "path": "data/playbook.jsonl", "content": false }]
}
```

**Related work**: FlowerDocs ships a native scope-level transport (CLM template directories of
JAXB XML + create/update/export/merge jobs, PDF pp. 139–155). `uxc` is deliberately different:
project-scoped (a prefix-owned *subset* of a shared scope), pure REST, covers uxopian-ai, adds
hash drift. Kind names mirror CLM directory names; a `--clm-template` emitter stays open for later.

## 7. Resource kinds & adapters

Adapters implement `list / get / exists / create / update / delete / canonicalize / validate /
template`. All five class types + tagcategory have verified LIST endpoints (full-object arrays) —
`status --remote` for class kinds costs ≤ 6 GETs.

| # | Kind | Storage | Mechanics (✅ = live-verified) |
|---|---|---|---|
| 1 | `fd.tagclass` | JSON | ✅ create `POST /rest/tagclass` ARRAY; update `POST …/{id}` ARRAY; types STRING/TEXT/INT/CHOICELIST/DATE/BOOLEAN/ICON; validate: aggregation pivots must be CHOICELIST |
| 2 | `fd.tagcategory` | JSON | ✅ same verb pattern; `tags[]` = membership |
| 3 | `fd.documentclass` | JSON | ✅ create needs top-level `category:"DOCUMENT"` + `active:true`. Update is FULL-REPLACE; **the local file is authoritative for all managed fields** — the server GET contributes only volatile/server-owned fields (version, dates, owner). A locally deleted tagReference MUST be gone after push (acceptance test) |
| 4 | `fd.taskclass` | JSON | ✅ **policy `createOnly` + `inPlaceUpdate`**: create if absent; **UPDATE in place** (same-id `POST /rest/taskclass/{id}` full-replace — binding-safe, e.g. adding `children` attachment slots, §20); but **never delete+recreate** (breaks ANSWER dispatch — §14), so `rm --server` stays gated behind `--force` (test teardown only). Schema change that needs a delete ⇒ new id |
| 5 | `fd.vfclass` | JSON | ✅ `POST /rest/virtualfolderclass`; DTO uses `type` discriminators (NOT `@class`); aggregation = outer `field` + recursive `nested`; pivots CHOICELIST |
| 6 | `fd.vfinstance` | JSON | ✅ `POST /rest/virtualFolder/` (capital F); policy `createOnly` |
| 7 | `fd.workflow` | JSON | 🧪 **policy `managed`** (full write). DTO `{id, startTaskClass, taskClasses[]}` (no category/data). create `POST /rest/workflow` ARRAY; update `POST …/{id}` FULL-REPLACE (docs p.986: unset fields cleared); delete `DELETE …/{id}` (docs p.987: no active-instance check). **get-ALL 500s live (T00303)** → read BY ID only, no `list`/`scan` (like vfinstance). create/update/delete DOCUMENTED (pp.983-987) but **round-trip not yet live-verified** (no server at impl time) — `uxc doctor`/`push` on a workflow scope to confirm, then → ✅. Note: taskclass↔workflow mutual ref (workflow pushes after taskclass; taskclass.workflow is a forward ref — verify) |
| 8 | `fd.acl` | JSON | ✅ **policy `managed`** (full write; live-verified fd.demo 2026-07-15/16, LEARNINGS §37). DTO `{id, name, entries[{principal, permission[], grant}]}` (`principal:"*"`=all, `grant`=ALLOW\|DENY; no category/data). create `POST /rest/acl` ARRAY; update `POST …/{id}` FULL-REPLACE; delete `DELETE …/{id}`. **get-ALL 500s live (T01006)** → read BY ID only, no `list`/`scan`; **missing ACL GETs as 500 T01002** (absent-code → classifies as create). **The GET echo is a lazy ACLProxy WITHOUT entries → entries are WRITE-ONLY**: readServer overlays the package's entries (server authoritative for existence/id/name only; entry drift undetectable; adopt yields a stub). Pushed BEFORE the classes that reference it (`data.ACL`). |
| 9 | `fd.script` | meta+`.js` | ✅ Script-class doc; exists-check FIRST, fresh tmp per attempt (T00707); create or update-in-place (GET → `files:[{id:tmp}]` → `POST /rest/documents/{id}` ARRAY); keep `RegistrationOrder` tag; cache clear |
| 10 | `fd.guiconfig` | meta+`.xml` | ✅ as script, class GUIConfiguration. `validate()` **in the tool**: XML well-formed; bean-id uniqueness across the package; refusal list for live singleton bean ids (`componentProperties`, `componentActivityConfigurations` — merge-into, never redefine); `--check-collisions` lists bean ids across live GUIConfiguration docs |
| 11 | `fd.handler` | meta + resolved script/filter | ✅ see §7.11 below |
| 12 | `fd.surfacing` | `surfacing.json` | ✅ see §7.12 below |
| 13 | `fd.dataset` | JSONL | ✅ see §7.13 below |
| 14 | `ai.prompt` | meta JSON + `.content.md` | ✅ fields `id, role, content, defaultLlmProvider, defaultLlmModel, temperature, reasoningDisabled, requiresMultiModalModel, requiresFunctionCallingModel, timeSaved` (strip `createdAt`; normalize `temperature` to string in canonical form — echo-verified by doctor; ft5 also strips `version`/`draft`/`usage`). Push goes through the dialect's **write strategy** (§18): `admin-v1` (≤ ft4) = POST `/api/v1/admin/prompts`, 409 → PUT (id in body); `versioned-v1` (2026.0.0-ft5) = POST create, update = open/reuse THE draft (`POST …/{id}/versions`) + publish (`PUT …/versions/{n}` `draft:false`), refusing a foreign unpublished draft unless `--force` (AI learnings §A11). List via **user** `GET /api/v1/prompts` — which can return a **reduced projection** (id+content only on some builds), so `readServer` overlays the echo on the local meta (server-present keys win → drift detectable; omitted keys fall back to local → config like `role`/`defaultLlmProvider`/`defaultLlmModel`/`temperature` is never lost on the push echo-leg writeback). Validate: `requiresFunctionCallingModel:true` ⇒ explicit `reasoningDisabled:false` (refuse push); helper calls linted against `GET /api/v1/admin/templating/completion` |
| 15 | `ai.goal` | `goals.json` | **Removed by uxopian-ai 2026.0.0-ft5** (404 / GOAL content 400, AI learnings §A12): dialect cap `goals:false` classifies every row `unsupported` — skipped by status/pull/push/verify, never a failure. Up to ft4: natural key **(goalName, promptId, filter)** — duplicate keys rejected at validate. Server row id is per-target → state. Reconcile reads `GET /api/v1/admin/goals` (filter client-side; `?goal_name=` used only once live-verified). **Only rows whose promptId belongs to the package are ever created/updated/deleted.** Import detects `index` collisions within a goalName vs foreign rows and re-bands with a printed report |
| 16 | `ai.mcp` | JSON | CRUD `/api/v1/admin/mcp/mcp-conf` (hot-reload server-side). Doctor verifies whether GETs mask header secrets; masked fields are excluded from the canonical hash (llmconf-style) and **push never overwrites a non-empty server secret with a placeholder** |
| 17 | `ai.llm` | JSON | CRUD `/api/v1/admin/llm/provider-conf` — LLM **provider configs** (provider + model catalog). Same secret contract as `ai.mcp`: `globalConf.apiSecret` echoes as `********` → masked to `__masked__` (never written to the package); on push `__masked__` resolves to the live server value, and a **fresh install ships an empty key** (operator sets it — an LLM provider is legitimately created keyless). `uxc ls ai.llm`. (Supersedes the former inspect-only `ai.llmconf`.) |
| 18 | `ai.agent` | JSON | **2026.0.0-ft5+** (cap `agenticPlans`). CRUD `/api/v1/admin/agent/agent-conf[/{id}]`: create 201 empty body, existing id = **400** (fallback to PUT), `PUT /{id}` full replace. `objective` = the prompt it runs (required); `successCriteria`; `permissions` (tool/tag/MCP/sub-plan whitelists); `secrets.*.value` under the `ai.mcp` mask contract. The gateway checks no references → `lintAgentic` warns offline; unknown tool names/tags warn at push (`GET /api/v1/admin/tools`). AI learnings §A13 |
| 19 | `ai.plan` | JSON | **2026.0.0-ft5+** (cap `agenticPlans`). CRUD `/api/v1/admin/plans[/{id}]`, same verbs as `ai.agent`. Validate (blocking): node ids unique, types AGENT/SUBPLAN/DIRECT_TOOL with their required field, dependencies exist, **no cycle** (server 400), `exposeAsTool` ⇒ `toolDescription` + tool-name-safe id. Lint (warning): each AGENT node's prompt variables must come from a dependency `outputKey`, a `persistOutput` node or `toolInputParameters` — else the run is refused (400). Runs: `uxc run --plan` (§14). AI learnings §A13/§A14 |
| 20 | `ai.application` | JSON | **2026.0.0-ft5+** (cap `applications`). CRUD `/api/v1/admin/application/application-conf[/{id}]`: existing name = **409** (fallback to PUT). **id = name** (the gateway derives one from the other — validate refuses a mismatch). Selected at run time by `X-Application-Id` (`uxc run --application`). A referenced prompt cannot be deleted, and the reference outlives the application ~2 s (prompt remove retries). AI learnings §A15 |

**Push order** (topological, always): acl → tagclass → tagcategory → documentclass →
taskclass → folderclass → workflow → vfclass → dataset → script → guiconfig → handler →
vfinstance → surfacing → ai.llm → ai.prompt → ai.goal → ai.mcp → ai.agent → ai.plan →
ai.application → f2.map. Delete = reverse. (acl first: classes
reference it via `data.ACL`. workflow after taskclass: a workflow lists `taskClasses`.)

**Cache clears**: a `pendingCacheClear` flag is persisted in state **before** the first
cache-affecting write and cleared only after a successful `DELETE /gui/rest/caches` (+
`/core/rest/caches` when handlers changed) — any later `uxc` invocation honors a dangling flag.
Clears run right after the handler block (the ~45 s clock must start there) and once more at the
end if later kinds touched cached surfaces.

### 7.11 fd.handler — the version-rotation adapter

Storage: `meta.json` (`{action, objectType, phase, asynchronous, stopOnException, order,
filter?, script}`) + resolved script/filter bytes. The **logical id** (`CtIngest_onCreate`) is the
registry key; the deployed id is `<logical>_v<N>`.

- **The server is the source of truth for N**: before any handler status/push, list
  OperationHandlerRegistration docs (one search) and match `^<logical>_v(\d+)$`. Live N =
  max(N); **every other survivor is an orphan** — `status` reports it, `push`/`verify` delete it.
  `deployState.deployedId` is a cache, never the input to N+1.
- Push: skip if resolved hash unchanged **and** exactly one live registration exists; else deploy
  `_v(max+1)`, verify it serves, delete all older `_v*`, clear `/core` + `/gui` caches, record
  `deployedId` + `deployedAt` in state.
- The **~45 s blind window is managed state**: `push --settle` blocks until t+45 s;
  `watch`/`run`/`verify` check `deployedAt` and print/wait one line ("handler active in ~23 s;
  events before that are lost") instead of letting the next action fall in the window.
- `adopt` derives the logical name by stripping `_vN` (warns if absent) and records the highest
  survivor; older survivors are reported as orphans immediately.
- `uxc disable <handler>` / `enable` = in-place `Enabled` tag flip on the live registration doc
  (GET-merge-POST) + cache clear, recorded in state; `status` shows `disabled`, not drift. This is
  the emergency kill switch — no version bump, no blind window.

### 7.12 fd.surfacing — the scope fragment

`surfacing.json` = the entries the project owns:
`[{ "profiles": "*" | ["profileName"…], "name": "search.template", "value": "ctContractSearch()" }]`.

- `profiles: "*"` expands against the **live** profile list at push time; the concrete expansion
  is recorded in state, so unsurface removes exactly what was added and a profile created later
  receives entries on the next push.
- Push protocol (live-verified sequence): backup scope to `.uxc/backups/` → additive merge (exact
  name+value presence check per profile) → `POST /rest/scope/{scope}` → re-GET → strip-own diff
  vs backup → **auto-restore on foreign change**.
- Adopt: scan scope property values referencing registry-owned ids (owned bean ids, VF instance
  ids, prefix forms) — part of `adopt --scan`.
- `rm`/unsurface warns when an entry's value references something the package doesn't own
  (shared-entry limitation, documented).

### 7.13 fd.dataset — row-level sync

State stores **per-row base hashes** (`docId → hash`); the 3-way runs per row, so disjoint row
edits merge cleanly and only same-row divergence conflicts. Server-side adds/deletes surface as
row-level drift lines. **Push never deletes server documents by default**: deletes happen only via
explicit local tombstone rows (`{"_id": "...", "_deleted": true}`) or `data push --prune`, which
prints the exact kill list and requires confirmation. Pull of a server-deleted row drops it with a
printed notice. Batched ≤ 20-id deletes with per-id fallback; deterministic ids; fresh tmp per
attempt; F00033 explained on push.

## 8. Registry, state, 3-way sync

`registry.json` (committed, exported):

```json
{ "resources": [
  { "kind": "fd.tagclass", "id": "CtTypeCode", "title": "Contract type code",
    "path": "fd/tagclasses/CtTypeCode.json", "policy": "managed",
    "notes": "CHOICELIST [NDA, CREDIT_INSURANCE]" },
  { "kind": "fd.handler", "id": "CtIngest_onCreate", "path": "fd/handlers/CtIngest_onCreate",
    "policy": "managed", "retired": false } ] }
```

Policies: `managed` · `createOnly` · `external`. A `createOnly` kind may additionally set the adapter
flag `inPlaceUpdate` (fd.taskclass) — push then UPDATES it in place (same-id POST) while the
`createOnly` delete gate stays in force; this separates the "may update" axis from the "delete is
dangerous" axis without a fourth policy. `retired: true` = tombstone: deliberately
removed from the server; excluded from push defaults; distinguishable from foreign deletion.

`.uxc/state.json` (committed — sorted keys, one resource per line, union-merge documented;
**excluded from `.uxpkg`**):

```json
{ "targets": { "iris": {
    "pendingCacheClear": false,
    "fixtures": { "smoke-nda": { "documentId": "CT_SMOKE_NDA08" } },
    "resources": {
      "fd.tagclass/CtTypeCode": { "syncedHash": "sha256:…", "syncedAt": "…" },
      "fd.handler/CtIngest_onCreate": { "syncedHash": "…", "deployedId": "CtIngest_onCreate_v13", "deployedAt": "…" },
      "fd.dataset/playbook": { "rows": { "CtFam_NDA_DATA_PROTECTION": "sha256:…" } },
      "ai.goal/summarize+ctSummary+8f3a01bc": { "serverId": "…" } } } } }
```

**Hashes.** `pull` and `push` both end by writing the **canonicalized server echo** to disk and
recording its hash as the base — *base is always `canon(server)`, never `canon(local)`*. Push =
write → re-GET → canonicalize echo → persist file + base. This is what makes server-injected
fields (taskclass `answers[].type: ReasonedAnswer`, tagReference flag defaults, temperature
coercion) invisible instead of phantom drift.

**Client compatibility gate (`lib/version.mjs`).** uxc is officially versioned by `package.json`
`version` (the single source of truth; print with `uxc version` / `uxc --version`). The **policy**:
bump the **minor** whenever a release adds a deploy capability a package can depend on. A package
declares the minimum client it needs to deploy *every* resource via a top-level
`minClientVersion` in `uxopian-project.json` (the alias `requires.uxc` is also read):

```json
{ "code": "ct", "version": "1.7.1", "minClientVersion": "0.2.0", "...": "…" }
```

`assertClientSupports(manifest, {client, ignore, out, action})` is the one gate. It throws (CLI
renders message + `↳ explanation`) when the running client is older than the declared minimum, or
when the value isn't valid semver. It runs **before any server write** at every deploy entry point:
`importPackage` (covers `uxc import` *and* `uxc mp install`), `uxc mp install` (an extra
**pre-download** check off the marketplace-stored manifest), and `uxc push` (before `connect()`, so
it refuses with no target needed). `mp publish` carries `minClientVersion` verbatim in the version
payload's `manifest`, validates it's semver, and warns if it exceeds the publishing client.
The override `--ignore-client-version` (distinct from `--force`) downgrades the refusal to a loud
warning — test/emergency only. **Bootstrapping caveat:** only clients ≥ the version that introduced
the gate (0.2.0) enforce it; older clients predate the field and ignore it — acceptable because the
client is still pre-release.

**The full decision matrix** (per resource, per target):

| base | hash(file) vs base | hash(canon(server)) vs base | State | Action |
|---|---|---|---|---|
| ✓ | = | = | in sync | — |
| ✓ | ≠ | = | local edit | `push` |
| ✓ | = | ≠ | server edit | `pull` |
| ✓ | ≠ | ≠, but file == server | **rebased** (someone else pushed the same thing) | auto-record base, report `rebased` |
| ✓ | ≠ | ≠ | conflict | `diff`, then `push --force` / `pull --force` |
| ✓ | any | server missing | deleted remotely | report; `push` recreates **only with `--recreate`**; or `rm --local` |
| — (no base) | — | server absent | new | `push` creates, records base |
| — (no base) | — | server present, == file | adopted | record base silently |
| — (no base) | — | server present, ≠ file | **collision** | refuse; `diff`, then `pull --force` / `push --force` / `adopt` |

`push` re-fetches and re-compares each resource's server hash immediately before its write
(TOCTOU guard) and **commits state per resource immediately after success** — a failed item 7/20
leaves items 1–6 synced and resumable; the run exits 2 with the failure + `explain` line +
"re-run `uxc push --changed` to resume".

**Untracked files**: `status` lists files under `fd/`/`ai/`/`data/` not referenced by the
registry (like git untracked) — generated files join via `uxc add <kind> --from-file <path>`.

**Round-trip invariants** (`uxc doctor --roundtrip`): (a) pull → status clean for every adopted
kind; (b) **push-echo leg**: create each kind's `Zz*` template, re-GET, assert canon equality,
delete — every diff becomes an explicit strip/normalize rule, discovered in doctor rather than as
one spurious conflict at a time.

## 9. Deletion lifecycle

| Command | File | registry.json | state | Server |
|---|---|---|---|---|
| `uxc rm <id>` (bare) | error: choose a flag | | | |
| `uxc rm <id> --local` | deleted | removed | **KEPT — §23 prune marker** | untouched now; listed + (confirmed) deleted at the next `push --all` |
| `uxc rm <id> --server` | kept | `retired: true` | base cleared | deleted (policy-gated; `createOnly`/`external` need `--force`) |
| `uxc rm <id> --both` | deleted | entry removed | entry removed | deleted (same gating) |
| `uxc destroy [--dry-run] [--force]` | — | — | — | full reverse-order teardown of every non-external resource (unsurface → disable handlers → delete in reverse topo order → cache clear), `--dry-run` prints the list first; requires typing the project code to confirm; `createOnly` entries are KEPT unless `--force` (the same delete gate `rm`/prune honor — §14 taskclass hazard) |

Tombstoned (`retired`) resources never push by default; `push <id> --revive` un-tombstones.

## 10. import / export / code-remap

- `uxc export [-o name.uxpkg]` — zip of the package's own files; refuses if status vs the
  default target is dirty unless `--allow-dirty`; scrubs secret fields (`ai.mcp` headers, LLM
  keys, agent secrets, f2 map credentials) on the staged copy. `mp publish` ships this same
  archive (it calls `exportPackage`).
  - **File list** (issue #100): inside a git work tree it is `git ls-files --cached --others
    --exclude-standard` run in the package dir, so `.gitignore` is honoured; without git (or
    outside a work tree, or when git lists nothing on disk) the directory is walked.
  - **Always excluded**, on both paths and even if git tracks them: `.uxc/`, `.git` (dir or
    file), `marketplace/` (listing assets, uploaded separately), `node_modules/`, `.claude/`
    (incl. `.claude/worktrees/`), `*.uxpkg`, and a nested git **worktree** (a subdirectory whose
    `.git` is a FILE pointing into a `/worktrees/` dir). Tracked files under those are reported
    with a warning. A submodule (`.git` file into `/modules/`) or a nested full repo (`.git`
    dir) ships like any directory, minus its own `.git`.
  - **Registry wins over ignore rules**: a file owned by a registered resource (under a registry
    entry path, incl. a `.json` meta's `<stem>.*` siblings; a manifest `dataSets` path; or
    `uxopian-project.json`/`registry.json`/`marketplace.json`/`AGENTS.md`/`CLAUDE.md`/`compat.json`)
    ships even when a `.gitignore` (own, parent repo, global excludes) ignores it — noted
    "included although gitignored". A `node_modules/` or `.claude/` dir INSIDE a registry entry
    path ships too (noted); the other hard excludes still apply there.
  - **Symlinks are followed** (files and dirs, inside or outside the package, as the pre-0.24.1
    copy did), cycle-guarded: a link resolving to an ancestor is reported `symlink-cycle`, a
    dangling one `broken-symlink`. git lists a symlink / nested repo as ONE entry; its verdict
    covers every file below it. On a case-insensitive filesystem (probed) git paths match
    case-insensitively, so a case-only index/disk mismatch never reads as "gitignored".
    Nothing is dropped silently: whatever is left out is in `excluded` with its reason.
  - export prints what it left out (grouped by excluded root, with sizes; `.uxc`/`.git` are
    not listed) and warns when the archive exceeds `UXC_EXPORT_WARN_MB` (default 25).
- `uxc import <pkg.uxpkg|dir> [--code-remap ct=xy]` —
  1. unpack;
  2. **pre-flight the whole package**: list/GET every target id, classify against the no-base
     matrix rows, print the full collision list **before any write**; `--force` required to
     overwrite collisions;
  3. ordered push (state recorded per resource — a failed import is resumable with `push`);
  4. `verify` (§11).
- **code-remap** is registry-driven, not string-replace: build the exact identifier map — every
  owned id → remapped id in all four prefix forms, plus derived forms (the VF magic bean-id
  mangle `content<Classid>VirtualFolder` with its case-folding, band-prefixed runtime ids like
  `CT_APPR_`) — apply with **token-boundary** replacement across all package files, then run a
  mandatory cross-reference lint: any residual old-prefix token = abort with the list. Flagged
  `experimental` in v1; refuses rather than guesses.

## 11. verify

Post-deploy assertions, per kind: resource exists; handler has exactly one live `_vN`, enabled,
inside its band; scripts/guiconfigs serve their exact bytes (`GET /gui/rest/scripts/{id}` /
content GET); surfacing entries present on the expected profiles; prompts listable; goals
reconciled. Plus a **cross-reference pass** (same token scanner as `refs`): classids in
`request.xml`/VF searches/GUIConfig criteria exist; prompt ids mentioned in handler.js/scripts
exist in the package or live; surfacing values resolve to owned bean/instance ids. This is what
catches the "renamed the taskclass, forgot the filter XML" class of silent breakage.
The package files are also checked against the JSON Schemas (§29): an error only where uxc already
refuses, a warning otherwise.

## 12. CLI surface

```
# package lifecycle
uxc init --name "…" --code ct [dir]            # scaffold + CLAUDE.md stanza for the package repo
uxc target add|ls|use …
uxc status [--remote] [kind|id…]               # drift + untracked + orphans + pendingCacheClear
uxc diff <id> [--base] [--full]
uxc pull [id…|--all]
uxc push [id|kind/id …|--changed|--all] [--force] [--settle] [--recreate] [--revive]
uxc add <kind> <Name> [--title …] [per-kind args] [--from-file p]
uxc adopt --scan [--kind k…] [--yes]           # prefix-driven bulk discovery → checklist → registry+pull
uxc adopt <kind> <server-id> [--external]      # single
uxc rm <id> --local|--server|--both [--force]
uxc destroy [--dry-run] [--force]
uxc f2 ls [--campaigns]                         # fast2 broker: maps + campaign states
uxc f2 run <MapName> [--campaign n] [--wait s] [--expect-ok n]
uxc export [-o f.uxpkg] [--allow-dirty]
uxc import <pkg|dir> [--code-remap a=b] [--force]
uxc verify [id…]
uxc data pull|push <name> [--prune]
uxc refs <id>                                  # which package files mention this id
uxc disable|enable <handlerId>

# day-to-day building
uxc ls <kind> [--mine] [--fields …]
uxc get <kind|doc> <id> [--fields …] [--content] [--full]
uxc schema <classId> [--tag T]                 # joined tagReferences × tagclass × categories table
uxc search <classId> [--where 'Tag=a|b']… [--category TASK] [--order f:desc] [--fields …] [--max n]
uxc doc create <classId> [--file f] [--tag k=v]… [--id …] [--name …]
uxc doc rm <id…>
uxc task ls [--class …] [--mine]               # note: answered tasks still show status NEW
uxc task answer <taskId> <answerId>
uxc watch <docId> [--fields a,b] [--until 'Tag=V'] [--timeout 300] [--interval 10]
uxc recent <classId|--category TASK> [--since 15m]
uxc run <promptId> [--payload k=v]… [--payload-json f] [--goal] [--provider …] [--model …]
        [--expect regex] [--max-chars n] [--timeout s] [--fixture name] [--save-fixture name]
uxc cache-clear
uxc explain <CODE|text>
uxc doctor [--roundtrip]
uxc install-claude
```

**Per-kind `add` signatures** (templates carry the verified mechanics — they ARE the product):
- `add fd.tagclass CtFoo --type CHOICELIST --values A,B [--fr …]`
- `add fd.documentclass CtBar --tags CtFoo:mandatory,SourceContractId:readonly --category-ids …`
- `add fd.taskclass CtGate --answers APPROVE,REJECT --workflow CtApproval`
- `add fd.handler CtBar_onCreate --object DOCUMENT --filter-class CtBar [--phase AFTER] [--sync]`
  → parses `_on<Action>`; template handler.js ships the safe `http()` (noBody fix), minted-JWT
  gateway call with connect+request timeouts, idempotency guard, error-marker-tag observability;
  `request.xml` scoped to `--filter-class`
- `add fd.guiconfig ct-foo-search --template search|home|vf-override --class CtBar`
- `add fd.script ct-foo --order <auto-from-band>`
- `add ai.prompt ctFoo [--fcm]` (`--fcm` sets requiresFunctionCallingModel + reasoningDisabled:false)
- `add ai.goal --goal <goalName> --prompt ctFoo [--filter expr] [--index n]` (≤ ft4)
- `add ai.agent ctFooAgent --objective ctFoo` · `add ai.plan ctFooPlan --agent ctFooAgent` ·
  `add ai.application ctPortal [--provider FlowerDocsProvider] [--prompt ctFoo]` (ft5+)
- any kind: `--from-file <path>` registers an existing/generated file instead of scaffolding.

**Output discipline** (the token-economy contract):
- one resource per line; aligned columns; summary counts; `--json` everywhere;
- **`diff`**: stat header (±lines, hunks) + first 80 lines + `(N more lines: --full)`; meta-diff
  and content-diff reported separately for content-bearing kinds;
- **`get --content`**: writes bytes to a file (or prints the managed file's path) + size + sha256;
  never dumps content to stdout unless `--full`;
- **`get` (documents)**: aligned tag table, values truncated at 120 chars with `(+5880 chars,
  --full)` markers;
- **`ls` default projections**: e.g. `ai.prompt` → `id role provider/model fcm size`; classes →
  `id title #tags`; never echo prompt content;
- **`search` defaults**: fields = name, classid + the `--where` tags; max = 20;
- **`run`**: streams capped at `--max-chars` (default 2000) with elapsed time; `--expect` prints
  PASS/FAIL + first 400 chars, exit 0/1;
- errors: one line + learned explanation + suggested next command. Exit codes: 0 ok, 1 drift or
  expectation failed, 2 error, 3 an upgrade `--report` found a `breaks` line (§26).

## 13. Error knowledge base (`uxc explain`, auto-appended to failures)

F00903 exists → update-in-place `POST …/{id}`; T00104 search engine can't run that (INT
orderClause / nested agg in search / criterion `type:null` / lowercase `creationdate`); F00032 tag
not in class schema; F00033 mandatory tag missing; T00707 tmp ref consumed by failed create;
T00108 id still occupied (incl. deleted tasks); F00013 creationDate in future; F00204 missing
category; F00414 taskclass attachments not REST-declarable → carry doc id in a task tag; goal run
400 with unresolved Thymeleaf vars → use a direct PROMPT input; "Function calling cannot be
required when reasoning is disabled" → explicit `reasoningDisabled:false`; gateway "Configuration
not found with id: X" → provider not configured; SSE plain-text / error-as-200-body signatures;
answered tasks still report `status: NEW` in search rows (footnoted on `task ls`).

## 14. Gateway run mechanics

`POST /api/v1/conversations` `{}` → `{id}`, then `POST /api/v1/requests/stream?conversation=<id>`
with `{"conversation":id,"inputs":[{"role":"USER","content":[{"type":"PROMPT","value":promptId,
"payload":{…}}]}]}` (non-stream `/requests` 404s on the external path). Tolerant parser: SSE
`data:` frames OR raw text; accumulate `content||text||delta.content||answer`; error-as-body
signature detection; one cold-start retry. LLM override via query params. `--goal` sends
`type:"GOAL"`. Fixtures (`--save-fixture/--fixture`) persist per-target payload/doc ids in state.

## 15. Library API (`lib/index.mjs`)

```js
import { connect, openPackage, kinds, canonicalize, explain } from 'uxopian-client';
const ux = await connect('iris');          // → { core, gateway, gui, target }
await ux.core.search('CtContract', { where: { CtReviewStatus: 'BLOCKED' }, fields: ['name'] });
await ux.core.upsertDoc({...});            // fresh-tmp + exists-first discipline inside
await ux.gateway.run('ctSummary', { payload: { documentId } });   // tolerant parser inside
const pkg = await openPackage('.');        // registry + state + adapters
```

Import path for sibling repos: relative file import or `npm link`. Rule of thumb in the skill:
one-off reads → `uxc` (`--json`); bespoke multi-step jobs (migrations, reconcilers, seeders) →
a small script on the lib — never a re-grown ad-hoc `http()` helper.

## 16. Claude integration

Sources in `claude/`, installed by `uxc install-claude` (symlinks into `~/.claude/`):

- **Skill `uxopian-client`** — slim SKILL.md (≤ ~120 lines: the three loops — build / sync /
  ship — and pointers), with `references/kinds.md`, `references/policies.md`,
  `references/errors.md`, `references/recipes.md` read on demand (progressive disclosure).
  Trigger description names the real nouns: FlowerDocs, Uxopian AI, IRIS, handler,
  OperationHandler, prompt, goal, tagclass, taskclass, GUIConfiguration, virtual folder, scope
  property, gateway, Core REST, deploy, smoke, drift, cache clear. Scope rule: **uxc for all
  API-surface work; in-browser verification stays Puppeteer** (link to iris-session.mjs).
- **Slash commands** (`claude/commands/`): `/ux-status`, `/ux-sync`, `/ux-new`, `/ux-push`,
  `/ux-export`, `/ux-import`, `/ux-smoke`.
- `uxc init` writes a CLAUDE.md stanza into the package repo so project-level instructions route
  to `uxc` instead of legacy scripts.

## 17. v1 acceptance

1. `uxc doctor` green on IRIS — including the `/gui/rest/caches` JWT probe (result recorded in
   FLOWERDOCS-LEARNINGS.md) and the push-echo round-trip leg on Zz* resources.
2. **The Ct module bundled as the worked example** via `adopt --scan` + `pull` (≈ 50 tagclasses,
   13+ categories, 5 classes, 2 taskclasses, 3 VF classes + 3 instances, scripts/GUIConfigs,
   5 handler logical names, surfacing entries, 12 prompts, goals, playbook dataset) → `status`
   clean → `export` → `ct-1.0.0.uxpkg`. Strictly read-only on Ct resources.
3. Round-trip invariant holds for every adopted kind (pull direction) and every Zz* template kind
   (push-echo direction).
4. Push/delete/disable paths verified on throwaway Zz* resources, torn down via
   `rm --server --force` — the shared instance ends clean.
5. Policy refusals verified: taskclass update refusal; external refusal; tombstone exclusion;
   documentclass local-deletion-wins test (removed tagReference stays removed after push).

## 18. Server dialects (version-aware behavior)

Uxopian products release fast (uxopian-ai monthly, API changes still allowed pre-GA; FlowerDocs
yearly; `fast2` support planned). uxc therefore detects the server VERSION it talks to and
branches on **capability flags**, never on raw version strings in adapters (`lib/dialects.mjs`).

**Detection** (once per product per run, cached on ctx; precedence):
1. operator pin — targets.json `fdVersion` / `aiVersion` (env `UXC_FD_VERSION` / `UXC_AI_VERSION`);
2. version endpoint — FlowerDocs Core `GET /core/actuator/info` → `{version:"2026.0.0", build}`
   (verified live, LEARNINGS §25); uxopian-ai exposes NO version surface as of 2026-07;
3. capability fingerprint — uxopian-ai: `GET /api/v1/admin/prompts` answers 200-array on 2026-07+
   builds and 500'd on 2025-era gateways; on 2026.0.0-ft5 its rows carry their served `version`
   (an empty list falls back to `GET /api/v1/admin/plans`, same release) — one or two cheap probes.
   Pinned versions are PRODUCT versions (`2026.0.0-ft5`); letter+digit prerelease ids compare
   naturally (`ft10` > `ft5`).

**Registry contract**: `DIALECTS[product].ranges` = ordered `{name, max, caps}` entries (exclusive
upper bounds, newest open-ended). Supporting a new server release = ONE new range entry plus the
capability wiring it flips; dropping an old release = deleting its entry and raising
`oldestSupported` (the guarded code paths go with it). Versions newer than every known range get
the newest dialect + a warning; older than `oldestSupported` is a hard error. `uxc doctor` prints
the detected version, dialect and caps per product.

**Capabilities wired today**: `vfInstanceCreatePath` (FD 2025 trailing-slash vs FD 2026 no-slash —
dialect picks the first attempt, the 404/405 fallback stays as safety net);
`adminPromptList` (2026-07+ gateway: prompt reads use the ADMIN list with FULL objects — the lossy
user-list projection stops mattering; audit fields stripped in canonicalization);
uxopian-ai **2026.0.0-ft5** (`ai-2026-ft5`): `promptVersioning` + `promptWrite: 'versioned-v1'`
(draft → publish; `uxc run --prompt-version`), `goals: false` (ai.goal → `unsupported`,
`run --goal` refused), `agenticPlans` (ai.agent, ai.plan, `run --plan`), `applications`
(ai.application, `run --application`).

**Kind dialect gate** — `adapter.serverSupport(ctx)` → `null | reason`: a kind the connected server
does not have (ai.goal on ft5, the agentic kinds and applications before it) classifies
**`unsupported`** in status, and pull/push/verify skip it with the reason instead of failing the
run. One package can therefore carry both generations and deploy what each server understands.

**Write strategies**: kinds whose write API may change per release dispatch through a strategy
table selected by a capability (ai.prompt: `caps.promptWrite` → `WRITE_STRATEGIES['admin-v1']` =
{shape, create, update}). An API change — a different create flow (working copies) or a body
reshape (a field turning mandatory, or the contrary) — is a NEW strategy + one dialect range
flipping the capability; the adapter body never changes. An unknown strategy name fails with
"upgrade uxc" guidance (a newer server than this client knows).

**Package-side server gate — `supportedVersions`** (mirror of `minClientVersion`): a manifest may
declare, per product, the server versions it was built for — multivalued patterns, ANY-match:

```json
{ "supportedVersions": { "flowerdocs": ["2025.*", "2026.*"], "uxopianAi": ["*"] } }
```

Pattern language: `*` (any) · `2025.*` (prefix) · `>=2026` / `>` / `<=` / `<` · exact. Enforced
before any write by `uxc push`, `uxc import`, and `uxc mp install` (pre-download, off the
marketplace-stored manifest): a server outside the patterns REFUSES with guidance; override with
`--ignore-server-version` (loud warning). Undetectable server versions (uxopian-ai today) make the
pattern unenforceable — warned, not blocked ( `["*"]` skips detection entirely). `mp publish`
validates the patterns parse.

## 19. Installation receipts (`uxc installed`)

A deployed package leaves a RECEIPT on every surface it targets, so anyone — with no package
checkout — can ask "what is installed here, at which version?" (`lib/receipt.mjs`):

- **FlowerDocs**: a document of the uxc-owned class `UxcPackage` (created on demand with five
  `Uxc*` STRING tagclasses), id **`UXC_PKG_<CODE>`** — deterministic, so per-package checks are a
  DIRECT GET (lag-proof, §25/LEARNINGS). Tags: `UxcPackageCode/Version/ClientVersion/InstalledAt/
  ArtifactSha`, plus `UxcCompat` (§26: the package's `dependencies` and `compat.requires`, JSON).
- **uxopian-ai**: a SYSTEM prompt **`uxcPkg<Code>`** whose content is the receipt JSON
  (`uxc-package-receipt/1`). Inert (no goal references it); visible in the admin UI by design.

Written automatically after `uxc import` (with the artifact sha) and after a FULL `uxc push --all`
(partial pushes don't bump receipts), always best-effort: a receipt failure warns and never fails
the deploy. `uxc installed [--code c]` lists receipts from both surfaces; `--write` stamps them for
the current package (backfill/repair).

**Owned upgrades (issue #52, decided 2026-10-01).** An upgrade unpacks into a FRESH dir (no sync
state), so every resource changed since the installed version used to classify as a no-base
`collision` and `--force` became mandatory — blunting a guard meant for FOREIGN same-id objects.
Decision: receipts now record **per-resource hashes** (`resourceHashes: {"kind/id": <first 16 hex
of the sync hash>}` — AI receipt JSON; FD tag **`UxcResourceHashes`** = `kind/id=<hex>,…`, its
tagclass created on demand like `UxcCompat`). The value is the sync base each resource has after the
deploy (= what the server holds). `import` passes them explicitly; `writeReceipts` otherwise derives
them from `ctx.pkg`'s sync state, so `push --all` and `installed --write` record them too. Backward
compatible: older uxc ignore the field; a server refusing the tag costs the hashes (warned, retried
without), never the receipt. 64-bit prefixes are ample to tell "unchanged" from "edited".
Import pre-flight (`reclassifyOwned`, both `uxc import` and `uxc mp install`, `--report` included):
a no-base `collision` whose kind/id is in the installed receipt for the SAME package code (any
version; `ownedByReceipt` merges both surfaces) is ours —
- recorded hash == server → state **`upgrade`** (base seeded = the server's current hash, pushed
  without `--force`; the push's TOCTOU re-read still refuses if it changes in between);
- recorded hash != server → **`conflict`** "edited on the server since <code>@<v> was installed",
  refused like any collision (`--force` overwrites the edit);
- receipt lists it but records no hash (written by an older uxc) → **`upgrade` with a warning**
  listing those resources: edits since the install are undetectable, but the receipt PROVES the
  object is ours, and refusing would keep `--force` mandatory for every pre-#52 install.
Never weakened: an id NOT in our receipt (foreign, another package's code, no receipt, receipts
unreadable, server re-read failed) keeps the plain collision refusal. A uxc release that changes
canonical hashing makes untouched objects look edited (a safe false refusal — `--force`). Results
carry `owned: {receipt, upgraded, unknownBase, edited}`.

## 20. Pre-install diagnostics (`uxc doctor --ready` / `--sandbox` / `--ai-smoke`)

Before installing on a new/unknown scope, `docs/DIAGNOSTICS.md` is the runbook and doctor is the
tool (`lib/preflight.mjs`): **--ready** = read-only layer checklist (base platform §23, dialects,
AI provisioning, LLM providers, receipts) — seconds; **--sandbox** = self-cleaning Zz* handler
probe answering "can handlers ACTUALLY execute here, and what does the GraalVM sandbox allow?" —
verdicts `SANDBOX_OK` / `NETWORK_BLOCKED` (exact denied classes; only the server team can fix) /
`NOT_FIRING`; fires FRESH events past the ~45s propagation window (§12/§27 — pre-window events are
lost) and uses a LOW RegistrationOrder (§27: high orders never execute); **--ai-smoke** = one real
LLM call through a throwaway prompt — the only way to prove a provider API key (masked on every
read surface). Browser-level E2E stays out of uxc (package tests design, #27).

## 21. Package variables (templating)

**Prior art studied (2026-07-09)** — four philosophies, one clear fit:

| System | Model | What uxc takes / rejects |
|---|---|---|
| **OpenShift Templates** | declared `parameters` (name/description/value/required/generate) + `${NAME}` substitution, rendered ONCE by `oc process`; `--parameters` lists them | **The chosen model** — `uxc import` IS `oc process \| oc create`. Rejected its `${}` syntax: `${…}` appears VERBATIM in our shipped content (fd.script JS template literals, prompt helpers `[[${…}]]`) |
| **Terraform variables** | typed declarations, `validation` (condition/error), `sensitive`, values via CLI/-var-file/`TF_VAR_*` env with strict precedence | Takes: `pattern` validation, `sensitive`, `UXC_VAR_*` env source, the precedence ladder |
| **Helm values** | values.yaml + `--set`/`-f`, templates re-rendered EVERY install/upgrade; "document every value" | Takes: `--var-file`, document-every-value. **Rejects the persistent-render model** — it would put templates inside the hash-sync loop (permanent phantom drift) |
| **Kustomize** | NO string templating — declarative overlays only | The guard-rail: templating stays OUT of the sync loop. A synced checkout is always CONCRETE |

**The mechanism**: manifest `variables` block + `{{uxc:name}}` placeholders (zero collisions,
verified against every existing package), rendered **exactly once at import/unpack** — before
remap, pre-flight, or any server write. Placeholders exist only in the artifact; the installed
checkout is concrete, so the 3-way hash sync never sees a template.

```json
"variables": {
  "gatewayUrl": { "description": "Uxopian AI gateway URL as seen FROM the FlowerDocs server",
                   "example": "http://gateway-service:8085", "required": true, "pattern": "^https?://" }
}
```

- **Values** (precedence): `--var name=value` (repeatable) > `--var-file values.json` >
  `UXC_VAR_<NAME>` env > declaration `default`. Missing required ⇒ refusal printing the full
  variable table (uxc is operator/Claude-driven: the "interactive prompt" is the caller asking,
  then retrying). `pattern` violations and unknown `--var` names refuse.
- **Rules**: placeholders NEVER in `uxopian-project.json`/`registry.json` (ids/sync keys stay
  concrete — publish and import both refuse); `sensitive: true` values are never persisted or
  echoed (`__sensitive__`) — but real secrets belong in the keychain, not variables.
- **Surfaces**: `uxc vars <pkg|slug>` lists variables + checks resolution (pre-download, from the
  marketplace manifest); `mp install`/`import` take `--var`/`--var-file` and fail BEFORE
  downloading when required values are missing; `mp publish` lints (undeclared placeholder =
  error, unused declaration = warning); `push` refuses a TEMPLATE checkout (unrendered
  placeholders in resource files — assets/README/CLAUDE.md excepted).
- **Records**: applied values land in `.uxc/variables.json` and ride in the installation receipt
  (`variables` field, sensitives masked) — `uxc installed`/the receipt prompt answer "how was this
  instance parameterized?".
- Future (deliberately not v1): OpenShift-style `generate: expression` values; a
  `uxc vars render --write` author-side materializer.

## 22. Package dependencies (v1: check-and-guide)

A package declares what must ALREADY be installed on the target (`lib/dependencies.mjs`, #46):

```json
"dependencies": {
  "uxoai": { "versions": ">=1.1", "slug": "uxoai-flowerdocs" },
  "llm":   "*"
}
```

Keys are **package codes** (the receipts §19 are the installed-ledger — works offline); `versions`
is a range in the §26 grammar (`satisfiesRange`: exact, `*`/`1.x`/`1.2.*`, `^1.2`, `~1.2`, `>=1.1`,
a space-AND set `>=0.4 <0.5`, `^1 || ^3`; a list is OR) — a superset of the §18 pattern language
it started with, so every pattern accepted before means the same (#109). ONE grammar everywhere:
`init --depends-on`, `verify` (an error, via `lintSchemas`) and `mp publish` validate with it
(`isValidRange`, `dependencyRangeErrors`), this gate and the upgrade report (§26) evaluate with it —
a range `init` writes is judged identically by both. `slug` only feeds the fix-it hint. Checked by `uxc import`,
`uxc mp install` (**pre-download**, off the marketplace manifest), full `uxc push --all`, and
`uxc doctor --ready` (L3 rows). An unmet dependency REFUSES with the exact ordered recipe
(`uxc mp install <slug> --target t   (variables? uxc vars <slug>)`); `--ignore-dependencies`
overrides loudly. Surfaces disagreeing on a dependency's version (partial deploy) are flagged.

Deliberately simple: **no transitive resolution, no lockfiles, no solver** — each install checks
its OWN dependencies, so a chain (contract-management → uxoai-flowerdocs → providers-set)
resolves naturally, one guided install at a time. v2 candidate (own session): `--with-deps`
auto-install, which must aggregate per-dependency VARIABLE tables (§21) into one refusal.

## 23. Upgrade pruning (removals are part of the version — DEFAULT)

Operator decision (2026-07-10): if cleanup is optional, nobody runs it and servers accumulate
crap — so resources REMOVED by a new package version are removed from the server BY DEFAULT
(`lib/prune.mjs`). Safety is the **confirmation**, not an opt-in flag:

- the removal list is ALWAYS computed and printed (`DELETE …` / `KEEP … (why)`);
- a TTY gets a y/N prompt; non-interactive callers must pass `--yes-removals` — **never silent
  deletion, never silent skipping**: declining still completes the upgrade and lists the skipped
  removals loudly with the exact `uxc rm` commands. `--keep-removed` is the explicit opt-out.
- policy-aware: `managed` kinds delete (handler removal sweeps every `_vN`; failed server deletes
  warn + continue); `createOnly` (taskclass §14!) and `external` are NEVER auto-deleted;
  `fd.dataset` (user data) and `fd.surfacing` (needs the old spec) are report-only.

Removal sources (precedence): the installed RECEIPT's **`resources` list** — every install
(uxc ≥ 0.11) records the exact kind/id list it deployed, making prune detection exact,
marketplace-independent, and available to PLAIN `import` upgrades too — then `push --all`'s
sync-state − registry diff (`rm --local` KEEPS its state entry as the prune marker), then
`mp install`'s old-version marketplace catalog (receipts written by older uxc). Cache-affecting
removals clear caches once at the end.

**Receipt ordering (field-reported 2026-07-10):** the receipt advances ONLY when the upgrade is
COMPLETE — removals confirmed, explicitly kept (`--keep-removed`), or none. A skipped/unconfirmed
prune HOLDS the receipt ("receipt NOT advanced…"), so the next run re-detects the upgrade and
re-offers the removals — an orphan can never strand behind an advanced receipt.

## 24. Package-embedded functional tests (`uxc test`)

Receipts (§19) say what is installed; **package tests say whether it WORKS** on this target.
A package ships `tests/*.test.mjs` (plain ES modules, never registry resources — they ride in
the `.uxpkg` and are inert to older clients). `uxc test` runs them SERIALLY in filename order
(`lib/commands/test.mjs`), each with a fresh `t` harness (`lib/testkit.mjs`):

- fixtures are minted `ZZTEST_<CODE>_<HINT>_<run8>` — namespaced, visible, doctor-scannable;
  `t.doc.create` REFUSES ids outside the namespace, and teardown (ALWAYS runs, LIFO) deletes
  ONLY what the harness tracked (`t.track('doc'|'task', id)` / `t.cleanup(fn)`); `--keep`
  keeps fixtures and prints them; raw `t.core` writes are possible but never cleaned — you own them.
- `t.waitFor(fn, {timeoutMs, everyMs, label})` is THE primitive for handler pipelines + search
  lag (§25 learnings: poll by DIRECT GET when the id is deterministic); `t.runPrompt` wraps
  lib/run.mjs (SSE quirks, cold-start retry); `t.answerTask` (ANSWER dispatches on the FIRST
  answer only, learnings §13); `t.expect/t.fail` throw TestFail (fail-fast per test).
- per-test `requires` pre-flight ⇒ **SKIP with the reason, never a failure** (a package must be
  testable on FD-only targets): `resources` (registry entry deployed — serverOf; an id the
  package does not carry resolves through a declared dependency whose receipt lists it, #115 —
  the skip reason names the dependency: not installed / installed but not listing it), `docs`
  (instance config like CT_CONFIG), `products`, `llmProvider`, `caps` (dialect capabilities §18).
- **safety gate**: tests create/delete real objects — the target opts in (`allowTests: true` in
  targets.json, `uxc target add --allow-tests`, env `UXC_ALLOW_TESTS=1`) or the caller passes
  `--yes`. Never surprise a production scope.
- a fully green run (0 fail, ≥1 pass) **re-stamps the installation receipt** with
  `UxcTestsPassedAt`/`UxcTestsResult` (FD tags + AI receipt JSON — `stampTestReceipt`, a targeted
  merge that never rewrites installedAt/version): `uxc installed` then answers both "what is
  deployed" and "when did it last prove itself". Exit 1 on any failure; `--json` for CI.

Out of scope v1 (PACKAGE-TESTS-DESIGN.md): declarative JSON tests, parallel execution,
browser/GUI assertions, CI orchestration beyond `--json`.

## 25. Several agents on one instance

Three weeks of driving uxc through coding agents on one shared FlowerDocs instance (a customer
POC, `docs/BACKLOG-AGENTIC.md`) produced a class of failure the single-operator design never had
to answer: two writers with no arbiter, a checkout with no opinion about which instance it belongs
to, and briefs full of "never do X" that get skimmed. The answer is the same in all three cases —
put the rule where the tool can enforce it, not where a human has to remember it.

### 25.1 The target lock (`lib/lock.mjs`)

The contended resource is the INSTANCE, so the lock key is the target NAME and the lock lives in
`~/.uxopian/locks/<target>.lock` — two clones of one package pushing to one server collide exactly
like two agents in one clone. `mkdir()` is the atomic test-and-set; the owner file carries
`{pid, host, cmd, at}`.

- **`write` is exclusive.** Writes serialise on the target. This is also what serialises handler
  deploys, which is the point of §7.11's rotation window: two rotations at once lose events in each
  other's shadow.
- **`read` NEVER waits.** A `status` that queues four minutes behind a `test --yes` campaign is
  what made the POC wrap uxc in a shell script. Reads take no lock; when a writer holds one they
  say who, so a surprising read explains itself.
- **Orphans**: a lock owned by a dead pid on this host is stolen immediately; one older than
  `maxAgeMs` (30 min) is stolen with a warning — the only recovery available for another host's
  lock, which we cannot probe.
- **The blind window outlives the process.** A rotation's ~45 s window (LEARNINGS §36) starts when
  push exits, so it is recorded in a file that survives release (`recordHandlerWindow`), and the
  next handler-touching write waits it out (`waitHandlerWindow`) instead of opening a second,
  overlapping one. `--settle` already sat through it under the lock, so it records nothing.
- Modes are declared in `lib/cli-meta.mjs` (`LOCK_MODES`), one audited place; a command may export
  its own `lock`, including a function of its flags — `uxc test --offline` takes none; a
  `LOCK_MODES` value may be such a function too (`import`/`mp-install --report` are reads, §26).
- Escape hatches: `--no-lock`, `--lock-timeout <s>`.

### 25.2 The package's operating policy (`lib/agent.mjs`)

`uxopian-project.json` gains an optional `agent` block. Absent, uxc behaves exactly as before.

```json
"agent": {
  "target":    "gfdefault",
  "protect":   ["fd.handler/PoEmail_onCreate"],
  "neverPull": ["ai.prompt/*"],
  "forbid":    ["push --changed"],
  "gotchas":   "docs/GOTCHAS.md"
}
```

- **`target` pins the instance.** `--target` may only CONFIRM it; naming another is refused
  (`--allow-target-mismatch` is the deliberate way out). A differing ambient default is refused for
  WRITES — confirm with `--target <pin>` — and warned for reads, which must stay usable.
  `.uxc/target` (one line) overrides the manifest pin for a single checkout.
- **`protect`** — naming a protected resource explicitly is an ERROR; a sweep (`--all`/`--changed`)
  skips it with a printed line. A sweep never meant to single it out; a direct hit did.
- **`neverPull`** — same split, for resources whose server copy is older on purpose.
- **`forbid`** — command shapes: `<command> [--flag | positional-glob]…`, all conditions ANDed.
  Two-word commands (`data push`) are matched whole.
- **`gotchas`** — a path surfaced by `uxc context`.

Enforcement is a preamble (`lib/session.mjs`) that runs before every command's `run()`.

### 25.3 Offline lints (`lib/lint.mjs`)

Checks whose BOTH halves live in the package hold with or without a server, and — more usefully —
BEFORE a push rather than after a 500 that left half the plan deployed. `verify` runs them all;
`push` runs them as a pre-flight.

- **Constrained tag values** (BLOCKING, `--ignore-lint` overrides): a CHOICELIST tag value outside
  its tagclass's `allowedValues` is the `500 F00020` that killed a `push --changed` mid-run. The
  message names the admitted values. Only CHOICELIST is constrained (FREELIST is open by design)
  and only package-owned tagclasses can be checked.
- **Prompt variables** (WARNING, never blocking): a `[[${var}]]` no caller provides makes the
  gateway HANG to timeout with no error code — the most expensive failure shape in the backlog.
  Evidence is required: a variable counts as provided when it is an object key OR simply named
  anywhere in the call (a key gathered asynchronously, a spread). A prompt with no caller in the
  package is informational only — it may be called from another client entirely.
- **Include order** (BLOCKING when declared): `"includeOrder": ["po-lib.js", …]` is declared once;
  every composed source's directives must be a SUBSEQUENCE of it (a source need not use every
  library — it must only not contradict the order).
- **Composed size**: what a resource composes to versus the ~1 MB server body limit, plus what
  `// @include <file> strip` would still save. `uxc size` reports it on demand; `push` warns.
- **Class-model references** (#117, `lintClassReferences`): the tag classes a class / vfclass /
  taskclass names (`tagReferences[].tagName`), its `tagCategories`, a tag category's `tags`, a VF
  instance's `data.classId`. Resolved by a registry entry (any policy — `external` is the "exists
  on the target" marker; a `fd.tagclass-delta` id resolves a tag reference) or a declared
  dependency's id prefix (offline, the prefix is the evidence). `untracked` = the conventional
  local file exists outside registry.json, so a push never deploys it and the server answers
  F00205: verify FAILS, push REFUSES a planned resource carrying it (`--force` pushes anyway).
  Anything else is a WARNING (platform tag classes live outside every package). `push --all` also
  warns once with the untracked files it skips (it deploys the registry, not the tree).

### 25.4 Agent ergonomics

- **`uxc context`** — the package map an agent otherwise rebuilds by grep: kinds and counts, ids,
  prefixes, registrationOrder bands, include order, policy, size budget, sync state, gotchas.
  Offline, deterministic, ~600 tokens for a 180-resource package.
- **`uxc test --offline`** — the tier that needs nothing but the checkout. A test declares
  `offline: true` and gets a harness WITHOUT core/gateway plus `t.loadShared(path, globals)`, which
  evaluates a `_shared` library (`@include` expanded, as a push would) in a `node:vm` sandbox. It
  takes no lock and skips the safety gate and the receipt stamp. A green offline book is necessary,
  never sufficient: handler scripts run on GraalJS, where `String` is `java.lang.String` (§32).
- **Composed sources are never flattened by `pull`.** `--force` means "server wins over my edits";
  it does not mean "dissolve my build". Flattening a 22-line composer into its 13 000-line
  expansion (LEARNINGS §35) needs its own consent, `--flatten`, and the refusal parks the server
  copy under `.uxc/pulled/` so the comparison is still possible.
- **`push --paths a,b`** scopes `--changed` to the files this task owns, so a sweep stops shipping
  another agent's half-done work.
- Category-aware reads: `search --category VIRTUAL_FOLDER|FOLDER|TASK`, `ls fd.vfinstance` really
  enumerating, `get <id>` falling back to the virtual folder, and `get --raw-tag <name>` printing
  one TEXT tag verbatim for a pipe (LEARNINGS §39).

### 25.5 First contact with an unpinned package (#110)

The global default target (`targets.json` `default`) is chosen once for every package on the
machine. A NEW package that pins nothing silently inherited it — `uxc doctor` in a fresh extension
cleared the GUI caches of a server nobody chose for it. The preamble (`lib/session.mjs`,
`firstContactGuard` in `lib/agent.mjs`) now asks one question before a command runs: did anyone
choose this instance for this package? Yes when ANY of: a pin (`agent.target`, `.uxc/target`), an
explicit `--target`, an env target (`UXC_TARGET`, `UXC_URL`/`UXC_CORE_URL`), or sync state already
recorded for that target in `.uxc/state.json` (the package was used there before — existing
checkouts are never blocked). Otherwise:

- a **write** (the command's declared mode, `--no-lock` notwithstanding) is refused before any
  request, naming the global target and the two ways to choose (`--target <name>`, or a pin);
- a **read** runs, with one stderr line naming the target and its origin (stdout and JSON mode
  untouched);
- an offline command (mode `none`: `verify --offline`, `test --offline`, `context`…) is unaffected.

The same review made the read-only paths actually read-only: `verify --offline` (= `--static`)
creates no client at all, `doctor`'s default gauntlet no longer sends `DELETE /gui/rest/caches`
(`--write-probes` does; it, `--roundtrip`, `--sandbox` and `--ai-smoke` make doctor a `write` —
`doctorLockMode`), and a flag the command does not read is WARNED about on stderr instead of being
dropped in silence (`unknownFlags` in `lib/cli-meta.mjs`, from the same introspection the #99 lint
uses, plus the helper modules a command hands its flags to). A warning, not a refusal: no
per-command flag set is provably complete (`uxc add` passes every flag to a kind template), and a
command that works today with a valid flag must keep working.

## 26. Upgrade report and compatibility (`compat.json`, `--report`)

Before a new version of a product lands, say for each installed extension that depends on it:
**holds**, **review** or **breaks**, with the reason and the remedy (`lib/compat.mjs`, pure).
uxc stays generic: it compares SETS declared in a file, and never learns what a family or an id
means. A package MAY ship `compat.json` (`uxc-compat/1`; manifest field `compat` = a path, default
`compat.json`, or the inline object):

```json
{ "kind": "uxc-compat/1",
  "provides": { "<family>": { "contract": "v1", "ids": ["a"] | { "a": { "params": ["p"] } } } },
  "requires": { "<depCode>": { "versions": "^1.2", "families": { "<family>": { "contract": "v1", "ids": [...] } } } },
  "renames":  { "<family>": { "<oldId>": "<newId>" } } }
```

- **`requires.<dep>.versions`** is a range (`satisfiesRange`, `lib/version.mjs`), a superset of
  the §18 pattern language: `set ( || set )*`, a set = space-separated comparators AND-ed, a
  comparator = `*` | `x` | `[op]partial` with op `>= <= > < = ^ ~`. `1.2.3`/`=1.2` exact (missing
  parts = 0, as in §18); `1.x`/`1.2.*` wildcard; `^1.2` = `>=1.2.0 <2.0.0` (`^0.2.3` =
  `>=0.2.3 <0.3.0`); `~1.2` = `>=1.2.0 <1.3.0`; `>=1.0 <2.0`; `^1 || ^3`. Prereleases order by
  semver precedence; the upper bound of `^ ~ x` excludes the next version's prereleases. A string
  array is OR. An unparseable range fails `validateCompat` (so `mp publish` refuses it).
  `versionSupported` (the server gate, §18) is unchanged; the dependency gate (§22) evaluates with
  `satisfiesRange` too (#109), so a dependency range means the same at install and in this report.
- **Receipts** keep what an installed package needs (§19): `dependencies` (normalized manifest
  block) and `requires` (= `compat.requires`), FD tag `UxcCompat`, AI receipt JSON fields. Absent
  when undeclared, so receipts of packages without either are byte-identical to before — and the
  `UxcCompat` tagclass / `UxcPackage` class reference is ensured only when that tag is written.
- **Judgement** (`judgeUpgrade(receipts, manifest, compat, {collisions})`): breaks = new version
  outside the range the extension declares (`requires.<dep>.versions`, else `dependencies`), a
  required id absent (remedy: its new name from `renames`, else "no replacement declared"), a
  family `contract` changed. Review = a required id lost parameters the extension names, or product
  resources edited on the instance (the pre-flight collision table, read only). Holds otherwise.
- **`uxc import <pkg|dir> --report`** and **`uxc mp install <slug>[@v] --report`**: read-only (the
  mp variant downloads and hash-verifies, then judges; an archive is unpacked to a scratch dir, a
  checkout is never rendered in place). Prints the table, one `remedy:` line per reason, `--json`
  gets `upgrade.rows`; **exit code 3** when a `breaks` line exists (2 stays "uxc failed").
  Takes the target lock in READ mode (`LOCK_MODES` is a function of `--report`): never queues
  behind a writer, never waits out a handler window. The scratch copy is removed on every path.
- **Install gate**: without `--report`, the same judgement REFUSES the install before any write
  when a `breaks` line exists; `--force` installs anyway with a warning. Only packages shipping a
  compat declaration are judged; everything else behaves exactly as before.
- `mp publish` validates the declaration and inlines it into the marketplace-stored manifest.

## 27. Extension packages: `uxc init --extension` and the prefix control

A package that EXTENDS another (declares it in `dependencies`, §22) is a partner's package: its own
code, its own id prefixes, deployed beside the product it extends. Two tools keep that honest.
Both stay generic: uxc compares prefixes and reads manifests; it never knows what the depended-on
package is. Everything package-specific comes from the depended-on package itself (its kit) or from
the generic built-ins.

### 27.1 `uxc init --extension <code> --depends-on <slug>@<range>`

`uxc init --extension acme --depends-on case-management@">=0.3" [--name …] [--dep-code cm]
[--kinds a,b | --kinds none | --no-examples] [--product-dir <checkout>] [dir]` (`--extension --code
acme` is the same). `<range>` is any §22/§26 range (`">=0.4 <0.5"`, `^0.4`, …).

- Writes the manifest of a NEW package (`code`, four prefix forms, `dependencies: { <depCode>:
  { versions, slug } }`, `extension: { of: <depCode> }`, `registrationOrderBands.fd.script` =
  `[950, 959]` so it never collides with a product band), registry, state, README, AGENTS.md +
  the CLAUDE.md pointer (§27.3; AGENTS.md says the package extends X and is held to its
  prefixes), and the examples.
- **Dependencies are keyed by package code** (§22), the slug is the marketplace hint. The code comes
  from `--product-dir`'s manifest, else `--dep-code`, else the slug when it is itself a valid code;
  otherwise the command refuses and names `--dep-code <code>` (#111: authors reach for `--code`,
  which is the extension's own code). Refusals: bad extension code, a code equal to the
  dependency's, a range outside the §22 grammar, an existing manifest, `--depends-on`/`--kinds`/
  `--product-dir`/`--dep-code` without `--extension`, an unknown kind.
- **Examples, one per extension kind, each with an offline test (`tests/NN-*.test.mjs`, green under
  `uxc test --offline`).** Where they come from is a decision:
  1. **The depended-on package's kit** (preferred). A package that wants to be extended ships an
     `extension-kit/` directory (relocatable with `"extensionKit": "<path>"` in its manifest) with a
     `kit.json` (`format: "uxc-extension-kit/1"`): `manifest` (deep-merged into the new manifest:
     `extension.library`, `extension.rowKeyTags`, bands…), `claude` (package notes, written to AGENTS.md
     after the uxc block — the field keeps its historical name), and
     `examples.<kind> = { summary, files: { dest: kit-relative source }, registry: [...], dataSets: [...] }`.
     Destinations and file contents are rendered with `{{code}} {{pascal}} {{camel}} {{kebab}}
     {{upper}} {{name}} {{dep.code}} {{dep.slug}} {{dep.range}} {{dep.version}}` (text files only;
     an unknown placeholder is an error, not a blank). A product therefore generates its kit from its
     proven bench (fixture with the names replaced by placeholders), never edits it apart. The kit
     is read from `--product-dir` (a checkout or an unpacked `.uxpkg`); uxc does not fetch it from
     a server or the marketplace yet. Kit paths must stay inside the kit and the package: every
     rendered destination, `registry[].path` and `dataSets[].path` is refused when absolute, when it
     climbs out with `..`, or when a segment is not a portable file name (Windows `<>:"|?*`, a
     trailing dot or space, a reserved name) — so `{{name}}`/`{{dep.range}}` never belong in a path.
     `manifest` is rendered value by value (keys included), never as JSON text: a quote in `--name`
     is data, not syntax.
  2. **Generic built-ins** when there is no `--product-dir` or the dependency ships no kit: kinds
     `script` (a browser script from the `fd.script` template, in the band), `prompt` (an `ai.prompt`),
     `dataset` (a document class, a dataset bound to it and one row). They are built through the same
     kind adapters as `uxc add`, so the mechanics are the tool's. Their tests are self-contained (no
     import from uxc): the resource is registered, its id carries the package's prefix and not the
     dependency's, its files parse.
- `--no-examples` (= `--kinds none`, #111) writes the skeleton only: the manifest (dependency,
  prefixes, `extension` block, a kit's `manifest` merge when `--product-dir` has one), registry,
  state, README, AGENTS.md + CLAUDE.md, and an empty `tests/` (`.gitkeep`) — no example resource,
  dataset or test, for an author starting from real resources. `uxc test --offline` on it is green
  (no tests = nothing to fail). `none` cannot be combined with other kinds, nor `--no-examples`
  with `--kinds <kinds>`.
- `--kinds` selects examples (`--families` is an accepted alias). The package is assembled in a
  staging directory and copied in only when everything rendered: a kit that fails half-way never
  leaves a manifest that blocks the retry. The staging directory is removed on every exit path.
  A file the kit would write that already exists in the target is refused (listed) unless
  `--force`; an existing `CLAUDE.md` / `AGENTS.md` is kept and gets the uxc block (§27.3).
- No version bump: `init` writes `version: 0.1.0` for the partner's package; uxc's own version is
  left to the release.

### 27.2 The prefix control (`lib/extension.mjs`, run by `verify`, `push` and `mp publish`)

`lintExtension(pkg)` is pure and offline; findings are blocking (`push --ignore-lint` overrides).
It also carries the tag-class delta lint (`lintTagDeltas`, §28: `EXT_TAG_*`, `where` =
`fd.tagclass-delta/<id>`), so `push` and `mp publish` refuse a bad delta in the same pass; `verify`,
which runs `lintTagDeltas` on its own as well, skips the duplicates by `findingKey` (code + id) (#93).
Two tiers, so a package that merely depends on another (for instance on a provider bundle) is not
broken by a rule it never opted into:

| Tier | Code | Refuses |
|---|---|---|
| any declared dependency | `EXT_PRODUCT_RESOURCE` | a non-external registry resource whose id carries a dependency's prefix |
| | `EXT_PRODUCT_ROW` | a dataset row (or tombstone `_id`) carrying a dependency's prefix |
| manifest `extension` block | `EXT_PRODUCT_CODE` | the package's code equals a dependency's (without the block it is the tolerated self-reference the dependency check ignores, `lib/dependencies.mjs`) |
| | `EXT_NO_DEPENDENCY` | `extension` declared, no dependency |
| | `EXT_FOREIGN_RESOURCE` | a non-external resource outside the package's own prefixes |
| | `EXT_ROW_PREFIX` | a dataset row outside the package's own prefixes |
| | `EXT_ROW_KEY` | a row whose logical key tag (`extension.rowKeyTags.<classId>` or `*`) does not end, after its last `. / : > \|`, with the package's UPPER prefix |
| | `EXT_LIBRARY` | a server-only `fd.script` (`registrationOrder: null`) without `extension.library.classId` or whose last non-blank line is not `extension.library.endMarker` (`{id}` = the script id) |

Decisions: a resource is "ours" when the conventional id for its kind under our prefix is the id
itself (§`naming.mjs`, so handlers/scripts/prompts follow their kind's form); `ai.llm`, `ai.goal` and
`fd.surfacing` ids are exempt (global or routing names); `policy: external` resources (referenced,
not owned) are exempt, which is how an extension names a dependency's class. "Carries a prefix" is
strict about word boundaries (`Cmd` and `cmdFoo` are not `Cm`/`cm` ids). The package's own
prefixes are its manifest `idPrefixes` when set (custom forms), else those derived from its code. Own-prefix wins over a
dependency's when they overlap. The registration check of the product's capability registry
(the spec's `EXT_REGISTRATION`) is NOT here: it needs the product's code and stays product-side
until the product publishes a machine-readable capability file; uxc will then compare sets, as the
compatibility report does. `uxc explain <CODE>` documents each finding.

### 27.3 AGENTS.md and the CLAUDE.md pointer (`lib/agents-md.mjs`, #98)

Partners may run Codex or Cursor rather than Claude, so the agent context is tool-neutral.
Both `init` forms write `AGENTS.md`: what the package is (code, name, version, owned prefixes,
EXTENDS/depends-on), the operating rules (uxc for all server work; `uxc context` first; `uxc
verify` before push; own prefixes only — and never the dependency's; never guess an API shape,
find the learnings with `uxc help --search`; one pinned target), the day-to-day cheat-sheet and the
test commands — ≤ 80 lines. CLAUDE.md gets only a pointer to it plus the Claude-only bits (the
skill and the `/ux-*` slash commands).

- **One uxc-owned block per file**, between `<!-- uxc:begin -->` and `<!-- uxc:end -->`. Text
  outside the markers is the author's: an existing file is kept and the block appended; a file
  that has the block gets only the block replaced. CRLF files stay CRLF. Neither file ever counts
  as a `--force` collision.
- **Rendered from the manifest only**, so it is deterministic. The pin shown is `agent.target`;
  the per-checkout `.uxc/target` is NOT read (AGENTS.md is tracked and must not differ per clone).
  A kit's `claude` notes go AFTER the block, since a refresh has no kit to re-read.
- **Refresh**: `init` refuses an existing manifest, so re-rendering is `uxc context --agents-md`
  (prints the block) `--write` (upserts AGENTS.md, creating it if absent, and the pointer block of
  an existing CLAUDE.md; reports "already up to date" when nothing changed). An older package's
  unmarked CLAUDE.md stanza is left in place — delete it by hand.

## 28. Tag-class deltas (`fd.tagclass-delta`)

An EXTENSION package cannot edit the product's CHOICELIST tag classes (task types, e-mail situations,
integration systems) — it does not own them — yet needs its own values in them. A **delta** is that
mechanism: `fd/tagclass-deltas/<Tag>.delta.json`, `{ "tagclass": "<Tag>", "allowedValues": [ {symbolicName,
displayNames} ] }`; the registry id is the TARGET tag class name (verbatim, never project-prefixed).

- **Push** (`lib/kinds/fd-tagclass-delta.mjs`): `GET /rest/tagclass/{id}`, merge by `symbolicName`,
  then **re-GET immediately before the write** and rebuild the merge on that fresh copy (a
  `lastUpdateDate` change between the two reads is printed), `POST /rest/tagclass/{id}` (array body,
  the fresh object with the merged `allowedValues`), re-GET to confirm — the read-back must hold every
  added value AND every value of the pre-POST read, else the push fails loudly naming the LOST values.
  **Residual race:** FlowerDocs has no conditional write (no If-Match / version check on the tag class
  POST), so a writer whose own full replace lands while our ~65 s POST is in flight can still erase our
  values, or we its values. The pre-POST re-read shrinks the window from "read … write" to the POST
  itself; the post-write check catches the case where our write erased theirs; the case where theirs
  erased ours shows up in `status --remote` (`absent: …`) and a re-push restores it.
- **Dropped values**: `ownValues` (the delta's names) is recorded in state at every push AND whenever
  sync records a base without calling the adapter (adopted/rebased/pulled — the `baseState` hook), so
  first-push-when-already-present is covered. A value in recorded `ownValues`, no longer in the file,
  carrying the package prefix, is an **orphan**: `status --remote` reports it (row `local`) and the next
  push removes it (`orphans` hook: push writes even when the slice is unchanged) with a printed line.
  Without a package prefix nothing is ever removed.
  The merge is `mergeTagDelta` in `lib/tagdelta.mjs`: PURE and exported, so the product's own
  `fusionnerDelta` uses the same logic. It appends what is missing, **never removes or renames** a
  value; labels of an existing value are refreshed only when the value carries the package prefix.
- **Hash**: the server side of the comparison is the *slice* of the tag class the delta names (its own
  values, projected to `symbolicName` + `displayNames`, sorted). The product's other values never read as
  drift, and an unchanged delta is **skipped without a write**. The kind sets `mergeOnPush` +
  `onlyMissing`: when the server slice differs from the file ONLY by values the server lacks, a merge
  cannot clobber, so `sync.mjs` skips the collision/conflict refusals and `--recreate` and classifies
  `local` (push merges the rest). A value BOTH sides hold with different labels (someone relabelled an
  extension value on the server) is a real server edit and keeps the normal refusals: status says
  `server edit — uxc pull`, and plain push refuses (`--force` overwrites) — like every other kind.
- **Order and pace**: last in `PUSH_ORDER`, one at a time (a module-level mutex besides the sequential
  loop). A tag class write takes ~65 s on fd.demo (the POST timeout is 240 s, not the default 60 s), so
  the kind prints what it is doing before and after each write. Never parallelize.
- **`rm --server`** (and upgrade pruning) removes only the extension's own values — names from the local
  file, or `ownValues` recorded in state when the file is gone, AND carrying the package prefix.
  The tag class and the product's values stay. When neither the file nor `ownValues` exists, nothing is
  removed and the warning lists the prefixed values found on the server as candidates.
  **`status --remote`** says `n/m values present — absent: …` (plus `orphaned: …`).
- **Interaction with the product's own `fd.tagclass` push.** The product package owns the tag class as a
  whole (`fd.tagclass`, full replace, hash of the WHOLE object). Once an extension delta is on the server:
  the product's `status --remote` sees its tag class as **server-changed** (`server edit`); a **forced
  product push** (`push --force`, or an upgrade that replaces the class) **wipes the extension's values**;
  a **product pull** absorbs them into the product's file (they then ship with the product — avoid it).
  Recommended procedure: never pull the product's tag class on an instance carrying extensions; after a
  product upgrade/forced push, **re-push every extension's deltas** (`uxc push` in each extension — the
  merge re-adds only what is missing); `uxc status --remote` in the extension detects the wipe
  (`absent: …`, row `local`).
- **Offline checks** (`lintTagDeltas`, run by `verify` and by `push` validation):
  `EXT_TAG_VALUE_PREFIX` (value lacks the manifest's uppercase prefix), `EXT_TAG_CLASS_UNKNOWN`
  (no/mismatched `tagclass`; online: class absent or not a CHOICELIST), `EXT_TAG_DELTA_OWN` (the target is a
  tag class this package owns). They live in `lib/tagdelta.mjs`, not `lib/extension.mjs`, so this PR has no
  file in common with #87; the extension prefix control (§27.2) now calls `lintTagDeltas` too (#93).
- Not done on purpose: no cache clear (tag classes are read live), no version bump, no GUI refresh hook —
  the product regenerates its own label catalogue after a delta (`CAPABILITIES`).

## 29. JSON Schemas for the package files (`schemas/`, `$schema`, `verify`)

The package files stay declarative JSON; uxc ships a JSON Schema (draft 2020-12) for each, so an
editor (and an agent through its LSP) completes and checks them while typing, and `uxc verify`
checks them with the same files (#97, BACKLOG-AGENTIC §27.4).

| File | Schema |
|---|---|
| `uxopian-project.json` | `uxopian-project.schema.json` (an inline `compat` object refers to the compat schema) |
| `registry.json` | `registry.schema.json` (the `kind` enum = `Object.keys(KINDS)`, held by a test) |
| `marketplace.json` | `marketplace.schema.json` |
| `compat.json` (or the manifest's `compat` path) | `compat.schema.json` |
| `fd/tagclass-deltas/<Tag>.delta.json` | `tagclass-delta.schema.json` |
| `fd/scripts/<id>/meta.json` · `fd/guiconfig/<id>/meta.json` · `fd/handlers/<L>/meta.json` | `fd.script.meta` · `fd.guiconfig.meta` · `fd.handler.meta` |

Schemas are derived from what the code reads (adapters' readLocal/validate, `validateCompat`,
`validateMarketplace`, the manifest readers) and are **open**: unknown keys are allowed everywhere,
so no package that works today is rejected by an editor or by verify. The other resource files
(class JSON, prompts, plans…) mirror server DTOs and have no schema yet.

- **`$id` and `$schema` (decision).** Each schema's `$id` is the raw GitHub URL of the file on main,
  `https://raw.githubusercontent.com/Uxopian/uxopian-node-client-experimental/main/schemas/<name>.schema.json`
  (`SCHEMA_BASE`, `lib/schemas.mjs`), and scaffolds write exactly that as `$schema`. Rejected: a
  relative path to the installed uxc (machine-specific, breaks for every other clone and in an exported
  `.uxpkg`); copies of the schemas inside each package (stale as soon as uxc changes, and exported
  noise); a `.vscode/settings.json` mapping (editor-specific). The URL is the same on every machine, an
  editor that downloads schemas (VS Code does by default) resolves it once the file is on main, and an
  offline editor only loses the hints. `uxc verify` never goes to the network: it reads the copies shipped
  under `schemas/` and resolves `$ref`s by `$id`. If the repository moves, change `SCHEMA_BASE` and the
  `$id`s together; existing `$schema` values stay harmless (an editor hint, never read by uxc).
- **Who writes `$schema`.** `uxc init` (manifest, registry), `init --extension` (the same, plus the generic
  script example's meta.json; a kit's own files are the kit's business), `uxc add` for the kinds above
  (meta.json, `*.delta.json`), `uxc mp init` (marketplace.json). There is no compat.json scaffold: its
  author adds the `$schema` line by hand.
- **`$schema` is never content.** `canonicalize()` deletes a top-level `$schema` for every kind, so it
  changes no hash (no server echo carries one: existing hashes are unchanged, tested per kind and per
  example resource). The class-kind create/update body drops it; script/guiconfig/handler/delta pushes
  build their bodies from named fields; `mp publish` strips it from the stored manifest and inlined
  compat. Every `writeLocal` that rewrites a JSON file from the canonical form (pull, push echo leg)
  keeps the `$schema` the file on disk carries (`keepSchemaKey`), so a pull does not churn the file.
- **Validator** (`lib/jsonschema.mjs`, zero-dep): the subset the schemas use — type, enum, const,
  pattern, min/maxLength, minimum/maximum, min/maxItems, items, properties, required,
  additionalProperties, propertyNames, allOf/anyOf/oneOf, not, `$ref` (local and by `$id`). A test
  refuses a schema that uses any other keyword. Paths are readable (`resources[3].kind`).
- **Severity (`x-uxc-severity`).** A finding is a **warning** unless the schema node holding the failing
  keyword says `"x-uxc-severity": "error"` (it covers that node's own `$ref`, not its children). Schemas
  set it only where uxc already refuses the same input: the handler/script/guiconfig `validate()`
  rules, the delta checks (`checkTagDelta`), `validateCompat` (import/mp install refuse), an unknown
  registry `kind` (sync throws), a non-semver `minClientVersion` (the client gate throws).
  Marketplace findings stay warnings: `mp publish` is their gate. `verify` prints errors as `FAIL` lines
  (exit 1) and warnings as warnings (`lintSchemas(pkg)`, offline, with the other §25 lints).
- Checked on every local package at implementation time (the examples/ packages and 16 other local
  packages, customer POCs included): no error, no warning.

## 30. Legacy values in a tag-class delta (`"legacy": [...]`)

An extension split out of a product sometimes inherits values that already live in a product tag class
under UNPREFIXED codes (the Purchase Order Management extension `po` owns `ORDER` in the product's
`CmCaseType`; renaming it `PO_ORDER` would touch every case, notebook and id prefix). A delta declares
them: `{ "tagclass": "CmCaseType", "legacy": ["ORDER"], "allowedValues": [ {ORDER…}, {PO_QUOTE…} ] }`.

- **Declared AND listed**: each `legacy` name must also be in `allowedValues` (with labels), else
  `EXT_TAG_LEGACY`. `legacy` not an array of strings is the same code.
- **Lint** (`lintTagDeltas`, `verify`, push validation): `EXT_TAG_VALUE_PREFIX` skips declared legacy
  values; every other value still needs the prefix. `legacyOf(delta)` is the pure accessor.
- **Push**: unchanged merge (`mergeTagDelta`): a legacy value the server lacks is appended; one the
  server already holds is left byte for byte (never relabelled).
- **Declared ≠ removable.** The declaration only exempts a value from the prefix lint. uxc removes an
  unprefixed value (`rm --server`, upgrade pruning, orphan removal on push) ONLY when it is in the
  state's `legacyAdded`: the declared legacy values that a push of THIS package actually ADDED to the
  server (`added ∩ legacy` of the write, accumulated across pushes, narrowed to what the delta still
  declares). A declared value already on the server when the package arrived (adopted, or present at
  merge time) is never recorded there: it is the product's value. `status --remote` and `rm --server`
  print it as `kept: <V> — legacy value present before this package`. No base record (adopted /
  rebased / pulled — `baseState`) ever writes `legacyAdded`.
- **Dropping a legacy value** from both `legacy` and `allowedValues`: if it is in `legacyAdded` it is an
  orphan and the next push removes it; otherwise uxc just stops tracking it (`ownValues` loses it,
  the server keeps it) and push prints `no longer tracked: <V> — … left on the server`.
- **The key survives rewrites, unhashed.** The canonical (hashed) form stays `{tagclass, allowedValues}`
  — a delta hashes identically with or without `legacy`, and as before §30. The push echo leg and pull
  rewrite the file through `jsonLayout.writeLocal`, whose `keepLocal(prevFile, canon)` hook re-attaches
  the file's `legacy` (narrowed to the names still listed — a pull never leaves `EXT_TAG_LEGACY`), the
  way `$schema` is kept (§29). Pull records its base extras from the file AS WRITTEN.
- State per target: `{ownValues, legacyValues (declared, informational), legacyAdded (removable)}`;
  `baseState` records the first two only.
- Schema `schemas/tagclass-delta.schema.json` documents `legacy`; `uxc explain EXT_TAG_LEGACY`.

## 31. `data push --prune` and row ownership across installed packages

A dataset can be fed by several installed packages: the Case Management product and an extension (the
Purchase Order Management `po`) both contribute rows to `CmTeams`. `--prune` deletes "server rows absent
from MY local file" — in a shared dataset that is the OTHER package's rows. It now never does.

- **Who owns a row** (`lib/ownership.mjs`): the other packages on the target, read from the installation
  receipts (DESIGN §19, `readReceiptsChecked`, both surfaces) plus the manifest's declared `dependencies`
  (an offline floor: receipts unreadable still protects the dependency). Never the package itself. A
  package owns the ids carrying its prefix forms, always derived from its code (`prefixForms`:
  `Cm`/`cm`/`cm-`/`CM_`) — receipts carry no `idPrefixes`, so only THIS package's manifest
  `idPrefixes` is honoured.
- **Longest prefix wins** (`prefixMatchLength`): each id goes to the package whose matching prefix form
  is LONGEST, across this package and every other one (own `cm` + installed `cm2`: `Cm2Team`, `cm2Team`,
  `cm2-x`, `CM2_X` are cm2's — they used to be pruned as cm's). Between foreign packages too, so the
  warning names the right owner. A tie goes to this package. Boundaries: `CM_`/`cm-` carry their
  separator (kebab case-insensitive); after pascal/camel the next char must start a word — for OUR
  claims (what we may delete) an uppercase letter only, for ANOTHER package's protection also a digit or
  `_` (`carriesForms`' lenient rule, so an unknown `Cm2024Team` still shields under `cm`). The asymmetry
  only ever errs on keeping. Matrix in `test/data-prune-ownership.test.mjs` (cm/cm2/cmx, ct/ctx).
- **Receipts readable vs not** (`readReceiptsChecked`; `readReceipts` keeps swallowing errors for its
  other callers): only proven absence is "no receipts" — FD search error + `UxcPackage` class absent, or
  a gateway 404. Any other error = unreadable, and then rows not provably ours are never deleted.
- **Decision per server row** (`splitRowOwnership`, pure -> `{own, foreign, unproven}`): our prefix
  longest -> ours, deletable; another package's prefix longest -> theirs, kept; no known prefix ->
  deletable exactly as before when receipts were READ, else `unproven`, kept (also under `--yes`).
- **Output**: the kill list (and `--yes` deletion) contains only our rows; foreign rows are named in one
  warning with their owner (`belong to another installed package (cm) — kept, never deleted: …`),
  unproven rows in another with the read error (`installation receipts could not be read (…) — … kept`);
  the result carries `keptForeign: [{id, code}]` and `keptUnproven: [id]`. A dataset whose only orphans
  are kept prints no kill list.
- **Every delete path**: `fd.dataset` `remove()` — reached by `rm --server`, `destroy` and the generic
  push/upgrade prune — applies the same rule (own-prefixed + unprefixed when receipts are readable; never
  another installed package's rows; kept rows named) and returns `{deleted, keptForeign, keptUnproven}`.
  A package alone on the target (readable receipts, no dependency) deletes every row, as before.
- Unchanged: tombstone rows (`{"_id":…,"_deleted":true}`) are explicit and still delete; without
  `--prune` nothing is deleted.
- Limit: a row of another package that carries NO prefix of it (a legacy code such as `SUPPLY_PLANNING`)
  cannot be told from ours by id; keep such rows out of the prune by listing them in the local file or
  avoid `--prune` on shared datasets.
