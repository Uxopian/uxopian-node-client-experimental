# DIAGNOSTICS — is this server/scope ready? (run BEFORE installing a package or starting a project)

The layer model and several checks originate from the fd.demo migration runbook (contracts-
management session, 2026-07); this version is corrected against the real uxc command surface and
wired to implemented commands. Knowledge references: FLOWERDOCS-LEARNINGS §12/§14/§23/§25/§26,
UXOPIAN-AI-LEARNINGS §A1–§A7.

## The 3-command gate

```bash
uxc doctor --ready                 # seconds, read-only: the layer checklist below
uxc doctor --sandbox               # ~60-120s, self-cleaning writes: can handlers ACTUALLY run?
uxc doctor --ai-smoke              # one real LLM call: does the provider API key work end-to-end?
```

Green on all three ⇒ install (`uxc mp install <slug>` / `uxc import <pkg>`); the install itself
then enforces `minClientVersion`, `supportedVersions`, and the receipt downgrade gate.
After installing: `uxc verify` (per-resource assertions) and `uxc doctor --dups` (duplicate scan).

## Layer 0 — platform (server-team territory; uxc can only DETECT, not fix)

| Check | Command | Failure meaning / fix |
|---|---|---|
| Base scope layer (§23) | `uxc doctor --ready` → `L0.platform` | `Script` / `OperationHandlerRegistration` / `GUIConfiguration` classes, `RegistrationOrder` tagclass, `acl-readonly` ACL missing ⇒ **blank scope**: scripts/handlers/guiconfigs cannot deploy (F00206/F00205/F00208). Fix: flower-docs-clm bundle `update` with the default-scope template — **never `delete`** (it WIPES the scope). |
| Server versions/dialects | `uxc doctor` → `dialect …` lines | FD version via `/core/actuator/info`; the AI gateway has **no version surface** — fingerprinted. A package's `supportedVersions` gates on this. |
| **GraalVM sandbox whitelist** | `uxc doctor --sandbox` | THE silent killer (fd.demo 2026-07-03): handlers run but die at their first `Java.type()` of a blocked class — no visible error anywhere. Verdicts: `SANDBOX_OK` · `NETWORK_BLOCKED` (+ the exact denied classes — server team must whitelist `java.net.*`, `javax.net.ssl.*`, `com.flower.docs.security.token.JWTTokenHelper`; jackson/java.util are usually default-allowed) · `NOT_FIRING` (propagation ~45s — retry `--wait 180` — or engine/registration broken). **Redeploying handlers never fixes a sandbox denial.** |
| AI gateway provisioned | `uxc doctor --ready` → `L0.ai` | 404 ⇒ Uxopian-AI is not provisioned for the scope (separate product layer, NOT in flower-templates). Server-side: the gateway route must use `provider: FlowerDocsProvider` (else every call 401s) and `FD_WS_URL` must point at Core (§A1). |
| LLM providers + keys | `uxc doctor --ready` → `L0.llm`, then `--ai-smoke` | **No provider (or empty key) makes every AI call HANG rather than error** (§A5) — the "wizard stuck on step 1" symptom. Install `uxopian-ai-default-providers-set` from the marketplace, then set the API key per instance (keys never travel in packages). `--ready` sees the provider list; only `--ai-smoke` proves the KEY. |
| Search index health | `uxc doctor --sandbox` reports `search indexed the probe doc after Ns` | Never-visible ⇒ index lag/rebuild (§25): uxc heals via direct-GET recovery, but run `uxc doctor --dups` before pushing handlers from a FRESH clone. |
| ARender | manual | Preview + AI annotation need ARender reachable and its Route configured. Not probeable via Core REST from the client — check a document preview in the GUI. |

## Layer 1 — the AI bridge (uxoai-flowerdocs)

Install the `uxoai-flowerdocs` marketplace package (12 `fd.script` docs, orders 930–941) BEFORE any
application module: `uxc mp install uxoai-flowerdocs`. **One manual step**: import its
`assets/infra/Gateway.xml` Route document (edit the `<URL>` to the gateway address as seen FROM the
FlowerDocs server) — Route-class documents are not uxc-managed. Gate: hard-reload the GUI → robot
button appears → chat answers (that last step also needs Layer 0's LLM key: `--ai-smoke` first).

## Layer 2 — per-instance config document

Modules with handlers read a singleton config doc (e.g. `CT_CONFIG`) with a `<Code>ConfigJson` tag
(`coreUrl`, `jwtSecret`, `aiGateway`, …) — created per instance, never shipped (no secrets in
packages). Check: `uxc get doc <CONFIG_ID>` shows the doc and the JSON parses. In-JVM read gotcha:
component services key on **`Id` objects, not strings** (§21) — a string silently returns nothing.

## Layer 3+4 — module install + seed data

```bash
uxc installed                      # what is already deployed here (receipts; upgrade/downgrade context)
uxc mp install <slug> [--target t] # or: uxc import <pkg.uxpkg> / uxc push --all --settle
uxc data push [--force]            # seed datasets (--force only to overwrite server-side edits)
uxc verify                         # post-deploy assertions (one live registration per handler, bytes, bands)
```

Corrections to the source runbook: taskclasses need **no special flag** — `fd.taskclass` is
`createOnly` (+ in-place update): push creates it once, then verifies; delete stays gated
(`rm --server --force` only; recreating breaks ANSWER dispatch permanently, §14). Existence check =
`uxc get fd.taskclass/<Id>` (path is `/rest/taskclass/{id}`, singular). Surfacing is part of
`uxc push` (no separate `surface` command) — surface on ONE umbrella profile (`["AllUsers"]`),
never `"*"` (§26 duplicate links). After handler pushes: the ~45s blind window (§12) — `--settle`
waits it out; events during the window are LOST.

## Symptom → first command

| Symptom | Run |
|---|---|
| "wizard stuck on first step" / AI call hangs | `uxc doctor --ready` (L0.llm) then `--ai-smoke` |
| handlers "do nothing", no errors anywhere | `uxc doctor --sandbox` |
| duplicated links / objects in the GUI | `uxc doctor --dups` (§25/§26) |
| pushes fail F00206/F00205/F00208 | `uxc doctor --ready` (blank scope, §23) |
| "what's installed here?" | `uxc installed` |
| drift/false conflicts after a migration | `uxc status --remote` (canonicalization §25; genuine vs echo drift) |
| prompt config vanished locally | old lossy user-list read — upgrade uxc (≥0.4 overlays; ≥0.5 admin list) |

Browser-level end-to-end (login → upload → preview → chat → handler effect) is deliberately NOT in
uxc (API surfaces only) — that is the package-embedded functional tests design
(PACKAGE-TESTS-DESIGN.md, ticket #27).
