---
name: uxopian-client
description: Use uxc (uxopian-client) for ALL FlowerDocs and Uxopian AI customization work on IRIS or any other instance — building, fixing, deploying, or syncing a handler (OperationHandler), prompt, goal, tagclass, taskclass, documentclass, GUIConfiguration, script, virtual folder, scope property, or dataset; calling Core REST or the uxopian-ai gateway; deploy, smoke test, drift check, cache clear; packaging and shipping a uxpkg; publishing/browsing addons on the Pulse Addons Marketplace. Fires on phrasings like "fix the ingest handler", "add a column to the deviation worklist", "push the prompt", "why didn't the handler fire", "export the ct package", "the search template disappeared", "publish this addon to the marketplace", "download the contract demo package".
---

# uxopian-client (uxc)

`uxc` is a zero-dependency Node (>=18) ESM CLI in this repository
that owns ALL the hard-won FlowerDocs + Uxopian AI API mechanics (array bodies, id-in-path
updates, handler version rotation, tmp-file ordering, cache clears, scope merges, error codes).
**Never hand-roll curl/fetch against Core REST or the gateway — go through uxc or its lib.**

Invoke: `uxc <cmd> …` (PATH-linked; or `node bin/uxc.mjs <cmd>` from the repo).
Targets/credentials live in `~/.uxopian/targets.json`; `--target <name>` overrides
the default. `uxc help` lists every command. A "package" = a directory with
`uxopian-project.json` + `registry.json` + `fd/` + `ai/` + `data/`; commands find it from cwd
(or `--dir`).

## The three loops

**Build** (day-to-day, inside a package):
```
uxc add <kind> <Name> [flags]     # scaffold with verified mechanics baked in (see references/kinds.md)
# edit the scaffolded file(s)
uxc push --changed [--settle]     # validated, ordered, resumable; --settle waits out the handler window
uxc verify                        # post-deploy assertions + cross-reference lint
uxc run <promptId> --payload k=v --expect 'regex'        # smoke a prompt
uxc doc create <classId> --file f && uxc watch <docId> --until 'Tag=V'   # smoke a handler
```

**Sync** (drift management):
```
uxc status --remote               # full 3-way: local vs base vs server, + untracked + orphans
uxc diff <id> [--full]            # before any decision
uxc pull <id…>|--all              # server edit wins        uxc push <id…>  # local edit wins
```
States: `insync` `local`(push) `server`(pull) `rebased`(auto-recorded, ignore)
`conflict`(diff, then pull/push --force) `collision`(no base + differs: diff first)
`server-missing`(push --recreate or rm --local).

**Ship** (cross-instance):
```
uxc export -o ct-1.0.0.uxpkg                 # refuses dirty status unless --allow-dirty
uxc target add stage --url … --scope … --user … --password …
uxc import ct-1.0.0.uxpkg --target stage     # pre-flights ALL collisions before any write
```

**Publish** (Pulse Addons Marketplace — browse/download in Pulse, ALL editing here in Claude):
```
uxc mp login --url https://pulse.<host> --token uxmk_…   # per-maintainer API key (once)
uxc mp init                                  # scaffold marketplace.json (slug, audience, compat, assets)
uxc mp publish --dry-run                      # export + catalog + validate, NO network — read it back
uxc mp publish                                # upsert listing -> upload .uxpkg + assets -> finalize
uxc mp ls / show <slug> / pull <slug>         # browse + download a version, then uxc import
```
Audience = generic | customer-demo | prospect-demo (demos need an `account`); compatibility =
tested-on tags; version comes from the manifest. Full surface + gotchas: `references/marketplace.md`.

## Absolute policies — the tool enforces these; never work around them

- **NEVER delete+recreate a taskclass.** It permanently breaks ANSWER dispatch. Schema change
  = mint a NEW class id. uxc refuses (`createOnly` policy); only test teardown may
  `rm --server --force`.
- **Handler redeploys are version-rotated BY THE TOOL** (`_vN` → `_vN+1`, old deleted, caches
  cleared). Never edit a live registration doc in place — Core keeps the stale subscription.
- After a handler push there is a **~45 s blind window**: events fired in it are LOST, no
  retro-fire. `push --settle` waits it out; never create the triggering doc immediately after.
- **Scope writes are additive + verified BY THE TOOL** (backup → merge → re-GET → auto-restore
  on foreign change). Never POST a whole scope yourself.
- **Cache clears are managed**: state carries `pendingCacheClear`; if status shows it dangling,
  run `uxc cache-clear`. Don't sprinkle manual clears.
- **Write only to resources the registry owns** (project-prefixed). Shared/native resources are
  `external` — read-only, always.

Full rationale + more rules: `references/policies.md`.

## Token-economy habits (you are the primary user — keep outputs small)

- `--fields a,b` on `ls`/`search`/`get`/`watch`; defaults are already capped projections.
- `uxc schema <classId>` for class structure — never `get` the full class JSON to see tags.
- `uxc watch <docId> --until 'Tag=V'` — never hand-write poll loops.
- `uxc explain <CODE|text>` BEFORE debugging any error; failures auto-append the explanation.
- Never `--full` unless the capped output truly lacks what you need; `get --content` writes
  bytes to a file instead of dumping them.
- `--json` everywhere when you will parse the output.
- Multi-step bespoke jobs (migrations, seeders): write a small script on the lib
  (`import { connect, runPrompt } from 'uxopian-client'`)
  — never a re-grown ad-hoc `http()` helper.

## Scope lifecycle (multi-tenant scopes)

FlowerDocs is multi-tenant via **scopes**, and a scope can be created/deleted **remotely** over
**Core REST** (`/core/rest/scope`) — `uxc` covers it with the same `core` client/JWT as every other
command:
```
uxc scope create <id> [--blank|--from scope.json] [--description … --display-en … --lang EN,FR --admin system]
uxc scope get <id>            # exists-check + summary (--json = full object)   uxc scope delete <id> --yes
```
`--target <name>` picks the instance; `create` upserts (new id created, existing id updated). Clone:
`uxc scope get <src> --json > s.json` then `uxc scope create <dst> --from s.json`. Endpoints:
`FD-SCOPE-REST.md`. Distinct from `fd.surfacing` (scope *properties* inside a scope).

## Scope rule

uxc covers the **API surfaces** (Core REST, gateway, GUI caches). **In-browser verification —
screenshots, GWT clicks, popup driving, visual checks — stays with your browser-automation tooling
(e.g. Puppeteer)**, not uxc. If the question is "does it render / can a user click it", that's the
browser tooling, not uxc.

## References (read on demand, not up front)

- `../../../docs/DIAGNOSTICS.md` — BEFORE installing on a new/unknown scope: uxc doctor --ready / --sandbox / --ai-smoke, layer gates, symptom table.
- `references/kinds.md` — 18-kind cheat sheet: storage, fields, policy, add signature, top gotcha.
- `references/policies.md` — the non-negotiables with the verified WHY behind each.
- `references/errors.md` — error code/signature KB + gateway stream quirks.
- `references/recipes.md` — worked end-to-end flows with exact commands (incl. `uxc test` — package-embedded functional tests, recipe 8).
- `references/marketplace.md` — `uxc mp` publish/browse, marketplace.json schema, audience + tested-on compatibility.
