# uxopian-client · `uxc`

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org)
[![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#status)
[![Dependencies: zero](https://img.shields.io/badge/deps-0-blue.svg)](#requirements)

**Build, package, and sync [FlowerDocs](https://www.uxopian.com/) + Uxopian AI customizations from the command line.**

`uxc` turns a customization project — content model, server-side handlers, GUI configs, virtual
folders, scope surfacing, AI prompts/goals, seed datasets — into a **package**: a plain directory
with a manifest, a resource registry, and content hashes. From there you can deploy it to an
instance, detect drift in *both* directions, pull server-side edits back into files, export it as a
single `.uxpkg`, install it elsewhere, publish it to an addon marketplace, and create/delete the
multi-tenant **scopes** it lives in — all over the documented APIs, no manual clicking.

It encodes the hard-won mechanics of the FlowerDocs Core REST + Uxopian AI gateway as tool
behavior — array bodies, id-in-path updates, full-replace merges, tmp-file ordering, handler
version rotation, create-once taskclasses, additive scope writes, cache-clear choreography — plus a
built-in error knowledge base (`uxc explain F00903`). The library is **zero-dependency** (Node ≥ 18:
`fetch`, `crypto`, `zlib`, and a tiny built-in zip reader/writer).

## FlowerDocs + Uxopian AI

[**FlowerDocs**](https://www.uxopian.com/) is Uxopian's content-services platform — a governed home
for your documents and records with a rich, fully customizable content model (document & folder
classes, tags, virtual folders), workflows, fine-grained ACLs, and multi-tenant **scopes**, all
reachable over clean REST APIs.

**Uxopian AI** layers intelligence directly on top of that content — prompts, goals, function
calling, and MCP, wired to the documents *and* to the model itself. Put them together and a passive
archive becomes an active one: drop in a contract and it gets classified, its clauses extracted and
assessed against a playbook, deviations flagged, and the right review tasks opened — all under the
same governance and security as everything else. You're not bolting AI onto files; you're teaching
a governed content model to **understand** them.

That pairing — a structured content platform *and* an AI layer that understands it — is what makes
the customizations `uxc` builds worth shipping. This client is the developer-friendly way to build,
version, and deploy them.

> ### Status
> **Experimental and unofficial.** This is a community/internal tool, not an official Uxopian
> product, and it comes with no support or warranty (see [License](#license)). APIs and commands
> may change. It targets the FlowerDocs / Uxopian AI **2025.x** API surface. Use against a
> non-production instance first.

---

## Requirements

- **Node ≥ 18.17** on your `PATH`. No `npm install` needed — there are no runtime dependencies.
- Network access to a FlowerDocs instance: its **Core REST** base (up to `/core`) and its
  **Uxopian AI** gateway base (up to `uxopian-ai`) — each configured independently.
- Credentials for that instance (a Core user/password + the scope id).

## Install

```bash
git clone https://github.com/Uxopian/uxopian-node-client-experimental.git
cd uxopian-node-client-experimental
node bin/uxc.mjs help

# optional: put `uxc` on your PATH
ln -s "$PWD/bin/uxc.mjs" /usr/local/bin/uxc

# optional: install the Claude Code skill + /ux-* slash commands
node bin/uxc.mjs install-claude
```

Credentials never live in the repo — they go in `~/.uxopian/targets.json` (chmod 600), written by
`uxc target add`. A target configures two base URLs — the **Core REST** base (`…/core`) and the
**Uxopian AI** base (`…/uxopian-ai`) — plus scope/user/password (the scope authenticates). A legacy
`--url <host>` shorthand derives both from the host + scope; each is also env-overridable
(`UXC_CORE_URL`, `UXC_AI_URL`, `UXC_GUI_URL`, …).

## Quick start

```bash
# 1. register an instance (the name "iris" is your local alias for these base URLs)
uxc target add iris \
  --core https://iris.demos.uxopian.com/core \
  --ai   https://iris.demos.uxopian.com/gui/plugins/IRIS/gateway/uxopian-ai \
  --scope IRIS --user system --password '••••' --default
#   standard-layout shorthand:  --url https://iris.demos.uxopian.com --scope IRIS …  (derives /core + gateway)
uxc doctor                      # connectivity gauntlet (add --roundtrip for the full echo test)

# 2. start a project and build
uxc init --name "My Project" --code mp
uxc add fd.tagclass MpStatus --type CHOICELIST --values "New,Done"
uxc add fd.handler MpDoc_onCreate --object DOCUMENT --filter-class MpDoc
uxc push --all --settle         # ordered, validated, resumable; the ~45s handler window is managed
uxc verify                      # post-deploy assertions + cross-reference lint

# …or adopt an existing build
uxc adopt --scan --yes          # prefix-driven discovery of everything the project owns
uxc status --remote             # 3-way drift: local file vs sync base vs server
uxc diff <id> ; uxc pull <id> ; uxc push <id>

# 3. ship it across instances
uxc export                      # -> <code>-<version>.uxpkg (no credentials, no sync state)
uxc import other-1.0.0.uxpkg --target stage   # pre-flight collision report, then ordered deploy
```

## What you can do

### Build — day-to-day, token-cheap by design

Outputs are capped, projected, and `--json`-able, so they stay cheap to read (including for an LLM
driving the CLI).

```bash
uxc add <kind> <Name> [flags]                 # scaffold a resource — the template IS the verified mechanics
uxc schema MpDoc                              # tagReferences × tagclass × categories, one table
uxc search MpDoc --where 'MpStatus=New' --max 10
uxc doc create MpDoc --file nda.docx --tag MpStatus=New
uxc watch MP_123 --until 'MpStatus=Done' --timeout 300
uxc run mpSummary --payload documentId=MP_123 --expect 'term'
uxc explain T00104                            # built-in error knowledge base
```

### Sync — drift in both directions

One hash, three states. `pull`/`push` always persist the **canonicalized server echo** as the sync
base, so server-injected fields never show up as phantom drift. `status` is local-and-instant;
`status --remote` adds the server side. Conflicts are surfaced, never silently clobbered.

### Ship — `.uxpkg` archives

`export` produces a single credential-free archive (sync state excluded, secrets scrubbed).
`import` pre-flights **every** resource against the target and prints the full collision report
*before any write*, then deploys in dependency order, resumably.

### Marketplace — publish & install addons

Publish a package as a versioned **addon** to a marketplace server, and install one back onto an
instance — with a **content-hash integrity gate** so a tampered/corrupted archive can never reach a
live server.

```bash
uxc mp login --url <MARKETPLACE_PUBLISH_URL> --token uxmk_…
uxc mp init                                   # scaffold marketplace.json (slug, audience, compatibility, assets)
uxc mp publish --dry-run                      # export + build the object catalog + validate, NO network
uxc mp publish                                # upsert listing -> upload .uxpkg + screenshots/docs -> finalize
uxc mp ls / show <slug> / versions <slug>     # browse
uxc mp install <slug> --target iris           # download -> verify sha256 vs published hash -> deploy
```

`uxc mp` speaks a documented REST contract to a marketplace server (Uxopian runs one on its Pulse
app) — the full contract is in [`PULSE-MARKETPLACE-SPEC.md`](./PULSE-MARKETPLACE-SPEC.md). The
artifact is the same credential-free `.uxpkg` that `uxc export` produces.

### Scopes — multi-tenant lifecycle

FlowerDocs is multi-tenant via **scopes**, and a scope can be created or deleted **remotely** over
Core REST (`/core/rest/scope`) — `uxc` speaks it with the same JWT and client as every other
command. See [`FD-SCOPE-REST.md`](./FD-SCOPE-REST.md) for the endpoints.

```bash
uxc scope create Acme --blank                 # or --from <scope.json> (clone an existing scope, id re-targeted)
uxc scope get Acme                            # exists-check + summary (--json dumps the full object)
uxc scope delete Acme --yes                   # destructive
```

## The package format

```
my-package/
  uxopian-project.json    # name, code (id prefix), bands, datasets, requirements
  registry.json           # resource catalog: kind, id, path, policy (managed/createOnly/external)
  marketplace.json        # (optional) addon listing metadata for `uxc mp publish`
  .uxc/state.json         # per-target sync state (machine-local; gitignored, never exported)
  fd/                     # tagclasses, tagcategories, classes, taskclasses, vfclasses,
                          # vfinstances, scripts, guiconfig, handlers, surfacing.json
  ai/                     # prompts (meta + content.md), goals, mcp confs
  data/                   # seed datasets (JSONL, row-level sync)
```

Safety policies are **enforced, not documented**: taskclasses are create-once (a schema change
mints a new id), handler redeploys rotate `_vN` registration ids with an orphan sweep, scope
surfacing writes are additive + diff-verified with auto-restore, shared/`external` resources are
never written, and deletes are explicit (`rm --local|--server|--both`, tombstones, `destroy --dry-run`).

## Example

[`examples/sample-package/`](./examples/sample-package/) is a tiny synthetic package — one tag
class, one document class, one AI prompt, plus a `marketplace.json` — scaffolded with
`uxc init` + `uxc add` to show the format and the publish flow. Build your own the same way:

```bash
uxc init --name "Sample Package" --code sp
uxc add fd.tagclass SpStatus --type CHOICELIST --values "Open,InProgress,Closed"
uxc add ai.prompt spSummary
```

## Library API

`uxc` is also an importable, zero-dep library for bespoke scripts:

```js
import { connect, openPackage } from 'uxopian-client'; // or a relative import to lib/index.mjs
const ux = await connect('iris');                       // { core, gateway, gui, cacheClear, target }
const { results } = await ux.core.search({ classId: 'MpDoc', where: { MpStatus: 'New' } });
await ux.gateway.run('mpSummary', { payload: { documentId: 'MP_123' } });
const pkg = openPackage('.');                           // registry + state access
```

It also exports the marketplace client (`createMarketplaceClient`), the scope client
(`createScopeClient`), and the canonicalization/naming helpers.

## Documentation

- [`DESIGN.md`](./DESIGN.md) — the full design: package format, 3-way sync matrix, per-kind
  adapters, naming convention, CLI reference.
- [`PULSE-MARKETPLACE-SPEC.md`](./PULSE-MARKETPLACE-SPEC.md) — the addon-marketplace HTTP contract
  for whoever builds/operates a marketplace server (data model, per-maintainer API keys, publisher +
  browse APIs, signed-URL uploads, the `marketplace.json` + object-catalog schema, UI requirements);
  [`PULSE-MARKETPLACE-CHANGE-01.md`](./PULSE-MARKETPLACE-CHANGE-01.md) is a follow-on change.
- [`FD-SCOPE-REST.md`](./FD-SCOPE-REST.md) — the FlowerDocs scope Core REST endpoints and the native
  `uxc scope` design.
- [`claude/`](./claude/) — a Claude Code skill (`uxopian-client`) + `/ux-*` slash commands,
  installed by `uxc install-claude`.

## Tests

```bash
npm test                 # === node --test test/ — offline unit tests (canonicalization, naming,
                         #     registry, diff, marketplace catalog, scope), zero network
uxc doctor --roundtrip   # live gauntlet incl. per-kind push-echo round-trip on Zz* throwaways
```

## Contributing

Issues and PRs welcome. Because the project is licensed under the MPL-2.0, modifications to existing
source files must be shared back under the same license (see below) — but you can freely combine
`uxc` with proprietary code. Please keep the zero-dependency rule, and run `npm test` before opening
a PR.

## License

[Mozilla Public License 2.0](./LICENSE) — a **weak (file-level) copyleft**: if you modify a covered
source file and distribute it, you must make that file's source available under the MPL, but the
rest of a larger work (your own files, proprietary code you combine it with) is unaffected.

## Disclaimer

FlowerDocs and Uxopian AI are products of [Uxopian](https://www.uxopian.com/) / Arondor. This is an
**experimental** client for working with their APIs; it is provided "as is", without warranty, and
is not an officially supported product. Trademarks belong to their respective owners.
