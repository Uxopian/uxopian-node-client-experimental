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
export async function classify(ctx, entry)     // -> {state: 'insync'|'local'|'server'|'rebased'|'conflict'|'server-missing'|'new'|'adopted'|'collision'|'retired'|'external'|'unsupported', detail?}
export async function unsupportedReason(ctx, kind) // adapter.serverSupport(ctx) cached per kind per ctx: null | reason
//   'unsupported' (dialect gate, DESIGN §18): status reports it (not drift), pull/push return
//   action 'unsupported' with the reason, verify notes and skips it — never a failure.
export async function statusAll(ctx, { remote = false, only = [] } = {})
//   -> { rows: [{kind,id,policy,state,detail}], untracked: [paths], orphans: [...], pendingCacheClear }
//   local-only mode: state limited to 'local'|'insync' (hash(file) vs base) without network.
export async function pullResources(ctx, entries, { force = false, flatten = false } = {})
//   per entry: serverOf -> writeLocal(canonical echo) -> setResState({syncedHash})
//   refuses conflict unless force. REFUSES a composed @include source unless `flatten` — --force
//   means "server wins over my edits", not "dissolve my build" (DESIGN §25.4); the refusal parks
//   the server copy under .uxc/pulled/<kind>/<id>/. Returns [{id, action}].
export function composedSources(pkg, entry)    // -> package-relative @include-built content files
export async function pushResources(ctx, entries, { force = false, settle = false, recreate = false } = {})
//   ORDER by PUSH_ORDER; per entry: validate() (abort on errors), TOCTOU re-check serverHash,
//   policy gates (createOnly: create-if-absent else verify+report, UNLESS adapter.inPlaceUpdate —
//     then update in place like managed, e.g. fd.taskclass; external/retired: skip),
//   create/update -> re-GET echo -> writeLocal(echo) -> setResState IMMEDIATELY (resumable),
//   an inPlaceUpdate kind reports detail 'updated IN PLACE — … answer bindings are preserved',
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
//   uxopian-ai caps: adminPromptList, promptVersioning, promptWrite ('admin-v1'|'versioned-v1'),
//   goals, agenticPlans, applications. Pinned versions are product versions (2026.0.0-ft5).
export function naturalVersion(v)          // '2026.0.0-ft10' -> '2026.0.0-ft.10' (ft10 > ft5)
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

## lib/compat.mjs — upgrade report (DESIGN §26)

```js
export async function readCompat(dirOrUxpkg)          // -> compat object | null; throws on invalid file
export async function readCompatLenient(dir, out)     // same, warns + null (receipt stamping never blocks)
export function validateCompat(c)                     // -> [problem]
export function receiptDeps(manifest, compat)         // -> { dependencies|null, requires|null } for receipts
export function judgeUpgrade(receipts, manifest, compat, { collisions })  // pure -> [{code,version,verdict,reasons[]}]
export function printUpgradeReport(out, product, version, rows); export const hasBreaks
// importPackage(..., { report:true }) -> { report:true, upgrade, collisions, written:false }, writes nothing;
//   process.exitCode = EXIT_BREAKS (3) when a row breaks
export const EXIT_BREAKS = 3
```

```js
// lib/version.mjs — compat ranges (DESIGN §26); versionSupported (§18 patterns) is unchanged
export function parseVersionRange(range)    // string | [string] -> [[ [op, version] ]] (OR of ANDs) | null
export function satisfiesRange(version, range)  // '^1.2' '~1.2' '1.x' '>=1.0 <2.0' '^1 || ^3' exact; unparseable -> false
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
  temperature, version = null, application = null, images = [], maxChars = 2000, expect = null,
  onText = null, timeoutMs } = {})
// conversations POST -> requests/stream POST -> tolerant parse (SSE 'data:' frames OR raw text,
// accumulate content||text||delta.content||answer, skip [DONE]); error-as-body detection
// (/timed out|HttpTimeout|Error: java/) with ONE cold-start retry; LLM override via query params.
// ft5: goal refused when caps.goals === false; version -> content.version after a GET …/versions/{n}
// existence check; application -> X-Application-Id header; a stream timeout POSTs
// /conversations/{id}/stop (best-effort) before rethrowing; a socket close is re-dressed as a
// NetworkError naming the prompt and the §29 isolation step (never printed as an answer, #71).
// images: data URIs only (`data:<mime>;base64,…`) appended as IMAGE content items — bare base64 is
// REFUSED client-side (the gateway closes the socket instead of answering 400); gated on
// caps.inlineImages (ft5+). UXOPIAN-AI-LEARNINGS §A19.
// -> { answer, elapsedMs, pass: expect ? regex.test(answer) : null, error?: string }
// lib/commands/versions.mjs (uxc versions <promptId> [--stats], read-only, caps.promptVersioning):
//   GET …/prompts/{id}/versions (+ …/versions/{n}/statistics, …/{id}/statistics) -> rows
//   {version, state served|draft|published, provider/model, size, local '= local'?, uses, feedback, saved (h)}
export async function runPlan(ctx, planId, { payload = {}, expect = null, maxChars = 2000, timeoutMs, pollMs = 2000, onProgress } = {})
// caps.agenticPlans required. POST /admin/plan-executions/run -> poll GET /{id} to
// COMPLETED|FAILED|CANCELLED; 400/404 at submit -> status REJECTED; timeout -> POST /{id}/stop.
// -> { executionId, status, answer (final nodes), nodes:[{id,type,status,outputKey,output,error?}],
//      elapsedMs, pass (expect over every node output, false when error), error? }
```

## lib/index.mjs (public lib)

```js
export { connect } from …       // async connect(targetName?) -> { core, gateway, gui, cacheClear, target }
export { openPackage } from '../registry path'
export { KINDS, PUSH_ORDER } from './kinds/index.mjs'
export { canonicalize, hashResource } from './canonical.mjs'
export { runPrompt, runPlan } from './run.mjs'
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
  GUIConfiguration, RegistrationOrder tag). fd-script only: `registrationOrder: null` SPELLED OUT =
  server-only library document (no tag, fetched + load()ed by handlers). The GUI still loads every
  Script-class doc, so (0.19) such a library may add `classId: '<OtherClass>'`: pushed under that
  class, echoed by readServer only when != Script; validate refuses it on a browser script or when
  spelled 'Script'. readServer: getDoc + getContent. guiconfig.validate:
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
  push: through WRITE_STRATEGIES[caps.promptWrite] — 'admin-v1' (≤ ft4): POST /api/v1/admin/prompts
  (object body), on 409 PUT same path (id in body); 'versioned-v1' (ft5): POST create (409 -> update),
  update = GET …/{id}/versions, reuse a harmless open draft or POST one, PUT …/versions/{n} draft:false;
  a foreign draft throws unless flags.force. export async function upsertPrompt(ctx, body) — uxc's own
  prompts (receipts). remove: DELETE, retrying a stale "referenced by application" 409. validate per DESIGN.
- **ai-goal**: serverSupport -> reason when caps.goals === false (ft5 removed goals; rows classify
  'unsupported', remove is a no-op). Single file ai/goals/goals.json `[{goalName, promptId, filter, index}]`; registry
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
- **ai-agentic** (shared, ft5): agenticCrud({kind, base, support, conflictStatus}) -> {list, get, create
  (conflict -> PUT), update (PUT /{id} full replace), remove (404 ok, no-op when unsupported), scan};
  agenticSupport(ctx, kind); idErrors(entry, obj); toolWarnings(ctx, permissions, extraToolNames)
  (GET /api/v1/admin/tools, warnings only).
- **ai-agent**: /api/v1/admin/agent/agent-conf; secrets under the ai-mcp mask contract
  (maskNormalize on read/writeLocal, resolveMasks(obj, live, id, 'ai.agent') on push); objective required.
- **ai-plan**: /api/v1/admin/plans; export planErrors(o), findCycle(nodes); validate = structure + cycle
  + exposeAsTool rules; lintHelpers = DIRECT_TOOL names.
- **ai-application**: /api/v1/admin/application/application-conf (existing name = 409); id === name
  (create/update send name = id; validate refuses a mismatch); serverSupport = caps.applications.
- lint.mjs **lintAgentic(pkg)** -> [{where, kind:'dangling'|'unprovided', message}] — warnings from
  verify and push (agent objective / allowedSubPlans, application prompt, plan agentConfId /
  subPlanId, AGENT node prompt variables vs dependency outputKeys ∪ persistOutput ∪ toolInputParameters).

## lib/testkit.mjs — package-embedded functional tests (DESIGN §24)

```js
export const makeRunId = () => '8-hex'            // one per `uxc test` invocation
export function mintId(code, hint, runId)          // ZZTEST_<CODE>_<HINT>_<run8>
export class TestFail extends Error                 // assertion failures vs infra errors
export function createOfflineHarness(ctx, { testsDir, log })  // -> { t, teardown() }  (DESIGN §25.4)
//   the `offline: true` tier: NO core/gateway/gui (that is the guarantee), plus
//   t.loadShared(relPath, globals) -> evaluates a _shared library (@include expanded, as a push
//   would) in a node:vm sandbox and returns its context. Takes no lock, skips the safety gate
//   and the receipt stamp. Green offline != green on GraalJS (LEARNINGS §32).
export function createHarness(ctx, { runId, testsDir, log }) // -> { t, teardown({keep}) }
//   t: core/gateway/gui, pkg (manifest+registry view), id(hint), doc.create({classId,…,file}),
//      track('doc'|'task', id), cleanup(fn), waitFor(fn,{timeoutMs,everyMs,label}), sleep,
//      answerTask(taskId, answerId), runPrompt(id, payload, opts), expect(cond,msg), fail(msg), log
//   teardown: LIFO, per-item try/catch, absent-already counts deleted; -> {deleted,failed,kept}
export async function checkRequires(ctx, pkg, requires)   // -> {ok:true} | {ok:false, reason}
//   requires: { resources:['kind/id'], docs:['ID'], products:['uxopian-ai'], llmProvider:true,
//               caps:{product:{cap:bool}} } — unmet => the runner SKIPS with the reason.
```

`lib/receipt.mjs` adds `stampTestReceipt(ctx, code, {passed, skipped, total, when})` — targeted
merge of UxcTestsPassedAt/UxcTestsResult (FD tags / AI receipt JSON); never creates receipts,
never rewrites installedAt. `resolveTarget` exposes `allowTests` (targets.json / UXC_ALLOW_TESTS).

## lib/home.mjs — where uxc keeps its non-package state

```js
export function uxcHome()                   // UXC_HOME (any platform) else os.homedir()
export function uxcDir(...parts)            // <home>/.uxopian/<...parts>, resolved PER CALL
```

`os.homedir()` reads $HOME on posix and %USERPROFILE% on Windows, so `HOME`-based test isolation
silently did nothing there — the suite overwrote the real `~/.uxopian/targets.json` (#71). Every
path under `~/.uxopian` goes through `uxcDir()`; tests set `UXC_HOME`.

## lib/lock.mjs — cross-process target lock (DESIGN §25.1)

```js
export const lockRoot = () => …                           // ~/.uxopian/locks — a FUNCTION: UXC_HOME
//                                                           must be obeyable after import (#71)
export async function acquire(key, {mode, cmd, timeoutMs, maxAgeMs, onWait, onSteal})
//   mode 'write' -> exclusive, waits (throws on timeout); 'read' -> NEVER waits;
//   'none' -> no-op. Returns {held, mode, contendedBy, release()} — release() is idempotent.
export function lockOwner(key)                            // -> {pid, host, cmd, at, ageMs} | null
export function recordHandlerWindow(key, ms, by)          // survives release()
export function handlerWindowLeft(key)                    // -> ms remaining (0 when clear)
export async function waitHandlerWindow(key, {onWait})    // -> ms waited
export function listLocks()                               // -> [{key, pid, cmd, at, stale}]
```

The key is the TARGET name (the instance is what is contended, not the checkout). Orphan recovery:
a dead pid on THIS host is stolen at once; anything older than maxAgeMs (30 min) is stolen with a
warning. Never throws on release.

## lib/agent.mjs — package operating policy (DESIGN §25.2)

```js
export function agentPolicy(pkgOrDir)   // -> {target, targetFrom, protect[], neverPull[], forbid[], gotchas, empty}
export function globMatch(pattern, value)              // anchored, '*' only
export function matchesEntry(pattern, entry)           // 'kind/id' or bare id, globs in both
export function resolvePinnedTarget({pin, pinFrom, requested, ambient, write, override})
//   -> {use, refuse:string|null, warn:string|null}   (refuse => the caller must fail())
export function forbiddenBy(policy, {command, args, flags})   // -> [{pattern, reason}]
export function partitionProtected(patterns, entries)         // -> {allowed, blocked:[{entry,pattern}]}
```

`.uxc/target` (one line) overrides `manifest.agent.target`. An absent block = empty policy: uxc
behaves exactly as it did before.

## lib/session.mjs — the command preamble

```js
export async function openSession(ctx, {command, modName, mod})
//   -> {release(), lockKey, policy, mode}   — release() MUST run in a finally (bin/uxc.mjs does).
```

Runs before every `run()`: enforces `agent.forbid`, resolves the target pin (mutating
`ctx.flags.target`), waits out a prior handler window, and takes the lock. Sets `ctx.policy` and
`ctx.lockKey` for commands that need them (push/pull consult protect/neverPull; push records the
handler window).

## lib/lint.mjs — offline lints (DESIGN §25.3)

```js
export function tagclassIndex(pkg)          // id -> {type, values:Set, constrained}
export function lintTagValues(pkg)          // -> [{where, tag, value, allowed[], message}]  BLOCKING
export function promptVariables(content)    // Set of bare ${x} (helper calls excluded by shape)
export function uninterpolatedVariables(content)    // -> [{name, line}] ${x} outside [[ ]] / [( )]
export function promptCallSites(text, id)   // -> [{line, keys:string[]|null, argText}]
export function lintPromptVariables(pkg)    // -> [{prompt, kind:'unprovided'|'no-caller'|'not-interpolated', …}]  WARNING
//   'not-interpolated' (#71): a bare ${x} the gateway never substitutes — the value is dropped at
//   runtime. Surfaced by BOTH verify and push (unlike 'no-caller', which is informational).
export function promptProviderOrder(pkg, entries)   // -> [{prompt, before[], why}]
export function includeOrders(pkg)          // -> [{path, includes[]}] in source order
export function declaredIncludeOrder(pkg)   // manifest.includeOrder, basenames
export function lintIncludeOrder(pkg)       // -> [{path, message}]  BLOCKING when declared
export function resourceSizes(pkg, entries) // -> [{kind,id,file,bytes,strippedBytes,saved}]
export function sizeWarnings(rows, warnAt)  // -> [{…, over:boolean, message}]
```

Every check is pure + offline: `verify` runs them all, `push` uses them as a pre-flight. Prompt
findings are warnings BY DESIGN — a prompt may be called from outside the package.

## Commands (lib/commands/<name>.mjs) — export default { name, summary, help, lock?, run(ctx) }

Names: init, target-add, target-ls, target-use, status, diff, pull, push, add, adopt, rm,
destroy, export, import, verify, data-pull, data-push, refs, disable, enable, ls, get, schema,
search, doc-create, doc-rm, task-ls, task-answer, watch, recent, run, test, cache-clear, explain,
doctor, install-claude, context, size, api, help.

`lock` is optional: `'write' | 'read' | 'none'`, or a function of the flags
(`lock: (flags) => flags.offline ? 'none' : 'write'`), and receives the positionals as a second
argument (`(flags, args)`). Absent, the mode comes from
`LOCK_MODES` in lib/cli-meta.mjs — the audited default per command (a value there may also be a
function of the flags: `import` / `mp-install` are `'read'` under `--report`).

Conventions: resolve resource args via `pkg.resolve(arg)` (kind/id or unique bare id); honor
DESIGN §12 output discipline exactly (caps, projections, exit codes 0/1/2 — use
process.exitCode = 1 for drift/expectation-failed, fail() for errors; 3 = an upgrade `--report`
found a `breaks` line, DESIGN §26); `--json` via
ctx.out.result() — every command ends in exactly one result() on every non-error path (see
lib/output.mjs below for the per-command shape). `help` prints the command list with summaries
(one line each);
`help --search|-s "<text>" [--limit N] [--json]` ranks commands + knowledge refs (lib/helpsearch.mjs).

## lib/helpsearch.mjs (#94) — offline, zero-dep, deterministic
    helpSearch(query, {limit=8, root=UXC_ROOT, helpText}) -> {query, commands:[{name, usage, summary, score}],
        refs:[{type:'learning'|'kind'|'explain', ref, title, file?, line?, path?, section?, source?, command?, score}]}
    formatHelpSearch(result) -> lines (≤ limit + 2)
    buildCorpus / rank / tokenize / stem / parseHeading / markdownSections   (building blocks)
Corpus, built per call (no cache): command modules (a broken one drops out), the explain KB,
references/kinds.md sections, `##`/`###` sections of docs/{FLOWERDOCS,UXOPIAN-AI,FAST2}-LEARNINGS.md
+ DIAGNOSTICS.md — a missing file is skipped. BM25 + light stemming + query-side synonyms;
commands get at most a third of `limit`.

## CLI verbs and flags (#99) — the canonical table; `test/cli-consistency.test.mjs` lints it

Data lives in lib/cli-meta.mjs (`VERBS`, `VERB_EXCEPTIONS`, `COMMAND_ALIASES`,
`SUBCOMMAND_ALIASES`, `FLAG_ALIASES`, `LEGACY_FLAG_ALIASES`, `DESTRUCTIVE`); this table explains
it. **Aliases, never renames**: the old spelling keeps working identically. The dispatcher
resolves an alias to the canonical module before the session opens, so lock modes and
`agent.forbid` patterns see one name (`forbid: ["scope delete"]` also blocks `scope rm`).

Subcommand verbs (a new two-word subcommand uses one of these, or joins VERB_EXCEPTIONS with a reason):

| verb | means | in use | alias spellings |
|---|---|---|---|
| `ls` | list many, read-only | `ls`, `target ls`, `task ls`, `f2 ls`, `mp ls` | `list` everywhere (`uxc list`, `mp list`, …) |
| `get` | read one, read-only | `get`, `scope get` | `mp get` = `mp show` |
| `create` | make a new server object | `doc create`, `scope create` | — |
| `add` | register or scaffold locally | `add`, `target add` | — |
| `rm` | delete (gated, see below) | `rm`, `doc rm`, `mp rm` (archive) | `scope rm` = `scope delete` |
| `push` / `pull` | local -> server / server -> local | `push`, `pull`, `data push`, `data pull`, `mp pull` | — |
| `run` | execute/start on the server | `run`, `f2 run` | — |

Allow-listed non-canonical verbs: `show` (-> `get`), `delete` (-> `rm`), `use`, `answer`, `init`,
`login`, `publish`, `install`, `deprecate`, `versions`, `categories` — reasons in
`VERB_EXCEPTIONS`. Top-level commands (`status`, `diff`, `verify`, `doctor`, …) are not verbs
of a family and are not linted for verb choice.

Flag semantics:

| flag | means | notes |
|---|---|---|
| `--yes` | confirm a destructive/irreversible action non-interactively | `scope delete`, `mp rm`, `data push --prune`, `adopt --scan` (write), `test` (on a target without allowTests); `push --yes-removals` is the removal-specific form |
| `--confirm <code>` | typed confirmation, stronger than `--yes` | `destroy` only (the whole package goes) |
| `--force` | override a safety check or a collision | `rm`/`destroy` (createOnly gate), `push`/`pull`/`import` (conflict/collision), `init`/`mp init` (overwrite) — never "skip the confirmation" |
| `--dry-run` | print what would happen, write nothing | `destroy`, `mp publish`; `import`/`mp install --report` is the upgrade-report form |
| `--json` | machine output via `ctx.out.result()` | global |
| `--target <name>` | which instance | global; checked against the package pin (DESIGN §25) |
| `--dir <path>` | which package | global |
| `--kind k1,k2` / `--prefix P` | filters on a package sweep | `status`, `adopt --scan`; `ls` takes the kind positionally |
| `--max n` | at most n items back | `search`, `recent`, `task ls`; `--limit` is an alias |
| `--limit n` (+ `--offset`) | page size of a paged listing | `mp ls`; `--max` is an alias (`--page-size` legacy) |
| `--fields a,b` | project columns | `ls`, `get`, `search`, `watch` |
| `--full` | no truncation / include informational lines | `diff`, `get`, `context`, `verify` |
| `--version v` | an ADDON version | `mp *`; the CLI version is `uxc --version` |
| `-o <file>` | output file | `export`, `mp pull` (`--output` legacy) |

`FLAG_ALIASES` (applied by the dispatcher; giving both spellings with different values is an
error): `search`/`recent`/`task ls` `--limit` -> `--max`; `mp ls` `--max` -> `--limit`.
`LEGACY_FLAG_ALIASES` records older in-module spellings (`--page-size`, `--fd`/`--uxai` ->
`--compat` on `mp ls`, `--notes`, `--output`, `--classId`, `--families`); do not add more.

Destructive gates (`DESTRUCTIVE`; the lint requires every `rm`/`delete`/`destroy` module to be
listed and its gate flags to be in its help and read by its code):
`rm` — a side (`--local|--server|--both`), `--force` for createOnly/external · `destroy` —
`--confirm <code>` or `--dry-run` · `doc rm` — explicit ids only · `scope delete` / `mp rm` —
`--yes` · `data push` — row deletes only with `--prune --yes`.

Lint rules (test/cli-consistency.test.mjs): every module exports `name`/`summary`/`help`/`run`
and its name matches its file; every two-word subcommand verb is in `VERBS` or
`VERB_EXCEPTIONS`; an exception that means a canonical verb has that alias registered; every
alias resolves to a real module and shadows none; every flag a module reads (`flags.x`,
`flags['x']`, `reclaim(…, 'x')`, `collectFlag('x')`) appears in its help/summary, unless global,
`--ignore-*`-covered, or a recorded alias; destructive gates as above; help and completion list
every alias.

## lib/commands/api.mjs — raw passthrough (#96, BACKLOG-AGENTIC §27 item 3)

```js
export function resolveSurface(path, {surface, target})   // -> {surface, path, inferred}
//   --surface wins (a matching /core, /gui, …/uxopian-ai prefix is stripped); else a full URL under
//   a target base -> that surface; …/uxopian-ai/… -> ai; /core/… -> core; /gui/… -> gui;
//   /api/v1/… -> ai; /api/… -> f2; anything else -> core. Paths are relative to the client base.
export function withQuery(path, pairs)          // --query k=v (repeatable), keeps an existing ?…
export function parseHeaders(pairs)             // --header k=v | "K: v" (repeatable) -> {}
export function redactHeaders(headers)          // authorization/token/cookie… -> '<redacted>'
export function responseHeaderSubset(headers)   // content-type, length, location, retry-after, etag…
export function readRequestBody(flags, {readStdin})  // --data | --body <file|-> -> {text, json} | null
export function explainResponse(status, json, text)  // body.code first, then the whole body
export { isReadMethod, apiLockMode }            // from lib/cli-meta.mjs
```

`uxc api <METHOD> <path>` goes through the target's own clients (`raw()`), so auth (Core JWT /
fast2 Bearer), pacing, 429 retry and timeouts are the verified ones. Lock: GET/HEAD/OPTIONS are
`'read'`; any other method is refused without `--yes` (and takes no lock), with `--yes` it is
`'write'` — serialised on the target and under the write rule of the target pin. Output: the status
line on stderr; the body on stdout (pretty JSON; raw text for `--raw` or a non-JSON content type);
`--json` -> `{status, surface, method, path, headers, body, explanation?}`. A status >= 400 prints a
2,000-char body excerpt + the `explain` match on stderr and exits 1. Tokens are never printed.

## lib/agents-md.mjs — AGENTS.md + CLAUDE.md pointer (DESIGN §27.3)

```js
export const BEGIN, END                          // '<!-- uxc:begin -->' / '<!-- uxc:end -->'
export function renderAgentsSection(manifest)    // -> fenced block, deterministic, manifest facts only
export function renderClaudeSection(manifest)    // -> fenced pointer block (AGENTS.md + skill/slash commands)
export function upsertSection(existing|null, section, header?)  // replace the block or append it; CRLF kept
```

Used by `init` (both forms) and `context --agents-md [--write]`. Pure; no I/O.

## lib/output.mjs — output modes and the per-command result contract (#95)
    agentDetected(env) -> bool        UXC_AGENT set+non-empty wins ('0'/'false'/'no'/'off' = no);
                                      else CLAUDECODE === '1'
    outputMode(flags, env) -> {json, compact, agent}
    setOutputMode(mode) / getOutputMode()   process-wide, set by the dispatcher before anything runs
    out(flags, mode?) -> {json, compact, result, line, note, warn, table, diff}
    errorEnvelope(err, exitCode) -> {ok:false, error, code, explanation, exitCode}
    reportError(err, exitCode) / fail(msg, code=2)

| invocation                         | agent detected | stdout                       |
|------------------------------------|----------------|------------------------------|
| (no flag)                          | no             | human text                   |
| (no flag)                          | yes            | compact JSON (one line)      |
| `--json`                           | no             | pretty JSON (2-space indent) |
| `--json`                           | yes            | compact JSON                 |
| `--human` (wins over `--json`)     | either         | human text                   |

Rules:
- A non-TTY stdout NEVER switches to JSON on its own (humans pipe to grep).
- JSON mode: `line`/`note`/`table`/`diff` are suppressed; progress and warnings go to stderr
  (`warn`); stdout carries ONLY the result() line(s). Nothing prompts (prune's y/N is skipped —
  `--yes-removals` / `--keep-removed` decide).
- Errors: the human text (`msg` + `↳ explanation`) goes to stderr ALWAYS; in JSON mode the
  envelope `{"ok":false,"error","code","explanation","exitCode"}` is ALSO printed on stdout. Exit
  codes are unchanged. `code` is the error's string/number code (HTTP/transport/marketplace)
  or null. A command that already printed its result and then fails prints a second line.
- `out(flags)` without a mode (library callers, e.g. packageio's fallback) keeps the legacy
  behaviour: JSON iff `flags.json`, pretty — detection is a CLI concern.
- Exempt (always plain text): `uxc help`, `uxc --version`/`-v`, `uxc <cmd> --help`,
  `uxc completion bash|zsh` (the script IS the output; `--install` has a result), and
  `get <docId> --raw-tag X`, which asked for verbatim bytes: it stays raw in agent mode and is
  wrapped as `{id, tag, value}` only under an explicit `--json`.
- Tests that parse human output spawn with `UXC_AGENT: '0'` (the suite runs inside Claude Code
  with CLAUDECODE=1).

Result shapes (a `[...]` is an array of the objects shown; `…` = adapter/server object as-is):

| command            | result                                                                  |
|--------------------|-------------------------------------------------------------------------|
| status             | `{rows:[{kind,id,state,detail?}], untracked:[key], orphans:[…], pendingCacheClear}` |
| diff               | `{id, meta:[…], content:{…}, localMissing?, serverMissing?}`           |
| pull / push        | `[{kind,id,action,…}]` (sync actions; `[]` when nothing to do)          |
| add                | `{kind, id, path, files, order, dataSet?}`                              |
| adopt              | candidates `[…]` (dry) · adopted `[…]` (--yes) · `{kind,id,path,policy}` (one id) |
| rm                 | `{id, local, server, retired}`                                          |
| destroy            | steps `[…]` (dry run) · `{steps, failures, kept}`                       |
| export             | `{file, …}` (packageio result)                                          |
| import             | packageio result · `{src, report:true, written:false, upgrade, collisions}` (--report) |
| verify             | `{resources, checks, failures:[string]}`                                |
| data pull / push   | row actions `[…]` or `{dataset}`                                        |
| refs               | `[hit]`                                                                 |
| enable / disable   | `{id, disabled}`                                                        |
| ls                 | `[projected row]` (per-kind projection, or `--fields`)                  |
| get                | resource `{kind,id,obj,contents}` · doc `{id,category,classId,status,version,name,tags,…}` · `--tag` `{id,tag,value}` |
| schema             | `{classId, category, tagCategories, rows}` · `--tag` `{classId,tagclass,reference,category}` |
| search             | `{found, category, rows, elsewhere}`                                    |
| recent / task ls   | `{found, rows}`                                                         |
| doc create         | `{id, classId, name}`                                                   |
| doc rm             | `{ok:[id], failed:[…]}`                                                 |
| task answer        | `{taskId, answerId, answered:true}`                                     |
| watch              | `{docId, elapsedSeconds, changes, untilMet, gone}`                      |
| run                | lib/run.mjs runPrompt / runPlan result (`{status?, answer, pass?, error?, elapsedMs, …}`) |
| test               | `{target, offline, runId, tests:[…], passed, failed, skipped, stamped}` · `--list` `{tests}` |
| versions           | `{id, served, versions:[…], statistics?}`                               |
| size               | `{limitBytes, warnAtBytes, rows, warnings}` (`[]` when empty)           |
| cache-clear        | `[status]`                                                              |
| explain            | `[{signature, explanation}]` or `{query, match:null, knownSignatures}`  |
| doctor             | `{checks, failures, report:[{check, ok, detail}]}`                      |
| context            | `{package, client, minClientVersion, kinds, retired, targets, policy, includeOrder, sizes, gotchas}` |
| vars               | `{variables, resolved, missing, unknown, invalid}`                      |
| installed          | `[receipt]`                                                             |
| install-claude     | `[{dest, src}]`                                                         |
| completion --install | `{installed, shell}`                                                  |
| version            | `{version}`                                                             |
| init               | `{dir, manifest, created, extension?}`                                  |
| target add         | `{name, core, ai, gui, f2, scope, default}`                             |
| target ls          | `[{def, name, core, ai, scope, user, password:'••••••'}]` (masked)      |
| target use         | `{default}`                                                             |
| scope get          | scope object · `{id, exists:false}` (exit 1)                            |
| scope create       | `{action:'created'|'updated', scope}`                                   |
| scope delete       | `{id, deleted:true}`                                                    |
| f2 ls              | `{maps, campaigns}`                                                     |
| f2 run             | `{map, mapId, campaign, status, elapsedSec?, ok?, exception?, steps?, waited?}` |
| mp ls / categories / versions / deprecate / rm | marketplace response as-is                  |
| mp show            | addon detail, or the version detail with `@version`                     |
| mp init            | `{path, marketplace, errors, warnings}`                                 |
| mp login           | `{url, maintainer, whoami}`                                             |
| mp pull            | `{slug, version, file, bytes, sha256, sha256_ok}`                       |
| mp publish         | `{slug, version, updated, listing, published, catalog}` · `{dryRun:true,…}` |
| mp install         | `{slug, version, sha256, verified, target, pushed, collisions, upgrade?}` · `--report` variant |

test/output-mode.test.mjs lints that every command module except help calls `.result(`.

## lib/tagdelta.mjs (DESIGN §28) — pure, shareable
    mergeTagDelta(serverValues, deltaValues, {prefix}) -> {values, added, updated, unchanged, kept}
    removeOwnValues(serverValues, names, {prefix, legacy}) -> {values, removed}
    legacyOf(delta) -> [name]   the delta's declared unprefixed own values (DESIGN §30)
    sliceOwn(serverValues, names) / projectValues(values)   (canonical slice both sides are hashed in)
    checkTagDelta(delta, {id, prefix, ownTagclasses, knownTagclasses}) -> [{code, message}]
    lintTagDeltas(pkg) -> [{code, message}]   codes: EXT_TAG_VALUE_PREFIX, EXT_TAG_CLASS_UNKNOWN, EXT_TAG_DELTA_OWN, EXT_TAG_LEGACY
      (also folded into extension.mjs lintExtension(pkg) -> [{code, where, message}]; findingKey(f) = code|id dedupes the two)
    valuePrefix(manifest) -> 'ACME_'
    onlyMissing(deltaValues, serverValues) -> bool   (server differs only by absent values)
Adapter `fd.tagclass-delta`: push/remove serialized; optional adapter hooks read by sync.mjs:
    mergeOnPush=true + onlyMissing(local, server) -> bool   skip collision/conflict refusals ONLY when true
    baseState(local) -> {ownValues, legacyValues}    merged into state wherever sync records a base without push()
                                                     (never legacyAdded: only push() records what it ADDED — §30;
                                                     pull passes the file as written, so kept keys count)
    keepLocal(prevFileObj, canon) -> {key: value}   jsonLayout.writeLocal re-attaches these unhashed keys (`legacy`)
    push() -> {ownValues, legacyValues, legacyAdded}  legacyAdded = declared legacy values a push of this package added
    orphans(ctx, entry, local) -> [name] non-empty = push writes although the slice is unchanged
    presence(ctx, entry) -> string | {state?, detail}   status --remote detail (and state override)

## lib/jsonschema.mjs + lib/schemas.mjs (DESIGN §29) — JSON Schemas of the package files
    validateSchema(schema, value, {registry: Map($id -> schema)}) -> [{path, message, keyword, severity}]
      subset: SUPPORTED_KEYWORDS; severity 'error' only where the failing node says "x-uxc-severity": "error"
    SCHEMA_BASE / schemaUrl(name) -> the $id (= the $schema scaffolds write); schemas read from schemas/
    SCHEMA_NAMES {manifest, registry, marketplace, compat} · KIND_SCHEMAS {kind -> name} · schemaForKind(kind)
    loadSchemas() -> {byName, byId} · validateAgainst(name, value) -> findings
    lintSchemas(pkg) -> [{file, path, message, severity, where}]   verify: error = FAIL, warning = warn
    stampSchema(absPath, name) -> bool   (init/add/init --extension/mp init; no-op if already set)
    keepSchemaKey(absPath, obj) -> obj   (writeLocal keeps the file's $schema across a canonical rewrite)
Invariant: canonicalize() strips a top-level `$schema` (no hash change, never pushed).

## lib/ownership.mjs (DESIGN §31) — row ownership for `data push --prune` and fd.dataset remove()
    rowOwners(ctx, manifest) -> {owners:[{code, forms, source:'receipt'|'dependency'}], receiptsReadable, receiptErrors:[string]}
    foreignOwners(ctx, manifest) -> owners                                             (rowOwners(...).owners)
    prefixMatchLength(forms, id, {strict?}) -> n   longest carried prefix form, 0 = none   PURE
    splitRowOwnership(ids, manifest, owners, {receiptsReadable=true}) -> {own:[id], foreign:[{id, code}], unproven:[id]}   PURE
      longest prefix wins (own strict boundary vs foreign lenient; tie -> own); unprefixed -> own when
      receiptsReadable, else unproven (kept)
    pushRows(...) report gains keptForeign: [{id, code}], keptUnproven: [id]
    fd.dataset remove(ctx, id) -> {deleted:[id], keptForeign, keptUnproven}   (rm --server, destroy, generic prune)
  lib/receipt.mjs: readReceiptsChecked(ctx) -> {receipts, readable, errors}   never throws; readReceipts unchanged
