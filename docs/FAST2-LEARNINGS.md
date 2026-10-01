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

## §F18 — The REAL FlowerDocs+AI ingestion pattern (from a working 15-version map)
Read from the live `CaptureAndExtraction` map (`4750aac1-…`, v15) on 2026-08-04 — the reference for
what §F17's silent failures were missing. **Read a working map before authoring one**: the shipped
`TEMPLATE-*` maps and any customer map in `f2_maps` are better documentation than the product docs.

Pipeline (7 steps, two-pass injection):
```
LocalSource(*.jpg)
  -> AlterPunnetProperties   propertyMap[category] = DOCUMENT        <- §F17's missing piece
  -> AlterDocumentProperties propertyMap[classid]  = Document
  -> FlowerInjector "Upload"  loadContent=true, modeUpdate=false,
                              documentIdDataName=flowerDocsDocumentId
  -> UxopianAIRequest         query=<prompt/goal>, responseMetadataKey=aiResponse,
                              metadataToInject=[flowerDocsDocumentId]
  -> JSTransform              parse aiResponse JSON -> document data
  -> FlowerInjector "Update"  modeUpdate=true, loadContent=false,
                              documentIdPattern=${flowerDocsDocumentId}
```
The four things that make it work, each of which my hand-authored map got wrong:
1. **`category` is a PUNNET property, set by `com.fast2.alter.AlterPunnetProperties`** — not a
   `FlowerInjector` step field and not a document property. That is the fix for the §F17 WARN
   `Flower category is missing for punnet <id>`. `classid` stays a DOCUMENT property
   (`AlterDocumentProperties`). Both use `propertyMap` with Pattern-bean values (§F15).
2. **The FlowerDocs endpoint ends in `/core/services`**, not `/core` — this is the SOAP/webservices
   base, not the REST base uxc itself talks to. A uxc target's `core` is NOT reusable verbatim here.
3. **Injection is TWO passes when AI enrichment is involved**: create the document first, capture
   its new FlowerDocs id into punnet metadata via `documentIdDataName`, then re-inject with
   `modeUpdate=true` + `documentIdPattern=${<thatKey>}` to write the enriched properties back onto
   the SAME document. A single-pass map cannot carry AI output into FlowerDocs.
4. **Passwords are the obfuscated `xr1c/…` token everywhere** (§F17) — in both the FlowerDocs
   connection and the AI connection.

`UxopianAIRequest` (`com.fast2.uxopianai.UxopianAIRequest`): `query` names the prompt/goal,
`responseMetadataKey` is where the raw answer lands as punnet metadata, `metadataToInject[]` lists
punnet metadata passed to the AI, `connectionSettings` ->
`com.fast2.uxopianai.UxopianAIFlowerDocsConnectionProvider` with only `user`/`password`/`scope` —
**no endpoint**, because the broker resolves the gateway from its own config (`GET /api/config`
`uxopian-ai` block, §F2).

The AI answer is a JSON STRING in punnet metadata; a `JSTransform` step turns it into document
data. The working script, verbatim:
```js
var doc = punnet.getDocuments().getFirst();
var rawJson = doc.getDataSet().getDataValue("aiResponse");
var result = JSON.parse(rawJson).result;      // the answer lives under .result
for (pty in result) doc.getDataSet().addData(pty, "String", result[pty]);
```

## §F19 — Link CONDITIONS: how a map branches
A link is `{name, target, condition}` where `condition` wraps an objectConfiguration:
```json
{"name":"no PII -> ingest","target":"<stepId>","condition":{"objectConfiguration":{
  "className":"com.fast2.taskflow.conditions.PatternCondition","singleton":false,
  "fullyConfigured":true,
  "fields":[{"name":"condition","primitiveConfiguration":{"value":"hasPii.equals(\"false\")"}}]}}}
```
- An **unconditional** link still carries the wrapper, with `className: ""` (empty string) and no
  fields. Omitting `condition` entirely also works on create, but the echo adds the empty form — so
  author the empty form to keep local and echo hashing equal.
- The 13 condition classes in the catalog (all `com.fast2.taskflow.conditions.*`): `PatternCondition`,
  `Otherwise`, `AlwaysTrue`, `AlwaysFalse`, `PunnetInException`, `PunnetHasData`, `DocumentHasData`,
  `ContentMimeTypeMatches`, `NumberOfDocuments`, `And`, `Or`, `Not`, `BinaryCondition`.
- **`PatternCondition.condition` is a Java-ish boolean expression over DATA NAMES as bare
  identifiers** — verified examples from the shipped templates:
  `acl.equals("ACL_archivists")` · `SOFT_DELETION.equals("TODO") && HARD_DELETION.equals("NOT_YET")`.
  So a `JSTransform` that does `punnet.getDataSet().addData("hasPii","String",v)` makes `hasPii`
  directly routable. String comparison via `.equals(...)`, not `==`.
- **`Otherwise` is the else branch** and is how the shipped maps terminate a decision fan-out. Order
  the links with the specific `PatternCondition`s first and `Otherwise` last.
- One step can carry many outbound links (`TEMPLATE-Documentum-multi-target` fans out to 6).

## §F20 — Moving/deleting the SOURCE file (filesystem side-effects)
- **`com.fast2.alter.MoveContent`** — "Move or copy the content of a document". Only `toFolder` is
  mandatory; the useful rest: `fromFolder`, `copyFile` (false = move), `deleteFromFolder`,
  `useOriginalFileName`, `overwriteExistingFile`, `processAllContent`, `newOutputFileName`,
  `fileExtension`, `supportedSourceMimeTypes`, `filesToExclude`, plus `waitTargetFile*` for
  slow/network targets. This is the task for "move the rejected file to another folder".
- `com.fast2.alter.MovePunnet` moves the punnet itself (`pathPattern` mandatory) — a different thing:
  it relocates the punnet within fast2's own working folders, not the source document's content.
- `com.fast2.filesystem.DeleteFileFromSystem` (`pathOfFileToDelete`) deletes the source outright.
- Remember `security.allowed.directories` in `config/application.properties`: when set, the worker
  may only touch listed directories — a move to an unlisted folder fails at run time.

---

**§F21–§F33 verified 2026-10-01** on a broker `2026.0.0-rc5` (`fast2-broker-rest-server`, built
`2026-09-14`), embedded worker, authentication on. REST only (no shell on the host); every write
used a throwaway `UXC_A0_probe_*` map, and all of them were deleted afterwards (pattern search
`^UXC_A0.*` → `{"total":0}`). No campaign was started, no library uploaded, no worker restarted.

## §F21 — Login, token lifetimes and refresh (rc5)
- `POST /api/auth/login` body `{email, password}` plus an optional `tenantId` (OpenAPI
  `AuthenticationRequest`) → **200** `{accessToken, refreshToken, tokenType:"BEARER", email,
  firstname, lastname, roles[], tenantId:"default", tenantIds[]}`. The token field is
  **`accessToken`** (unchanged from §F3). Roles come back as `ROLE_*` plus `*_PRIVILEGE` entries.
- The access JWT is RS256 with claims `role, tenantId, email, sub, iat, exp`; **`exp - iat` =
  14'400 s (4 h)**. The refresh JWT also lives **4 h** (claims `tenantId, sub, iat, exp`). Refresh
  endpoint: **`POST /api/auth/refresh-token`** (exists in the OpenAPI; not exercised by uxc yet).
- Anonymous (public) endpoints: `GET /api/auth/is-authentication-required` → `true`,
  `/api/auth/is-authenticated` → `false`, `/api/auth/max-failed-attempts` → `3`,
  `/api/auth/lock-time-duration` → `30`, `/v3/api-docs` → 200 (OpenAPI 3.1, 113 paths / 140
  operations, global `Bearer Token` scheme), `/swagger-ui/index.html` → 200.
- Only FAILED logins count toward the lockout (§F3). Each `uxc` process logs in once on its own;
  that is noisy in the broker's auth log but harmless for the lockout counter.

## §F22 — 401 vs 403: what each one means on rc5 (updates §F3 and §F14)
- **No token → 403** with the generic Spring envelope
  `{"timestamp", "status":403, "error":"Forbidden", "path"}` — no `message`. Verified on
  `/actuator/info`, `/api/broker/health`, `/api/config`, `/api/workers`, `/api/maps/...`. Never 401,
  never a 200 envelope. (On rc4, §F3 recorded the generic text "An unexpected error occurred…".)
- **Bad token → 401** with the envelope `{"status":"INVALID","message":"Invalid compact JWT string: …"}`
  for a non-JWT, and a 401 `"…signed with the 'HS256' signature algorithm, but the provided
  …RSAPublicKeyImpl key may not be used…"` for a forged HS256 JWT. So rc5 answers a bad token with
  **401 + INVALID**, where rc4 answered a stale-after-restart token with **200 + INVALID** (§F14).
  Keep both: a client must branch on 401 AND still guard the 200 envelope for older builds.
  A stale-after-restart token was not re-tested on rc5 (it needs a broker restart).
- **Consequence for uxc (`lib/http.mjs` `f2Surface`)**: re-authenticate on **401**; on a 403 only
  when the body is the generic envelope above, at most once per token. Any other 403 is a real
  authorization answer (§F23) and is surfaced verbatim, with no login attempt.

## §F23 — Authenticated-but-forbidden: a 403 is NOT always an expired token
Two legitimate 403s answered with a valid super-admin token:
- **`GET /api/broker/health` → 403 even for `ROLE_SUPER_ADMIN`.** It is unusable as a probe on
  rc5. Probe with the authed `GET /actuator/info` (§F24), or anonymously with
  `GET /api/auth/is-authentication-required` (2026 only).
- **`GET /api/broker/contents?path=/` → 403** `Access denied: Attempt to access file outside storage
  root (/)` (§F31).
A client that treats every 403 as "token expired" logs in again, loses the broker's text, and —
with a second such 403 inside the 30 s lock window — trips its own anti-lockout cooldown with a
message about failed logins although none failed. Fixed in uxc by §F22's rule.

## §F24 — Version detection needs the token on rc5
- `GET /actuator/info` → 200 `{"build":{"artifact":"fast2-broker-rest-server","name":"Fast2 REST
  Server","time":"2026-09-14T…","version":"2026.0.0-rc5","group":"com.fast2"}}` **with** the token;
  **anonymous → 403** (generic envelope). So version detection must run after login (uxc does).
- There is no anonymous version surface: `/v3/api-docs` is public but carries `servers[]`, no
  version.
- `uxc doctor --f2` on rc5 detects `fast2 2026.0.0-rc5 -> f2-2026 [actuator]`, and every f2-2026
  capability flag (`apiPrefix`, `actuatorInfo`, `mapJsonCrud`, `uploadAutoRenames`) was confirmed
  true by §F25–§F27.
- `GET /api/config` → 200 `{"dashboards":{…},"uxopian-ai":{"url":…},"server":{…}}` with the token.

## §F25 — XML upload answers 201 + the full map, and `_new1` is confirmed on rc5
- `POST /api/maps/upload/{mapName}` (multipart field `file`) → **201 Created** (not 200), body =
  the **full map JSON** (`id`, `name`, `mapVersionsSerieId`, `mapVersion{versionNumber,
  displayName, lastModificationDate{value,type,format}}`, `mapDescription`, `steps`). Read the new
  id from `.id`; no follow-up search is needed.
- The `<id>` inside the XML is ignored: the broker assigns a new one (as on rc4, §F7).
- **`_new1` re-confirmed**: a second upload under the same name → 201 and a NEW map
  `<name>_new1` with a new id and a new `mapVersionsSerieId`. No 409, no overwrite.
  `GET /api/maps/name-availability?mapName=` reads `true` before the first upload and `false`
  after it — it remains the clean pre-create check.

## §F26 — JSON create is accepted on rc5, and it never updates
- `POST /api/maps` with a JSON body → **201** + the map JSON. "Please import XML map only" never
  appears on rc5 (`mapJsonCrud` holds).
- It **ignores a supplied `id` / `mapVersionsSerieId`**: posting the full identity block of an
  EXISTING map under another name created a NEW map (new id, new serie) — no overwrite, no 409.
  So `POST` is create-only; an update must go through `PUT` (§F27). This is why `f2.map` is
  `createOnly + inPlaceUpdate`.

## §F27 — `PUT /api/maps` in place on rc5; a description-only edit keeps the version
- `PUT /api/maps` with the body of `GET /api/maps/{id}` (identity block included, §F16) and
  `mapDescription.content` changed → **200** + the updated map JSON. Same `id`, same
  `mapVersionsSerieId`; only `lastModificationDate` moves.
- The **description-only** change did NOT mint a version: still `v1`, and
  `search-by-version` → total 1. Do not expect a version bump on every PUT.
- Whether a STRUCTURAL `PUT` mints a new version on rc5 (§F16, rc4: yes) was not re-tested.

## §F28 — Link conditions: the XML tag and the rc5 JSON echo
- XML: a link is `<com.fast2.model.taskflow.design.TaskLink>` holding `<name>`, `<target><id>` and
  **`<taskLinkCondition class="com.arondor.common.reflection.bean.config.ObjectConfigurationBean">`**
  with `<className>`, `<fields/>`, `<singleton>`, `<fullyConfigured>`. 19 occurrences across 6 of
  the 9 maps exported via `GET /api/maps/download/{id}` (200, `application/octet-stream`); e.g. the
  shipped `DefaultMap` routes `Success` with `com.fast2.taskflow.conditions.Otherwise` and `Fail`
  with `…PunnetInException`.
- JSON (`GET /api/maps/{id}`): `steps[].links[] = {name, target, condition:{objectConfiguration:
  {className, singleton, fullyConfigured, fields[]}}}` (as §F19). On these rc5 exports an
  unconditioned link came back as just `{target}`; keep authoring §F19's empty form, which the
  broker accepts, and let canonicalization absorb the difference if a hash drift ever shows up.

## §F29 — `DELETE /api/maps/{id}` → 200 with an EMPTY body
- **200, empty body, no content-type.** A JSON accessor gets nothing (uxc: `undefined`); that is success, not an error.
  Afterwards `GET /api/maps/{id}` → 404 and the pattern search → `{"total":0}`.
- A malformed id (e.g. an object stringified into the path) → **400 with an HTML Tomcat error
  page**, not JSON. Do not assume error bodies are JSON on the maps routes.

## §F30 — Map id shape differs between the summary and the body
- `GET /api/maps/summary/search-by-pattern` → `{total, collection:[{id:{mapId}, name,
  versionNumber}]}` — **`id` is NESTED `{mapId}`**.
- `GET /api/maps/{id}`, and the upload/POST/PUT bodies → **`id` is a flat string**.
- Any new code path that reads a summary row must normalise `id.mapId` (`uxc f2 ls` does).
- `GET /api/maps/{id}` keys: `isReadOnly, id, name, mapVersionsSerieId, mapVersion,
  mapDescription, steps`; step keys: `id, name, queue, taskType, graphic, objectConfiguration,
  links`.

## §F31 — `broker/contents` is not a directory browser
- The path is resolved **under a storage root**; it lists nothing, and that root is not the
  install's `files/` directory under that name.
- `?path=/` → **403** `Access denied: Attempt to access file outside storage root (/)` (§F23).
  `?path=` and `?path=.` → **500** with a generic `An unexpected error occurred…` (text/plain).
  `files`, `files/`, `logs`, `maps`, `config`, `exceptions.csv`, `output_<run>.csv`,
  `files/output_<run>.csv`, `./files/output_<run>.csv` → **404** `Content not found: <path>`
  (text/plain).
- Which file a CSVWriter `./files/x.csv` lands on is still unproven (see the list below).

## §F32 — Workers and libraries (read-only)
- `GET /api/workers` → `{total, collection:[{embedded, hostname, jdkVersion, lastSeen, pid,
  processingSpeed, queueFilter, tenantId, totalProcessed, workerId}]}`. The id field is
  **`workerId`**; there is **no status field** (liveness = `lastSeen`). `lastSeen` is an **age in
  ms**, not a timestamp (broker source: `WorkerRegistry` sets it from `LastActivity.age()`), so
  `2667` = seen 2.7 s ago. `uxc doctor --f2` prints it as such.
- `GET /api/workers/{id}/logs?results=<n>` → 200, a bare JSON **array** of events with keys
  including `campaign`, `category` (`<logger>:<line>`), `exception` (full stack trace as a string).
- `GET /api/workers/libraries?size=<n>` → `{total, collection:[{jarName, groupId, artifactId,
  version, source, lastModificationDate, creationDate, fileSize, versionsLibs}]}`.
- From the OpenAPI only (not called): `POST /api/workers/upload-library` (multipart, required field
  `file`; 200 / 400 "Invalid file provided" / 500 — no "campaign running" code documented),
  `POST /api/workers/restore-library?jarToVersion=&jarToRestore=`,
  `GET /api/workers/library-versions/{libraryName}`, `POST /api/workers/generate-token?workerLogin=`,
  `POST|DELETE /api/workers`.
- Broker source (`LibraryManagementService`): upload-library and restore-library refuse while
  `CampaignService.isAnyCampaignRunning()`, which looks for a campaign in **`Started`** only
  ("At least one campaign is currently running, upload library not allowed"). The HTTP status of
  that refusal is unverified (see below). `uxc doctor --f2` is stricter and also counts `Starting`.
- `OPTIONS /api/workers/upload-library` → 403 with or without CORS preflight headers: that is the
  security filter, so OPTIONS proves nothing about a route. The OpenAPI is the source of truth.

## §F33 — Campaigns and catalog (read-only)
- `GET /api/campaigns/search-by-pattern` → `{total, collection:[<names>]}` — names only, no
  status. `GET /api/campaigns/{name}/status` → 200, a bare JSON string (`"Finished"`), as §F9.
- `GET /api/catalog` → a bare array of **163** classes; `?allTask=true` → **1'511** (§F15 counted
  161 / 1505 on rc4 — the counts move with the installed jars, never hard-code them).

## Unverified on rc5 (open after the 2026-10-01 probe)
Out of scope of a read-mostly probe; verify on a throwaway object before relying on them:
- What `broker/contents?path=` resolves a CSVWriter `./files/<x>.csv` to — needs a controlled run
  that writes a known CSV.
- The `upload-library` refusal status while a campaign is running.
- The worker-restart response (200 vs 207 multi-status).
- The exceptions and results file formats of a run.
- Whether a structural `PUT /api/maps` mints a new version on rc5 (§F16 says yes on rc4).
- A stale token after a broker restart (rc4: 200 + INVALID, §F14; rc5: untested).
