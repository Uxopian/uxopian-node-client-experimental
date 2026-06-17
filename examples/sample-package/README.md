# Sample Package (`sp`)

A uxopian-package: FlowerDocs + Uxopian AI customizations managed by `uxc`.

- manifest: `uxopian-project.json` · catalog: `registry.json` · per-target sync state: `.uxc/state.json`
- resources live under `fd/`, `ai/`, `data/` — every owned server id carries a project prefix
  (`Sp*` classes/handlers, `sp*` prompts/goals/beans, `sp-*` script/guiconfig docs, `SP_*` runtime ids)
- common loop: `uxc add <kind> <Name>` → edit → `uxc push --changed` → `uxc verify`
- inspect: `uxc status [--remote]` · `uxc diff <id>` · `uxc explain <CODE>`
