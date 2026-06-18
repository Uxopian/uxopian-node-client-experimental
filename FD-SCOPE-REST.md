# FlowerDocs scope management over Core REST

`uxc` manages FlowerDocs scopes (create / get / delete, and clone) natively over the **Core REST**
API — the same `/core/rest` surface, JWT auth, and array-body conventions as every other resource.
No SOAP, no CLM bundle.

> Earlier iterations used the SOAP scope service (`/core/services/scope`). That was removed: the
> FlowerDocs tech lead confirmed REST covers scope management, and the SOAP layer is going away in
> FlowerDocs 2026. Scope is now just another Core REST resource.

## Endpoints (verified live 2026-06-18 on a 2025.x instance)

| op | call | notes |
|---|---|---|
| **get** | `GET /core/rest/scope/{id}` | returns an **array of 1** (`uxc` unwraps via `getOne`); absent → `null` (F00206/404) |
| **create** | `POST /core/rest/scope` with `[scope]` | a **new** id; an existing id → `500` "symbolic name must be unique" |
| **update** | `POST /core/rest/scope/{id}` with `[scope]` | id in path, array body |
| **delete** | `DELETE /core/rest/scope/{id}` | `200` |

Auth/transport are `uxc`'s standard `core` client: `POST /core/rest/authentication {user,password,scope}`
→ JWT in the `token:` header, array bodies in/out, single-GET array-of-1 unwrap. Verified end to end
with a create → get → delete → gone round-trip on a throwaway scope.

## The scope object (JSON)

```json
{
  "id": "Acme",
  "description": "…",
  "displayNames": [{ "value": "Acme", "language": "EN" }, { "value": "Acme", "language": "FR" }],
  "languages": ["EN", "FR"],
  "data": { "ACL": "acl-scope" },
  "people": { "profiles": [{ "id": "ADMIN", "name": "Administrator", "principals": ["system"] }] }
}
```
The server fills `data.creationDate`/`lastUpdateDate`. A real scope's `people.profiles[]` also carry
`properties[]` (`{name, value}`) — surfacing config, search templates, home widgets, etc. A
`--from` clone preserves all of that; `--blank` ships the minimal object above.

## `uxc` commands

```
uxc scope get <id> [--target name]            # summary; --json prints the full scope object
uxc scope create <id> [--blank]               # minimal blank scope
        [--from scope.json]                   #   …or clone (see below)
        [--description … --display-en … --display-fr … --lang EN,FR --admin system,admin]
uxc scope delete <id> --yes                   # destructive
```

Clone in two steps (no SOAP, no CLM):
```
uxc scope get IRIS --json > iris.json         # then edit ids / scope-bound URLs as needed
uxc scope create Acme --from iris.json
```

`create` upserts: a new id is created (`POST /rest/scope`); an existing id is updated
(`POST /rest/scope/{id}`). `--target <name>` selects the instance. This is distinct from
`fd.surfacing` (scope *properties* inside a scope).

## Implementation
`lib/scope.mjs` — the object builders (`blankScope`, `retargetScope`, `readScopeFile`) plus a thin
client over `clients.core` — and `lib/commands/scope-{get,create,delete}.mjs`. There is no dedicated
transport: scope rides the existing Core REST client.
