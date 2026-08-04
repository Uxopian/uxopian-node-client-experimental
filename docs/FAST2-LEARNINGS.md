# FAST2-LEARNINGS — verified Fast2 broker mechanics

Same contract as [FLOWERDOCS-LEARNINGS.md](./FLOWERDOCS-LEARNINGS.md) and
[UXOPIAN-AI-LEARNINGS.md](./UXOPIAN-AI-LEARNINGS.md): every entry was VERIFIED live before being
written; never guess an API shape — prove it on a throwaway `Zz*` object, then append here
(numbered §, date, instance).

**Verification instance for §F1–§F12**: local `fast2-complete-package-2026`, broker
`2026.0.0-rc4` (build `fast2-broker-rest-server`, `2026-03-25`), embedded worker + embedded
OpenSearch, `http://localhost:1789` — all verified **2026-08-04**.

## §F1 — Topology + surfaces
- One **broker** (`fast2-broker-package-<ver>.jar`, `startup-broker.sh`) serves the UI, the REST
  API, Swagger, and manages an **embedded OpenSearch** as a CHILD PROCESS. Killing the broker
  takes OpenSearch down with it (verified: `pkill -f fast2-broker-package` → :1790 dead too).
- **Workers** register themselves TO the broker (never the reverse). One worker is embedded in the
  broker by default; `startup-worker.sh` starts an extra standalone one. A standalone worker on a
  broker that already has security state can fail with
  `IllegalStateException: Failed to register worker` — the embedded worker is enough for dev.
- Ports (`config/application.properties`): broker `server.port=1789`, embedded OpenSearch `1790`
  (`opensearch.port`, commented default), OpenSearch transport `9300`.
- **REST base is `/api/...`** on this build (`/api/maps`, `/api/campaigns/…`). The published docs
  show root-level paths (`/maps`) — they are WRONG for 2026.0.0. Always confirm against
  `GET /v3/api-docs` (unauthenticated, 108 paths) or `/swagger-ui/index.html`.
- `GET /actuator/health` is unauthenticated (useful as a readiness probe);
  `GET /api/broker/health` requires auth and 403s without it.

## §F2 — Version detection (for lib/dialects.mjs)
- **`GET /actuator/info` → `{"build":{"version":"2026.0.0-rc4","artifact":"fast2-broker-rest-server",…}}`**
  — a REAL version surface, unlike the uxopian-ai gateway (§A2). Use it as the dialect detect
  function; no capability fingerprinting needed.
- `GET /api/config` returns the effective server/dashboards config AND a `uxopian-ai` block
  (protocol/host/port/basePath) — i.e. the broker itself knows how to reach a uxopian-ai gateway.

## §F3 — Auth: plaintext login, RS256 JWT
- `POST /api/auth/login` with `{"email":"…","password":"…"}` → `{accessToken, refreshToken,
  tokenType, email, roles, firstname, lastname}`. Then `Authorization: Bearer <accessToken>` on
  every `/api/**` call. Access token TTL 4h (`security.jwt.expiration=14400000`).
- The password is sent **PLAINTEXT** (JSON), NOT pre-encrypted. `GET /api/auth/public-key` exposes
  an RSA public key, but login does not require using it — verified by logging in with a plaintext
  body against a known bcrypt-hashed account.
- **Lockout is real**: `security.authentication.maximum-failed-attempts=3`, then
  `lock-time-duration=30`s. NEVER probe/guess passwords against a live broker — you will lock the
  account. Introspect with `/api/auth/remaining-attempts?email=`.
- Users live in the OpenSearch index `f2_users`, password = **BCrypt `$2a$10$…`**, fields
  `{email, password, firstName, lastName, role, enabled}`; roles `USER | ADMIN | SUPER_ADMIN`
  (+ internal `WORKER`). There is **no password recovery flow**.
- Missing auth on `/api/**` returns **403 with a generic body** ("An unexpected error occurred…"),
  not 401 — do not read 403 as "wrong endpoint".

## §F4 — A map IS `com.fast2.model.taskflow.design.TaskFlowMap`
Two representations, and the difference matters:

| | XML (`.map.xml`) | JSON |
|---|---|---|
| Where | `GET /api/maps/download/{mapId}` (`application/octet-stream`, `Content-Disposition: …map.xml`), `POST /api/maps/upload/{mapName}`, and the `maps/` drop-in folder | `GET /api/maps/{mapId}`, `POST /api/maps`, `PUT /api/maps` |
| Shape | XStream object graph: `<com.fast2.model.taskflow.design.TaskFlowMap>` with FQCN element names (`com.arondor.common.reflection.bean.config.{Primitive,Object,List}ConfigurationBean`) | flat-ish `{id, name, isReadOnly, steps[], mapVersion, mapVersionsSerieId, mapDescription}` |
| Links field | `<outboundTaskLinks>` | **`links`** |

- JSON top level: `id`, `name`, `isReadOnly`, `steps[]`, `mapVersion{versionNumber, displayName,
  lastModificationDate}`, `mapVersionsSerieId`, `mapDescription{content, graphic{x,y,image},
  isExpanded, height, width}`.
- A step: `{id, name, queue, taskType, graphic{x,y,image}, objectConfiguration{className,
  singleton, fullyConfigured, fields[]}, links[]}`. A link is `{target: "<stepId>"}` — links
  reference **step ids**, so step ids are load-bearing content, not incidental.
- **Canvas positions (`graphic.x/y`) are part of the saved map**, as are MAP-scoped shared objects.
  GLOBAL-scoped shared objects are NOT embedded (they live in `config/sharedObjects.xml` and
  `f2_global_shared_object`) — a map depending on them is not self-contained.

## §F5 — The full lifecycle is PURE JSON (no multipart needed)
> Superseded in part by **§F16**: `PUT` is in-place only for cosmetic edits, and it needs the
> identity block back in the body. Read §F16 before implementing an update path.
Verified on throwaway `ZzUxc*` maps, then cleaned up:
- **read**: `GET /api/maps/{mapId}` → JSON.
- **create**: `POST /api/maps` with the full JSON body **minus** `id`, `mapVersion`,
  `mapVersionsSerieId`, `isReadOnly` → **201**; the server mints those four. Steps, step ids,
  links, classNames and x/y all survive verbatim (verified field by field).
- **update**: `PUT /api/maps` with the JSON **carrying `id`** → **200, IN PLACE**: no new version,
  the version series stays at 1 entry. This is the `inPlaceUpdate` shape (DESIGN §262), not a
  create-new-version shape.
- **delete**: `DELETE /api/maps/{mapId}`, or `DELETE /api/maps/delete-by-pattern?namePattern=` /
  `delete-by-ids?mapIds=` (207 multi-status: `{failures:[{id, stackTrace}], success:[{id}]}`).
- **A bare-string body is NOT accepted**: `POST /api/maps` with `"MyName"` → 500. The docs type
  both `POST`/`PUT /maps` bodies as `"string"`; that is a generated-doc artifact. Send the object.
- `PUT` did **not** enforce the documented version match: re-sending a stale `mapVersion` returned
  200, not 404. Do not rely on it as optimistic concurrency.

## §F6 — Name resolution: `namePattern` is a FULL-MATCH REGEX
- `GET /api/maps/summary/search-by-pattern?namePattern=<re>` → `{total, collection:[{id:{mapId},
  name, versionNumber}]}`. Verified: `ZzUxc` → 0 hits, `ZzUxc.*` → 3, `ZzUxcProbe` → 1,
  `.*Probe.*` → 2, empty → ALL.
- So resolving one map by exact name means passing the name **regex-escaped**; and any
  "delete/search by pattern" call is a regex, not a glob — `delete-by-pattern?namePattern=` with an
  EMPTY value matches every map. Treat that as a loaded gun.
- `GET /api/maps/name-availability?mapName=` → boolean; the only clean pre-create existence check.

## §F7 — DUPLICATE HAZARD: upload silently renames instead of failing
- `POST /api/maps/upload/{mapName}` (multipart field `file`) **ignores the `<id>` and `<name>`
  inside the uploaded XML**: the server mints a new `mapId`/`mapVersionsSerieId` and takes the
  name from the **URL segment**. Step ids inside the file ARE preserved.
- Uploading the SAME name twice does **not** 409 (the docs claim it does) and does not create a new
  version — it creates a SECOND map named **`<name>_new1`** (verified: `ZzUxcProbe` →
  `ZzUxcProbe_new1`). This is the DESIGN §19 duplicate hazard: a naive "push = upload" litters the
  instance with `_new1`, `_new2`, … copies that all look plausible in the UI.
- `POST /api/maps` (JSON create) **does** behave: duplicate name → **409 "Map name already
  exists"**. Prefer the JSON path for every write; keep XML for UI interop only.
- There is NO upload-to-update endpoint. `POST /api/maps/upload` (plural, `names` query +
  `files[]`) is bulk CREATE.

## §F8 — DELETE GATE: a map that has ever run may be undeletable
- `DELETE` a map that has campaigns → failure `Cannot delete map <id> because some campaigns are
  currently associated with this map`. You must delete the campaigns first.
- **A campaign wedged in status `Starting` is neither stoppable nor deletable**: `stop` → 400
  "Campaign must be started to be stopped. Status of the campaign found is Starting";
  `DELETE /api/campaigns/{name}` → 500. It then blocks its map's deletion **permanently** via the
  API. Observed on a real instance too — the broker logs
  `Campaign <name>, unsupported status Starting!` at startup for a pre-existing wedged campaign.
- Escape hatch (verified): delete the campaign doc straight out of OpenSearch
  (`DELETE :1790/f2_campaigns/_doc/<campaignName>?refresh=true`) and drop its index
  (`f2_<campaign-lowercased>`) — then **restart the broker**, because `CoreBroker` keeps campaigns
  in memory and still lists a deleted campaign until it does. After the restart the map deletes
  cleanly.
- Consequence for uxc: `f2.map` must be **delete-gated** (`createOnly`-style policy), and
  `uxc destroy` must not assume a map is removable.

## §F9 — Campaign runs
- Start: `POST /api/campaigns/{campaign}/start?mapId=<id>&newCampaign=true` → **200 with the
  ACTUAL campaign name in the body**, e.g. `"ZzUxcSmoke_Run2"`. The suffix is **`_Run<n>`**, not
  the documented `_Try<n>`, and `<n>` increments even over FAILED starts.
- **The returned name is authoritative** — `GET /api/campaigns/{requested}/status` 400s with
  `Could not find campaign with name <requested>`. Always poll the name the start call returned.
- `GET /api/campaigns/{campaign}/status` → a bare JSON string (`"Finished"`, `"Starting"`, …).
  `…/stats` → `{campaign, taskFlowMapRef{mapId}, campaignStatus, startDate, finishDate,
  taskStepStat:{ "<stepId>": {paused, stats:{Queued|Processing|ProcessedOK|ProcessedException:
  {total, speed, timeframe}}}}}` — **stats are keyed by STEP ID**, another reason step ids must be
  stable and author-controlled in a package.
- Verified end to end: a 6-step sandbox map ran to `Finished` with 40 `ProcessedOK` /
  60 `ProcessedException` (the map's `ExceptionGenerator` is deliberate).
- `GET /api/punnets/punnet-contexts?campaign=` **requires `stepId` too** (400 without it).

## §F10 — OpenSearch can silently block ALL runs
- Every campaign creates an index `f2_<campaign-lowercased>`. If the cluster carries
  **`persistent: {"cluster.blocks.create_index": "true"}`**, `start` fails with a generic 500 and
  the broker logs `RuntimeException: Caught exception Forbidden access` at
  `CampaignRepository.ensureCampaignIndexExists`. The campaign record is created anyway and wedges
  in `Starting` (→ §F8).
- Diagnose: `GET :1790/_cluster/settings?flat_settings`. Clear:
  `PUT :1790/_cluster/settings {"persistent":{"cluster.blocks.create_index":null}}`. The block is
  usually a leftover of a past disk-watermark event and does NOT clear itself when disk frees up
  (observed with 14 GiB free).
- Indices to know: `f2_maps`, `f2_users`, `f2_campaigns`, `f2_campaigns_sources`,
  `f2_global_shared_object`, `f2_<campaign>`.

## §F11 — Secrets and machine-specific values live INSIDE map files
- Connector credentials are stored in the map: `FlowerDocsConnectionProvider` carries `endPoint`,
  `login`, `scope`, `password` as `PrimitiveConfigurationBean` values. The password is
  **obfuscated, not encrypted** (`xr1c/1e364255…` — Arondor's reversible scheme), so it must be
  treated as a plaintext secret.
- Maps also embed absolute local paths (e.g. `LocalSource.filesPathList` =
  `/Users/<me>/Desktop/testFast2/*.*`).
- Both are exactly what DESIGN §21 package variables are for: a packaged map must carry
  `{{uxc:…}}` placeholders for endpoint/login/password/scope/paths, never a real credential.
- `GET /api/maps/{mapId}/encryption-key` exists (unprobed) — check before designing secret
  handling.

## §F12 — Task catalog = a real schema surface
- `GET /api/catalog` → **161 entries** of full reflection metadata per task class:
  `{classBaseName, className, description, abstract, accessibleFields{<field>:{className,
  mandatory?, …}}, accessibleMethods, constructors, interfaces, jarPath, defaultBehavior}`.
  `GET /api/catalog/dto` is the lighter projection; filters: `?name=&classNames=&allTask=`.
- Use it to VALIDATE a packaged map's step `className`s and field names against the target broker
  before pushing, instead of hard-coding the doc tables. It also resolves the doc's naming drift
  (`FlowerInjector` vs `FlowerDocInjector`, `worker-libs/` vs `lib/`) per instance.
- FlowerDocs/uxopian-ai task classes present on this build:
  `com.fast2.flowerdocs.FlowerInjector`, `com.fast2.flowerdocs.FlowerDocsConnectionProvider`,
  `com.fast2.uxopianai.UxopianAIRequest`,
  `com.fast2.uxopianai.UxopianAIFlowerDocsConnectionProvider`, plus core tasks
  `com.fast2.filesystem.LocalSource`, `com.fast2.script.JSTransform`,
  `com.fast2.alter.AlterDocumentProperties`, `com.fast2.model.context.Pattern`.

---

**§F13–§F17 verified 2026-08-04** on the same broker, while implementing `f2.map` (issue #63) and
pushing a real map from a uxc package to fast2 with FlowerDocs `fd.demo.uxopian.com` (scope IRIS)
as the injection target.

## §F13 — `mapDescription` is character-validated
- `POST /api/maps` with an em dash (or other non-latin punctuation) in `mapDescription.content`
  → **400 "Map description contains invalid characters. Allowed characters are letters, numbers
  and standard punctuation."** Keep descriptions ASCII. The map NAME is not affected.

## §F14 — A broker restart rotates the JWT signing key, and a stale token 200s
- After a broker restart, an old access token does not 401/403 — the call returns **HTTP 200 with a
  body `{"status":"INVALID","message":"JWT signature does not match locally computed signature…"}`**.
  Any client that only branches on the status code will parse that envelope as data. uxc logs in
  fresh per run, so it is not exposed, but a long-lived script must check the envelope.

## §F15 — The task CATALOG is authoritative for field names — and still incomplete
- `GET /api/catalog` returns only the **~161 top-level TASK classes**. Credential/helper beans
  (e.g. `FlowerDocsConnectionProvider`) are absent from it. **`?allTask=true` returns all 1505**
  classes and is what a "is the connector jar installed?" check must use.
- The FQCN is the **`name`** field; `classBaseName` is the simple name. `?classNames=<fqcn>`
  returned 0 hits — do not rely on it, filter client-side.
- Per-class field metadata is `accessibleFields: {<field>: {className, mandatory}}`. **The product
  docs' field labels are NOT the bean field names** — verified mismatches on `FlowerInjector`:
  docs say "FlowerDocs connection provider" / "Load document file content", the real fields are
  **`connection`** (mandatory) and **`loadContent`**. Always read the catalog, never the doc table.
- **`accessibleFields` is itself incomplete**: the shipped `TEMPLATE-Flower-archiving` map
  configures `FlowerInjector.category = DOCUMENT`, a field the catalog does not list. Treat the
  shipped `TEMPLATE-*` maps as a second reference when a field seems to be missing.
- Field value encodings in the JSON form: `primitiveConfiguration {value}`, `objectConfiguration
  {className, fields[]}`, `listConfiguration []`, `referenceConfiguration`, and **`mapConfiguration`**
  whose entries are `{key: <config>, value: <config>}` — the key is itself a wrapped config, and
  values are usually `com.fast2.model.context.Pattern` beans (so `${…}` expressions work).

## §F16 — `PUT /api/maps`: identity block required, and a structural edit MINTS A NEW VERSION
Refines §F5, which was measured on a description-only edit:
- The body must carry **`id` AND `mapVersion` AND `mapVersionsSerieId`**. Sending only `id` (the
  canonical content plus the id) fails with **400 "Map id: …, name: … is corrupted"**. Since uxc
  strips those three as server-owned, the update path must re-attach them from a live GET.
- A **cosmetic** edit (e.g. `mapDescription.content`) updates in place: same `mapId`, same version.
- A **structural** edit (adding/removing a step) creates a **NEW VERSION**: a NEW `mapId`, a NEW
  `mapVersionsSerieId`, `versionNumber+1`, and the previous version flipped to `isReadOnly: true`.
- Therefore **a cached mapId goes stale on every structural update** — and the stale one still
  resolves (to the frozen read-only version), so a "does it still GET?" check does NOT detect it.
  Resolve by NAME: `summary/search-by-pattern` returns only the CURRENT version (the read-only
  ancestors stay inside the version series and never collide by name).

## §F17 — FlowerInjector: two silent failure modes (ProcessedOK proves NOTHING)
Both observed with the campaign reporting `Finished` and `ProcessedOK` for every step, while
**zero documents were created** in FlowerDocs. `ProcessedOK` is not evidence of injection — verify
on the FlowerDocs side (`uxc search <class> --order creationDate:desc`), and read the WORKER log.
1. **The password must be fast2's OBFUSCATED form (`xr1c/…`), never plaintext.** A plaintext value
   fails at bean-instantiation time with
   `ERROR ReflectionInstantiatorReflect: While setting password on class
   com.fast2.flowerdocs.FlowerDocsConnectionProvider, caught Unexpected encoded string !`
   — logged by the WORKER, invisible in the campaign stats, and the punnet still counts OK.
   No REST endpoint obfuscates a password (`/api/maps/{id}/encryption-key` 500s; there is no
   encode service in the 108-path API). The obfuscated string is produced by the fast2 UI. So a
   uxc package variable for a fast2 connector password must carry the **obfuscated token**, copied
   from the UI — uxc treats it as opaque. (This is also why the value is a secret: the scheme is
   reversible, §F11.)
2. **`Flower category is missing for punnet <id>`** — a WARN, again with ProcessedOK. Setting
   `category` as a step field on `FlowerInjector`, and setting a `category` DOCUMENT property via
   `AlterDocumentProperties.propertyMap`, both leave the warning in place; the injector resolves
   the category from somewhere else (punnet-level data is the likely candidate). **Unresolved** —
   configure a working FlowerInjector in the fast2 UI and diff its map JSON before trusting a
   hand-authored one.

**Consequence for uxc**: `uxc f2 run` reports what the broker reports; it cannot certify that a
FlowerDocs injection happened. Package functional tests (`uxc test`) should assert on the
FlowerDocs side (search the target class) rather than on campaign stats.
