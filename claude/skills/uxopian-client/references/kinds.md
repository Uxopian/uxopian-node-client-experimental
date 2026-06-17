# Kind cheat sheet (17 kinds)

Registry id form: `kind/id` (bare id works when unique). Policies: `managed` (full sync),
`createOnly` (create if absent, then verify-only), `external` (never written/deleted).
Push order is topological and automatic; you never order writes yourself.

## fd.tagclass — managed
- Storage: `fd/tagclasses/<Id>.json`
- Fields: `id, type, searchable, displayNames[, allowedValues[{symbolicName, displayNames}]]`
- Types: STRING TEXT INT CHOICELIST DATE BOOLEAN ICON (there is NO "INTEGER")
- Add: `uxc add fd.tagclass CtFoo --type CHOICELIST --values "A,B" [--title …] [--fr …]`
- Gotcha: VF/aggregation pivot tags MUST be CHOICELIST. choicelist symbolicNames are UPPER_SNAKE.

## fd.tagcategory — managed
- Storage: `fd/tagcategories/<Id>.json`
- Fields: `id, tags[] (membership), icon, visible, inline, reduced, displayNames`
- Add: `uxc add fd.tagcategory CtConIdentity --title …`
- Gotcha: a category not listed in the class's `tagCategories` simply does not render — no error.

## fd.documentclass — managed
- Storage: `fd/classes/<Id>.json`
- Fields: `id, category:"DOCUMENT", active:true, tagReferences[{tagName,mandatory,readonly,order}], tagCategories[], displayNames`
- Add: `uxc add fd.documentclass CtBar --tags "CtFoo:mandatory,SourceContractId:readonly" --category-ids CtConIdentity`
- Gotcha: update is FULL-REPLACE and the LOCAL file is authoritative — a tagReference you delete
  locally stays deleted after push. Missing `category` at create = F00204.

## fd.taskclass — createOnly
- Storage: `fd/taskclasses/<Id>.json`
- Fields: `id, category:"TASK", workflow, autoAssign, icon, answers[{id, displayNames}], tagReferences`
- Add: `uxc add fd.taskclass CtGate --answers APPROVE,REJECT --workflow CtApproval`
- Gotcha: NEVER recreate (breaks ANSWER dispatch — policies.md). Schema change = NEW id.
  Attachments are not REST-declarable (F00414) — carry the linked doc id in a task TAG.

## fd.vfclass — managed
- Storage: `fd/vfclasses/<Id>.json` (`POST /rest/virtualfolderclass`)
- Fields: `id, category:"VIRTUAL_FOLDER", active, displayNames, searches[{id, category, request}]`
- Add: `uxc add fd.vfclass CtReview --title …` (then author `searches` by hand)
- Gotcha: DTO uses `type` discriminators, NOT `@class` (validate catches it). Every aggregation
  level with `nested` children must ALSO carry `field` or it silently yields no buckets.

## fd.vfinstance — createOnly
- Storage: `fd/vfinstances/<Id>.json` (`POST /rest/virtualFolder/` — capital F)
- Fields: `id, name, category:"VIRTUAL_FOLDER", data.classId (required), tags`
- Add: `uxc add fd.vfinstance CtContractsReview --class CtReview [--name …]`
- Gotcha: no server LIST endpoint — adopt by id. Left-menu visibility comes ONLY from a
  `tab.virtualfolder` scope property (fd.surfacing), never automatically.

## fd.workflow — external (read-only v1)
- Storage: `fd/workflows/<Id>.json` — reference only; write path unverified, uxc refuses writes.

## fd.acl — external (read-only v1)
- Storage: `fd/acls/<Id>.json` — reference only; uxc refuses writes.

## fd.script — managed, cache-affecting
- Storage: `fd/scripts/<id>/meta.json + <id>.js` (a Script-class document; kebab ids `ct-foo`)
- Meta: `name, acl, registrationOrder (STRING), contentFile`
- Add: `uxc add fd.script ct-foo` (RegistrationOrder auto-allocated from the manifest band)
- Gotcha: without a RegistrationOrder tag the script is stored but NEVER loaded by the GUI.
  Every change needs the cache clear (uxc does it) + a full browser page reload.

## fd.guiconfig — managed, cache-affecting
- Storage: `fd/guiconfig/<id>/meta.json + <id>.xml` (GUIConfiguration-class doc, Spring-bean XML)
- Add: `uxc add fd.guiconfig ct-foo-search --template search|home|vf-override --class CtBar`
- Gotcha: ALL GUIConfiguration docs share ONE GWT bean context — a malformed bean or duplicate
  bean id can break the whole GUI for everyone. validate() refuses redefining live singletons
  (`componentProperties`, `componentActivityConfigurations`); `--check-collisions` scans live ids.
  VF override bean id is the magic `content<Classid>VirtualFolder` (case-folded) and must be
  presentation-only (NO hiddenRequest).

## fd.handler — managed, cache-affecting (THE version-rotated kind)
- Storage: `fd/handlers/<Logical>/meta.json + handler.js [+ request.xml]`; `meta.script`/`meta.filter`
  may point to `../shared/…` (two registrations, one source; hash runs over resolved bytes)
- Registry key = LOGICAL name `CtBar_onCreate`; deployed doc id = `<logical>_vN` (server-truth N)
- Meta: `action, objectType, phase(BEFORE|AFTER), asynchronous, stopOnException, order, script, filter, enabled`
- Add: `uxc add fd.handler CtBar_onCreate --object DOCUMENT --filter-class CtBar [--phase AFTER] [--sync]`
  — template ships the proven Graal mechanics: safe http() (noBody fix), minted-JWT gateway call,
  idempotency guard on `<Class>Status`, error marker on `<Class>Error`
- Gotchas: push = rotate to `_v(max+1)` + delete orphans + cache clears + ~45 s blind window
  (`--settle` waits). The filter file must be NAMED `request` on the doc (uxc does it). Marker
  tags must be DECLARED tagclasses referenced by the class or writes fail F00032.
  `uxc disable <logical>` = instant kill switch (Enabled flip, no window).

## fd.surfacing — managed (the scope-property fragment)
- Storage: `fd/surfacing.json`, single registry entry `surfacing`:
  `[{"profiles": "*"|["name"…], "name": "search.template", "value": "ctContractSearch()"}]`
- Property names seen: `search.template`, `home.widget.catalog`, `tab.virtualfolder`, `place.shortcut`
- Add: edit the file directly, then `uxc push surfacing`
- Gotcha: push is backup → additive merge → re-GET → auto-restore on foreign change. `"*"`
  expands against LIVE profiles at push time (expansion recorded in state for exact unsurface).

## fd.dataset — managed, row-level
- Storage: `data/<name>.jsonl` (one canonical doc per line, sorted by id), declared in
  `uxopian-project.json` `dataSets[{name, classId, path}]`
- Sync: `uxc data pull|push <name>`; per-row 3-way (disjoint row edits merge cleanly)
- Gotcha: push NEVER deletes server docs unless an explicit tombstone row
  `{"_id": "...", "_deleted": true}` or `data push --prune` (prints kill list, needs confirm).

## ai.prompt — managed
- Storage: `ai/prompts/<id>.json` (meta) + `<id>.content.md` (content VERBATIM; camel ids `ctFoo`)
- Meta: `id, role(USER|SYSTEM), defaultLlmProvider, defaultLlmModel, temperature(string),
  reasoningDisabled, requiresFunctionCallingModel, requiresMultiModalModel, timeSaved`
- Add: `uxc add ai.prompt ctFoo [--fcm]` (`--fcm` = tool-using: sets fcm:true + reasoningDisabled:false)
- Gotcha: `requiresFunctionCallingModel:true` REQUIRES explicit `reasoningDisabled:false`
  (absent = Java default true = runtime failure; validate refuses). Listing uses the user
  endpoint (`GET /api/v1/prompts`) — the admin GET 500s, that's normal.

## ai.goal — managed (runtime prompt routing)
- Storage: ONE file `ai/goals/goals.json`: `[{goalName, promptId, filter, index}]`;
  registry id per row = `<goalName>+<promptId>+<filterHash8>`
- Add: `uxc add ai.goal --goal <goalName> --prompt ctFoo [--filter expr] [--index n]`
- Gotcha: uxc only ever touches rows whose promptId is a package-owned ai.prompt. The server
  row id is per-target (state), never in the file. Duplicate (goalName,promptId,filter) rejected.

## ai.mcp — managed
- Storage: `ai/mcp/<id>.json` (CRUD `/api/v1/admin/mcp/mcp-conf`, hot-reload server-side)
- Add: `uxc add ai.mcp ctTools --url https://…`
- Gotcha: masked secrets (`********`) normalize to `__masked__` locally; push resolves them back
  from the live server and NEVER overwrites a real secret with a placeholder. Export scrubs them.

## ai.llmconf — inspect-only
- No storage. `uxc ls ai.llmconf` to see configured providers; declare needs in manifest
  `requires.llmProviders`. Secrets are masked on GET — configs cannot round-trip.
