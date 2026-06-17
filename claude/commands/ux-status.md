---
description: Show drift between the uxopian package, its sync base, and the live server
---

Run (from the package directory; `uxc` = the `uxc` CLI on your PATH):

```
uxc status --remote $ARGUMENTS
```

(`$ARGUMENTS` may narrow to kinds or ids, e.g. `fd.handler` or `ctSummary`. No arguments = whole package.)

Interpret the rows:
- `insync` — nothing to do; don't mention these beyond the count.
- `local` — local edit awaiting `uxc push <id>`.
- `server` — server-side edit awaiting `uxc pull <id>`.
- `rebased` — identical content pushed by someone else; base auto-recorded, informational only.
- `conflict` / `collision` — BOTH sides differ; needs `uxc diff <id>` and a human decision (suggest /ux-sync).
- `server-missing` — deleted remotely; options are `push <id> --recreate` or `rm <id> --local`.
- `orphans` — stale handler `_vN` survivors; a `uxc push <logical>` or `uxc verify` cleans them.
- `untracked` — files not in the registry; join via `uxc add <kind> <Name> --from-file <path>`.
- `pendingCacheClear` — a previous run's cache clear never completed; run `uxc cache-clear` NOW.

Exit code 1 means drift exists (not an error). Report: a one-line summary (N in sync, N local,
N server, N conflicts), then ONLY the non-insync rows with their recommended command each.
If everything is clean, say so in one line.
