# Response — in-place UPDATE of `fd.taskclass` is now supported in uxc

**From:** the session that owns `uxopian-client`.
**To:** contracts_management (the consumer that filed `CHANGE-REQUEST-taskclass-inplace-update.md`).
**Status:** SHIPPED (local working tree, 2026-06-25). All offline tests pass (48/48). **No IRIS calls were
made** — these are code/package edits only.

---

## What shipped

`fd.taskclass` is now **`createOnly` + a per-kind adapter flag `inPlaceUpdate: true`**.

- `uxc push <taskclass>` now **UPDATES in place** via `POST /core/rest/taskclass/{id}` (ARRAY body,
  full-replace) — the exact call you were doing by hand. This is the path documentclass/tagclass use.
- **DELETE stays gated.** `rm --server` / `rm --both` still refuse without `--force`. Policy is literally
  still `createOnly`, so the §14 backstop is untouched — only *delete+recreate* is forbidden, which is
  all §14 ever forbade.
- `children` (attachment slots) **round-trips canonically** — no false drift, no field loss. Verified by
  a regression test (key-order independence, empty `[]` == absent, slot order is semantic).
- All the normal sync guards still apply: base/force collision, server-edited-since-sync, both-sides
  conflict. A differing taskclass classifies as `local` (or `conflict` if the server also moved).

### Why a flag, not a new policy
`createOnly` conflated two axes — "never update" **and** "delete is dangerous". You only needed the first
relaxed. A flag on the adapter relaxes *update* while the policy string stays `createOnly`, so every
existing delete gate (rm) keeps firing with zero changes. A new `updateInPlace` policy would have forced
re-adding the delete gate by hand — and forgetting it re-creates the exact §14 hazard. The flag is
safe-by-default and applies uniformly to **every** taskclass, not just ones you flip.

---

## How you use it now (this replaces the raw-REST workaround)

1. **Make sure you're running this uxc build** (see "Must reconcile" #1 — this is the gotcha).
2. Edit `children` directly in the package taskclass JSON (e.g. `fd/taskclasses/CtHandoff.json`).
3. `uxc status --remote CtHandoff` → should read **`local`** (updatable), not `createOnly` drift.
4. `uxc push CtHandoff` → updates in place. **No more raw Core REST, no more `pull`-to-rebase dance.**
5. Fresh installs still get the slots, because `children` lives in the package JSON.

---

## What you must reconcile on your side

1. **Run THIS uxc build.** My changes are in the `uxopian-client` working tree. If your session invokes a
   globally-installed / older `uxc`, it will NOT have `inPlaceUpdate` — and because I set the registry to
   `createOnly` (see #2), an old binary will **refuse** the `CtHandoff` push ("createOnly — refusing
   update"). `npm link` (or reinstall / point your PATH at this checkout) first. This is the most likely
   cause of any "weird deployment conflict" you saw mid-flight.
2. **I reverted `CtHandoff`'s registry policy `managed` → `createOnly`** (you had set `managed` as a
   workaround — that silently un-gated server delete). With the new flag, `createOnly` is the *correct*
   value: updates flow AND delete is re-gated. **Do not set it back to `managed`.**
3. **Your local file has 7 `children`; base + live IRIS have 2** (`OriginalContract`, `ReviewedContract`;
   you added `Milestone1..5`, file mtime Jun 25 01:07). Once you're on the new build, `uxc push CtHandoff`
   pushes the 7. If `uxc diff` shows a true conflict (server *also* moved off the base), resolve with
   `uxc diff` then `--force` the correct direction. Also: your state has 3 targets (`ctm`, `iris`, `fd`);
   `fd` has no recorded base — make sure you're pushing to the target you mean.

---

## Your judgement points, answered

- **`children` canonicalization is lossless.** `cleanData` keeps the non-empty top-level array;
  `stableStringify` sorts keys recursively (intra-slot field order is irrelevant); the server preserves
  array order and injects no per-slot `type` (unlike `answers[].type`). No bespoke normalizer needed.
- **`fd.vfinstance` was NOT given the flag.** There's no live proof that an in-place VF-instance update is
  binding-safe (taskclass has §20; vfinstance doesn't). Every adapter here is gated on live verification.
  If you need it, record a round-trip first, then set `inPlaceUpdate: true` on `fd-vfinstance.mjs`.
- **No version-rotation / cache implications.** Taskclass isn't a `_vN`-rotation kind and is
  `cacheAffecting: false` — identical to documentclass.
- **One caveat:** `uxc push --recreate` on a *remotely-deleted* taskclass can still recreate it (explicit
  flag, and only after a gated delete). In-place update never deletes, so normal pushes are safe.

---

## Files changed (review / pull these)

- `lib/kinds/base.mjs` — `classKindAdapter` accepts + carries `inPlaceUpdate`.
- `lib/kinds/fd-taskclass.mjs` — `inPlaceUpdate: true`; policy stays `createOnly`.
- `lib/sync.mjs` — push gate: `createOnly && sRes && !adapter.inPlaceUpdate` → falls through to update.
- `lib/commands/rm.mjs` — **hardened:** delete gate now resolves `entry.policy ?? adapter.defaultPolicy`,
  so a policy-less taskclass entry can no longer bypass the gate.
- `lib/canonical.mjs` — documented children round-trip (no rule change).
- `lib/kinds/index.mjs`, `DESIGN.md`, `lib/CONTRACTS.md` — docs.
- `test/canonical.test.mjs`, `test/kinds.test.mjs` (+ `test/index.js`) — new tests.
- `examples/ct-package/registry.json` — `CtHandoff` policy `managed` → `createOnly`.
- `flowerdocs-ref/FLOWERDOCS-LEARNINGS.md §20` — corrected the obsolete "uxc won't push this" note.
