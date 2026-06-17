---
description: Smoke-test a deployed prompt, goal, or handler pipeline end to end
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

`$ARGUMENTS` names what to smoke (a promptId, goal name, handler logical id, or classId). Pick
the matching flow; if ambiguous, ask which.

**Prompt:**
```
uxc run <promptId> --payload k=v … --expect '<regex>'
```
- Saved inputs: `--fixture <name>` (create one with `--save-fixture <name>` on a good run).
- `--expect` tests the FULL answer; exit 1 = expectation failed, with PASS/FAIL + first 400 chars.
- Gateway errors stream as 200 bodies; uxc retries once automatically — a reported `error`
  after that is real. `uxc explain '<message>'` for the next move.

**Goal (routing):**
```
uxc run <goalName> --goal --payload k=v … --expect '<regex>'
```
- A 400 about unresolved Thymeleaf vars means the goal needs runtime context a direct call
  can't provide — fall back to smoking the underlying prompt directly.

**Handler pipeline (enrich-at-ingestion):**
```
uxc status fd.handler            # confirm the handler is in sync, enabled, no orphans
uxc doc create <classId> --file <sample> --name "smoke-$(date +%s)"   # prints the new doc id
uxc watch <docId> --fields <Class>Status,<Class>Error --until '<Class>Status=DONE' --timeout 300
```
- If the handler was pushed less than ~45 s ago, uxc warns about the blind window — WAIT for it
  before creating the doc (events inside it are lost; the doc would never process).
- On `FAILED` or timeout: `uxc get <docId> --fields <Class>Status,<Class>Error` — the error tag
  is the handler's only readable log. `uxc explain` its content.
- ANSWER-handler smokes need a FRESH task (re-answering an answered task does not dispatch);
  note answered tasks still show status NEW in `task ls`.
- Clean up throwaway docs afterwards: `uxc doc rm <docId>`.

Report: PASS/FAIL per smoke, elapsed time, the decisive output snippet (answer extract or final
tag values), and the exact failing command if anything failed.
