# Non-negotiable policies — and the verified WHY behind each

Every rule below was paid for in debugging time on IRIS (FLOWERDOCS-LEARNINGS.md §10–§15).
uxc enforces them mechanically; your job is to not fight the tool.

## 1. NEVER delete+recreate a taskclass (LEARNINGS §14, CONFIRMED live)
Deleting and recreating a taskclass — even with the identical schema and id — permanently breaks
ANSWER operation dispatch: handlers stop firing on fresh tasks of that class, with no error
anywhere. The only fix observed was minting a brand-NEW class id and repointing the registration
filter, handler guard, and task creation at it.
- uxc: `fd.taskclass` is `createOnly` — push creates if absent, otherwise verifies and reports
  drift; update/delete are refused. `rm --server --force` exists ONLY for test teardown.
- Schema change = NEW id (e.g. `CtDeviationApproval3`), never an edit.

## 2. Handler in-place edits go STALE (LEARNINGS §10)
Core keeps the old operation subscription when a registration doc is edited or
delete+recreated under the SAME id — the handler silently keeps running the old code (or stops
firing). The working discipline: deploy under a FRESH id, then delete the old one.
- uxc: every handler push deploys `<logical>_v(max+1)`, verifies it reads back, deletes every
  older `_v*`, clears `/core` + `/gui` caches. The server is the source of truth for N — never
  compute N from state, never reuse an id. Orphan `_v*` survivors are reported by `status` and
  cleaned by `push`/`verify`.
- Never edit a live `OperationHandlerRegistration` doc directly. The ONE sanctioned in-place
  write is the `Enabled` tag flip (`uxc disable|enable`) — the emergency kill switch, no version
  bump, no blind window.

## 3. The ~45 s blind window (LEARNINGS §12) — events are LOST, no retro-fire
After a handler (re)deploy + cache clear, operations fired within the next ~45 seconds can be
missed ENTIRELY. There is no retro-fire and no queue.
- uxc: `push --settle` blocks until the window has passed; `watch`/`run`/`verify` check
  `deployedAt` and warn ("handler active in ~23 s") instead of letting your next action fall in.
- Never create the triggering component immediately after deploying its handler. Design handlers
  with a retry path (e.g. an UPDATE-triggered guard) so a missed event is recoverable.

## 4. T00707 — a FAILED create CONSUMES the tmp file (LEARNINGS §13)
Uploading a tmp file and then hitting "already exists" on create burns the tmp ref; the
follow-up update then 500s T00707.
- uxc: exists-check FIRST, decide create-vs-update, upload a FRESH tmp per attempt
  (`core.upsertDoc` discipline). Never reuse a tmp id across attempts.

## 5. Scope writes: additive + verified + auto-restore (deploy-gui.mjs lineage)
The scope object is shared by every project on the instance; a full-replace POST can wipe
another project's `search.template` / `tab.virtualfolder` entries.
- uxc surfacing push: backup the scope to `.uxc/backups/` → additive merge (exact name+value
  presence check per profile) → POST → re-GET → diff-minus-own-entries vs the backup →
  AUTO-RESTORE the backup if anything foreign changed.
- `profiles: "*"` expands against the live profile list at push; the expansion is recorded in
  state so unsurface removes exactly what was added.
- Never POST `/rest/scope/{scope}` yourself.

## 6. Shared/external resources are NEVER touched
Resources with `policy: external` (native classes, other projects' objects, workflows/acls in
v1) are references: uxc never writes or deletes them, and you don't either. All writes are
gated on registry ownership; `ai.goal` additionally refuses any row whose promptId is not a
package-owned prompt (a goalName is shared routing infrastructure).

## 7. RegistrationOrder bands
Scripts, GUIConfigs, and handlers carry an integer RegistrationOrder; on a shared instance,
collisions mean another project's bean/script wins or loses by precedence. The manifest declares
per-kind bands (e.g. `"fd.guiconfig": [30, 49]`); `uxc add` allocates the lowest free integer in
the band; exhaustion is a hard error ("widen registrationOrderBands"); `doctor`/`import` warn on
foreign occupants inside your bands. Don't hand-pick orders outside the band.

## 8. Base hash = canon(server echo), never canon(local)
The server injects fields on write (taskclass `answers[].type: ReasonedAnswer`, tagReference
flag defaults, temperature string-coercion). If the sync base were the local form, every one of
those would surface as phantom drift forever.
- uxc: push = write → re-GET → canonicalize the echo → persist the file AND its hash as base.
  Pull does the same. So after any successful push/pull, your file IS the canonical server form —
  do not "tidy" it back.

## 9. Cache clears are managed state
Script/GUIConfig/handler writes need `DELETE /gui/rest/caches` (+ `/core/rest/caches` for
handlers) or the GUI/Core serves stale artifacts. uxc sets `pendingCacheClear` in state BEFORE
the first cache-affecting write and clears the flag only after a successful clear — a crash
leaves the flag dangling and ANY later uxc invocation honors it. If `status` shows
`pendingCacheClear`, run `uxc cache-clear`; never assume a clear happened.

## 10. The bodyless-DELETE-as-GET bug class (LEARNINGS §14)
The historical Graal `http()` helper sent every bodyless non-GET as a GET — "DELETE returns 200
but the resource survives" (the 200 was the GET). Three debugging iterations lost.
- uxc's own HTTP layer always sends an explicit empty body on non-GET — structurally immune.
- The `uxc add fd.handler` template ships the FIXED helper. If you ever meet a handler.js with
  `else b.GET()` as the fallback, that is the bug — fix it.

## 11. Observability inside handlers = marker TAGS, not logs
`logger` writes to the Core log, unreadable without server access. Handlers must write
status/error marker tags (`<Class>Status`, `<Class>Error`) — and those tags must be DECLARED
tagclasses referenced by the class, or the write itself fails F00032. The add-template wires
this; keep it when editing.

## 12. Deletion is explicit and three-way
`uxc rm <id>` alone errors — choose `--local` (forget it), `--server` (tombstone + delete live),
or `--both`. Tombstoned (`retired: true`) resources never push by default (`push --revive`
un-tombstones). Datasets never delete server docs without tombstone rows or `--prune` + confirm.
`uxc destroy` (full teardown) requires typing the project code; use `--dry-run` first.
