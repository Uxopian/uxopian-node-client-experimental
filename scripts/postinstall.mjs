// npm lifecycle hook (postinstall + prepare): best-effort shell-completion setup.
//
// Goal: `npm install -g .` / `npm link` also wires up `uxc <TAB>`, with NO per-platform
// handling to maintain — npm already builds the cross-platform `uxc` bin shim; here we just
// drop a completion file when the shell supports it, and do nothing everywhere else.
//
// Contract: this NEVER fails the install. Any problem (no shell, no HOME, Windows, CI) exits 0.
// It is idempotent — if the completion file is already current it writes nothing and stays quiet,
// so the postinstall+prepare double-fire (and repeated installs) produce no noise.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

async function main() {
  if (process.env.CI || process.env.UXC_SKIP_COMPLETION) return; // leave CI / opted-out machines alone
  const shell = (process.env.SHELL || '').split('/').pop();
  if (shell !== 'bash' && shell !== 'zsh') return; // Windows / other: nothing to install, no complexity

  const { bashCompletion, completionArgs, bashCompletionInstallPath } =
    await import('../lib/commands/completion.mjs');

  if (shell === 'zsh') {
    // zsh auto-load wants an fpath/#compdef file; reusing the bash-compat script means a profile
    // line, which we won't write unasked. Just point the way.
    console.log('uxc: for zsh completion, add to ~/.zshrc:  source <(uxc completion zsh)');
    return;
  }

  const dest = bashCompletionInstallPath();
  const script = bashCompletion(completionArgs());
  if (existsSync(dest) && readFileSync(dest, 'utf8') === script) return; // already current — silent
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, script);
  console.log(`uxc: bash completion installed -> ${dest} (open a new shell to use it)`);
}

main().catch(() => { /* never break the install */ });
