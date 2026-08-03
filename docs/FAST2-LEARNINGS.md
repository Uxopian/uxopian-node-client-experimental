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
