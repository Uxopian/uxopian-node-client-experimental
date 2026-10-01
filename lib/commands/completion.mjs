// uxc completion [bash|zsh] — print a shell completion script.
//   Add to your shell:  source <(uxc completion bash)   (bash)
//                       source <(uxc completion zsh)    (zsh)
// The script is generated from the live command registry (lib/cli-meta.mjs), the two-word
// subcommand files on disk, and the kind registry — so it never drifts from what dispatches.
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, TWO_WORD, COMMAND_ALIASES, SUBCOMMAND_ALIASES } from '../cli-meta.mjs';
import { KINDS } from '../kinds/index.mjs';
import { fail } from '../output.mjs';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url)); // lib/commands

const GLOBAL_FLAGS = ['--target', '--json', '--human', '--dir', '--help'];

// Curated per-command flags (keyed by command, or "cmd sub" for two-word commands).
export const FLAGS = {
  init: ['--name', '--code', '--description', '--extension', '--depends-on', '--dep-code', '--kinds', '--product-dir', '--force'],
  status: ['--remote'],
  diff: ['--base', '--full'],
  pull: ['--all'],
  push: ['--changed', '--all', '--force', '--settle', '--recreate', '--revive', '--ignore-client-version', '--ignore-server-version', '--ignore-dependencies', '--yes-removals', '--keep-removed'],
  add: ['--order', '--fcm', '--from-file', '--goal', '--prompt', '--filter', '--index', '--objective', '--agent', '--provider'],
  adopt: ['--scan', '--kind', '--yes', '--external'],
  rm: ['--local', '--server', '--both', '--force'],
  destroy: ['--dry-run'],
  export: ['-o', '--allow-dirty'],
  import: ['--code-remap', '--force', '--expect-sha256', '--ignore-client-version', '--ignore-server-version', '--ignore-dependencies', '--var', '--var-file', '--report'],
  vars: ['--var', '--var-file'],
  ls: ['--mine', '--fields'],
  get: ['--fields', '--content', '--full'],
  schema: ['--tag'],
  search: ['--where', '--category', '--order', '--max', '--limit'],
  watch: ['--until', '--interval', '--timeout'],
  recent: ['--category', '--since', '--max', '--limit'],
  run: ['--payload', '--image', '--goal', '--plan', '--prompt-version', '--application', '--expect'],
  versions: ['--stats'],
  api: ['--surface', '--data', '--body', '--query', '--header', '--raw', '--timeout', '--verbose', '--yes'],
  doctor: ['--roundtrip', '--dups', '--ready', '--sandbox', '--wait', '--ai-smoke', '--write-probes'],
  verify: ['--full', '--offline', '--static'],
  'target add': ['--core', '--ai', '--gui', '--url', '--scope', '--user', '--password', '--default'],
  'task ls': ['--class', '--max', '--limit'],
  'doc create': ['--tag', '--file', '--id', '--name', '--acl'],
  'mp publish': ['--dry-run'],
  'mp ls': ['--category', '--audience', '--product', '--compat', '--fd', '--uxai', '--q', '--limit', '--max', '--offset'],
  'mp show': ['--version', '--catalog'],
  'mp pull': ['--version', '-o'],
  'mp install': ['--report', '--force', '--target', '--var', '--var-file', '--ignore-dependencies', '--yes-removals', '--keep-removed'],
  'mp deprecate': ['--version', '--yank', '--reactivate'],
  'mp login': ['--url', '--token', '--name', '--email'],
  'mp rm': ['--yes'],
  'scope create': ['--blank', '--from', '--description', '--lang', '--admin'],
  'scope delete': ['--yes'],
};

// Commands whose first positional arg is a kind / an id, for argument-aware completion.
const KIND_COMMANDS = ['add', 'adopt', 'ls', 'schema']; // get is handled separately (kind | doc)
const ID_COMMANDS = ['diff', 'pull', 'push', 'rm', 'refs', 'verify', 'disable', 'enable'];

/** Top-level alias spellings of a canonical command (`ls` -> ['list']). */
function aliasesTo(cmd) {
  return Object.entries(COMMAND_ALIASES).filter(([, c]) => c === cmd).map(([a]) => a);
}

/** FLAGS plus an arm per alias spelling (`list`, `mp get`, …) carrying its canonical's flags. */
export function flagTable() {
  const table = { ...FLAGS };
  for (const [a, c] of Object.entries(COMMAND_ALIASES)) if (FLAGS[c]) table[a] = FLAGS[c];
  for (const [fam, map] of Object.entries(SUBCOMMAND_ALIASES)) {
    for (const [a, c] of Object.entries(map)) if (FLAGS[`${fam} ${c}`]) table[`${fam} ${a}`] = FLAGS[`${fam} ${c}`];
  }
  return table;
}

/** Add the alias spellings (#99) to the command list and each family's subcommands. */
export function withAliases(commands, subcommands) {
  const subs = {};
  for (const [fam, list] of Object.entries(subcommands)) {
    const extra = Object.entries(SUBCOMMAND_ALIASES[fam] ?? {}).filter(([, c]) => list.includes(c)).map(([a]) => a);
    subs[fam] = [...new Set([...list, ...extra])].sort();
  }
  const cmds = [...commands, ...Object.keys(COMMAND_ALIASES).filter((a) => commands.includes(COMMAND_ALIASES[a]))];
  return { commands: cmds, subcommands: subs };
}

/** Two-word subcommands derived from lib/commands/<cmd>-<sub>.mjs files. */
export function subcommandsFrom(files, twoWord = TWO_WORD) {
  const out = {};
  for (const cmd of twoWord) {
    const prefix = `${cmd}-`;
    out[cmd] = files
      .filter((f) => f.endsWith('.mjs') && f.startsWith(prefix))
      .map((f) => f.slice(prefix.length, -4))
      .sort();
  }
  return out;
}

/** All kind tokens offered for completion (the real adapters, incl. ai.llm). */
export function kindList() {
  return [...new Set(Object.keys(KINDS))].sort();
}

/** Generate the bash completion script. Pure — all inputs passed in, returns a string. */
export function bashCompletion({ commands, twoWord, subcommands, kinds }) {
  const indent = '      ';
  const subArms = twoWord
    .map((cmd) => `${indent}${cmd}) COMPREPLY=( $(compgen -W '${subcommands[cmd].join(' ')}' -- "$cur") ); return;;`)
    .join('\n');
  const flagArms = Object.entries(flagTable())
    .map(([key, fl]) => `${indent}"${key}") __uxc_flags="$__uxc_flags ${fl.join(' ')}";;`)
    .join('\n');

  return `# bash completion for uxc — generated by \`uxc completion bash\`.
# Enable for this shell:        source <(uxc completion bash)
# Enable permanently:           echo 'source <(uxc completion bash)' >> ~/.bashrc

# Print the resource ids from the nearest registry.json (walks up from \$PWD).
_uxc_registry_ids() {
  local dir="\$PWD"
  while [ -n "\$dir" ] && [ "\$dir" != "/" ]; do
    if [ -f "\$dir/registry.json" ]; then
      grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]+"' "\$dir/registry.json" 2>/dev/null \\
        | sed -E 's/.*"([^"]+)"[[:space:]]*\$/\\1/'
      return
    fi
    dir="\$(dirname "\$dir")"
  done
}

_uxc() {
  local cur cmd sub key __uxc_flags
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"

  local TOPCMDS='${commands.join(' ')}'
  local KINDS='${kinds.join(' ')}'

  # ---- flags (anywhere the current word starts with '-') ----
  if [[ "\$cur" == -* ]]; then
    key="\$cmd"
    case "\$cmd" in
      ${twoWord.join('|')}) [ -n "\$sub" ] && key="\$cmd \$sub";;
    esac
    __uxc_flags='${GLOBAL_FLAGS.join(' ')}'
    case "\$key" in
${flagArms}
    esac
    COMPREPLY=( $(compgen -W "\$__uxc_flags" -- "\$cur") )
    return
  fi

  # ---- position 1: top-level command ----
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\$TOPCMDS" -- "\$cur") )
    return
  fi

  # ---- position 2: subcommand / kind / id ----
  if [ "\$COMP_CWORD" -eq 2 ]; then
    case "\$cmd" in
${subArms}
      ${KIND_COMMANDS.join('|')}) COMPREPLY=( $(compgen -W "\$KINDS" -- "\$cur") ); return;;
      ${KIND_COMMANDS.flatMap(aliasesTo).join('|') || '__uxc_none'}) COMPREPLY=( $(compgen -W "\$KINDS" -- "\$cur") ); return;;
      get) COMPREPLY=( $(compgen -W "\$KINDS doc" -- "\$cur") ); return;;
      ${ID_COMMANDS.join('|')}) COMPREPLY=( $(compgen -W "$(_uxc_registry_ids)" -- "\$cur") ); return;;
      completion) COMPREPLY=( $(compgen -W 'bash zsh' -- "\$cur") ); return;;
      explain) COMPREPLY=( $(compgen -W 'F00903 T00104 T00707' -- "\$cur") ); return;;
    esac
  fi
}
complete -F _uxc uxc
`;
}

/** zsh: load the bash-completion compatibility layer, then reuse the bash function. */
export function zshCompletion(args) {
  return `# zsh completion for uxc — generated by \`uxc completion zsh\`.
# Enable for this shell:        source <(uxc completion zsh)
# Enable permanently:           echo 'source <(uxc completion zsh)' >> ~/.zshrc
autoload -U +X bashcompinit && bashcompinit
${bashCompletion(args)}`;
}

/** Where bash-completion v2 auto-loads a per-command completion file (XDG user data dir). */
export function bashCompletionInstallPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'bash-completion', 'completions', 'uxc');
}

/** Assemble the generator inputs from the live registry + the two-word files on disk + kinds. */
export function completionArgs() {
  const { commands, subcommands } = withAliases(COMMANDS, subcommandsFrom(readdirSync(COMMANDS_DIR)));
  return { commands, twoWord: TWO_WORD, subcommands, kinds: kindList() };
}

export default {
  name: 'completion',
  summary: 'print a shell completion script (bash|zsh) — source <(uxc completion bash), or --install',
  help: 'uxc completion [bash|zsh] [--install]\n'
    + '  print:    source <(uxc completion bash)   (add to ~/.bashrc to persist)\n'
    + '  install:  uxc completion --install        (drop an auto-loaded file, no ~/.bashrc edit; bash only)',
  async run(ctx) {
    const shell = (ctx.args[0] ?? 'bash').toLowerCase();
    if (shell !== 'bash' && shell !== 'zsh') {
      fail(`unsupported shell "${shell}" — usage: uxc completion [bash|zsh] [--install]`);
    }
    const args = completionArgs();

    if (ctx.flags.install) {
      if (shell !== 'bash') {
        fail('--install supports bash only — for zsh add to ~/.zshrc: source <(uxc completion zsh)');
      }
      const dest = bashCompletionInstallPath();
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bashCompletion(args));
      ctx.out.line(`installed bash completion -> ${dest}`);
      ctx.out.note('open a new shell to use it (bash-completion auto-loads it; no ~/.bashrc edit).');
      ctx.out.note(`if bash-completion isn't installed, add instead: source ${dest}`);
      if (ctx.out.json) ctx.out.result({ installed: dest, shell });
      return;
    }

    console.log(shell === 'zsh' ? zshCompletion(args) : bashCompletion(args));
  },
};
