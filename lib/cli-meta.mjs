// Single source of truth for the command surface — shared by the dispatcher (bin/uxc.mjs)
// and `uxc completion`, so shell completion never drifts from what actually dispatches.

export const COMMANDS = [
  'init', 'target', 'status', 'diff', 'pull', 'push', 'add', 'adopt', 'rm', 'destroy',
  'export', 'import', 'verify', 'data', 'refs', 'disable', 'enable', 'mp', 'scope', 'f2',
  'ls', 'get', 'schema', 'search', 'doc', 'task', 'watch', 'recent', 'run', 'versions', 'vars', 'test',
  'context', 'size', 'api',
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
 * may export its own `lock`, including a function of its flags (and positionals: `api`) (see `uxc test --offline`); a value
 * here may be such a function too.
 */
// --report (DESIGN §26) judges an upgrade and writes nothing: a read — it must neither queue behind
// a writer nor wait out a handler window it will never open
const writeUnlessReport = (flags) => (flags.report ? 'read' : 'write');

/** GET/HEAD/OPTIONS are reads; any other HTTP method may change the instance. */
export const isReadMethod = (method) => ['GET', 'HEAD', 'OPTIONS'].includes(String(method ?? '').toUpperCase());

/**
 * `uxc api <METHOD> <path>` (#96): the mode is a function of the METHOD (its first positional).
 * A write WITHOUT --yes is refused by the command before any request, so it takes no lock —
 * queuing behind a campaign only to be refused is the needless wait this table exists to prevent.
 * With --yes it is a 'write', which also makes the session apply the target pin for writes,
 * exactly as for push. A malformed method is a usage error: no lock.
 */
export function apiLockMode(flags = {}, args = []) {
  const method = args[0];
  if (!method || !/^[A-Za-z]+$/.test(method)) return 'none';
  if (isReadMethod(method)) return 'read';
  return flags.yes ? 'write' : 'none';
}

export const LOCK_MODES = {
  push: 'write', pull: 'write', rm: 'write', destroy: 'write', import: writeUnlessReport, adopt: 'write',
  enable: 'write', disable: 'write', 'cache-clear': 'write', test: 'write',
  'data-push': 'write', 'data-pull': 'write', 'doc-create': 'write', 'doc-rm': 'write',
  'scope-create': 'write', 'scope-delete': 'write', 'task-answer': 'write',
  'mp-install': writeUnlessReport, 'f2-run': 'write', api: apiLockMode,

  status: 'read', diff: 'read', get: 'read', ls: 'read', schema: 'read', search: 'read',
  verify: 'read', refs: 'read', recent: 'read', installed: 'read', watch: 'read', doctor: 'read',
  'task-ls': 'read', 'f2-ls': 'read', 'scope-get': 'read', run: 'read', versions: 'read',
};

/** Commands whose writes open the handler blind window (~45 s) and must wait a prior one out. */
export const HANDLER_WINDOW_COMMANDS = new Set(['push', 'import', 'mp-install', 'destroy', 'rm']);
