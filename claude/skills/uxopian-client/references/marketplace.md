# Pulse Addons Marketplace — publishing & browsing (the `uxc mp` surface)

The marketplace is an area in **Pulse** (presales/eng) that stores reusable FlowerDocs + Uxopian AI
addons as `.uxpkg` packages, with version history, a readable object catalog, screenshots/docs, and
tested-on compatibility. **Split of duties:** Pulse browses + downloads; **Claude/`uxc` does ALL
create/update/version/lifecycle.** No editing happens in the Pulse UI. The full contract the
marketplace server implements is `PULSE-MARKETPLACE-SPEC.md` at the repo root.

## Config (credential, outside any package)
`~/.uxopian/marketplace.json` (chmod 600) — endpoint + **per-maintainer API key**. The endpoint is
the **publish** edge-function root; the `browse`/`download` roots are auto-derived (swap the
`-publish` suffix):
```
uxc mp login --url <MARKETPLACE_PUBLISH_URL> --token uxmk_… \
  --name "Your Name" --email you@example.com --verify
```
Env overrides: `UXC_MARKETPLACE_URL`, `UXC_MARKETPLACE_BROWSE_URL`, `UXC_MARKETPLACE_DOWNLOAD_URL`,
`UXC_MARKETPLACE_TOKEN`. The key is never committed/exported. Publishes are attributed to the key's
owner (the server resolves identity from the key, not from `marketplace.json`).

## marketplace.json (in the package; `uxc mp init` scaffolds it)
```json
{
  "format": "uxopian-marketplace/1",
  "slug": "contract-management",          // marketplace listing id (kebab; defaults from name)
  "audience": "generic",                   // generic | customer-demo | prospect-demo
  "account": null,                          // REQUIRED when audience != generic (the org name)
  "category": "contract-intelligence",
  "tags": ["nda", "legal"],
  "summary": "One-line pitch (<= 200 chars).",
  "maintainer": { "name": "…", "email": "…" },   // falls back to the `mp login` default
  "compatibility": { "flowerdocs": ["5.6"], "uxopianAi": ["1.10"] },  // TESTED-ON tags
  "docs": ["README.md"],                    // paths inside the package
  "screenshots": ["marketplace/screenshots/worklist.png"],
  "changelog": "What changed in THIS version."
}
```
- **Version** is not here — it comes from `uxopian-project.json` `version`, unique per addon.
- **Compatibility = tested-on tags**, not ranges: record the FlowerDocs / Uxopian AI backend
  versions you actually validated against.
- Listing-level fields (slug/name/category/audience/maintainer) upsert the listing; version-level
  fields (changelog/compatibility/catalog/screenshots/docs/artifact) attach to the new version.

## Publish (always dry-run first)
```
uxc mp publish --dry-run        # export + catalog + validate + print payload, NO network
uxc mp publish                  # upsert listing -> create draft -> upload .uxpkg + assets -> finalize
```
Overrides: `--audience --account --category --changelog --fd 5.6 --uxai 1.10 --tags a,b --slug --allow-dirty --file <x.uxpkg>`.
- The **object catalog** (the "what's inside" list the marketplace renders) is built automatically
  from the registry — counts per kind + one row `{kind,id,title,note,policy}` per resource.
- Re-publishing an existing published version → `version_exists`: **bump the manifest version**.
- Refuses a dirty package unless `--allow-dirty` (run `uxc status --remote` / `/ux-sync` first).

## Browse / download
```
uxc mp ls [--category --audience --account --product --fd --uxai --q --tag --sort]
uxc mp show <slug> [--version v] [--catalog]      # detail + version history (+ object catalog)
uxc mp versions <slug>
uxc mp pull <slug> [--version v] [-o f.uxpkg]     # download (defaults to latest), sha256-checked
uxc import f.uxpkg --target <name>                # then install it on an instance
uxc mp categories
```

## Trusted install (integrity gate)
A downloaded `.uxpkg` is verified against its **marketplace-published sha256 before any resource is
written** to a FlowerDocs / Uxopian AI server — so a tampered/corrupted archive can never reach a
live instance. Two entry points:
```
uxc mp install <slug>[@version] --target <name>   # pull -> verify vs published hash -> deploy (one trusted step)
uxc import f.uxpkg --target <name> --expect-sha256 <hash>   # manual: verify before deploy, abort on mismatch
```
`mp install` re-checks the same hash inside `import` (defense in depth); a mismatch aborts before
unpacking, before connecting, before any write (exit 2). `uxc push` of a working package is already
integrity-tracked per resource (3-way hashes + a re-check right before each write), so the artifact
gate fills the gap for *downloaded* packages.

## Lifecycle
```
uxc mp deprecate <slug> --version v [--reason "…"]   # deprecate (still listed/downloadable)
uxc mp deprecate <slug> --version v --yank           # hide (kept for audit)
uxc mp deprecate <slug> --version v --reactivate     # re-publish
uxc mp rm <slug> --yes                                # archive the listing (soft-delete)
```

## Notes / gotchas
- No **dependency management** in v1 (declaring addon→addon needs) — out of scope by design.
- The `.uxpkg` is the same artifact `uxc export` produces: credential-free, `.uxc/` excluded,
  `ai.mcp` secrets scrubbed. The marketplace treats it as opaque.
- Read commands use the marketplace endpoint only (no FlowerDocs target needed); write commands need
  a valid maintainer key.
