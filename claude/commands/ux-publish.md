---
description: Publish the uxopian package to the Pulse Addons Marketplace (upsert listing, upload artifact + assets, finalize)
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

Publishing is **Claude's job** — Pulse only browses and downloads. This command ships the current
package as one addon **version** to the marketplace.

`$ARGUMENTS` may carry overrides: `--audience generic|customer-demo|prospect-demo`, `--account "ACME"`,
`--changelog "…"`, `--fd 5.6`, `--uxai 1.10`, `--category …`, `--allow-dirty`, `--file <x.uxpkg>`.

1. **Pre-reqs (once):** the endpoint + a per-maintainer API key must be configured:
   ```
   uxc mp login --url https://pulse.<host> --token uxmk_… --name "…" --email …
   ```
   and the package needs a `marketplace.json` (slug, audience, category, compatibility, screenshots,
   docs). If it's missing, scaffold and fill it:
   ```
   uxc mp init        # then edit marketplace.json (compatibility = the versions you TESTED on)
   ```

2. **Always dry-run first** — it exports, builds the object catalog, validates `marketplace.json`,
   and prints the exact payload **without touching the network**:
   ```
   uxc mp publish --dry-run $ARGUMENTS
   ```
   Read back the audience/category, the compatibility tags, the artifact size/sha, the catalog
   object count, and the screenshot/doc list. If validation fails, fix `marketplace.json` (the
   errors name the exact fields). Confirm the summary matches intent before going live.

3. **Publish** (staged + resumable: upsert listing → create draft version → upload `.uxpkg` +
   screenshots/docs to signed URLs → finalize with sha256 verification):
   ```
   uxc mp publish $ARGUMENTS
   ```

Rules and gotchas:
- **Version comes from `uxopian-project.json` `version`** and is unique per addon. Re-publishing an
  existing published version fails `version_exists` — **bump the manifest version** and publish again.
- `marketplace.json` `audience` distinguishes **generic** packages from **customer-demo** /
  **prospect-demo** — the latter two **require** an `account` (the org name).
- **Compatibility = tested-on tags** (`compatibility.flowerdocs`, `compatibility.uxopianAi`), e.g.
  `["5.6"]` / `["1.10"]`. Record what you actually validated against.
- Screenshots and docs are paths **inside the package**; the dry-run fails if any are missing.
- The artifact is the same `.uxpkg` `uxc export` produces — credential-free, `.uxc/` excluded,
  `ai.mcp` secrets scrubbed. Publish refuses a dirty package unless `--allow-dirty` (run /ux-status
  first).

Report: the slug@version published, audience/category, compatibility tags, catalog object count,
assets uploaded, and the browse URL.
