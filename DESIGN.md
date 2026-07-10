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
| uxopian-ai gateway | `https://<host>/gui/plugins/<scope>/gateway/uxopian-ai` | same JWT, `token:` header — **live-verified 2026-06-12** incl. admin endpoints (`admin/goals`, `admin/llm/*`) |
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

A package is a plain directory; `.uxpkg` is a zip of it (export excludes `.uxc/`).

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
| 8 | `fd.acl` | JSON | 🧪 **policy `managed`** (full write). DTO `{id, name, entries[{principal, permission, grant}]}` (`principal:"*"`=all, `grant`=ALLOW\|DENY; no category/data). create `POST /rest/acl` ARRAY; update `POST …/{id}` FULL-REPLACE; delete `DELETE …/{id}`. **get-ALL 500s live (T01006)** → read BY ID only, no `list`/`scan`. Pushed BEFORE the classes that reference it (`data.ACL`). create/update/delete DOCUMENTED (pp.978-982), **round-trip pending live verify** (`uxc doctor --roundtrip`) → then ✅ |
| 9 | `fd.script` | meta+`.js` | ✅ Script-class doc; exists-check FIRST, fresh tmp per attempt (T00707); create or update-in-place (GET → `files:[{id:tmp}]` → `POST /rest/documents/{id}` ARRAY); keep `RegistrationOrder` tag; cache clear |
| 10 | `fd.guiconfig` | meta+`.xml` | ✅ as script, class GUIConfiguration. `validate()` **in the tool**: XML well-formed; bean-id uniqueness across the package; refusal list for live singleton bean ids (`componentProperties`, `componentActivityConfigurations` — merge-into, never redefine); `--check-collisions` lists bean ids across live GUIConfiguration docs |
| 11 | `fd.handler` | meta + resolved script/filter | ✅ see §7.11 below |
| 12 | `fd.surfacing` | `surfacing.json` | ✅ see §7.12 below |
| 13 | `fd.dataset` | JSONL | ✅ see §7.13 below |
| 14 | `ai.prompt` | meta JSON + `.content.md` | ✅ fields `id, role, content, defaultLlmProvider, defaultLlmModel, temperature, reasoningDisabled, requiresMultiModalModel, requiresFunctionCallingModel, timeSaved` (strip `createdAt`; normalize `temperature` to string in canonical form — echo-verified by doctor). Push = POST `/api/v1/admin/prompts`, 409 → PUT (id in body). List via **user** `GET /api/v1/prompts` — which can return a **reduced projection** (id+content only on some builds), so `readServer` overlays the echo on the local meta (server-present keys win → drift detectable; omitted keys fall back to local → config like `role`/`defaultLlmProvider`/`defaultLlmModel`/`temperature` is never lost on the push echo-leg writeback). Validate: `requiresFunctionCallingModel:true` ⇒ explicit `reasoningDisabled:false` (refuse push); helper calls linted against `GET /api/v1/admin/templating/completion` |
| 15 | `ai.goal` | `goals.json` | natural key **(goalName, promptId, filter)** — duplicate keys rejected at validate. Server row id is per-target → state. Reconcile reads `GET /api/v1/admin/goals` (filter client-side; `?goal_name=` used only once live-verified). **Only rows whose promptId belongs to the package are ever created/updated/deleted.** Import detects `index` collisions within a goalName vs foreign rows and re-bands with a printed report |
| 16 | `ai.mcp` | JSON | CRUD `/api/v1/admin/mcp/mcp-conf` (hot-reload server-side). Doctor verifies whether GETs mask header secrets; masked fields are excluded from the canonical hash (llmconf-style) and **push never overwrites a non-empty server secret with a placeholder** |
| 17 | `ai.llm` | JSON | CRUD `/api/v1/admin/llm/provider-conf` — LLM **provider configs** (provider + model catalog). Same secret contract as `ai.mcp`: `globalConf.apiSecret` echoes as `********` → masked to `__masked__` (never written to the package); on push `__masked__` resolves to the live server value, and a **fresh install ships an empty key** (operator sets it — an LLM provider is legitimately created keyless). `uxc ls ai.llm`. (Supersedes the former inspect-only `ai.llmconf`.) |

**Push order** (topological, always): acl → tagclass → tagcategory → documentclass →
taskclass → folderclass → workflow → vfclass → dataset → script → guiconfig → handler →
vfinstance → surfacing → ai.prompt → ai.goal → ai.mcp. Delete = reverse. (acl first: classes
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
| `uxc destroy [--dry-run]` | — | — | — | full reverse-order teardown of every non-external resource (unsurface → disable handlers → delete in reverse topo order → cache clear), `--dry-run` prints the list first; requires typing the project code to confirm |

Tombstoned (`retired`) resources never push by default; `push <id> --revive` un-tombstones.

## 10. import / export / code-remap

- `uxc export [-o name.uxpkg]` — zip of the package minus `.uxc/`; refuses if status vs the
  default target is dirty unless `--allow-dirty`; scrubs `ai.mcp` secret fields.
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

## 12. CLI surface

```
# package lifecycle
uxc init --name "…" --code ct [dir]            # scaffold + CLAUDE.md stanza for the package repo
uxc target add|ls|use …
uxc status [--remote] [kind|id…]               # drift + untracked + orphans + pendingCacheClear
uxc diff <id> [--base] [--full]
uxc pull [id…|--all]
uxc push [id…|--changed|--all] [--force] [--settle] [--recreate] [--revive]
uxc add <kind> <Name> [--title …] [per-kind args] [--from-file p]
uxc adopt --scan [--kind k…] [--yes]           # prefix-driven bulk discovery → checklist → registry+pull
uxc adopt <kind> <server-id> [--external]      # single
uxc rm <id> --local|--server|--both [--force]
uxc destroy [--dry-run]
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
        [--expect regex] [--max-chars n] [--fixture name] [--save-fixture name]
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
- `add ai.goal --goal <goalName> --prompt ctFoo [--filter expr] [--index n]`
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
  expectation failed, 2 error.

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
   builds and 500'd on 2025-era gateways — one cheap probe.

**Registry contract**: `DIALECTS[product].ranges` = ordered `{name, max, caps}` entries (exclusive
upper bounds, newest open-ended). Supporting a new server release = ONE new range entry plus the
capability wiring it flips; dropping an old release = deleting its entry and raising
`oldestSupported` (the guarded code paths go with it). Versions newer than every known range get
the newest dialect + a warning; older than `oldestSupported` is a hard error. `uxc doctor` prints
the detected version, dialect and caps per product.

**Capabilities wired today**: `vfInstanceCreatePath` (FD 2025 trailing-slash vs FD 2026 no-slash —
dialect picks the first attempt, the 404/405 fallback stays as safety net);
`adminPromptList` (2026-07+ gateway: prompt reads use the ADMIN list with FULL objects — the lossy
user-list projection stops mattering; audit fields stripped in canonicalization).
**Reserved**: `promptVersioning` (announced prompt versioning / working copies — will gate the
prompt write path + the post-create duplicate assertion when that release lands).

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
  ArtifactSha`.
- **uxopian-ai**: a SYSTEM prompt **`uxcPkg<Code>`** whose content is the receipt JSON
  (`uxc-package-receipt/1`). Inert (no goal references it); visible in the admin UI by design.

Written automatically after `uxc import` (with the artifact sha) and after a FULL `uxc push --all`
(partial pushes don't bump receipts), always best-effort: a receipt failure warns and never fails
the deploy. `uxc installed [--code c]` lists receipts from both surfaces; `--write` stamps them for
the current package (backfill/repair).

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
reuses the §18 pattern language; `slug` only feeds the fix-it hint. Checked by `uxc import`,
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

Removal sources: `push --all` = sync-state keys − registry keys (the state remembers everything
this checkout ever synced — and `rm --local` now KEEPS the state entry as the prune marker);
`mp install` upgrades = the INSTALLED version's marketplace catalog (via the receipt) − the new
registry; plain `import` upgrades have no reliable old list (noted in output — upgrade via
mp install for pruning). Cache-affecting removals clear caches once at the end.
