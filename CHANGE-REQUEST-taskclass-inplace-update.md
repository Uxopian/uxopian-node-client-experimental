# Change request — allow in-place UPDATE of `fd.taskclass` (keep delete gated)

**From:** contracts_management session (outside-in consumer of uxc).
**To:** the session that owns `uxopian-client`.
**Status:** request only — I did NOT edit uxc. Please implement using YOUR knowledge of uxc's
architecture (policies, canon/hash, rm gating, version rotation, status reporting). Treat my
proposed diff below as a starting hypothesis, not a spec — override it where your design knows better.

## The need
`fd.taskclass` is `defaultPolicy: 'createOnly'`. On push, `sync.mjs` refuses any update when the
server object differs ("createOnly — refusing update; schema change needs a NEW id"). That rule
exists to honor learnings §14 (**delete+recreate a taskclass → ANSWER dispatch breaks permanently**).

But I now need to **add/maintain task attachment slots** on an EXISTING taskclass. Attachment slots
live in the taskclass **`children`** array (see new FLOWERDOCS-LEARNINGS §20 — this corrects the old
§13 "REST can't declare attachments" note, which had the wrong field name). Because uxc won't update
a taskclass, I had to apply `children` to the live `CtHandoff` via **raw Core REST**, out of band —
which defeats the package being the source of truth.

## What I verified live (IRIS, 2026-06-24/25)
- **In-place taskclass UPDATE is binding-SAFE.** `POST /core/rest/taskclass/{id}` (id in path, ARRAY
  body, full-replace — same shape as documentclass) updated `CtHandoff`'s `children` and **did NOT
  recreate** the class. The `CtHandoff_onAnswer` ANSWER handler (the baton) kept firing. The §14
  danger is specifically **DELETE + recreate**, NOT an in-place same-id POST update.
- So `createOnly` currently **conflates two different operations**: in-place update (safe) and
  delete+recreate (dangerous). Only the latter should be forbidden.
- The mechanics already exist: `classKindAdapter.update()` (base.mjs) does `POST /{restPath}/{id}`
  in-place — exactly what `fd.documentclass` (policy `managed`) uses and what I did by hand.
- `children` round-trips: after the raw-REST update I ran `uxc pull CtHandoff` and it `rebased`
  cleanly (165 insync), so canon/hash appears to include `children` — **please confirm** canonicalization
  is stable for `children` (ordering, the nested `Tags`/`displayNames`) so status won't show false drift.

## Proposed minimal change (hypothesis — defer to your design)
1. `lib/kinds/base.mjs` → `classKindAdapter({... , inPlaceUpdate = false})`; carry `inPlaceUpdate`
   onto the returned adapter object (it's currently a fixed destructure that drops unknown props).
2. `lib/kinds/fd-taskclass.mjs` → pass `inPlaceUpdate: true`. **Keep `defaultPolicy: 'createOnly'`**
   so `rm` stays gated (rm.mjs gates on `createOnly`/`external`; delete must remain dangerous).
3. `lib/sync.mjs` ~line 358 → `if (policy === 'createOnly' && sRes && !adapter.inPlaceUpdate)` so the
   taskclass falls through to the normal `adapter.update` (in-place POST `/{id}`) path, which already
   has the base/force collision + conflict guards.
4. Mirror the same `inPlaceUpdate` exception in the **status-reporting** path (lib/sync.mjs ~85–130)
   so a differing taskclass reports as `local` (updatable) instead of createOnly drift.

## Points for your judgement (you know uxc better than I do)
- Is a per-kind `inPlaceUpdate` flag the right primitive, or would a distinct policy
  (e.g. `updateInPlace` / `managedNoDelete`) read better and compose with the status/rm/diff paths?
- Should `fd.vfinstance` (also `createOnly`) get the same treatment, or is it genuinely create-only?
- Confirm `children` canonicalization is lossless (the attachment slot fields:
  `classId,id,category,displayNames[],multivalued,readonly,required,technical,order`, plus optional
  `Tags.tags[]`) so no false drift / no silent field loss on update.
- Any version-rotation / cache-clear implications for taskclass updates I'm not aware of.

## Current state to reconcile after you ship this
- Live `CtHandoff` already has 2 `children` slots (`OriginalContract`, `ReviewedContract`) applied via
  raw REST; package `examples/ct-package/fd/taskclasses/CtHandoff.json` matches; base is rebased
  (insync). Once uxc supports the update, no migration is needed — a future `children` edit should
  just push cleanly.
