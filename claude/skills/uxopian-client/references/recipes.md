# Worked flows — exact commands

`uxc` = the `uxc` CLI on your PATH. All commands run from
inside the package directory (or pass `--dir`). Add `--target <name>` to aim anywhere but the
default. Add `--json` when parsing.

## 1. Start a new package

```
uxc target ls                                   # check the instance is registered; else:
uxc target add iris --url https://iris.demos.uxopian.com --scope IRIS --user system --password '…'
uxc init --name "Contract Management" --code ct ./contracts-pkg
cd contracts-pkg
uxc doctor                                      # connectivity + endpoint gauntlet — run BEFORE building
```
`init` writes the manifest (edit `registrationOrderBands` if defaults clash), registry, state,
dirs, and a CLAUDE.md stanza routing future sessions to uxc.

## 2. Adopt an existing build (bring live resources under management)

```
uxc adopt --scan --yes          # prefix-driven discovery across all kinds -> registry + pull + base hashes
uxc pull --all                  # make every local file the canonical server echo
uxc status                      # must be clean; orphan _vN handlers are listed if any
```
Single resource: `uxc adopt fd.handler CtIngest_onCreate` (accepts the deployed `_vN` id too).
Reference without owning: `uxc adopt <kind> <id> --external`.

## 3. Enrich-at-ingestion handler, end to end

```
# 1. marker tags (handler observability — REQUIRED, writes fail F00032 without them)
uxc add fd.tagclass CtBarStatus --type STRING --title "Bar pipeline status"
uxc add fd.tagclass CtBarError  --type STRING --title "Bar pipeline error"
# 2. the class referencing them
uxc add fd.documentclass CtBar --tags "CtBarStatus,CtBarError" --title "Bar document"
# 3. the handler — template ships safe http(), minted JWT, idempotency guard, marker tags
uxc add fd.handler CtBar_onCreate --object DOCUMENT --filter-class CtBar
# 4. edit fd/handlers/CtBar_onCreate/handler.js:
#    - set the instance JWT secret (REPLACE_WITH_INSTANCE_JWT_SECRET) — never commit a real one
#    - write your logic where the template marks it (e.g. callPrompt + setTagValue)
uxc push --changed --settle     # ordered push; --settle waits out the ~45 s blind window
uxc verify                      # exactly one live _vN, enabled, in band; cross-refs resolve
# 5. smoke: create a triggering doc, watch the marker tag
uxc doc create CtBar --file ./sample.pdf --name "smoke-1"        # prints the new doc id
uxc watch <docId> --fields CtBarStatus,CtBarError --until 'CtBarStatus=DONE' --timeout 300
```
If watch times out: `uxc get <docId> --fields CtBarStatus,CtBarError` — a FAILED status with the
error tag populated is your stack trace. `uxc explain` whatever it says.

## 4. Add + smoke a prompt

```
uxc add ai.prompt ctBarSummary            # add --fcm if it must call tools (sets the fcm pair correctly)
# edit ai/prompts/ctBarSummary.content.md (the prompt text, verbatim)
# edit ai/prompts/ctBarSummary.json if provider/model/temperature need changing
uxc push ai.prompt/ctBarSummary
uxc run ctBarSummary --payload documentId=CT_TEST_01 --expect 'score'
```
`--expect` tests the FULL answer (exit 1 on fail). Reusable test inputs:
`uxc run … --save-fixture smoke-bar`, later `uxc run ctBarSummary --fixture smoke-bar --expect …`.
Route it: `uxc add ai.goal --goal summarize --prompt ctBarSummary` then `uxc push --changed`;
smoke the goal with `uxc run summarize --goal --payload …` (goals 400 on unresolved Thymeleaf
vars — fall back to direct PROMPT runs with a full payload).

## 5. Ship to another instance

```
uxc status --remote                       # must be clean (export refuses dirty unless --allow-dirty)
uxc export -o ct-1.0.0.uxpkg              # zip minus .uxc/, ai.mcp secrets scrubbed
uxc target add stage --url https://stage.example.com --scope STAGE --user system --password '…'
uxc import ct-1.0.0.uxpkg --target stage
```
Import pre-flights EVERY resource and prints the full collision list BEFORE any write
(`--force` to overwrite). A failed import is resumable: `uxc push --changed --target stage`.
`--code-remap ct=xy` is EXPERIMENTAL: registry-driven token-boundary renaming across all four
prefix forms + derived ids, then a residual lint — it ABORTS if any old-prefix token survives.
Review the lint output with the user; never force past it.

## 6. Recover drift

```
uxc status --remote               # classify everything first; never push blind
uxc diff <id>                     # for each drifted row, BEFORE deciding
uxc pull <id>                     # state 'server'  : keep the server edit
uxc push <id>                     # state 'local'   : keep your edit
# state 'rebased'  : someone pushed the identical content — base auto-recorded, nothing to do
# state 'conflict' : both sides changed — diff, decide with the user, then push --force or pull --force
# state 'collision': no base + server differs from file — diff, then pull --force / push --force / adopt
# 'server missing' : deleted remotely — uxc push <id> --recreate to restore, or uxc rm <id> --local to accept
```
Untracked files listed by status join the registry via `uxc add <kind> <Name> --from-file <path>`.

## 7. Emergency stop (handler misbehaving in production)

```
uxc disable CtBar_onCreate        # in-place Enabled=false flip + cache clear — immediate, NO blind window
# …fix handler.js…
uxc push CtBar_onCreate --settle  # rotation deploys the fix
uxc enable CtBar_onCreate         # only if you disabled without pushing a fix
```
`status` shows `disabled` as its own state, not drift.

## 8. Package-embedded functional tests (`uxc test`, uxc ≥ 0.13)

Ship the package's own "does it actually work HERE?" checks in `tests/*.test.mjs`; run them
against any target where the package is installed.

```bash
uxc test --list                       # what does this package test?
uxc test --target dev --yes           # all tests, serial, filename order (--yes = one-off consent)
uxc test ingest --keep                # filter by name; keep ZZTEST_* fixtures for inspection
```

- Standing opt-in per target: `uxc target add … --allow-tests` (or `allowTests: true` in
  targets.json / `UXC_ALLOW_TESTS=1`). Without it, `--yes` each run — tests create real objects.
- A test file default-exports `{ name, description?, requires?, timeoutMs?, run(t) }`.
  `requires` unmet ⇒ SKIP with reason (not a failure): `resources` (deployed kind/id),
  `docs` (instance config, e.g. CT_CONFIG), `llmProvider: true`, `caps: {product:{cap:true}}`.
- Harness: `t.doc.create({classId, tags, file})` mints `ZZTEST_*` + auto-tracks;
  `t.waitFor(fn, {timeoutMs, label})` for handler pipelines + search lag (poll DIRECT GETs on
  deterministic ids); `t.runPrompt(id, payload, {expect: /re/})`; `t.answerTask(taskId, answerId)`
  (ANSWER dispatches on the FIRST answer only); `t.track('task', id)` for handler-spawned tasks.
- Green run ⇒ receipt stamped: `uxc installed` shows `tests: N/N pass @ date`.
- Reference suite: `examples/ct-package/tests/` (baseline, worklists, prompt smoke, ingest e2e,
  walk-away approval e2e).
