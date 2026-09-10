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
   fixtures) for the keys; warn "variable X of prompt P is provided by no caller". **A warning,
   never a blocker**: a prompt can be called from outside the package's handlers (another
   client, a script, Uxopian AI without FlowerDocs at all), so absence of a caller proves
   nothing. Where a caller *is* found, order the push plan: handler providing the variable
   before the prompt consuming it, and say why.
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

## Added 2026-09-06

17. **Composed script size guard.** Why: the composed `fd.script` (14 parts plus the two include
    marker lines per part) hit nginx's 1 MB body limit; `push` answered `413 Request Entity Too
    Large` with no hint. `push` should print the composed size, warn above a configurable
    threshold (default 900 KB), and offer `--strip-comments` (comment lines only, never inline) so
    an agent can see the budget before it overflows. A `uxc size fd.script/<id>` would let agents
    check without pushing.

## Added 2026-09-10

From one afternoon session on the Gerflor POC (customer profile, D63): a new `_shared` library, a
new admin command, two datasets, a new GUI part, a prompt, a test book, deployed to `gfdefault`.
One agent this time, no concurrency: everything below is plain single-agent friction.

18. **`search` cannot find a virtual folder.** *(P1)* Why: `uxc search PoOrder --max 3` answers
    `found 0` on a scope holding dozens of `PoOrder` folders — the handler deployed minutes
    earlier read eleven of them for a single customer. `--category VIRTUAL_FOLDER` and
    `--category FOLDER` change nothing. Folders are searched on `/rest/virtualFolder/search`,
    documents on `/rest/documents/search` (see `coreSearch` in the POC's `po-lib.js`); the CLI
    looks like it only ever calls the document endpoint. Consequence: an agent cannot list or
    inspect a case from the CLI at all. I ended up reading the live state through a handler.
19. **`ls fd.vfinstance` and `status --remote` disagree.** *(P1)* Why: `uxc ls fd.vfinstance`
    prints `0 fd.vfinstance` while, in the same minute against the same target, `uxc status
    --remote` lists fourteen `fd.vfinstance` rows as `server edit`. One of the two is lying, and
    an agent that trusts `ls` concludes the instance is empty.
20. **Lint constrained tag values before pushing.** *(P2, same family as 7)* Why: `push
    --changed` died mid-run on `POST /core/rest/documents -> 500: F00020: the value
    PoProfileRules is not an allowed choice for tag PoRuleSet`, after other resources had already
    gone up. `PoRuleSet` carries `allowedValues` and the two new datasets were missing from it.
    Both halves live in the package, so `verify` and the pre-flight of `push` can catch this
    offline: for every dataset row and every resource tag, check the value against its tagclass's
    `allowedValues`. Bonus: name the admitted values in the error.
21. **Dataset scaffold: the class too, not only the manifest.** *(extends 8)* Why: `uxc add
    fd.dataset PoProfileRules` prints the manifest error *and* `created fd.dataset/…` in the same
    breath, so it is unclear whether anything happened; the `--class` flag that error suggests
    does not appear in `uxc help`; and the document class the dataset needs is not scaffolded
    either. I copied `PoRefCustomers.json` by hand for both new sets, then edited
    `uxopian-project.json` and `registry.json` by hand — precisely what scaffolding exists to avoid.
22. **`get doc <id>` misleads.** *(P3)* Why: `uxc get doc PoCustomerProfile_C-10021` answers
    `document doc not found (and "doc" is not a registry resource)`, which reads as "your document
    does not exist" when it means "drop the word doc". Same with `get document <id>`. Two
    round-trips lost before trying `uxc get <docId>` bare.
23. **`--raw-tag <name>`.** *(P3)* Why: TEXT tags holding JSON are the norm in these packages
    (`PoCaseLog`, `PoObligationState`, `PoAiProcessing`, and now `PoCustomerProfileJson`).
    `get --full` mixes a table header with the value, so reading one back means a regex over the
    CLI output. A flag printing one tag's raw value would make them scriptable.

Confirmed again this session, unchanged: **4** (the ~45 s blind window, met three times in one
afternoon), **8**, **11** (`uxc context` — the first forty minutes went to rebuilding the package
map by grep, exactly as described) and **13** (`--offline`: the package's 80 test books run
without a server in 0.5 s and could run unlocked).
