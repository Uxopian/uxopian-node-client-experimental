# docs/ — the uxc knowledge base

## FLOWERDOCS-LEARNINGS.md — verified API mechanics (READ BEFORE ANY API WORK)

The operational knowledge behind uxc: every FlowerDocs / Uxopian AI mechanic the client relies on
was **verified live** and recorded here first — numbered sections (§1–§25+) that the code comments
cite (`LEARNINGS §14`, `§25`…). It covers auth, CRUD shapes per kind, error codes (F00903,
T00108, T00707…), cache-clear discipline, handler version rotation, search eventual-consistency,
FD 2025→2026 differences, and the append discipline for new findings.

**Discipline**: never guess an API shape. If a mechanic is not recorded, prove it on a throwaway
`Zz*` object against a demo instance, then append the finding (same style: numbered section,
date, instance). This file is the single source of truth — the canonical copy lives HERE in the
uxc repo so every checkout ships it; some sibling projects still reference it through a symlink
at the old `flowerdocs-ref` location.

## The full FlowerDocs PDF (not in this repo)

Sections occasionally cite pages of the official FlowerDocs documentation PDF (~1050 pages,
~27 MB). It is **not** committed here — ask Uxopian for `flowerdocs-current.pdf` (uxodocs
export). If you have it locally, the token-cheap lookup protocol is: search your extracted page
text for the term, then read only the matching page range — never the whole PDF.
