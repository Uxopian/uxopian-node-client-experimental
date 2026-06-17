# CLAUDE.md — Sample Package

## Uxopian customizations — route through `uxc`

This directory is a uxopian-package (`uxopian-project.json`). ALL FlowerDocs / Uxopian AI
server work goes through the `uxc` CLI — never ad-hoc HTTP deploy scripts (the verified API
mechanics, cache clears and handler version rotation live inside the tool).

- `uxc status [--remote]` — local/server drift + untracked files + orphans
- `uxc add <kind> <Name>` — scaffold a resource (templates ARE the mechanics)
- `uxc push --changed` / `uxc pull` — hash-synced deploy / backport; conflicts surface, never clobber
- `uxc diff <id>` · `uxc verify` · `uxc explain <CODE>` · `uxc doctor`
- Owned id prefixes: `Sp` (pascal), `sp` (camel), `sp-` (kebab), `SP_` (upper)
