---
description: Import a .uxpkg (or package dir) onto a target instance, with pre-flight collision review
---

`uxc` = the `uxc` CLI on your PATH.

`$ARGUMENTS` = `<pkg.uxpkg|dir> [--target name] [--code-remap old=new]`.

1. Confirm the target instance with the user if not explicit (`uxc target ls` shows them).
2. Run the import:
   ```
   uxc import $ARGUMENTS
   ```

How it behaves — and what you do at each phase:
- **Pre-flight**: every resource is checked against the live server BEFORE any write. If a
  collision list prints (same id exists with different content), STOP. Show the list to the
  user, `uxc diff` the important ones, and only re-run with `--force` after they approve —
  forcing overwrites live resources.
- **Ordered push**: resources deploy in dependency order, state committed per resource. A
  failure mid-import is resumable: fix the cause, then `uxc push --changed --target <name>`
  from the unpacked package dir.
- **Verify**: runs automatically at the end; report its summary.

`--code-remap old=new` is EXPERIMENTAL: it renames every owned identifier across all prefix
forms (registry-driven, token-boundary), then lints for residual old-prefix tokens and ABORTS
if any survive. If the lint aborts, show the residual list to the user — never patch around it
blindly; never `--force` past it.

Also check: the manifest `requires` block (llmProviders, helpers) — confirm the target instance
satisfies it (`uxc ls ai.llmconf --target <name>`), and warn about foreign occupants if the
import reports RegistrationOrder band conflicts.

Report: collision decisions made, per-kind created/updated counts, verify result, and any
follow-up needed (cache clear, handler settle window, unsatisfied requires).
