# Lovable change request — Marketplace Change 01: artifact-hash versioning

**Paste this into Lovable.** It changes only the `marketplace-publish` edge function. No DB schema
change, no UI change, no change to `marketplace-browse` / `marketplace-download`.

---

## Goal

Right now, re-publishing an existing addon version returns `409 version_exists`, so a published
version is fully frozen. Change this so that **a version's identity is its artifact (the `.uxpkg`)
content hash** — everything else stays editable:

- **Same version + same artifact `sha256`** → treat the publish as an **in-place edit** of that
  release (even if it's already `published`). Update its `changelog`, `compatibility`, `catalog`,
  `manifest`, and its `screenshots`/`docs`, and only return signed upload URLs for the artifact/
  assets that are actually new or changed. **Succeed — do not 409.**
- **Same version + different artifact `sha256`** → reject with `409 { code: "artifact_changed" }`
  ("the package content changed — bump the version"). This is the *only* case that forces a new
  version.
- **New version** → behaves exactly as today (create draft, return upload URLs, finalize).

This lets maintainers fix a typo, correct the tested-on compatibility tags, swap a screenshot, or
improve the docs **without** inventing a new version number — while still guaranteeing that a given
version number always maps to one exact package.

## Why it's safe

`marketplace_versions` already stores `artifact_sha256`. The publisher (`uxc`) already sends
`artifact.sha256` in the create-version request body. So the server has everything it needs to
compare; this is purely edge-function logic.

## Change 1 — `POST /addons/:slug/versions` (create/edit version)

Make it an **upsert keyed by `(addon, version)`**, with the artifact hash as the gate:

```
on POST /addons/:slug/versions { version, changelog, compatibility, manifest, catalog,
                                 artifact: { sha256, bytes, filename, content_type }, assets: [...] }:

  addon = require addon by slug (404 if missing)
  existing = find version row (addon_id, version)

  if existing AND existing.status != 'draft' AND existing.artifact_sha256
       AND existing.artifact_sha256 != artifact.sha256:
     return 409 { error: { code: "artifact_changed",
       message: `version ${version} already exists with different package content — bump the version`,
       details: { slug, version, stored_sha256: existing.artifact_sha256, incoming_sha256: artifact.sha256 } } }

  // create-or-update the version row (status stays 'published' if it was; new rows start 'draft')
  upsert version row with changelog, compat_flowerdocs, compat_uxopian_ai, catalog, manifest,
         artifact_filename, artifact_content_type   // keep artifact_sha256/bytes until finalize verifies

  artifactUnchanged = existing AND existing.artifact_sha256 == artifact.sha256

  // ASSET RECONCILIATION — the declared `assets` array is authoritative for this version:
  //  - upsert a row per declared asset (by filename); set kind/title/sort_order/content_type
  //  - delete asset rows (and their storage objects) whose filename is NOT in the declared list
  reconcile assets

  // signed upload URLs — only for what must be (re)uploaded:
  uploads.artifact = artifactUnchanged ? null
                     : createSignedUploadUrl(`addons/${slug}/${version}/${artifact.filename}`)   // x-upsert: true
  uploads.assets = for each declared asset that is NEW or whose sha256 changed vs the stored row:
                     { filename, ...createSignedUploadUrl(`addons/${slug}/${version}/assets/${filename}`) }
                   // assets whose sha matches the stored row are omitted (no re-upload)

  return 200/201 {
    version: { id, addon_id, version, status },
    uploads: { artifact: uploads.artifact, assets: uploads.assets },
    updated: Boolean(existing),     // true when this edited an existing version
    expires_in: 900
  }
```

Use `x-upsert: true` on the signed upload URLs so an edit overwrites the stored object in place.

## Change 2 — `POST /addons/:slug/versions/:version/finalize`

Handle the edit path: don't re-stamp `published_at` for an existing published version, and finish
the asset reconciliation.

```
on POST /addons/:slug/versions/:version/finalize { artifact: { sha256, bytes } }:
  row = require version (404)
  // artifact may NOT have been re-uploaded (same-hash edit) — verify against the already-stored object
  verify the stored artifact object exists and its sha256 == row.artifact_sha256 (recompute or trust
    the recorded upload); set artifact_sha256/bytes if this was a fresh upload; mismatch -> 422 artifact_integrity
  for each declared asset: verify the storage object exists; backfill bytes/sha256
  drop any asset storage objects + rows no longer declared (reconciliation, in case finalize is the cleanup point)

  wasPublished = (row.status == 'published')
  set row.status = 'published'
  if not wasPublished: set published_at = now(), published_by = <key maintainer>
  set updated_at = now()
  recompute addon.latest_version = newest semver among published, non-yanked versions

  return 200 {
    version: { id, version, status: 'published', published_at, published_by },
    addon: { slug, latest_version },
    updated: wasPublished      // true = this was an in-place edit, not a first publish
  }
```

## Change 3 — error code

Replace the `version_exists` rejection with `artifact_changed` (409) as above. Keep the standard
error envelope: `{ "error": { "code, message, details } }`. Everything else in the error vocabulary
stays the same.

## Do NOT change

- `PUT /addons/:slug` (listing upsert) — already idempotent; listing fields are already editable.
- `marketplace-browse` and `marketplace-download` functions.
- DB schema (no migration needed; `artifact_sha256` already exists).
- Auth, the catalog/screenshot/doc shapes, the UI.

## Acceptance tests

1. Publish `contract-management@1.0.1` (artifact hash H). ✅
2. Re-publish `1.0.1` with the **same** artifact (hash H) but changed `compatibility` and a new
   screenshot → **200, `updated: true`**; `GET /addons/contract-management/versions/1.0.1` reflects
   the new compatibility + screenshot; `published_at` unchanged. ✅
3. Re-publish `1.0.1` with a **different** artifact (hash H2) → **409 `artifact_changed`**, stored
   version untouched. ✅
4. Remove a screenshot from the declared `assets` and re-publish (same hash) → that screenshot is
   gone from the version (storage object + row deleted). ✅
5. Publish a brand-new `1.0.2` → unchanged behavior (draft → upload → finalize → published; becomes
   `latest_version`). ✅
