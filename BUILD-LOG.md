# uxopian-client — build log

Initial build **COMPLETE** (2026-06-12). This file records how v1 was built and verified; for
what the tool *is*, read README.md → DESIGN.md.

## How it was built

1. **Research** — 5 parallel researchers mined: the Ct deploy scripts (`contracts_management/
   demo/ct/`), uxopian-ai controller source (prompt/goal/mcp/llm schemas + admin API), IRIS
   session memory, the FlowerDocs PDF (native CLM template transport, pp.139–155; class REST
   pp.865–912), and a live read-only probe. Decisive findings: the Core JWT authenticates ALL
   THREE surfaces (gateway incl. admin, and `/gui/rest/caches`) → no Puppeteer anywhere; LIST
   endpoints exist for all five class types + tagcategory.
2. **Design** — DESIGN.md v1, then a 3-lens adversarial review (DX, sync correctness, token
   economy): 26 findings, 2 blockers (handler `_vN` duplicate-survivor scenarios; surfacing
   bootstrap circularity), all folded into DESIGN.md v2.
3. **Implementation** — hand-written foundation (http/auth, canonical, naming, registry/state,
   output, explain, dispatcher, adapter interface) + `lib/CONTRACTS.md` pinning inter-module
   APIs, then a 10-agent parallel fleet over disjoint files (8 lost to a session limit mid-run;
   re-scoped completion fleet finished them — finished files persist, so retries only re-run
   what's missing).
4. **Live verification on IRIS** — all green:
   - `doctor` 13/13 incl. `--roundtrip` push-echo on Zz* throwaways for 5 kinds.
   - **Ct module bundled**: `adopt --scan` found all 111 candidates (54 tagclasses, 13
     tagcategories, 5 classes, 4 taskclasses [2 burned ones dropped from the package], 3
     vfclasses, 5 handler logicals correctly derived from `_vN` regs, 2 scripts, 7 guiconfigs,
     7 surfacing entries, 14 prompts, 3 datasets) + 3 vfinstances adopted by id → **112
     resources, `status --remote` clean, `verify` 123 checks 0 failures, exported
     `examples/ct-package/ct-1.0.0.uxpkg`** (144 files). Strictly read-only on Ct*.
   - Write paths on Zz* scratch package: create→push→edit→diff→push→server-side-edit→status
     `server`→pull; createOnly drift refusal; external delete refusal; tombstone exclusion;
     documentclass local-deletion-wins (removed tagReference stayed removed); `destroy` teardown;
     instance left clean.
   - Round-trip fixes discovered live and encoded in `lib/canonical.mjs` + `lib/explain.mjs` +
     learnings §18: F00208 (class create needs data.ACL), F00206 (class not-found = 500, not
     404), echoes omit empty arrays/empty data, prompt role lowercased, temperature → string,
     taskclass `answers[].type` injected.
5. **Claude integration** — skill `uxopian-client` (+ references/kinds|policies|errors|recipes)
   and slash commands `/ux-status /ux-sync /ux-new /ux-push /ux-export /ux-import /ux-smoke`,
   installed via `uxc install-claude` (symlinks; live-verified in session).

## State

- 28/28 unit tests; doctor 13/13; ct-package 112 insync remote; verify 0 failures.
- Repo is git-initialized, **no commits made** — the user commits/pushes (GitHub: Uxopian/uxopian-node-client-experimental).
- Targets file: `~/.uxopian/targets.json` has `iris` (default).

## Open / future (v1.1 candidates)

- `import --code-remap` is implemented (registry-driven map + token-boundary replace + residual
  lint that aborts) but flagged **experimental** — exercise on a real cross-code import before
  trusting; the magic VF bean-id derivations and handler-minted runtime ids are covered, free-text
  prose mentioning the code is not.
- `fd.workflow` / `fd.acl` are read-only (write shapes unverified — probe before enabling).
- `uxc mv <id> <newId>` (rename + reference rewrite) designed but not implemented; `uxc refs` +
  `verify`'s cross-reference lint cover the detection half.
- Dataset rows with `content: true` fetch file bytes — code path exists, untested against a
  binary-heavy dataset.
- A `--clm-template` export emitter (FlowerDocs-native XML template) is sketched in DESIGN §6.
