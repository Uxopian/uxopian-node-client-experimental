# Portfolio Review — an Agentic Plan demo (`pfr`)

One question, a whole contract portfolio read in parallel, one executive brief. This package shows
what the **uxopian-ai 2026.0.0-ft5 Agentic Plan engine** is for, on any FlowerDocs scope that holds
contracts. Needs uxc ≥ 0.18.0 and an ft5 gateway.

```
pfrPortfolioReview (classId)                       pfrContractsBrief (docIds) — exposed as a chat tool
  find ── AGENT pfrFinderAgent                        each ── SUBPLAN pfrReviewOne, fan-out over docIds (8 at a time)
  │        read-only search tools → ["id", …]          │        read ── DIRECT_TOOL extractDocumentText (no LLM)
  └ review ─ SUBPLAN pfrContractsBrief ──────────►     │        facts ─ AGENT pfrFactsAgent → JSON fact sheet (gpt-4o-mini)
                                                       └ brief ─ AGENT pfrBriefAgent → markdown brief (gpt-4o, successCriteria)
```

`pfrAssistant` is an Application that grants the chat assistant read-only search tools, Excel/CSV
export, and the `pfrContractsBrief` plan as a tool.

## Try it

```bash
uxc push --all                                              # 3 prompts, 3 agents, 3 plans, 1 application
uxc run --plan pfrReviewOne --payload item=<documentId>     # one contract -> JSON fact sheet (~4 s)
uxc run --plan pfrPortfolioReview --payload classId=CtContract --timeout 600   # whole class -> brief
uxc destroy --confirm pfr                                   # remove everything again
```

Measured on fd.demo (IRIS, 15 `CtContract` documents, 2026-09-16): the whole-class review took
**36.8 s**. Running the 15 fact sheets 8 at a time took 20 s instead of 50 s one by one. From chat,
with `X-Application-Id: pfrAssistant`, "which Banque Horizon contracts need attention first?"
got a prioritized answer with document links in 22.8 s, and "export the table to Excel" returned a
download link. Admins can open **Plans** in the uxopian-ai admin panel to see the flow, click
**Run**, and follow each node in the **Runs** tab.

## Adapting it

- **Other document types:** edit `ai/prompts/pfrContractFacts.content.md` (the fact-sheet keys) and
  `pfrPortfolioBrief.content.md` (the brief sections). The plans don't change.
- **Models:** each agent runs on its objective prompt's `defaultLlmModel`. The map step is cheap
  (gpt-4o-mini) and the reduce is strong (gpt-4o).
- **Before pushing,** run `uxc verify`. It flags a node prompt variable that no dependency provides,
  which the engine would otherwise refuse at run time.
- **Rate limits:** lower `maxParallelElements` in `pfrContractsBrief.json` if the LLM provider
  throttles.

## Caveats

- **Triage, not verdicts:** risk levels are LLM triage and can shift between runs.
- **One failure fails the batch:** one unreadable document fails the whole fan-out (and the run).
- **Search cost:** the finder agent spends ~24 k input tokens per run on search results. In chat the
  assistant searches itself and calls `pfrContractsBrief` with the ids.

Mechanics and measurements: `docs/UXOPIAN-AI-LEARNINGS.md` §A13–§A16.
