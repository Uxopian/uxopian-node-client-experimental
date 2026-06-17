---
description: Browse the Pulse Addons Marketplace and download an addon version as a .uxpkg
---

`uxc` = the `uxc` CLI on your PATH.

The marketplace stores reusable FlowerDocs + Uxopian AI addons (`.uxpkg` packages) with version
history, an object catalog, screenshots/docs, and tested-on compatibility. Browsing + download are
also available in the Pulse UI; these commands are the CLI side for Claude.

`$ARGUMENTS` chooses the action. Common flows:

- **Browse / search** (filters map to the marketplace query params):
  ```
  uxc mp ls --category contract-intelligence
  uxc mp ls --q invoice --product uxopian-ai --fd 5.6
  uxc mp ls --audience customer-demo --account "ACME"
  uxc mp categories
  ```
- **Inspect an addon** — metadata, version history, and the object catalog of a version:
  ```
  uxc mp show <slug>                 # listing + version history
  uxc mp show <slug> --version 1.2.0 --catalog   # the readable object catalog for that version
  uxc mp versions <slug>             # just the version history
  ```
- **Download a version** (defaults to the latest; pick any prior `--version`) and install it:
  ```
  uxc mp pull <slug> [--version 1.0.0] [-o file.uxpkg]
  uxc import file.uxpkg --target <name>      # pre-flights collisions before any write
  ```
  `pull` verifies the artifact sha256 against the version metadata and prints the `uxc import` line.
- **Trusted install in one step** (integrity-gated — download, verify against the marketplace's
  published hash, then deploy; aborts before any server write on mismatch):
  ```
  uxc mp install <slug>[@version] --target <name> [--force]
  ```
  For a local archive, `uxc import file.uxpkg --target <name> --expect-sha256 <hash>` does the same
  gate manually.

Notes:
- Reads use the configured marketplace endpoint (`uxc mp login`); they don't require a FlowerDocs
  target. **Editing** (create/version/deprecate) is a separate, Claude-only flow — see /ux-publish.
- `mp deprecate <slug> --version v` flips lifecycle (`--yank` to hide, `--reactivate` to restore);
  `mp rm <slug> --yes` archives a whole listing. Both need a maintainer key.

Report: for browse, the matching addons; for show, the listing + versions (+ catalog if asked); for
pull, the saved file, its size, the sha256 check, and the ready-to-run `uxc import` command.
