# Pulse Addons Marketplace — Implementation Spec (for Lovable)

**Audience:** the Lovable developer building the new *Addons Marketplace* area inside Pulse.
**Status:** v1 spec, 2026-06-15. **Owner:** Your Name (you@example.com).

This document is self-contained. It defines the data model, the HTTP API, the upload protocol,
the auth model, and the UI to build. You do **not** need to read the `uxopian-client` codebase to
implement Pulse — everything Pulse needs to know about the publishing side is in §6 (the JSON
payloads Claude sends) and §10 (the worked example).

---

## 1. What we are building and why

We have a set of **project packages** ("addons") — reusable FlowerDocs + Uxopian AI
customizations (content model, server handlers, GUI configs, virtual folders, AI prompts/goals,
seed datasets) that our `uxopian-client` (`uxc`) tooling can now build, export, and install with
one command. Today they live as files. We want an **internal marketplace inside Pulse**, for
**presales and engineering**, where the team can:

- **browse** a catalog of addons with categories and filters,
- read each addon's **description, documentation, and screenshots**,
- see **which FlowerDocs / Uxopian AI backend versions** each addon was tested on,
- read a **catalog of the objects** an addon contains (its tagclasses, classes, handlers, prompts…),
- see the **version history** and **download any version** as a `.uxpkg` archive,
- tell apart **generic packages** from **customer- or prospect-specific demos**.

### 1.1 The two-actor split (important)

There are two clients of this system, and the split is deliberate:

| Actor | What it does | Surface |
|---|---|---|
| **Pulse users** (humans, presales/eng) | **Browse, filter, read, download.** Read-only. | The new Pulse UI (this spec, §9) + the public read API (§7). |
| **Claude / `uxc`** (the publisher tool) | **All create / update / version / lifecycle.** Writes. | The publisher API (§6), authenticated with a per-maintainer API key. |

**Pulse's UI never edits an addon.** There is no "new addon" or "edit" form to build. Every
write — creating an addon, publishing a new version, attaching docs/screenshots, deprecating a
version — happens from Claude via the publisher API. Pulse only needs to **render** what is
already there and let people **download** it. This keeps the package contents authoritative in the
source repos and the tooling, not hand-edited in a web form.

> **Dependency management is explicitly out of scope for v1.** Do not model inter-addon
> dependencies. We will add it later (see §11).

---

## 2. Glossary

- **Addon** — a marketplace listing. Identified by a stable **slug** (e.g. `contract-management`).
  Has listing-level metadata (name, maintainer, category, audience…) and many versions.
- **Version** — one published release of an addon (e.g. `1.0.0`). Carries its own artifact,
  catalog, compatibility tags, changelog, docs, and screenshots. A version is identified by its
  **artifact content hash**: the `.uxpkg` is immutable for a given version string, but all other
  fields stay editable in place (§6.0). A *different* artifact requires a new version.
- **Artifact** — the downloadable `.uxpkg` file for a version. A `.uxpkg` is a ZIP of a package
  directory; treat it as an opaque binary blob. (~hundreds of KB to a few MB; the reference
  example is 144 files.)
- **Catalog** — a machine-readable, human-readable list of the FlowerDocs/Uxopian AI **objects**
  inside a version (counts per kind + one row per object). Claude computes this and sends it as
  JSON; Pulse stores and renders it. See §6.4 / §8.2.
- **Maintainer** — the person responsible for an addon. Owns an **API key** (§5). Publishes are
  attributed to the key's owner.
- **Audience** — `generic` | `customer-demo` | `prospect-demo`. Non-generic addons carry an
  **account** name (the customer/prospect org). This is the generic-vs-demo distinction.
- **Compatibility tags** — the FlowerDocs / Uxopian AI backend versions a version was **tested
  on**, e.g. `FlowerDocs 5.6`, `Uxopian AI 1.10`. Free-form tags, filterable by exact match.

---

## 3. Tech assumptions

Pulse is a **Supabase**-backed Lovable app. This spec is written for:

- **Postgres** for the relational model (§4), with **Row-Level Security**.
- **Supabase Storage** for binaries: two buckets — `marketplace-artifacts` (the `.uxpkg` files)
  and `marketplace-assets` (screenshots + rendered docs). Both **private**; downloads go through
  short-lived **signed URLs**.
- **Edge Functions** (Deno) for the publisher API (§6) and the download/redirect endpoints, so we
  can enforce API-key auth and signed-URL minting server-side. The browse/read API (§7) can be
  PostgREST + RLS or thin edge functions — your call; the contract in §7 is what matters.

If any of these change, keep the **HTTP contract in §6–§7 stable** — that is what `uxc` codes
against.

---

## 4. Data model (Postgres)

Indicative DDL. Adjust types/policies to your conventions; keep column names and semantics.

```sql
-- A marketplace listing. One row per addon.
create table marketplace_addons (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,              -- stable id, e.g. 'contract-management'
  name            text not null,                     -- display name, 'Contract Management'
  code            text not null,                     -- uxc project code, 'ct' (informational)
  summary         text not null,                     -- one-line pitch for the catalog card
  description     text not null,                     -- long markdown description
  category        text not null references marketplace_categories(key),
  audience        text not null default 'generic'
                    check (audience in ('generic','customer-demo','prospect-demo')),
  account         text,                              -- customer/prospect org; required if audience<>'generic'
  tags            text[] not null default '{}',      -- free-form labels for search
  products        text[] not null default '{}',      -- ['flowerdocs','uxopian-ai']
  maintainer_id   uuid not null references marketplace_maintainers(id),
  latest_version  text,                              -- denormalized convenience (the newest published version)
  status          text not null default 'active'     -- 'active' | 'archived'
                    check (status in ('active','archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint account_required_for_demos
    check (audience = 'generic' or account is not null)
);

-- A published release of an addon.
create table marketplace_versions (
  id                  uuid primary key default gen_random_uuid(),
  addon_id            uuid not null references marketplace_addons(id) on delete cascade,
  version             text not null,                 -- semver string from the package manifest, '1.0.0'
  status              text not null default 'draft'  -- see §6.6 lifecycle
                        check (status in ('draft','published','deprecated','yanked')),
  changelog           text,                          -- markdown, this version's notes
  -- compatibility: what this version was TESTED ON (tag-match filtering)
  compat_flowerdocs   text[] not null default '{}',  -- ['5.6']
  compat_uxopian_ai   text[] not null default '{}',  -- ['1.10']
  -- the object catalog (see §6.4): { counts: {...}, objects: [...] }
  catalog             jsonb not null default '{}',
  -- a snapshot of the package manifest (uxopian-project.json), for reference
  manifest            jsonb not null default '{}',
  -- artifact (the .uxpkg in storage)
  artifact_path       text,                          -- storage object key in marketplace-artifacts
  artifact_filename   text,                          -- 'ct-1.0.0.uxpkg'
  artifact_sha256     text,                          -- 'sha256:...'; integrity check on finalize
  artifact_bytes      bigint,
  published_by        uuid references marketplace_maintainers(id),
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (addon_id, version)
);

-- Screenshots and documentation files attached to a version.
create table marketplace_assets (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references marketplace_versions(id) on delete cascade,
  kind          text not null check (kind in ('screenshot','doc')),
  filename      text not null,                       -- 'worklist.png', 'README.md'
  title         text,                                -- optional caption / doc title
  storage_path  text not null,                       -- object key in marketplace-assets
  content_type  text not null,                       -- 'image/png', 'text/markdown'
  bytes         bigint,
  sha256        text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

-- Maintainers (key owners). May map onto Pulse users later; standalone for v1.
create table marketplace_maintainers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text unique not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Per-maintainer API keys (see §5). Store only a hash of the key.
create table marketplace_api_keys (
  id            uuid primary key default gen_random_uuid(),
  maintainer_id uuid not null references marketplace_maintainers(id) on delete cascade,
  label         text,                                -- 'my laptop'
  key_prefix    text not null,                       -- first 8 chars, shown in UI for identification
  key_hash      text not null,                       -- sha256 of the full key; never store the key
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- Controlled vocabulary for categories (editable by admins).
create table marketplace_categories (
  key         text primary key,                      -- 'contract-intelligence'
  label       text not null,                         -- 'Contract Intelligence'
  description text,
  sort_order  int not null default 0
);
```

**RLS / access:**
- **Read** (browse): any authenticated Pulse user may `select` from `marketplace_addons`,
  `marketplace_versions` (where `status in ('published','deprecated')`), `marketplace_assets`,
  `marketplace_categories`, and the **non-sensitive** maintainer columns (name, email). Drafts and
  yanked versions are hidden from normal users.
- **Write**: only the publisher edge functions (running with the service role) write, **after**
  validating the API key. Normal users have no insert/update/delete.

**Seed categories** (editable later; start with these):
`content-intelligence`, `contract-intelligence`, `invoice-ap`, `hr-employee`, `quality-compliance`,
`records-management`, `case-management`, `ai-assistants`, `search-discovery`, `demo-showcase`,
`utilities`, `other`.

---

## 5. Auth — per-maintainer API keys

Publishing is authenticated with a **bearer API key**, one (or more) per maintainer.

- **Key format:** `uxmk_` + 40 random url-safe chars (e.g. `uxmk_3f9a…`). The literal value is
  shown to the maintainer **once**, at creation. We store only `sha256(key)` plus the first 8
  chars (`key_prefix`) for identification.
- **Minting / revoking:** build a small admin screen (or seed via SQL for v1) to create a
  maintainer, issue a key, and revoke a key (`revoked_at`). Revoked or expired keys are rejected.
- **Use:** every publisher request (§6) sends `Authorization: Bearer uxmk_…`. The edge function:
  1. hashes the presented key, looks it up in `marketplace_api_keys` where `revoked_at is null`;
  2. resolves the owning maintainer (must be `active`);
  3. sets `published_by` / `maintainer_id` from that maintainer (the client cannot spoof identity);
  4. updates `last_used_at`.
- **Attribution:** a publish is always attributed to the key's maintainer. The `maintainer` block
  a client *sends* in a payload is treated as a **display hint only** for a brand-new addon; the
  authoritative owner is the key owner. (If the sent email differs from the key owner, prefer the
  key owner and ignore the hint.)
- **Authorization rule for v1:** any valid maintainer key may create new addons and publish new
  versions to **any** addon (small internal team). Record `published_by` on every version so we
  have an audit trail. (A stricter "only the addon's maintainer may publish" rule can come later —
  do not block v1 on it.)

`401` for a missing/invalid/revoked key. `403` if the maintainer is inactive.

---

## 6. Publisher API (write) — what Claude / `uxc` calls

Base path: **`/api/marketplace`** (edge functions). All requests carry the bearer key (§5).
All bodies are JSON unless noted. All responses are JSON. Errors use the shape in §6.7.

The publish flow is **staged and resumable** (create → upload → finalize) so a large artifact
upload can be retried without redoing metadata, and so binaries never pass through the edge
function body (they go straight to Storage via signed URLs).

### 6.0 Versioning model — the artifact hash is the version's identity

> **This supersedes the earlier "published versions are immutable" rule.** Implemented as
> *Change 01* (see `PULSE-MARKETPLACE-CHANGE-01.md`).

A version is identified by its **artifact content** (the `.uxpkg`), captured as `artifact_sha256`.
The rule is:

- **The artifact is immutable for a given `version` string.** Once `1.0.0` is published with a
  given hash, you can never store a *different* `.uxpkg` under `1.0.0`.
- **Everything else about that version is editable** — re-publishing the **same** `version` with
  the **same** artifact hash updates `changelog`, `compatibility`, `catalog`, `manifest`, and the
  `screenshots`/`docs` in place (and the listing fields via §6.2). This is the "fix a typo, correct
  the compatibility tags, swap a screenshot, improve the docs" path. No version bump required.
- **A different artifact under an existing version is rejected** with `409 artifact_changed` →
  "the package content changed; bump the version." That is the *only* thing that forces a new
  version.

So `createVersion` (§6.3) becomes an **upsert keyed by `(slug, version, artifact_sha256)`**, and
`finalize` (§6.5) reconciles the editable fields. The publisher sends `artifact.sha256` on every
publish; the server compares it to decide create-new / update-in-place / reject.

### 6.1 `GET /api/marketplace/whoami`
Sanity/auth check. Returns the resolved maintainer.
```json
// 200
{ "maintainer": { "id": "…", "name": "Your Name", "email": "you@example.com" },
  "key_prefix": "uxmk_3f9a", "scopes": ["publish"] }
```

### 6.2 `PUT /api/marketplace/addons/{slug}` — upsert the listing
Create the addon if `slug` is new, else update its listing-level metadata. **Idempotent.** Does
**not** touch versions.
```json
// request body
{
  "name": "Contract Management",
  "code": "ct",
  "summary": "Playbook-driven contract intelligence (NDA + credit insurance).",
  "description": "## Contract Management\n\nEnrich-at-ingestion handlers, deviation review tasks, …",
  "category": "contract-intelligence",
  "audience": "generic",                 // generic | customer-demo | prospect-demo
  "account": null,                       // required when audience != generic
  "tags": ["nda", "credit-insurance", "legal", "playbook"],
  "products": ["flowerdocs", "uxopian-ai"],
  "maintainer": { "name": "Your Name", "email": "you@example.com" }  // display hint; key owner wins
}
// 200 (created or updated)
{ "addon": { "id": "…", "slug": "contract-management", "name": "Contract Management",
             "category": "contract-intelligence", "audience": "generic", "status": "active",
             "latest_version": "1.0.0", "updated_at": "…" } }
```
Validation: `name`, `summary`, `description`, `category` (must exist in `marketplace_categories`),
`audience` required; `account` required when `audience != 'generic'`; `summary` ≤ 200 chars.
`422` on validation failure (§6.7).

### 6.3 `POST /api/marketplace/addons/{slug}/versions` — create a draft version
Registers a new version and **returns signed upload URLs** for the artifact and every declared
asset. The version starts in `status: 'draft'` and is invisible to browsing until finalized (§6.5).
```json
// request body
{
  "version": "1.0.0",                    // from the package manifest; unique per addon
  "changelog": "Initial release.",
  "compatibility": {                     // tested-on tags (the chosen model)
    "flowerdocs": ["5.6"],
    "uxopianAi": ["1.10"]
  },
  "manifest": { "...": "the full uxopian-project.json, verbatim" },
  "catalog": { "...": "see §6.4" },
  "artifact": { "filename": "ct-1.0.0.uxpkg", "sha256": "sha256:…", "bytes": 245760,
                "content_type": "application/zip" },
  "assets": [
    { "kind": "screenshot", "filename": "worklist.png", "title": "Deviation worklist",
      "sha256": "sha256:…", "bytes": 81234, "content_type": "image/png", "sort_order": 0 },
    { "kind": "doc", "filename": "README.md", "title": "Overview",
      "sha256": "sha256:…", "bytes": 4096, "content_type": "text/markdown", "sort_order": 0 }
  ]
}
// 201
{
  "version": { "id": "…", "addon_id": "…", "version": "1.0.0", "status": "draft" },
  "uploads": {
    "artifact": { "url": "https://…signed-upload…", "method": "PUT",
                  "headers": { "content-type": "application/zip", "x-upsert": "true" } },
    "assets": [
      { "filename": "worklist.png", "url": "https://…", "method": "PUT",
        "headers": { "content-type": "image/png" } },
      { "filename": "README.md", "url": "https://…", "method": "PUT",
        "headers": { "content-type": "text/markdown" } }
    ]
  },
  "expires_in": 900
}
```
- **Existing version (the §6.0 model):**
  - **Same `artifact.sha256` as stored** → this is an **edit of the same release** (even if already
    `published`). Update `changelog`/`compatibility`/`catalog`/`manifest` and reconcile assets.
    Return upload URLs **only** for the artifact/assets that are new or whose sha changed; **omit**
    `uploads.artifact` when the artifact hash is unchanged (no re-upload needed), and include
    `"updated": true` in the response. The client skips uploads it isn't given a URL for.
  - **Different `artifact.sha256`** → reject `409 artifact_changed` (the package content changed —
    bump the version). This is the only case that forces a new version.
  - A still-`draft` version always returns fresh signed upload URLs (resume).
- Create the Storage object keys (e.g. `addons/{slug}/{version}/ct-1.0.0.uxpkg`,
  `addons/{slug}/{version}/assets/worklist.png`) and mint **upload** signed URLs via Supabase
  Storage `createSignedUploadUrl` (with `x-upsert` so an edit overwrites the stored object).
  `expires_in` ≥ 900s.
- Persist `catalog`, `manifest`, `changelog`, `compat_*`, and the asset rows; fill
  `artifact_*`/asset bytes on finalize-verify.
- **Asset reconciliation:** the declared `assets` array is **authoritative** for the version —
  insert new ones, overwrite changed ones (by `filename`), and **delete** stored assets that are no
  longer declared (so removing a screenshot from `marketplace.json` removes it from the listing).

### 6.4 The `catalog` object (what Claude sends in 6.3)
A readable inventory of the objects in the package. Pulse stores it as `jsonb` and renders it
(§8.2). **Pulse does not compute it** — just validate it is well-formed and store it.
```json
{
  "counts": { "fd.tagclass": 64, "fd.tagcategory": 13, "fd.documentclass": 5, "fd.taskclass": 2,
              "fd.vfclass": 3, "fd.vfinstance": 3, "fd.script": 2, "fd.guiconfig": 7,
              "fd.handler": 5, "fd.surfacing": 1, "fd.dataset": 3, "ai.prompt": 14 },
  "total": 122,
  "objects": [
    { "kind": "fd.documentclass", "id": "CtContract", "title": "Contract",
      "policy": "managed", "note": "12 tag references" },
    { "kind": "fd.handler", "id": "CtIngest_onCreate", "title": "On create of a Contract",
      "policy": "managed", "note": "DOCUMENT · AFTER · async" },
    { "kind": "ai.prompt", "id": "ctSummary", "title": "Summarize a contract",
      "policy": "managed", "note": "system · openai" }
    // …one row per resource
  ]
}
```
`kind` is one of the FlowerDocs/Uxopian AI resource kinds (the `fd.*` / `ai.*` namespaces).
`title` is human-friendly; `note` is a short descriptor; `policy` is `managed`/`createOnly`/`external`.
Pulse should treat `kind` values as opaque labels and group by them (don't hardcode an enum —
new kinds may appear).

### 6.5 `POST /api/marketplace/addons/{slug}/versions/{version}/finalize` — publish
Called after the client has uploaded the artifact and all assets to their signed URLs.
```json
// request body (optional integrity re-assertion)
{ "artifact": { "sha256": "sha256:…", "bytes": 245760 } }
// 200
{ "version": { "id": "…", "version": "1.0.0", "status": "published", "published_at": "…",
               "published_by": { "name": "Your Name", "email": "…" } },
  "addon": { "slug": "contract-management", "latest_version": "1.0.0" } }
```
Server steps:
1. Verify the artifact object exists in Storage and its size matches; **verify `sha256`** against
   the stored object. For an **edit** (§6.0 same-hash update) the artifact was not re-uploaded, so
   verify against the already-stored object. Mismatch → `422 artifact_integrity`.
2. Verify each declared asset object exists; backfill `bytes`/`sha256`; drop assets no longer
   declared (§6.3 reconciliation).
3. Ensure the version is `published` (a new draft flips to published; an edit of an already-
   published version stays published — do **not** reset `published_at`; you may stamp an
   `updated_at`). Recompute the addon's `latest_version` (newest by semver among published, non-
   yanked versions).
4. Return the version, with `"updated": true` when this finalize edited an existing published
   version rather than publishing a new one.
If finalize is never called, a never-published draft (and its half-uploaded objects) can be
garbage-collected by a periodic job after, say, 24h.

### 6.6 Lifecycle: deprecate / yank / re-activate a version
`POST /api/marketplace/addons/{slug}/versions/{version}/status`
```json
// request
{ "status": "deprecated", "reason": "superseded by 1.1.0" }
// 200
{ "version": { "version": "1.0.0", "status": "deprecated" } }
```
- `deprecated` — still listed and downloadable, shown with a "deprecated" badge; never becomes
  `latest_version`.
- `yanked` — hidden from normal browse and from the default download, but **kept** (audit/legal).
  An admin view may still see it. Recompute `latest_version` excluding yanked.
- `published` — re-activate a deprecated version.
A published version's **artifact is immutable** (its `.uxpkg` content cannot change without a new
version — §6.0), but its **metadata and assets are editable** by re-publishing the same version
with the same artifact hash (changelog, compatibility, catalog, screenshots, docs).

### 6.7 `DELETE /api/marketplace/addons/{slug}` — archive a listing
Soft-delete: set addon `status = 'archived'` (hidden from default browse). Hard delete is **not**
exposed via the API (do it in admin if ever needed). `200 { "addon": { "slug": "...", "status": "archived" } }`.

### 6.8 Error shape (all publisher endpoints)
```json
// non-2xx
{ "error": { "code": "version_exists", "message": "version 1.0.0 already published for contract-management",
             "details": { "slug": "contract-management", "version": "1.0.0" } } }
```
Stable `code` values `uxc` keys on: `unauthorized` (401), `forbidden` (403), `not_found` (404),
`validation_failed` (422), **`artifact_changed` (409)** — existing version, different `.uxpkg`
content; bump the version — `artifact_integrity` (422), `category_unknown` (422),
`rate_limited` (429), `internal` (500). Always include a human `message`. (`version_exists` (409)
is retired by §6.0 — a same-hash re-publish now succeeds as an in-place edit instead of 409ing.)

---

## 7. Public read / browse API — what Pulse UI (and `uxc`) calls

These power the marketplace UI. They are also called by `uxc` for `mp ls` / `mp show` / `mp pull`,
so keep the JSON shapes stable. Read access requires a normal Pulse session **or** a maintainer
key (both are fine); they only ever read published/deprecated data.

### 7.1 `GET /api/marketplace/categories`
```json
{ "categories": [ { "key": "contract-intelligence", "label": "Contract Intelligence", "count": 3 }, … ] }
```
Include a live `count` of active addons per category (for the filter sidebar).

### 7.2 `GET /api/marketplace/addons`
List + filter. **Query params** (all optional, combinable):
`q` (full-text over name/summary/description/tags), `category`, `audience`
(`generic|customer-demo|prospect-demo`), `account`, `product` (`flowerdocs|uxopian-ai`),
`compat_flowerdocs` (exact tag, e.g. `5.6`), `compat_uxopian_ai` (exact tag), `maintainer` (email),
`tag` (repeatable), `sort` (`recent|name|downloads`, default `recent`), `page`, `page_size`
(default 24).
```json
{
  "addons": [
    { "slug": "contract-management", "name": "Contract Management",
      "summary": "Playbook-driven contract intelligence (NDA + credit insurance).",
      "category": "contract-intelligence", "audience": "generic", "account": null,
      "products": ["flowerdocs","uxopian-ai"], "tags": ["nda","legal"],
      "maintainer": { "name": "Your Name", "email": "…" },
      "latest_version": "1.0.0",
      "latest_compatibility": { "flowerdocs": ["5.6"], "uxopianAi": ["1.10"] },
      "object_count": 122,
      "thumbnail_url": "https://…signed…",   // first screenshot of the latest version, if any
      "updated_at": "2026-06-15T…" }
  ],
  "page": 1, "page_size": 24, "total": 1
}
```
`compat_flowerdocs` / `compat_uxopian_ai` filter against the **latest published version's** tags
(simplest, matches user intent: "which addons run on FlowerDocs 5.6"). `thumbnail_url` may be a
short-lived signed URL or a cached public-render URL.

### 7.3 `GET /api/marketplace/addons/{slug}`
Full listing detail + version history.
```json
{
  "addon": {
    "slug": "contract-management", "name": "Contract Management", "code": "ct",
    "summary": "…", "description": "## …markdown…",
    "category": "contract-intelligence", "audience": "generic", "account": null,
    "products": ["flowerdocs","uxopian-ai"], "tags": ["nda","legal"],
    "maintainer": { "name": "Your Name", "email": "…" },
    "latest_version": "1.0.0", "status": "active",
    "created_at": "…", "updated_at": "…"
  },
  "versions": [
    { "version": "1.0.0", "status": "published",
      "compatibility": { "flowerdocs": ["5.6"], "uxopianAi": ["1.10"] },
      "changelog": "Initial release.",
      "object_count": 122,
      "artifact": { "filename": "ct-1.0.0.uxpkg", "bytes": 245760, "sha256": "sha256:…" },
      "published_by": { "name": "Your Name", "email": "…" },
      "published_at": "…",
      "download_url": "/api/marketplace/addons/contract-management/versions/1.0.0/download" }
    // newest first; include deprecated; exclude yanked for normal users
  ]
}
```

### 7.4 `GET /api/marketplace/addons/{slug}/versions/{version}`
One version, including the **full catalog** and asset lists (the detail page lazy-loads this).
```json
{
  "version": {
    "version": "1.0.0", "status": "published",
    "compatibility": { "flowerdocs": ["5.6"], "uxopianAi": ["1.10"] },
    "changelog": "…",
    "manifest": { "…": "uxopian-project.json snapshot" },
    "catalog": { "counts": {…}, "total": 122, "objects": [ … ] },     // §6.4
    "artifact": { "filename": "ct-1.0.0.uxpkg", "bytes": 245760, "sha256": "sha256:…",
                  "download_url": "/api/marketplace/addons/contract-management/versions/1.0.0/download" },
    "screenshots": [ { "filename": "worklist.png", "title": "Deviation worklist",
                       "url": "https://…signed…", "content_type": "image/png" } ],
    "docs": [ { "filename": "README.md", "title": "Overview",
                "url": "https://…signed…", "content_type": "text/markdown" } ],
    "published_by": { "name": "Your Name", "email": "…" }, "published_at": "…"
  }
}
```
Asset `url`s are short-lived signed download URLs (mint on read), or proxy via an edge function.

### 7.5 `GET /api/marketplace/addons/{slug}/versions/{version}/download`
The artifact download. Auth required. Behavior: **302 redirect** to a freshly-minted, short-lived
signed Storage URL for the `.uxpkg` (or stream it through the function). Set
`Content-Disposition: attachment; filename="ct-1.0.0.uxpkg"`. Increment a download counter if you
add one. Yanked versions → `404`/`410` for normal users.

---

## 8. The artifact and the catalog (reference)

### 8.1 The `.uxpkg` artifact
Opaque to Pulse. It is a ZIP of a package directory containing a manifest, a resource registry,
and the resource files. Pulse stores it, serves it for download, and **never opens it**. (Claude
re-installs it elsewhere with `uxc import file.uxpkg`.) Do not attempt to unzip or validate its
internals — trust `sha256`/`bytes`.

### 8.2 Rendering the catalog (UI)
The `catalog.objects` array (§6.4) is the "readable catalog of objects" requirement. Render it on
the version detail page as a **grouped, searchable table**:
- group by `kind` (use a friendly label map; unknown kinds → show the raw kind);
- show `counts` as a summary row of chips at the top ("64 tagclasses · 14 prompts · 5 handlers …");
- per row: `title` (bold), `id` (mono, secondary), `note` (muted), and a small `policy` badge;
- a text filter box that filters across `title`/`id`/`note`;
- this is read-only — no actions on rows.

Suggested friendly labels for `kind`:
`fd.tagclass`→"Tag classes", `fd.tagcategory`→"Tag categories", `fd.documentclass`→"Document
classes", `fd.taskclass`→"Task classes", `fd.vfclass`→"Virtual-folder classes",
`fd.vfinstance`→"Virtual folders", `fd.script`→"Scripts", `fd.guiconfig`→"GUI configurations",
`fd.handler`→"Server handlers", `fd.surfacing`→"Scope surfacing", `fd.dataset`→"Seed datasets",
`ai.prompt`→"AI prompts", `ai.goal`→"AI goals", `ai.mcp`→"MCP configs".

---

## 9. UI requirements (the Pulse area to build)

A new top-level **Marketplace** area (presales/eng). All read-only. Match Pulse's existing look.

### 9.1 Browse / catalog page
- A **grid of addon cards**. Each card: name, summary, category chip, an **audience badge**
  (see below), product badges (FlowerDocs / Uxopian AI), `latest_version`, object count, and a
  **thumbnail** (first screenshot of the latest version, fallback to a generated placeholder).
- **Audience badge** — the generic-vs-demo distinction must be obvious at a glance:
  - `generic` → neutral chip "Generic".
  - `customer-demo` → distinct color + the **account** name, e.g. "Customer demo · ACME".
  - `prospect-demo` → distinct color + the account name, e.g. "Prospect demo · Globex".
- **Filter sidebar / bar:** Category (from §7.1, with counts), Audience, Product, Compatibility
  (FlowerDocs tag, Uxopian AI tag), Maintainer, free-text tags. **Search box** (full text). **Sort**
  (recent / name). Filters map 1:1 to §7.2 query params; reflect them in the URL so views are
  shareable.
- Empty/loading/error states.

### 9.2 Addon detail page
- Header: name, summary, category, audience badge (+account), product badges, maintainer (name +
  email/contact), `latest_version`.
- **Description** rendered as markdown.
- **Screenshots gallery** (from the selected version) with lightbox.
- **Documentation**: render attached `doc` assets; markdown inline, other types as download links.
- **Compatibility**: badges "Tested on: FlowerDocs 5.6 · Uxopian AI 1.10" for the selected version.
- **Objects catalog**: the grouped table from §8.2 for the selected version.
- **Version history** panel: list every version (newest first) with version, published date,
  publisher, compatibility tags, status badge (published/deprecated), changelog (expandable), and a
  **Download** button per version → §7.5. Selecting a version re-points the screenshots / docs /
  compatibility / catalog sections to that version. Deprecated versions are visibly marked but
  downloadable. (Yanked versions are not shown to normal users.)
- A prominent **Download latest** button.

### 9.3 Nice-to-have (not required for v1)
- Copy-to-clipboard of the `uxc import <file>.uxpkg` command on the download button.
- Per-version downloads counter.

---

## 10. Worked example — publishing `contract-management@1.0.0`

This is exactly what `uxc mp publish` does against the API. Use it as your integration fixture.

1. **Upsert the listing** — `PUT /api/marketplace/addons/contract-management` with the §6.2 body
   (name "Contract Management", category `contract-intelligence`, audience `generic`, products
   `[flowerdocs, uxopian-ai]`).
2. **Create the draft version** — `POST …/versions` with the §6.3 body: `version: "1.0.0"`,
   compatibility `{ flowerdocs:["5.6"], uxopianAi:["1.10"] }`, the manifest snapshot, the §6.4
   catalog (122 objects: 64 tagclasses, 14 prompts, 5 document classes, 5 handlers, …), artifact
   descriptor (`ct-1.0.0.uxpkg`, sha256, bytes), and asset descriptors (screenshots + README).
   → server returns signed upload URLs.
3. **Upload** the `.uxpkg` to the artifact signed URL (`PUT`, `content-type: application/zip`), and
   each screenshot/doc to its signed URL.
4. **Finalize** — `POST …/versions/1.0.0/finalize`. Server verifies sha256/size, flips to
   `published`, sets `latest_version = 1.0.0`.
5. It now appears in `GET /api/marketplace/addons` and on the browse grid; the detail page renders
   the description, screenshots, README, "Tested on FlowerDocs 5.6 / Uxopian AI 1.10", and the
   122-object catalog; the version panel offers the `.uxpkg` download.

---

## 11. Out of scope for v1 (do not build)

- **Dependency management** between addons (declaring/resolving that addon A needs addon B). We
  will add a `requires` model later; leave room but build nothing now.
- Editing addons from the Pulse UI (all writes are via Claude/`uxc`).
- Ratings/reviews/comments, install analytics beyond a simple download count, SSO-scoped private
  addons, public (external) exposure. Internal only.
- Opening/validating `.uxpkg` internals server-side.

---

## 12. Acceptance criteria

1. A maintainer key authenticates; `GET /whoami` returns the right maintainer; a revoked key → 401.
2. The full §10 flow (upsert → create draft → upload → finalize) publishes `contract-management@1.0.0`.
   Re-publishing the **same** version with the **same** artifact but edited compatibility/changelog/
   screenshots **succeeds** and updates in place (§6.0); re-publishing the same version with a
   **different** `.uxpkg` → `409 artifact_changed`.
3. Browse grid lists the addon with the correct audience badge; category/product/compatibility
   filters and full-text search work and are reflected in the URL.
4. Detail page renders markdown description, screenshot gallery, README, compatibility badges, and
   the grouped 122-object catalog; version panel downloads the exact `.uxpkg` (sha256 matches).
5. Publishing `1.1.0` updates `latest_version`; `1.0.0` remains downloadable; deprecating `1.0.0`
   shows the badge and keeps it downloadable; yanking hides it from normal users.
6. Generic vs customer-demo vs prospect-demo addons are visually distinct and independently
   filterable.

---

## 13. As-built deployment (verified 2026-06-16)

The live implementation (Lovable Cloud / Supabase) follows this spec's payloads, error envelope,
and `marketplace.json` / catalog shapes **verbatim**. The contract was verified end-to-end by
publishing `contract-management@1.0.0` and round-tripping it (publish → browse → download with a
matching sha256). Two routing-level differences from §6/§7, which the `uxc mp` client codes against:

**Three function roots** instead of one host with an `/api/marketplace/...` prefix (Lovable Cloud
routes everything through `/functions/v1/<name>`). Each function URL is its own API root — routes
append directly:

| Function root | Auth | Routes (verified) |
|---|---|---|
| `…/functions/v1/marketplace-publish` | `Bearer uxmk_…` | `GET /whoami` · **`PUT /addons/:slug`** (upsert) · `POST /addons/:slug/versions` · `POST /addons/:slug/versions/:version/finalize` · `POST /addons/:slug/versions/:version/status` |
| `…/functions/v1/marketplace-browse` | Pulse JWT or `uxmk_` | `GET /categories` · `GET /addons` · `GET /addons/:slug` · `GET /addons/:slug/versions/:version` |
| `…/functions/v1/marketplace-download` | Pulse JWT or `uxmk_` | `GET /addons/:slug/versions/:version/download` → `302` signed URL |

(Upsert is `PUT`, version-status is `POST` — as in §6.2/§6.6. `DELETE /addons/:slug` archive is not
yet deployed.)

**Browse query params** (`GET /addons`) as deployed: `category`, `audience`, `product`,
`compatibility` (single tested-on tag), `q`, `limit`, `offset` — in place of §7.2's split
`compat_flowerdocs`/`compat_uxopian_ai` + `page`/`page_size`.

`uxc` config (`~/.uxopian/marketplace.json`) stores the publish root as `url` and auto-derives the
`browse`/`download` roots by swapping the `-publish` suffix (overridable via `browseUrl`/`downloadUrl`).

**Pending change (not yet deployed):** the initial deployment 409s (`version_exists`) on any
re-publish of an existing version. *Change 01* (§6.0, `PULSE-MARKETPLACE-CHANGE-01.md`) relaxes this
to artifact-hash identity — same-hash re-publish edits in place; only a changed `.uxpkg` is
rejected (`artifact_changed`). Apply that change to `marketplace-publish` to enable metadata/asset
fixes without a version bump.
```
