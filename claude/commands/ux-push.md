---
description: Push local package edits to the server (validated, ordered, resumable)
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

1. Preview what will move:
   ```
   uxc status
   ```
2. Push (`$ARGUMENTS` = specific ids, or empty for everything changed). If ANY fd.handler is in
   the change set, add `--settle` so the ~45 s activation window is waited out:
   ```
   uxc push --changed --settle
   # or: uxc push $ARGUMENTS [--settle]
   ```
3. Verify:
   ```
   uxc verify
   ```

Interpreting push output:
- One line per resource with its action (`created`/`updated`/`skipped`/`rotated _vN`); state is
  committed per resource IMMEDIATELY, so a failure at item 7/20 leaves 1–6 done.
- Validation errors abort BEFORE any write — fix the listed problem in the file and re-run.
- On a hard failure: read the auto-appended explain line, fix, then resume with
  `uxc push --changed` (already-pushed items won't repeat).
- TOCTOU refusal ("server changed since status") — re-run `uxc status --remote`, then /ux-sync.
- `createOnly` kinds (taskclass, vfinstance) report drift instead of updating: that is policy,
  not a bug. NEVER try to force a taskclass update — schema change = new id.
- If the run mentions a pending/failed cache clear, run `uxc cache-clear`.

After a handler push WITHOUT `--settle`: warn the user that events in the next ~45 s are lost —
do not smoke-test inside the window.

Report: per-resource actions, any failures with their explain line, and verify's summary.
