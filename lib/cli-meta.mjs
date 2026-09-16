// Single source of truth for the command surface — shared by the dispatcher (bin/uxc.mjs)
// and `uxc completion`, so shell completion never drifts from what actually dispatches.

export const COMMANDS = [
  'init', 'target', 'status', 'diff', 'pull', 'push', 'add', 'adopt', 'rm', 'destroy',
  'export', 'import', 'verify', 'data', 'refs', 'disable', 'enable', 'mp', 'scope', 'f2',
  'ls', 'get', 'schema', 'search', 'doc', 'task', 'watch', 'recent', 'run', 'versions', 'vars', 'test',
  'context', 'size',
  'cache-clear', 'explain', 'doctor', 'installed', 'install-claude', 'completion', 'version', 'help',
];

/** Commands whose first arg is a subcommand, resolving to lib/commands/<cmd>-<sub>.mjs. */
export const TWO_WORD = ['target', 'data', 'doc', 'task', 'mp', 'scope', 'f2'];

/**
 * Lock mode per command module (BACKLOG-AGENTIC #2). One audited place, because getting a command
 * into the wrong column is either a lost serialisation guarantee or a needless queue.
 *
 *   'write' — mutates the INSTANCE (or the shared checkout on the strength of what it read from
 *             the instance). Serialised across processes on the target.
 *   'read'  — talks to the instance read-only. NEVER waits; it only reports a writer holding the
 *             lock, so a surprising read explains itself.
 *   absent  — purely local (scaffolding, help, config): no lock, no contention report.
 *
 * Two-word commands are keyed by their module name ('data-push', 'target-add'). A command module
 * may export its own `lock`, including a function of its flags (see `uxc test --offline`).
 */
export const LOCK_MODES = {
  push: 'write', pull: 'write', rm: 'write', destroy: 'write', import: 'write', adopt: 'write',
  enable: 'write', disable: 'write', 'cache-clear': 'write', test: 'write',
  'data-push': 'write', 'data-pull': 'write', 'doc-create': 'write', 'doc-rm': 'write',
  'scope-create': 'write', 'scope-delete': 'write', 'task-answer': 'write',
  'mp-install': 'write', 'f2-run': 'write',

  status: 'read', diff: 'read', get: 'read', ls: 'read', schema: 'read', search: 'read',
  verify: 'read', refs: 'read', recent: 'read', installed: 'read', watch: 'read', doctor: 'read',
  'task-ls': 'read', 'f2-ls': 'read', 'scope-get': 'read', run: 'read', versions: 'read',
};

/** Commands whose writes open the handler blind window (~45 s) and must wait a prior one out. */
export const HANDLER_WINDOW_COMMANDS = new Set(['push', 'import', 'mp-install', 'destroy', 'rm']);
