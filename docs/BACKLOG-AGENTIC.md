# uxc backlog: running several coding agents against one instance

Written 2026-09-05 from three weeks of driving `uxc` through Claude agents on the Gerflor POC
(package `po`, scope `default`, up to two agents in parallel, one shared FlowerDocs instance).
Everything below was hit for real; the "why" line says how it bit us. Ordered by pain.

## P1 — correctness with concurrent agents

1. **Composed scripts: pull must not flatten a source with `// @include` lines.**
   Why: a `pull` of `fd.script/po-widgets` overwrote the 22-line composer with the 13 000-line
   server output; every later part change was silently ignored, and `push` answered "unchanged"
   until `--force`. Fix: refuse to overwrite a composed source (or re-materialize the parts),
   and let `status` hash the *composed* output, not the source file.
2. **Built-in lock, read/write.** Why: no lock exists; we wrapped `uxc` in `bin/uxcl` (mkdir
   lock, orphan detection). A `status` waited four minutes behind a `test --yes` campaign.
   Reads (`status`, `diff`, `get`, `schema`) should never wait behind writes.
3. **Pinned target per package.** Why: an agent pushed to the wrong instance once. A
   `uxopian-project.json` `target` (or `.uxc/target`) that `--target` may only *confirm*, plus a
   loud refusal when the CLI default differs.
4. **Serialize handler pushes across processes.** Why: the ~45 s blind window after a handler
   push loses events; two pushes at once double the window and nothing stops them. Enforce a
   queue for `fd.handler` kinds; `--settle` stays, but the tool should hold the lock for the
   settle duration.
5. **`push --changed` with a path scope.** Why: with two agents editing disjoint files,
   `--changed` ships the other agent's half-done work. `--changed --paths fd/handlers/PoEmail_onCreate`
   or worktree awareness (only files changed in *this* checkout since a marker).
6. **Rollback for handlers.** Why: rotation deletes `_vN` after `_vN+1` is live; a bad push has
   no way back but a new push. Keep N-1 and add `uxc rollback fd.handler/<id>`.

## P2 — verify should catch what broke us

7. **Prompt variable lint.** Why (2026-09-05): three prompts gained `${openObligations}`, the
   deployed handlers did not send it, the gateway hung until timeout, four e2e tests broke, the
   agent had to revert on the server. Static check in `verify`: for each `ai.prompt`, extract
   `${vars}` from the content and grep every handler's `callPrompt` payloads (and `uxc run`
   fixtures) for the keys; warn "variable X of prompt P is provided by no caller". Also order the
   push plan: handler providing a variable before the prompt consuming it, or block.
8. **Dataset scaffold writes the manifest.** Why: `uxc add` of a dataset leaves the
   `dataSets` entry of `uxopian-project.json` to be added by hand; the first push fails with an
   explicit but avoidable error.
9. **Include-order lint for handlers.** Why: `_shared` libraries have an implicit order
   (po-lib, calendar, time, rules, sla, case, integrations, obligations, ai, eml). A misplaced
   `// @include` fails only at runtime. Declare the order once per package and verify it.
10. **Taskclass in-place update guard.** Why: the "never recreate a taskclass" rule is enforced
    by `createOnly`, but adding tags in place is allowed and safe; the CLI should say so in the
    push output ("updated in place, answer binding preserved") so agents stop fearing it.

## P3 — agent ergonomics and token economy

11. **`uxc context`**: print a compact package map in about a thousand tokens: kinds and counts,
    key ids, include order, owned prefixes, known gotchas from a `GOTCHAS.md`, last verify state.
    Every agent currently rebuilds this by `grep` in its first ten minutes.
12. **Guardrails as data**: a package file listing forbidden commands (`--changed`, `pull` on
    given ids, `rm --server`), protected ids, and "never pull" prompts (the server may hold an
    older version on purpose). Enforced by the CLI, not by briefs that get skimmed.
13. **Offline test tier.** In-memory suites (`loadShared` + fake Core) need no server; tag them
    and run them without the lock, in parallel with an e2e campaign. `test --only <pattern>`
    exists and is good; add `--offline`.
14. **Compact dataset format.** The thirteen generic columns repeated on every JSONL line cost
    tokens every time an agent reads or writes rules. Accept a columnar form
    (`key | order | value | json | fr | en`) expanded at push, keep JSONL as the canonical export.
15. **`status` without the lock and with `--kind`/`--prefix` filters**, `--json` everywhere
    (mostly there), and a one-line summary first, details after.
16. **Explain on hang.** A gateway call that hangs until timeout produces no error code, so
    `explain` cannot help. Detect the prompt-variable case client-side (see 7) and print the
    likely cause on timeout.

## Already fixed this week (for the record)

- `export`: `out is not defined` (fe3e60b).
- `tagclass`: FREELIST accepted; `UXC_HTTP_LOG` request journal (81a9575).
- `surfacing`: optional `order` key pins `tab.virtualfolder` order; `UXC_DEBUG_SCOPE` (ac51818).
- Uncommitted on this branch: `doctor --sandbox --classes a,b` (lib/preflight.mjs, lib/commands/doctor.mjs).
