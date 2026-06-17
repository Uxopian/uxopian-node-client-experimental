---
description: Export the uxopian package as a shareable .uxpkg archive
---

`uxc` = the `uxc` CLI on your PATH. Run from the package directory.

1. The package must be in sync first (export refuses dirty otherwise):
   ```
   uxc status --remote
   ```
   If drift exists, stop and run /ux-sync — only use `--allow-dirty` if the user explicitly
   says the drift is fine to ignore.
2. Export (`$ARGUMENTS` may carry `-o <file.uxpkg>`; default name derives from the manifest):
   ```
   uxc export $ARGUMENTS
   ```

What the archive contains: the whole package directory MINUS `.uxc/` (per-target state and
backups never travel) and with `ai.mcp` secret fields scrubbed. Credentials are never inside —
the importing side uses its own `~/.uxopian/targets.json`.

Report: the absolute .uxpkg path, its size, and the resource counts per kind (from the export
summary). Mention that `uxc import <file>.uxpkg --target <name>` installs it elsewhere and that
the manifest `requires` block (LLM providers, Java helpers) must be satisfied on the target
instance — list it if non-empty.
