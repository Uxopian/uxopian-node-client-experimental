---
description: Scaffold a new package resource (tagclass, class, handler, prompt, goal, ...) with verified mechanics baked in
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

`$ARGUMENTS` = `<kind> <Name> [flags]` (e.g. `fd.handler CtBar_onCreate --filter-class CtBar`).
If the kind or flags are unclear, check the per-kind add signatures in
`claude/skills/uxopian-client/references/kinds.md` first.

```
uxc add $ARGUMENTS
```

Common signatures:
```
uxc add fd.tagclass      CtFoo  --type CHOICELIST --values "A,B" [--title …] [--fr …]
uxc add fd.documentclass CtBar  --tags "CtFoo:mandatory,SourceContractId:readonly" --category-ids …
uxc add fd.taskclass     CtGate --answers APPROVE,REJECT --workflow CtApproval
uxc add fd.handler       CtBar_onCreate --object DOCUMENT --filter-class CtBar [--phase AFTER] [--sync]
uxc add fd.guiconfig     ct-foo-search  --template search|home|vf-override --class CtBar
uxc add fd.script        ct-foo
uxc add ai.prompt        ctFoo  [--fcm]
uxc add ai.goal          --goal <goalName> --prompt ctFoo [--filter expr] [--index n]
uxc add <kind> <Name> --from-file <path>     # register an existing/generated file instead
```

After scaffolding:
1. Note the files uxc reports (and the allocated RegistrationOrder for banded kinds).
2. Open and complete them — for handlers: set the instance JWT secret in handler.js and write
   the logic where the template marks it; for prompts: write `<id>.content.md`.
3. Name follows the project convention (pascal `Ct*` for classes/handlers, camel `ct*` for
   prompts/goals, kebab `ct-*` for scripts/guiconfigs) — uxc errors if it doesn't.
4. Nothing is on the server yet. Tell the user the resource is scaffolded and that
   `/ux-push` (or `uxc push --changed`) deploys it.

Report: kind, id, file paths created, what still needs filling in before push.
