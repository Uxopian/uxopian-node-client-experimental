// uxc help — the static command map. No dynamic imports: this must work even when a command
// module is broken, because help is what you reach for when something is. `--search` is the one
// exception: it loads lib/helpsearch.mjs lazily, and that module survives a broken command module.
export const TEXT = `uxc — build, package, and sync FlowerDocs + Uxopian AI customizations

package lifecycle:
  init                      scaffold a package (--name "…" --code ct) + CLAUDE.md stanza
  target add|ls|use         manage connection targets (~/.uxopian/targets.json)
  target logout [name]      forget the cached fast2 token (--all: every one); local, no broker call
  status                    drift + untracked + orphans + pendingCacheClear (--remote --kind --prefix)
  diff <id>                 local vs server diff, capped at 80 lines (--base --full)
  pull [id…|--all]          pull server edits into the package (--force; --flatten for @include)
  push [id…|--changed|--all] push local edits (--paths --force --settle --recreate --revive)
  add <kind> <Name>         scaffold a resource with the verified mechanics (--from-file)
  adopt --scan              prefix-driven bulk discovery -> registry + pull (--kind --yes)
  adopt <kind> <id>         adopt a single server resource (--external)
  rm <id>                   delete: pick --local | --server | --both (--force for gated kinds)
  destroy                   full reverse-order teardown of the package (--dry-run)
  export [-o f.uxpkg]       zip the package minus .uxc/ (--allow-dirty)
  import <pkg|dir>          pre-flight + ordered push (--code-remap a=b --force --expect-sha256 H --report)
  verify [id…]              post-deploy assertions + cross-reference + offline lints
  data pull <name>          dataset rows: server -> JSONL (row-level 3-way)
  data push <name>          dataset rows: JSONL -> server (--prune prints the kill list; rows of other installed packages are kept)
  refs <id>                 which package files mention this id
  disable <handlerId>       flip Enabled off on the live registration (kill switch, no window)
  enable <handlerId>        flip Enabled back on

day-to-day:
  ls|list <kind>            list server resources (--mine --fields)
  get <kind|doc> <id>       read one resource/document/virtual folder (--fields --raw-tag --content)
  schema <classId>          tagReferences x tagclass x categories table (--tag T)
  search [classId]          REST search (--where 'Tag=a|b'… --category TASK|VIRTUAL_FOLDER --max 20)
  doc create <classId>      create a document (--tag k=v… --file --id --name)
  doc rm <id…>              delete documents (batched 20/call, per-id fallback)
  task ls                   list tasks (--class); answered tasks still show status NEW
  task answer <task> <ans>  answer a task (handlers fire on the FIRST answer only)
  watch <docId>             poll for tag changes (--until 'Tag=V' --interval 10 --timeout 300)
  recent [classId]          newest components (--category TASK --since 15m)
  run <promptId>            run a prompt/goal via the gateway (--payload k=v… --goal --expect --prompt-version --application)
  run --plan <planId>       run an ai.plan to completion, per-node report (uxopian-ai ft5+)
  versions <promptId>       a prompt's version history, served/draft, = local (--stats; ft5+)
  context                   compact package map for an agent: kinds, ids, include order, policy
  size [id…]                composed push-body size vs the ~1 MB server limit (+ strip savings)

several agents on one instance (DESIGN §25):
  --no-lock                 skip the target lock (writes serialise on it; reads never wait)
  --lock-timeout <s>        how long a write waits for the lock (default 600)
  --target <name>           may only CONFIRM a package pinned by agent.target / .uxc/target
  --allow-target-mismatch   deploy to a target other than the pinned one, on purpose
  uxopian-project.json "agent": { target, protect[], neverPull[], forbid[], gotchas }

marketplace (Pulse Addons Marketplace — publish/browse .uxpkg addons):
  mp login                  save the endpoint + per-maintainer API key (--url --token --name --email)
  mp init                   scaffold marketplace.json in the package (--force)
  mp publish                publish a version: upsert listing, upload artifact+assets, finalize (--dry-run)
  mp ls                     browse addons (--category --audience --product --fd --uxai --q --tag)
  mp show|get <slug>        addon detail + version history (--version --catalog)
  mp versions <slug>        version history of an addon
  mp pull <slug>            download a version as .uxpkg (--version -o); then 'uxc import'
  mp install <slug>[@ver]   download + verify hash + deploy to --target (--report: read-only upgrade report, exit 3 = breaks)
  mp deprecate <slug>       lifecycle: deprecate / --yank / --reactivate a --version
  mp categories             list marketplace categories
  mp rm <slug>              archive a listing (--yes)

fast2 (migration/ingestion maps on a fast2 broker):
  f2 ls                     list maps on the broker (--campaigns adds campaign states)
  f2 run <MapName>          start a campaign and report per-step results (--wait --expect-ok --no-wait)
  f2 status <campaign>      campaign state + per-step punnet counts (--watch --interval --timeout)
  f2 exceptions <c…>        save the campaigns' exception export, count rows + top (step, class) (--out)
  f2 lib ls|push|restore    worker jars: list, upload <x.jar>, roll back --from <jar.old> (--yes)

scopes (FlowerDocs multi-tenant scope lifecycle — Core REST /core/rest/scope):
  scope get <id>            read a scope (exists-check + summary)
  scope create <id>         create/update a scope remotely (--blank | --from scope.json --description --lang --admin)
  scope delete|rm <id>      delete a scope and its data (--yes)

utilities:
  cache-clear               DELETE /gui + /core caches; clears pendingCacheClear
  api <METHOD> <path>       raw call on core|gui|ai|f2 with the target's auth, pacing, lock + explain
                            (surface inferred from /core /gui /api/v1 /api; writes need --yes)
  explain <CODE|text>       error knowledge base (F00903, T00104, T00707, …)
  doctor                    connectivity + endpoint gauntlet (--roundtrip)
  vars [pkg|slug]           list a package's variables + check --var resolution (DESIGN §21)
  installed                 list package receipts on the target (what is deployed here)
  install-claude            symlink the Claude skill + slash commands into ~/.claude
  completion [bash|zsh]     print a completion script (or --install for an auto-loaded bash file)
  help                      this list
  help --search "<task>"    find the commands + learnings § for a task, offline (-s, --json, --limit N)

kinds: fd.tagclass fd.tagcategory fd.documentclass fd.folderclass fd.taskclass fd.vfclass fd.vfinstance
       fd.workflow fd.acl fd.script fd.guiconfig fd.handler fd.surfacing fd.dataset
       ai.prompt ai.goal ai.mcp ai.llm ai.agent ai.plan ai.application  f2.map
       (uxc ls ai.tool lists the gateway's native tools — not a package kind)

aliases (same command, other spelling — verb/flag table: lib/CONTRACTS.md):
  list = ls   <family> list = <family> ls (target task f2 mp)   mp get = mp show   scope rm = scope delete
  --limit = --max (search, recent, task ls)   --max = --limit (mp ls)

global flags: --target <name>  --json  --human  --dir <packageDir>  --no-token-cache
fast2 token: one login is shared by every uxc process (~/.uxopian/f2-tokens/, mode 600) until 10 min
              before it expires; --no-token-cache or UXC_F2_TOKEN_CACHE=0 turns it off, target logout clears it
output:       JSON is the default when an agent drives uxc (UXC_AGENT=1, or CLAUDECODE=1) — compact,
              one line; errors become {"ok":false,"error",…} on stdout. UXC_AGENT=0 turns detection
              off; --human / --json force either. A piped stdout alone never switches to JSON.

not sure which command or which learnings §?  uxc help --search "update a tag class"`;

export default {
  name: 'help',
  summary: 'list all commands',
  help: 'uxc help [--search|-s "<what you want to do>"] [--limit N] [--json]',
  async run(ctx) {
    const flags = ctx?.flags ?? {};
    const args = ctx?.args ?? [];
    const dashS = args.indexOf('-s');
    if (flags.search === undefined && dashS < 0) return console.log(TEXT);
    // `--search a b` parses as search='a' + args ['b']: take every word, quoted or not
    const query = [typeof flags.search === 'string' ? flags.search : '', ...args.filter((_, i) => i !== dashS)]
      .join(' ').trim();
    if (!query) return ctx.out.line('usage: uxc help --search "<what you want to do>" [--limit N] [--json]');
    const limit = Number.parseInt(flags.limit, 10) > 0 ? Number.parseInt(flags.limit, 10) : 8;
    const { helpSearch, formatHelpSearch } = await import('../helpsearch.mjs');
    const res = await helpSearch(query, { limit, helpText: TEXT });
    if (ctx.out.json) return ctx.out.result(res);
    for (const l of formatHelpSearch(res)) console.log(l);
  },
};
