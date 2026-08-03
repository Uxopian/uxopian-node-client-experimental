# FAST2-DESIGN — fast2 as a third product surface in uxc

Status: **plan** (Phase 1). Every mechanic cited here was verified live on a local
`fast2-complete-package-2026` broker `2026.0.0-rc4` on 2026-08-04 and recorded in
[docs/FAST2-LEARNINGS.md](./docs/FAST2-LEARNINGS.md) (§F1–§F12). Nothing below is guessed.

**Goal**: a uxopian package can hold **fast2 maps** alongside its FlowerDocs and Uxopian-AI
resources, and `uxc push` / `import` / `mp install` deploys them to a fast2 broker — so one artifact
ships a complete solution: the FlowerDocs data model, the AI prompts, *and* the migration/ingestion
map that feeds it.

---

## 1. Why this fits the existing architecture (and where it does not)

fast2 is the **third product**, after `flowerdocs` and `uxopian-ai`. The reserved slots already
exist: `DIALECTS.fast2` (`lib/dialects.mjs:46`), the `FAST2-LEARNINGS.md` slot (now filled), and
`manifest.products`. Three things are genuinely new:

| | flowerdocs / uxopian-ai | fast2 |
|---|---|---|
| Auth | FlowerDocs Core JWT in a `token:` header, one credential set + scope | **separate user store**, `POST /api/auth/login {email,password}` → `Authorization: Bearer` (§F3) |
| Version | Core `/actuator/info`; AI has none (fingerprinted) | `/actuator/info` → `build.version` (§F2) — a real surface |
| Resource identity | the id IS the key (`CtContract`) | maps are keyed by **name**, but addressed by a server-minted **`mapId` UUID** (§F5/§F6) |

The name-vs-id split is the only real modelling novelty, and uxc already has the pattern for it:
`fd.handler` keeps a *logical* registry id (`CtIngest_onCreate`) and resolves the *deployed* id
(`…_v13`) at runtime via per-target state (`deployedId`). **`f2.map` uses the same trick**: the
registry key is the map NAME; the `mapId` is per-target state, resolved by name lookup and cached.

---

## 2. Target surface

fast2 needs its own base URL and its own credentials — it does **not** share the FlowerDocs ones.

```
uxc target add local --core https://host/core --ai …/uxopian-ai --scope IRIS --user u --password p \
    --f2 http://localhost:1789 --f2-user me@example.com --f2-password '…'
```

- `targets.json`: `f2`, `f2User`, `f2Password` (env `UXC_F2_URL`, `UXC_F2_USER`, `UXC_F2_PASSWORD`).
- `resolveTarget()` gains them as **optional** — a target without `f2` simply cannot push `f2.*`
  resources, and `push` says so instead of failing obscurely. No derivation from the Core host:
  fast2 is usually a different machine entirely, and §61's split-port lesson says derivation lies.
- Password handling follows the fd.demo precedent: injected via env, never committed.

## 3. New client surface: `ctx.clients.f2`

`createClients()` currently closes over ONE token and one `auth()` (`lib/http.mjs:50-75`). fast2
needs a second, independent auth loop in the same shape:

- `auth()` → `POST {f2}/api/auth/login {email,password}` → `accessToken` (TTL 4h; re-auth at 3h30).
- `authed()` → `Authorization: Bearer <token>`; on 403/401, re-auth **once**.
- Surface flavour: single JSON objects (like the gateway, not the array-wrapped Core).
- **Do not retry on 403 more than once**: fast2 locks an account after 3 failed logins for 30s
  (§F3). A retry storm locks the operator out of the UI. The client refuses to re-auth more than
  once per 30s and says why.

## 4. The `f2.map` adapter

```js
{
  kind: 'f2.map',
  dir: 'f2/maps',
  layout: 'json',              // f2/maps/<Name>.json — the JSON representation (§F4)
  defaultPolicy: 'createOnly',
  inPlaceUpdate: true,         // PUT /api/maps updates IN PLACE, no version churn (§F5)
  cacheAffecting: false,       // fast2 has no GUI cache to clear
}
```

**Why `createOnly` + `inPlaceUpdate`** — the exact `fd.taskclass` shape (DESIGN §262): updates are
safe and in-place, but **deletion is dangerous and can be impossible**. A map with any associated
campaign refuses to delete, and a campaign wedged in `Starting` is unstoppable and undeletable via
the API, blocking its map's deletion permanently (§F8). So `rm --server` / `destroy` stay gated —
which is exactly the gate the 0.13.2 `destroy` fix (#61) just made real.

**Storage format: JSON, not `.map.xml`.** The XML is XStream (FQCN element names,
`PrimitiveConfigurationBean` wrappers) and there is **no upload-to-update endpoint** — the whole
CRUD lifecycle is pure JSON (§F5). Storing JSON means: diffable in review, canonicalizable, no
XStream parser to write and maintain, and one representation for hash + push. `.map.xml` stays what
it is — the UI interchange format — handled by the import/export paths in §7.

### Mechanics per adapter method

| method | implementation | learning |
|---|---|---|
| `list` | `GET /api/maps/summary/search-by-pattern?namePattern=` (empty = all) | §F6 |
| `resolveId` (internal) | `summary/search-by-pattern?namePattern=<REGEX-ESCAPED name>`, require exactly 1 hit; cache as per-target state `mapId` | §F6 |
| `get` / `readServer` | resolveId → `GET /api/maps/{mapId}` → canonicalize | §F5 |
| `create` | `POST /api/maps` with the body **minus** `id`/`mapVersion`/`mapVersionsSerieId`/`isReadOnly`; **409 → heal into update** (resolveId + PUT), the `isExistsError` pattern | §F5, §F7 |
| `update` | resolveId → `PUT /api/maps` with `id` injected | §F5 |
| `remove` | resolveId → `DELETE /api/maps/{mapId}`; on the campaign-association failure, fail with the §F8 explanation (which campaigns, how to clear) | §F8 |
| `scan` | `list` filtered by `looksOwned(manifest, name)` | naming.mjs |
| `validate` | offline lints — see §5 | §F11 |

**Canonicalization rules** (new `f2.map` section in `lib/canonical.mjs`): strip the four
server-minted fields (`id`, `mapVersion`, `mapVersionsSerieId`, `isReadOnly`). Everything else is
authored content and must hash: `name`, `steps[]` (including `id`, `graphic.x/y`, `objectConfiguration`,
`links[]`), `mapDescription`. Step ids are **author-controlled and preserved on create** (verified
field-by-field, §F5) — and campaign stats are keyed by step id (§F9) — so they are content, not noise.

**Duplicate-proofing (DESIGN §19)**: `push` must NEVER touch `POST /api/maps/upload/{name}`. That
endpoint ignores the file's id/name, takes the name from the URL, and on a name collision silently
creates `<name>_new1` instead of erroring (§F7) — the exact "second live object" failure §19 exists
to prevent. The JSON `POST` 409s properly. After any create, verify by name that exactly one map
matches.

## 5. Secrets and portability — the part that must not be got wrong

A real map embeds, inline: FlowerDocs `endPoint` / `login` / `scope` / `password`, and absolute
local paths like `/Users/me/Desktop/testFast2/*.*` (§F11). The password is **obfuscated, not
encrypted** (`xr1c/…`, reversible) — a plaintext secret for all practical purposes.

So `f2.map` is the first kind where **package variables (DESIGN §21) are mandatory, not optional**:

- `uxc add f2.map <Name>` scaffolds connector steps with `{{uxc:f2FlowerEndpoint}}`,
  `{{uxc:f2FlowerLogin}}`, `{{uxc:f2FlowerPassword}}` (declared `sensitive`), `{{uxc:f2FlowerScope}}`
  and `{{uxc:f2SourcePath}}` rather than literals.
- `validate()` **refuses to push** a map whose `password`-named field holds a non-placeholder value,
  naming the step and field. Same lint at `uxc export` / `mp publish` time — the existing mcp secret
  scrub in `exportPackage` is the precedent. A credential must never reach a `.uxpkg`.
- `uxc pull` / `adopt` of a live map does the reverse: it detects credential-shaped fields and warns
  that the pulled file holds a secret which must be variable-ized before commit.

## 6. Dialects

```js
fast2: {
  oldestSupported: '2025.0',
  ranges: [
    { name: 'f2-2026', max: null, caps: {
        actuatorInfo: true,      // GET /actuator/info -> build.version (§F2)
        mapJsonCrud: true,       // POST/PUT /api/maps take the object (§F5)
        apiPrefix: '/api',       // 2026 moved the REST surface under /api (§F1)
        uploadAutoRenames: true, // upload collision -> <name>_new1, never 409 (§F7)
    } },
  ],
}
```

Detection = `GET /actuator/info` → `build.version` (unauthenticated-friendly; §F2), with the
`f2Version` target pin / `UXC_F2_VERSION` override as precedence 1, per DESIGN §18. The documented
root-level paths (`/maps`) belong to an older build; `apiPrefix` is the capability flag that absorbs
it if uxc ever meets one — never a raw version check in the adapter.

## 7. XML interop without an XStream parser

Users have `.map.xml` files (UI downloads, the `maps/` drop-in folder, the shipped `TEMPLATE-*`
maps). Converting XStream XML → JSON in uxc would be a large, brittle surface. Instead, **let the
broker do it** — a proven composition of two verified mechanics:

```
uxc add f2.map <Name> --from-xml path/to/foo.map.xml
  → POST /api/maps/upload/ZzUxcConv<rand>   (broker parses the XML)
  → GET  /api/maps/{newId}                  (broker emits the JSON)
  → canonicalize, write f2/maps/<Name>.json
  → DELETE /api/maps/{newId}                (never-run map deletes cleanly — verified)
```

The reverse (`uxc get f2.map <Name> --xml`) is just `GET /api/maps/download/{mapId}`, which returns
the `.map.xml` the UI expects. Both directions are server-authoritative, so uxc never owns a
serializer it would have to keep in step with fast2 releases.

## 8. Running a map: `uxc f2 run`

The FlowerDocs/AI analogue of `uxc run <promptId>`, and the smoke-test primitive:

```
uxc f2 run <MapName> [--campaign <name>] [--wait <s>] [--expect-ok <n>] [--json]
```

- `POST /api/campaigns/{campaign}/start?mapId=<id>&newCampaign=true`, then **poll the campaign name
  the response returned** — the requested name 400s, and the suffix is `_Run<n>` which increments
  even over failed starts (§F9). This is precisely the trap a naive implementation falls into.
- Poll `…/status` until terminal, then `…/stats`, and render `taskStepStat` **resolved from step id
  back to the authored step name** (stats are id-keyed, §F9) — the whole reason step ids are content.
- Exit 1 on any `ProcessedException`, or on `--expect-ok <n>` mismatch. This is what makes maps
  testable from `uxc test` (the package-embedded functional test harness, #27/0.13.0).

## 9. Diagnostics: `uxc doctor --f2`

The fast2 leg of the pre-install gate, because two of the failure modes found in one afternoon are
invisible from the UI:

1. auth + `/actuator/info` version + dialect resolution;
2. map list / catalog reachable (`GET /api/catalog` → 161 entries here);
3. **the connector-jar gate** — is `com.fast2.flowerdocs.FlowerInjector` (and
   `com.fast2.uxopianai.UxopianAIRequest`, if the map uses it) present in the catalog? If not, the
   worker lacks the connector jar and every FlowerDocs injection will fail at run time, not push
   time (§F12). This is a package **dependency** in the #46 sense, declarable as
   `requires.f2TaskClasses`.
4. **the OpenSearch `create_index` block** — if `cluster.blocks.create_index: true` is set, EVERY
   campaign start fails with a generic 500 and wedges a campaign in `Starting`, which then blocks
   map deletion forever (§F8/§F10). Reported with the exact clearing command. A stale block does not
   clear itself when disk frees up.
5. wedged-campaign scan: any campaign in `Starting` → warn, name it, explain the OpenSearch escape.

## 10. Ordering, manifest, packaging

- **`PUSH_ORDER`**: `f2.map` goes **last**, after `ai.*`. A map references FlowerDocs classes and
  AI prompts by id; those must exist before the map that feeds them. Delete order reverses
  automatically.
- `manifest.products` accepts `fast2`; `supportedVersions.fast2` gates the install (DESIGN §18);
  `requires.f2TaskClasses: [...]` is the connector-jar dependency (§9.3).
- Receipts: a fast2 install should record on the fast2 side too. Deferred for the first release —
  fast2 has no obvious receipt-bearing object; `f2.map`'s presence + the FlowerDocs receipt is
  enough to answer "what is deployed here". Revisit with #23.
- `KIND_FORM['f2.map'] = 'pascal'` (map names allow `_`, so `CtIngestFromShare` is conventional and
  `looksOwned` works unchanged).

## 11. Scope of the first release (0.14.0, minor — packages gain a pinnable capability)

**In**: `f2` target surface + client; `f2.map` kind (JSON CRUD, canonical rules, createOnly +
inPlaceUpdate, name→id state, duplicate-proof create); dialects entry + `/actuator/info` detect;
variables-mandatory scaffold + secret lint; `--from-xml` adopt and `--xml` export; `uxc f2 run`;
`doctor --f2` incl. the connector-jar and `create_index` gates; `docs/FAST2-LEARNINGS.md`; offline
tests for every new pure function; live verification against local fast2 + the IRIS scope.

**Out (explicitly deferred)**: shared objects as their own kind (`f2.sharedobject` — GLOBAL-scoped
ones are not embedded in a map, §F4, so a map can depend on invisible state; needs its own design);
queues; jobs/scheduler (`/api/jobs` cron automation); workers/library upload; punnet-level
inspection beyond stats; fast2-side receipts.

## 12. Phase-2 live verification plan

The end-to-end proof, on the local broker against the real IRIS scope:

1. `uxc target add` with the `f2` surface; `uxc doctor --f2` green.
2. Build a package holding a **meaningful** map: `LocalSource` → `UxopianAIRequest` (classify/extract
   via the AI gateway) → `AlterDocumentProperties` → `FlowerInjector` into IRIS — the same shape as
   the user's existing `UxopianAI_IrisDemos`, but fully variable-ized.
3. `uxc push` it, confirm one map (no `_new1`), `uxc status` → insync, `uxc diff` → clean.
4. `uxc f2 run` it on real sample content → campaign `Finished`, punnets `ProcessedOK`, and the
   documents actually land in the IRIS scope (verified with `uxc search` on the target class).
5. Round-trip: edit a step locally → push → `uxc status` insync; edit on the server → `uxc status`
   shows `server` → `uxc pull`.
6. `uxc export` → `uxc import` on a second map name, proving portability and the secret lint.
7. Record any new mechanic in FAST2-LEARNINGS.md, then release 0.14.0.
