# FlowerDocs scope management — the SOAP protocol (decompiled) + uxc-native design

**Goal:** manage FlowerDocs scopes natively from `uxc` (create / get / delete / list, and clone),
without shelling out to the CLM bundle JAR.

**Source of truth:** reverse-engineered from `flower-docs-clm-2025.2.0-bundle.jar` (Spring Boot fat
jar) and its `flower-docs-ws-client` / `flower-docs-ws-api` / `flower-docs-security` libs (CFR
decompile, 2026-06-17). Status: **LIVE-VERIFIED end-to-end** on `iris.demos.uxopian.com` (2026-06-17)
— create → get → delete → get(gone) round-trip on a throwaway `ZzUxcScopeTest`, reusing uxc's JWT.
See "Verified live" below.

---

## 1. TL;DR — it's SOAP, and it's small

Scope lifecycle is **not** Core REST — it's a **SOAP 1.1 web service** (Apache CXF, JAX-WS,
document/literal) under `/core/services`. The CLM bundle is just a Spring app that calls
`ScopeService.create/update/get/delete`, where each is one SOAP request. "Create a scope remotely"
= **one SOAP POST**. No server-side filesystem work, which is exactly the discovery.

The auth the running CLM uses is **a token in a SOAP header** — and that token is the *same*
FlowerDocs token `uxc` already mints at `POST /core/rest/authentication` (`{value: JWT}`). So a
native client is: get the JWT we already get → wrap the request in a SOAP envelope with three
headers → POST. Tiny.

---

## 2. The wire protocol (verified from WSDL + decompiled client)

### Endpoint
```
POST  <baseUrl>/core/services/scope        # ws.url is "<base>/core/services"; client appends "/scope"
Content-Type: text/xml; charset=UTF-8
SOAPAction: "http://flower.com/service/scope/<op>"     # op = create | update | get | delete
```
Sibling services follow the same pattern: `…/core/services/{document,documentclass,tagclass,
workflow,acl,authentication,token,…}` (from `SOAPClientConfiguration`). Scope is **not** MTOM
(plain SOAP); the document service is MTOM.

### Operations (portType `ScopeWSService`, ns `http://flower.com/docs/ws/api/scope`)
| op | body in | body out | what it does |
|---|---|---|---|
| `create` | `createRequest` = 1..n `Scope` | `createResponse` = the scopes | create one/many scopes |
| `update` | `updateRequest` = 1..n `Scope` | `updateResponse` | update one/many scopes |
| `get` | `getRequest` = 1..n `id` (`common:Id`) | `getResponse` = the scopes | read by id |
| `delete` | `deleteRequest` = 1..n `id` | `deleteResponse` (empty) | delete by id |

Faults: SOAP faults `TechnicalException` / `FunctionalException` (ns
`http://flower.com/docs/ws/api/common`) carrying a FlowerDocs error code (e.g. `F00xxx`/`T00xxx`).

### Auth + context — three SOAP headers (decompiled from the CXF interceptors)
The proxy for every service attaches `scopeInjector` + `requestIdInjector` + `smartTokenInjector`.
Each injector adds a SOAP **header element in namespace URI `flower`** (literally the string
`"flower"`; `Document.createElementNS("flower", name)`):

| Header | Source | Value |
|---|---|---|
| `<token xmlns="flower">` | `TokenInjector` / `SmartTokenInjector` | the FlowerDocs token = **the JWT from `/core/rest/authentication`** |
| `<scope xmlns="flower">` | `ScopeInjector` | the scope **context** for the call |
| `<request xmlns="flower">` | `RequestIdInjector` | a request id (any uuid; not required) |

> A second injector, `UserCredentialsInjector`, builds `<login>`/`<password>`/`<scope>` headers
> instead of a token. It's declared as a bean but **not** wired onto the service proxies — the live
> CLM uses the token path. Plain login/password headers may also be accepted server-side, but the
> token path is what's proven in use, so the native client mirrors it.

### Request envelope — create (the one that matters)
```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <token   xmlns="flower">{JWT from /core/rest/authentication}</token>
    <scope   xmlns="flower">{scope context — see Open Q1}</scope>
    <request xmlns="flower">{uuid}</request>
  </soap:Header>
  <soap:Body>
    <createRequest xmlns="http://flower.com/docs/ws/api/scope">
      <Scope xmlns="http://flower.com/docs/domain/scope">
        <!-- the marshalled Scope: <id>, <data>(owner,dates), <people><profiles>(ADMIN), … -->
        <!-- == the content of a CLM export's scope.xml, exactly -->
      </Scope>
    </createRequest>
  </soap:Body>
</soap:Envelope>
```
`ScopeImportOperation` (decompiled) sets, server-intent-wise, before calling create/update:
`Scope.id = <target>`, `data.owner = admin`, `data.creationDate/lastUpdateDate = now`, and adds the
admin user to the `ADMIN` profile's principals. `create` if the scope doesn't exist, else `update`.

### Request envelope — delete / get (by id)
```xml
<soap:Body>
  <deleteRequest xmlns="http://flower.com/docs/ws/api/scope">
    <id><value xmlns="http://flower.com/docs/domain/common">{SCOPE}</value></id>
  </deleteRequest>
</soap:Body>
```
(`getRequest` is identical with `getRequest`/`get` SOAPAction; `common:Id` shape to confirm from
`Common.xsd` — almost certainly a `<value>`.)

### The `Scope` payload
The body's `Scope` element is the same object a CLM `export` serializes to `scope.xml`. Two ways to
get one:
- **Clone:** take an existing scope's `scope.xml` (from a CLM export, or a future native export) and
  re-target it — exactly two anchored edits, per the colleague's toolkit: `<id>SRC</id>`→`<id>DST</id>`
  and `/gui/plugins/SRC/`→`/gui/plugins/DST/` (never a blind global replace — `MULTIRISQUE`
  contains `IRIS`). Then `create`.
- **Blank:** build a minimal `Scope` (id + admin profile + data) from a uxc template. Exact required
  fields come from `Scope.xsd` (in `flower-docs-ws-api`) — to be pinned during implementation.

---

## 3. uxc-native design — SHIPPED (scope CRUD, verified live 2026-06-17)

**Implemented:** `lib/soap.mjs` (zero-dep SOAP 1.1 envelope/post/fault parse), `lib/scope.mjs`
(`createScopeClient` over `/core/services/scope`, reusing the target JWT), and commands
`uxc scope get|create|delete`. Wired into the dispatcher/help/lib; offline tests in
`test/scope.test.mjs`. Live-verified create→get→delete→gone on iris.

```
uxc scope create <id>   # blank by default; --from <scope.xml> (id re-targeted), --description, --display-en/-fr, --lang, --admin
uxc scope get <id>      # exists-check + summary (id, description, languages, profiles); exit 1 if absent
uxc scope delete <id>   # destructive; requires --yes
# all accept --target <name> (the instance) and --auth-scope (override the SOAP scope header)
```

**Not yet built (follow-on slices):** native scope **export** (many SOAP `get`/search calls across
all component services — the bulk of CLM) and a full **clone** (`uxc scope clone <src> <dst>` =
native export + the two anchored re-target edits + create). `--from` already covers
"create from an existing CLM export's scope.xml". A true `scope ls` needs a list endpoint the scope
WS doesn't expose (§4.5).

### Original design sketch (for the follow-on slices)

Reuse everything uxc already has (targets, JWT auth in `lib/http.mjs`, output discipline). Add a
**thin SOAP layer** + a **scope client** + **commands**. No new heavy deps (Node has no SOAP stack;
we hand-build the envelope and parse the response with a small XML reader — the messages are simple).

```
lib/soap.mjs        # buildEnvelope({soapAction, headers, bodyXml}) + post() + parseFault()/parseBody()
lib/scope.mjs       # createScopeClient(target): { list?, get, create, update, delete } over /core/services/scope
                    #   reuses target JWT (auth once via /core/rest/authentication), injects token/scope/request headers
lib/commands/
  scope-ls.mjs      # list scopes        (see Open Q2 — get-all vs an admin/list op)
  scope-get.mjs     # uxc scope get <id>           -> prints scope summary (id, owner, profiles)
  scope-create.mjs  # uxc scope create <id> [--from <scope.xml|export-dir>] [--admin user] [--blank]
  scope-delete.mjs  # uxc scope delete <id> --yes  (gated; destructive)
  scope-clone.mjs   # uxc scope clone <src> <dst> [--from <export-dir>]  -> retarget + create  (native rename)
```
- **Targets, not ws.url.** A uxc target already has `{url, scope, user, password}`. The SOAP base is
  `target.url + "/core/services"`; the JWT comes from the existing auth. `--target` selects the
  instance, exactly like every other uxc command.
- **Auth scope context (Open Q1).** For `create <new>`, authenticate against an existing scope you
  can administer, but set the `<scope>` SOAP header to the target (mirroring CLM). Needs one live check.
- **Clone** stays faithful to the proven toolkit semantics (the two anchored re-target edits +
  residual report), but the import becomes a native `create`/`update` SOAP call instead of the JAR.
- **Out of scope for a first slice:** native *export* of a full scope (it's many SOAP `get`/search
  calls across all component services + file serialization — that's the bulk of the CLM). For clone,
  start by consuming an existing CLM export folder; native export is a follow-on.

---

## 4. Verified live (2026-06-17, iris.demos.uxopian.com)

Probed by reusing uxc's auth (`connect('iris')` → JWT) and hand-building the SOAP envelopes:

1. **Auth:** uxc's JWT from `POST /core/rest/authentication {scope:IRIS}` works directly as the
   `<token xmlns="flower">` SOAP header. No separate token mint needed.
2. **Auth scope for `create`:** a JWT minted for an existing scope (IRIS) + `<scope>` header set to
   the **new** target id (`ZzUxcScopeTest`) is accepted — create succeeds. So `<scope>` = the scope
   id being operated on; the JWT just needs to be valid for *some* scope you can administer.
3. **`Id` shape:** `@XmlValue` → the request element carries the id as text: `<ns:id>X</ns:id>`
   (`ns = http://flower.com/docs/ws/api/scope`). Confirmed by a working `get`/`delete`.
4. **Minimal blank `Scope`** that the server accepts (order matters — matches the `get` response):
   `<scope:Scope>` with `<common:id>`, `<scope:description>`, `<scope:displayNames language=…>`
   `<i18n:value>`, `<scope:languages>`, `<scope:data><common:ACL>acl-scope</common:ACL></scope:data>`,
   `<scope:people><scope:profiles><common:id>ADMIN</common:id><scope:name>…</scope:name>`
   `<scope:principals>system</scope:principals></scope:profiles></scope:people>`. The server fills
   `creationDate`/`lastUpdateDate`. (Namespaces: scope=`…/domain/scope`, common=`…/domain/common`,
   i18n=`…/domain/i18n`.)
5. **No `list` op:** the scope WSDL exposes only get/create/update/delete. `get` of a missing scope
   returns **HTTP 200 with an empty `getResponse`** (no fault). So enumeration isn't exposed by this
   service — `uxc scope get` checks existence; a true `scope ls` would need another endpoint (TBD).
6. **`<login>/<password>` header path** left unused — the JWT/token path is proven and uxc already
   has the JWT.

---

## 5. Evidence trail (classes read)
- `com.flower.docs.clm.legacy.operation.ScopeImportOperation` → `scopeService.create/update([Scope])`.
- `…operation.ScopeDeleteOperation` → `scopeService.delete([Id])`.
- `…legacy.CLMRunner` → user/password into Spring Security context; scope context = `--scope`.
- `flower-docs-clm.xml` → `create` = bulk(scope-import + model + components); `delete` = bulk(ScopeDelete + purge-cache).
- `flower-docs-services-webservices.xml` + `ws.client.SOAPClientConfiguration` → CXF JaxWs proxies,
  address `${ws.url}/scope`, interceptors `scopeInjector + requestIdInjector + smartTokenInjector`.
- `ws.client.scope.ScopeWSServiceClient` → maps create/get/update/delete to `CreateRequest`… (the XSD elements).
- `security.soap.{TokenInjector,ScopeInjector,RequestIdInjector,UserCredentialsInjector,SecurityInjector}`
  → header element names + the `flower` namespace + token = `ContextHelper.getUser().getToken()`.
- `scope.wsdl` / `scope.xsd` (in `flower-docs-ws-api`) → operations, SOAPActions, message elements.
```
