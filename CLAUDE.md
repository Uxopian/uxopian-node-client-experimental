# uxc — uxopian-client

`uxc` is a zero-dependency Node CLI + library that builds, packages, and syncs **FlowerDocs +
Uxopian AI customizations** (packages, registry, hash-based bidirectional sync, marketplace).

## Read this FIRST before touching any FlowerDocs / Uxopian AI API

**`docs/FLOWERDOCS-LEARNINGS.md`** (FlowerDocs Core/GUI) and **`docs/UXOPIAN-AI-LEARNINGS.md`**
(the AI gateway) are the operational knowledge base — one file per product, `FAST2-LEARNINGS.md`
will follow when fast2 support lands. They hold every verified API
mechanic, error code, and hard-won gotcha (array bodies, id-in-path updates, cache-clear
protocol, handler version rotation, taskclass delete hazards, search eventual-consistency,
server dialects…). It is numbered (§1–§25+) and the code comments cite those sections.

Rules of engagement:
- **Never guess an API shape** — check the learnings; if a mechanic isn't recorded, verify it
  live on a throwaway `Zz*` object (see `uxc doctor --roundtrip` for the pattern), then
  **append what you proved** to the product's learnings file (same numbered style, with the
  date and the instance you verified on).
- The architecture contract lives in `DESIGN.md` (sections are cited from code) and the
  inter-module API in `lib/CONTRACTS.md`. Update them when behavior changes.
- Per-version server differences belong in `lib/dialects.mjs` (capability flags), NEVER as
  raw version checks inside adapters — see DESIGN §18.

## Working on the code

- Zero runtime dependencies; Node ≥ 18.17. Tests: `npm test` (offline — never require a server).
- Every behavior change ships with offline unit tests; live mechanics get verified against a
  demo instance first and recorded in the learnings.
- `lib/canonical.mjs` is load-bearing for sync (hash of the canonical form) — changes there
  re-hash every resource; add a normalize rule only for a verified echo difference.
- The Claude skill + slash commands live under `claude/` (installed by `uxc install-claude`);
  keep `claude/skills/uxopian-client/references/*.md` in step with kind/behavior changes.

## Layout

- `bin/uxc.mjs` — dispatcher · `lib/commands/*.mjs` — one file per command
- `lib/kinds/*.mjs` — one adapter per resource kind (the verified mechanics live here)
- `lib/sync.mjs` — the 3-way hash engine · `lib/dialects.mjs` — server-version capabilities
- `docs/` — the knowledge base (this is the canonical location; some external projects
  reach it via a symlink from the old `flowerdocs-ref` checkout)
- `examples/ct-package/` — the reference package used for live verification
