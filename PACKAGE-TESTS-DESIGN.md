# Package-embedded functional tests — design (NOT implemented)

Status: **design for review** (2026-07-08). Companion ticket tracks the go/no-go.
Goal: a package ships its own functional tests — scripts that exercise the **deployed**
customization on a live target (upload → handler fires → clauses/tasks appear → prompt answers)
— runnable by anyone who installed the package: `uxc test`.

## 1. Why

- After `uxc import`, "did the whole pipeline actually work HERE?" is answered today by hand or
  by the ad-hoc `/ux-smoke` Claude skill. The knowledge of *what to test* belongs to the package
  author and should travel WITH the package (same philosophy as templates carrying mechanics).
- Receipts (DESIGN §19) say what is installed; package tests say whether it *works*.

## 2. Shape in the package

```
<package>/
  tests/
    10-ingest-e2e.test.mjs        # discovered by glob tests/*.test.mjs, run in filename order
    20-prompts-smoke.test.mjs
    30-worklists.test.mjs
```

- **Not registry resources** — never pushed to a server; they ride in the `.uxpkg` only.
  (Already true mechanically: export copies the whole tree minus `.uxc/.git/marketplace`;
  `untracked()` only walks `fd/ ai/ data/` so `tests/` is not flagged. Zero packaging changes.)
- A test file is a plain ES module:

```js
export default {
  name: 'ingest e2e',
  description: 'upload a contract -> ingest handler -> clauses + review task',
  requires: { resources: ['fd.handler/CtIngest_onCreate'], products: ['uxopian-ai'], llmProvider: true },
  timeoutMs: 180_000,
  async run(t) {
    const doc = await t.doc.create({ classId: 'CtContract', name: t.id('nda') + '.docx',
                                     file: 'fixtures/small-nda.docx' });     // auto-tracked
    const clauses = await t.waitFor(
      async () => (await t.core.search({ classId: 'CtClause', where: { SourceContractId: doc.id } })).found >= 3,
      { label: 'clauses extracted', timeoutMs: 120_000 });
    t.expect(clauses, 'ingest produced clauses');
    const { pass } = await t.runPrompt('ctSummary', { documentId: doc.id }, { expect: /summary|résumé/i });
    t.expect(pass, 'ctSummary answers');
  },
};
```

## 3. The `t` harness (the whole contract test authors get)

| Member | Behavior |
|---|---|
| `t.core / t.gateway / t.gui` | the same authenticated surfaces uxc uses |
| `t.pkg` | read-only manifest + registry view |
| `t.id(hint)` | mints `ZZTEST_<CODE>_<HINT>_<run8>` — namespaced, unique per run, **auto-tracked** |
| `t.doc.create({classId, name, tags, file})` | upsertDoc with a minted id; refuses ids outside the `ZZTEST_` namespace; returns the doc; tracked for cleanup |
| `t.track(kind, id)` / `t.cleanup(fn)` | register extra teardown (LIFO) |
| `t.waitFor(fn, {timeoutMs, everyMs, label})` | poll until truthy — the primitive for the ~45 s handler window and search lag (poll by DIRECT GET, LEARNINGS §25) |
| `t.runPrompt(idOrGoal, payload, {expect})` | wraps `lib/run.mjs` (SSE quirks, cold-start retry) |
| `t.expect(cond, msg)` / `t.fail(msg)` | assertions; failures collected with context |
| `t.log(msg)` | progress line in the runner output |

Safety by construction: the harness only deletes what it tracked; created fixtures are always
`ZZTEST_`-prefixed (visible, doctor-scannable); raw `t.core` writes remain possible but the
harness never cleans them — documented as "you own it".

## 4. Runner: `uxc test`

```
uxc test [name…] [--target t] [--keep] [--json] [--yes]
```

- Discovers `tests/*.test.mjs`, runs serially in filename order; per-test wall clock; default
  timeout 120 s.
- **Pre-flight per test** (`requires`): declared resources must exist on the server (`serverOf`
  non-null), declared products must be reachable, `llmProvider: true` needs a configured provider
  (`ai.llm` list non-empty). Unmet ⇒ **SKIP with the reason** (not a failure) — a package must be
  testable on FD-only targets.
- **Teardown always runs** (finally, LIFO). `--keep` skips it and prints the kept fixture ids.
  Failed teardown ⇒ loud warning listing survivors (all `ZZTEST_*`).
- Summary table (`pass/fail/skip · duration · detail`), exit 1 on any failure; `--json` for CI.
- **Safety gate**: runs only when the target sets `allowTests: true` in targets.json OR `--yes`
  is passed — functional tests create and delete real objects; never surprise a production scope.
- **Receipts tie-in**: on a fully green run, re-stamp the installation receipt with
  `testsPassedAt` + `testsPassed/total` (visible in `uxc installed`) — the receipt then answers
  both "what is installed" and "when did it last prove itself".

## 5. Versioning / dialects

Tests run through the same client, so dialect capabilities (DESIGN §18) apply transparently.
A test needing a capability declares `requires: { caps: { adminPromptList: true } }` ⇒ SKIP on
older servers instead of failing.

## 6. Explicitly out of scope (v1)

- Declarative JSON test format (the JS form + harness covers the need; revisit if non-developers
  author tests).
- Parallel test execution (serial keeps fixture interference impossible).
- Browser/GUI assertions (Puppeteer stays out of uxc — API surfaces only, as everywhere else).
- Scheduled/CI orchestration (CI can call `uxc test --json`; nothing more needed client-side).

## 7. Implementation sketch (when green-lit)

- `lib/testkit.mjs` (harness, ~250 lines) + `lib/commands/test.mjs` (runner, ~120 lines) —
  offline-unit-tested with mocked clients like the rest of the tree.
- 2–3 reference tests in `examples/ct-package/tests/` (ingest e2e, prompt smoke, worklist VF).
- Docs: DESIGN §20, kinds-agnostic; skill recipe update; `completion` picks up `test` from
  cli-meta automatically.

Estimated effort: one focused PR. Risks: none structural — the packaging layer already carries
`tests/` untouched; the only genuinely new machinery is the harness.
