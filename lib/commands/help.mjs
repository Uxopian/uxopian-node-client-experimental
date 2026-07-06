// uxc help — the static command map. No dynamic imports: this must work even when a command
// module is broken, because help is what you reach for when something is.
const TEXT = `uxc — build, package, and sync FlowerDocs + Uxopian AI customizations

package lifecycle:
  init                      scaffold a package (--name "…" --code ct) + CLAUDE.md stanza
  target add|ls|use         manage connection targets (~/.uxopian/targets.json)
  status                    drift + untracked + orphans + pendingCacheClear (--remote)
  diff <id>                 local vs server diff, capped at 80 lines (--base --full)
  pull [id…|--all]          pull server edits into the package (base = canon(server echo))
  push [id…|--changed|--all] push local edits (--force --settle --recreate --revive)
  add <kind> <Name>         scaffold a resource with the verified mechanics (--from-file)
  adopt --scan              prefix-driven bulk discovery -> registry + pull (--kind --yes)
  adopt <kind> <id>         adopt a single server resource (--external)
  rm <id>                   delete: pick --local | --server | --both (--force for gated kinds)
  destroy                   full reverse-order teardown of the package (--dry-run)
  export [-o f.uxpkg]       zip the package minus .uxc/ (--allow-dirty)
  import <pkg|dir>          pre-flight + ordered push (--code-remap a=b --force --expect-sha256 H)
  verify [id…]              post-deploy assertions + cross-reference lint
  data pull <name>          dataset rows: server -> JSONL (row-level 3-way)
  data push <name>          dataset rows: JSONL -> server (--prune prints the kill list)
  refs <id>                 which package files mention this id
  disable <handlerId>       flip Enabled off on the live registration (kill switch, no window)
  enable <handlerId>        flip Enabled back on

day-to-day:
  ls <kind>                 list server resources (--mine --fields)
  get <kind|doc> <id>       read one resource/document (--fields --content --full)
  schema <classId>          tagReferences x tagclass x categories table (--tag T)
  search [classId]          REST search (--where 'Tag=a|b'… --category TASK --order f:desc --max 20)
  doc create <classId>      create a document (--tag k=v… --file --id --name)
  doc rm <id…>              delete documents (batched 20/call, per-id fallback)
  task ls                   list tasks (--class); answered tasks still show status NEW
  task answer <task> <ans>  answer a task (handlers fire on the FIRST answer only)
  watch <docId>             poll for tag changes (--until 'Tag=V' --interval 10 --timeout 300)
  recent [classId]          newest components (--category TASK --since 15m)
  run <promptId>            run a prompt/goal via the gateway (--payload k=v… --goal --expect)

marketplace (Pulse Addons Marketplace — publish/browse .uxpkg addons):
  mp login                  save the endpoint + per-maintainer API key (--url --token --name --email)
  mp init                   scaffold marketplace.json in the package (--force)
  mp publish                publish a version: upsert listing, upload artifact+assets, finalize (--dry-run)
  mp ls                     browse addons (--category --audience --product --fd --uxai --q --tag)
  mp show <slug>            addon detail + version history (--version --catalog)
  mp versions <slug>        version history of an addon
  mp pull <slug>            download a version as .uxpkg (--version -o); then 'uxc import'
  mp install <slug>[@ver]   download + verify hash + deploy to --target (trusted pipeline)
  mp deprecate <slug>       lifecycle: deprecate / --yank / --reactivate a --version
  mp categories             list marketplace categories
  mp rm <slug>              archive a listing (--yes)

scopes (FlowerDocs multi-tenant scope lifecycle — Core REST /core/rest/scope):
  scope get <id>            read a scope (exists-check + summary)
  scope create <id>         create/update a scope remotely (--blank | --from scope.json --description --lang --admin)
  scope delete <id>         delete a scope and its data (--yes)

utilities:
  cache-clear               DELETE /gui + /core caches; clears pendingCacheClear
  explain <CODE|text>       error knowledge base (F00903, T00104, T00707, …)
  doctor                    connectivity + endpoint gauntlet (--roundtrip)
  install-claude            symlink the Claude skill + slash commands into ~/.claude
  completion [bash|zsh]     print a completion script (or --install for an auto-loaded bash file)
  help                      this list

kinds: fd.tagclass fd.tagcategory fd.documentclass fd.folderclass fd.taskclass fd.vfclass fd.vfinstance
       fd.workflow fd.acl fd.script fd.guiconfig fd.handler fd.surfacing fd.dataset
       ai.prompt ai.goal ai.mcp ai.llm

global flags: --target <name>  --json  --dir <packageDir>`;

export default {
  name: 'help',
  summary: 'list all commands',
  help: 'uxc help',
  async run() {
    console.log(TEXT);
  },
};
