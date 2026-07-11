// Single source of truth for the command surface — shared by the dispatcher (bin/uxc.mjs)
// and `uxc completion`, so shell completion never drifts from what actually dispatches.

export const COMMANDS = [
  'init', 'target', 'status', 'diff', 'pull', 'push', 'add', 'adopt', 'rm', 'destroy',
  'export', 'import', 'verify', 'data', 'refs', 'disable', 'enable', 'mp', 'scope',
  'ls', 'get', 'schema', 'search', 'doc', 'task', 'watch', 'recent', 'run', 'vars', 'test',
  'cache-clear', 'explain', 'doctor', 'installed', 'install-claude', 'completion', 'version', 'help',
];

/** Commands whose first arg is a subcommand, resolving to lib/commands/<cmd>-<sub>.mjs. */
export const TWO_WORD = ['target', 'data', 'doc', 'task', 'mp', 'scope'];
