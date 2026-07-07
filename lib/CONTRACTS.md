# Inter-module contracts (implementation fleet: build EXACTLY to these)

Foundation (already written — read them first, do not modify):
`util.mjs`, `config.mjs`, `http.mjs`, `explain.mjs`, `naming.mjs`, `canonical.mjs`,
`registry.mjs`, `output.mjs`, `kinds/index.mjs` (adapter interface), `kinds/base.mjs`
(classKindAdapter factory, jsonLayout, pushContentDoc), `../bin/uxc.mjs` (dispatcher).

`ctx` (built by bin/uxc.mjs): `{ args, flags, out, requirePkg() -> pkg, connect() -> clients, target, clients }`.
Commands call `ctx.connect()` before using `ctx.clients` / `ctx.target`. `pkg` is the
registry.mjs package object. `ctx.out` is output.mjs `out(flags)`.

## lib/sync.mjs — the 3-way engine

```js
export function localOf(pkg, entry)            // -> {obj, contents?}|null  (adapter.readLocal)
export function localHash(pkg, entry)          // -> 'sha256:…'|null
export async function serverOf(ctx, entry)     // -> {obj, contents?}|null  (adapter.readServer)
export async function serverHash(ctx, entry)   // -> 'sha256:…'|null
export function baseHash(pkg, targetName, entry) // from state
// One resource's 3-way classification (full matrix incl. no-base rows + rebased):
export async function classify(ctx, entry)     // -> {state: 'insync'|'local'|'server'|'rebased'|'conflict'|'server-missing'|'new'|'adopted'|'collision'|'retired'|'external', detail?}
export async function statusAll(ctx, { remote = false, only = [] } = {})
//   -> { rows: [{kind,id,policy,state,detail}], untracked: [paths], orphans: [...], pendingCacheClear }
//   local-only mode: state limited to 'local'|'insync' (hash(file) vs base) without network.
export async function pullResources(ctx, entries, { force = false } = {})
//   per entry: serverOf -> writeLocal(canonical echo) -> setResState({syncedHash})
//   refuses conflict unless force. Returns [{id, action}].
export async function pushResources(ctx, entries, { force = false, settle = false, recreate = false } = {})
//   ORDER by PUSH_ORDER; per entry: validate() (abort on errors), TOCTOU re-check serverHash,
//   policy gates (createOnly: create-if-absent else verify+report, UNLESS adapter.inPlaceUpdate —
//     then update in place like managed, e.g. fd.taskclass; external/retired: skip),
//   create/update -> re-GET echo -> writeLocal(echo) -> setResState IMMEDIATELY (resumable),
//   pendingCacheClear set BEFORE first cacheAffecting write, cacheClear after handler block and
//   at end, cleared in state only on success. Returns [{id, action, detail?}]. Throws on first
//   hard failure with explain attached (state already committed for prior items).
```

## lib/zip.mjs — minimal zip (store + deflate-raw, zip64 not needed)

```js
export async function zipDir(dir, outFile, { exclude = [] } = {})  // exclude: path prefixes relative to dir
export async function unzipTo(file, destDir)
```

## lib/version.mjs — client/package compatibility gate

```js
export const CLIENT_VERSION                       // package.json version (single source of truth)
export function parseSemver(v)                     // -> {nums:[maj,min,pat], pre:[...], valid}
export function compareSemver(a, b)                // -1|0|1 (release outranks its prereleases)
export function satisfiesMinClient(required, client = CLIENT_VERSION)   // client >= required (no req => true)
export function minClientVersionOf(manifest)       // manifest.minClientVersion ?? requires.uxc ?? null
export function assertClientSupports(manifest, { client, ignore = false, out, action = 'deploy' })
//   THROWS (Error + .explanation) when client < minClientVersion or the declared min isn't semver;
//   ignore:true warns via out and returns {required, ok:false, ignored:true}. Called before any
//   write by importPackage (import + mp install), mp install (pre-download), and push (pre-connect).
```

## lib/dialects.mjs — server dialects (version-aware capabilities)

```js
export const DIALECTS                      // per-product ordered {name, max, caps} ranges
export function rangeForVersion(product, version)  // exclusive max; throws below oldestSupported
export async function capabilities(ctx, product)
//   -> { product, version|null, build?, source: 'override'|'actuator'|'probe'|'unknown',
//        dialect, caps }  — cached per ctx; detection: target pin > version endpoint > fingerprint.
//   Adapters read caps (e.g. caps.adminPromptList, caps.vfInstanceCreatePath), never versions.
```

## lib/packageio.mjs

```js
export async function exportPackage(ctx, { output, allowDirty = false })  // zip minus .uxc/; mcp secret scrub
export async function importPackage(ctx, src, { remap = null, force = false, ignoreClientVersion = false })
//   unpack (or use dir) -> assertClientSupports(manifest) (refuse before any dir/write) ->
//   if remap 'old=new': naming.buildRemapMap + applyRemap over ALL text files + rename files/dirs +
//   rewrite registry/manifest, lint residuals (abort if any) -> PRE-FLIGHT every resource vs server
//   (no-base matrix) and print full collision list BEFORE any write (need --force to overwrite) ->
//   pushResources in PUSH_ORDER -> verify summary.
```

## lib/refs.mjs

```js
export function findRefs(pkg, id)  // token-boundary scan of every text file in the package
// -> [{ path, line, text }]  (text = trimmed matching line, truncated 120)
export function crossReferenceLint(pkg)  // every classid/promptId-looking token in handler
// request.xml, vfclass searches, guiconfig criteria, surfacing values that matches the project
// prefixes must resolve to a registry id -> [{path, token, problem}]
```

## lib/run.mjs

```js
export async function runPrompt(ctx, idOrGoal, { payload = {}, goal = false, provider, model,
  temperature, maxChars = 2000, expect = null, onText = null } = {})
// conversations POST -> requests/stream POST -> tolerant parse (SSE 'data:' frames OR raw text,
// accumulate content||text||delta.content||answer, skip [DONE]); error-as-body detection
// (/timed out|HttpTimeout|Error: java/) with ONE cold-start retry; LLM override via query params.
// -> { answer, elapsedMs, pass: expect ? regex.test(answer) : null, error?: string }
```

## lib/index.mjs (public lib)

```js
export { connect } from …       // async connect(targetName?) -> { core, gateway, gui, cacheClear, target }
export { openPackage } from '../registry path'
export { KINDS, PUSH_ORDER } from './kinds/index.mjs'
export { canonicalize, hashResource } from './canonical.mjs'
export { runPrompt } from './run.mjs'
export { explainCode, explainError } from './explain.mjs'
export * as naming from './naming.mjs'
export * as util from './util.mjs'
```

## Adapters — kind-specific notes (DESIGN.md §7 is normative; highlights)

- **fd-handler**: registry key = logical id. `readServer` lists OperationHandlerRegistration docs
  (one `core.search` classid=OperationHandlerRegistration max 200 + getDoc per match) matching
  `^<logical>_v(\d+)$`; live = max N; expose `orphans` (other survivors) via adapter.extras.
  meta.json: `{ action, objectType, phase:'AFTER', asynchronous:true, stopOnException:false,
  order, script:'handler.js', filter:'request.xml'|null, enabled:true }` — script/filter paths
  resolve relative to the handler dir (`../shared/…` allowed); hash over RESOLVED bytes.
  push: deploy `_v(max+1)` via pushContentDoc (classId OperationHandlerRegistration, files
  [{script bytes}, {filter bytes, name:'request'}], tags OperationHandler/ExecutionPhase/Action/
  ObjectType/Enabled/Asynchronous/StopOnException/RegistrationOrder) -> verify getDoc -> DELETE
  all other `_v*` -> record deployedId/deployedAt. disable/enable = GET reg doc, flip Enabled
  tag, POST /{id} in place, cacheClear, state note.
- **fd-script / fd-guiconfig**: dir layout `<dir>/<id>/meta.json + <id>.js|.xml`. meta:
  `{ name, acl, registrationOrder, contentFile }`. push via pushContentDoc (classId Script /
  GUIConfiguration, RegistrationOrder tag). readServer: getDoc + getContent. guiconfig.validate:
  XML well-formedness (cheap paren/quote/tag balance — no XML lib), bean-id uniqueness within
  package, refusal of singleton bean ids (componentProperties, componentActivityConfigurations).
- **fd-surfacing**: single registry entry id `surfacing` (path fd/surfacing.json). File =
  `[{profiles:"*"|[names], name, value}]`. readServer extracts the scope's matching entries
  limited to names+values present in the local file OR (during adopt-scan) values referencing
  owned ids. push per DESIGN §7.12 (backup to .uxc/backups/scope-<ts>.json, additive merge,
  POST /rest/scope/{scope} array body, re-GET, strip-own compare, auto-restore on foreign diff);
  state records the concrete expansion `{profile -> [entries]}`.
- **fd-dataset**: registry entries kind fd.dataset, id = dataset name from manifest.dataSets.
  JSONL rows = full canonical document objects (id, name, classId, tags) sorted by id. Row-level
  3-way via state.rows (docId -> hash). push: upsert changed rows only (core.upsertDoc), NEVER
  delete unless row tombstone `{"_id":…,"_deleted":true}` or --prune (prints kill list, requires
  flags.yes). pull: search classId (paged, max 200/page) + getDoc each changed row.
- **ai-prompt**: meta json (all fields except content) + `<id>.content.md` = content verbatim.
  readServer: user `GET /api/v1/prompts` (cache per ctx), find by id, then OVERLAY the echo on the
  local meta — the user endpoint may return a reduced projection (id+content), so server-present keys
  win (drift detectable) while omitted keys fall back to local (never lose role/provider/model/…).
  push: POST /api/v1/admin/prompts (object body), on 409 PUT same path (id in body). validate per DESIGN.
- **ai-goal**: single file ai/goals/goals.json `[{goalName, promptId, filter, index}]`; registry
  entry per row, id `<goalName>+<promptId>+<filterHash8>`. readServer: GET /api/v1/admin/goals
  (list), filter client-side to rows whose promptId is package-owned. push: match by
  (goalName, promptId, filter) -> POST (capture id into state) or PUT {id in body}.
- **ai-mcp**: GET/POST/PUT/DELETE /api/v1/admin/mcp/mcp-conf[/{id}]. If server masks secret
  headers (detect '********'), exclude those header values from canonical hash and never push a
  placeholder over a non-empty server value.
- **ai-llm**: GET/POST/PUT/DELETE /api/v1/admin/llm/provider-conf[/{id}] — LLM provider configs
  `{id/provider, defaultLlmModelConfName, globalConf:{apiSecret,…}, llModelConfs:[…]}`. Same masking
  as ai-mcp (`********`→`__masked__`, resolve to live on push, secrets never in the package), plus
  strips audit fields (createdAt/By, updatedAt/By). Divergence: a masked secret with NO live value
  pushes as EMPTY (fresh keyless install) rather than erroring. list = GET base (array); id⇄provider.

## Commands (lib/commands/<name>.mjs) — export default { name, summary, help, run(ctx) }

Names: init, target-add, target-ls, target-use, status, diff, pull, push, add, adopt, rm,
destroy, export, import, verify, data-pull, data-push, refs, disable, enable, ls, get, schema,
search, doc-create, doc-rm, task-ls, task-answer, watch, recent, run, cache-clear, explain,
doctor, install-claude, help.

Conventions: resolve resource args via `pkg.resolve(arg)` (kind/id or unique bare id); honor
DESIGN §12 output discipline exactly (caps, projections, exit codes 0/1/2 — use
process.exitCode = 1 for drift/expectation-failed, fail() for errors); `--json` via
ctx.out.result(). `help` prints the command list with summaries (one line each).
