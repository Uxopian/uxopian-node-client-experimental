# Change request — make uxc canonicalization compatible with BOTH FD 2025 and FD 2026

**Goal:** one package that syncs cleanly against either FlowerDocs version (no forking).
**Where:** the `uxopian-client` repo (`lib/canonical.mjs`).
**How to use:** paste the "PROMPT" block below into a uxc-client session, or work from the detail here.

---

## Prompt (paste-ready)

```
Make uxc's canonicalization compatible with BOTH FlowerDocs 2025 and 2026, so one
package syncs cleanly against either version. Work in the uxopian-client repo.

CONTEXT
We migrated from FD 2025 (old IRIS, gone) to FD 2026 (fd.demo.uxopian.com, target
`fddemo`, scope IRIS). The same package DEPLOYS fine to both, but
`uxc status --remote --target fddemo` on examples/ct-package shows ~42 false
`collision`s. Root cause: FD 2026's REST echo is RICHER than FD 2025's, and
lib/canonical.mjs only normalizes the 2025 shape. Because canonicalize() runs on
BOTH the local file AND the server echo, stripping the 2026 extras is a NO-OP on
2025 → a single rule set makes one package hash-clean on both versions (no forking).

THE FD 2026 ECHO EXTRAS (verified live with `uxc diff` on target fddemo)
1. Empty NESTED arrays the echo includes but local omits: `descriptions:[]` (on
   tagReferences etc.), `allowedValues:[]` (tagclass), `nested:[]`/`context:[]`/
   `clauses:[]` (vfclass searches). cleanData currently strips only TOP-LEVEL empties.
2. Nested Java `type` discriminators, e.g. `type:"com.flower.docs.domain.tagclass.
   AllowedValue"` on allowedValues (same family as the answers[].type we already strip
   on taskclass; vfclass DTOs also use type discriminators — LEARNINGS §200).
3. `active:true` omitted by the echo (local writes active:true; echo drops the default).

TASK — update lib/canonical.mjs
- Strip empty arrays RECURSIVELY (any depth), not just top-level.
- Strip `type` fields whose value is a FlowerDocs FQCN (/^com\.flower\.docs\./) at any
  depth. CRITICAL: do NOT touch the tagclass TOP-LEVEL `type` (STRING/CHOICELIST/…)
  — it's load-bearing. The FQCN guard spares it (it's not an FQCN); add a test that
  proves tagclass `type` survives.
- Normalize `active`: treat active:true as the default (drop it → absent == true).
  KEEP active:false (a genuinely inactive class must stay visible).
- Keep every existing rule (volatile data strip, taskclass answers[].type, children
  round-trip, ai.prompt echo-overlay, script/guiconfig/handler files strip, etc.).

DO NOT MASK GENUINE DIFFS
On fddemo these are REAL content differences, not canonicalization — leave them as
diffs: handler `CtIngest_onCreate` (script content differs) and datasets `library` /
`playbook` (seed rows differ).

TESTS (offline)
Extend test/canonical.test.mjs: empty nested arrays stripped (local hash == echo hash);
nested FQCN `type` stripped; tagclass top-level `type` PRESERVED; active:true dropped
but active:false kept. Cover documentclass/tagclass/vfclass/taskclass echo shapes.
`npm test` must stay green.

LIVE VERIFICATION (FD 2026, target fddemo — creds in macOS login keychain)
Run uxc with creds inline (never printed):
  UXC_USER=aescaffre \
  UXC_PASSWORD="$(security find-generic-password -a aescaffre -s uxc-fddemo -w)" \
  node bin/uxc.mjs <cmd> --target fddemo --dir examples/ct-package
- `uxc doctor --roundtrip --target fddemo` stays green.
- `uxc status --remote --target fddemo --dir examples/ct-package`: the ~39 class/tag
  `collision`s should flip to `adopted`; only CtIngest_onCreate + library + playbook
  may remain.

BONUS (same live box, closes #12): verify fd.workflow + fd.acl write round-trip
(doctor --roundtrip covers acl; push a throwaway workflow referencing a real taskclass)
and folderclass; if they pass, flip DESIGN §7 #7/#8 from 🧪 to ✅.

SHIP: branch `feat/fd2026-canon`, PR describing the FD-2026 echo deltas + the
dual-version reasoning (with a ticket). Record the FD 2026 echo findings + the
now-verified GUI-cache JWT surface (doctor showed GET/DELETE 200) in
FLOWERDOCS-LEARNINGS.md.

Note: this re-hashes every resource, so recorded sync bases rebase automatically on
the next status/pull (expected; the ct bases are stale post-rebuild anyway).
```

---

## Why this works (dual-version reasoning)

`canonicalize()` is applied to **both** sides of every comparison — the local file and the
server echo. So a rule that removes an FD 2026 echo extra is a **no-op on FD 2025** (where the
extra isn't present) and a **normalizer on FD 2026** (where it is). Both sides therefore reduce
to the same canonical form on either server → identical hashes → one package, both versions.

The package **content** is already compatible (both versions accept the same write DTOs — proven:
the ct-package just deployed to FD 2026 and previously ran on FD 2025). The only gap is uxc's
hash/diff layer, which this change closes.

## Evidence captured on FD 2026 (target `fddemo`, 2026-07-03)

- `uxc doctor --target fddemo`: 9 checks, 0 failures. Core auth ✓, AI gateway ✓, GUI caches
  GET/DELETE 200 ✓, class LISTs: documentclass 34, folderclass 1, taskclass 25, vfclass 14,
  tagcategory 22, tagclass 214.
- `uxc status --remote` on examples/ct-package: 112 adopted, **42 collision**, 21 new (prompts,
  since deployed). Every collision diff was one of the three echo extras above.
- Sample diffs: `CtContract`/`CtAnnotation` (documentclass) → `+active:true` + nested
  `descriptions:[]`; `CtApplyRequest` (tagclass) → `allowedValues:[]` + AllowedValue `type`;
  `CtLibrary` (vfclass) → `+active:true` + nested `nested:[]`/`context:[]`/`clauses:[]`.

## The one real hazard

Do **not** strip `type` indiscriminately: `fd.tagclass` has a **top-level** `type`
(`STRING`/`TEXT`/`INT`/`CHOICELIST`/`DATE`/`BOOLEAN`/`ICON`) that is the tag's data type and MUST
be preserved. Only strip `type` values that are FlowerDocs FQCNs (`com.flower.docs.*`), which are
the nested serialization discriminators. Add a regression test that asserts tagclass `type`
survives canonicalization.

## Genuine (non-canonicalization) diffs to reconcile separately

- `fd.handler/CtIngest_onCreate` — ported script content differs from the package.
- `fd.dataset/library`, `fd.dataset/playbook` — ported seed rows differ from the package.

These are real; decide per-resource whether to `pull` (adopt the server version) or `push --force`
(overwrite with the package version). Not part of the canonicalization fix.
