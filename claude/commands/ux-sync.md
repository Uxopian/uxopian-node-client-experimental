---
description: Reconcile package vs server drift, resource by resource, deciding pull vs push with the user
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

Procedure — strictly in this order:

1. **Always start with the full picture:**
   ```
   uxc status --remote $ARGUMENTS
   ```
2. For EACH drifted resource, show the evidence before acting:
   ```
   uxc diff <id>
   ```
   (capped at 80 lines; `--full` only if the cap hides the decisive part).
3. Decide per resource — involve the user whenever both sides changed:
   - `local`  → `uxc push <id>` (handler ids: add `--settle`).
   - `server` → `uxc pull <id>`.
   - `rebased` → nothing; base was auto-recorded.
   - `conflict` or `collision` → present the diff to the user, state which side you'd keep and
     why, and WAIT for their call. Then `uxc push <id> --force` or `uxc pull <id> --force`.
   - `server-missing` → ask: restore (`uxc push <id> --recreate`) or accept the deletion
     (`uxc rm <id> --local`).
4. Re-run `uxc status --remote` and confirm it is clean (exit 0).

Hard rules:
- **NEVER use `--force` without having shown the user the diff for that exact resource.**
- Never batch-force (`push --all --force`); forces are per-resource, deliberate decisions.
- If `pendingCacheClear` shows, run `uxc cache-clear` before finishing.

Report: per resource — id, state, action taken (or decision pending); end with the final
status summary line.
