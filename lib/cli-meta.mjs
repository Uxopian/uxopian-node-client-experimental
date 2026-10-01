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

/** FlowerDocs searches are POSTs (a query body, no side effect): `/rest/documents/search`,
 *  `/rest/tasks/search`, `/rest/virtualFolder/search`… — a POST whose path ENDS in `/rest/<x>/search`
 *  is a read. Anything else that is not GET/HEAD/OPTIONS stays a write. */
const SEARCH_PATH_RE = /^(?:\/[A-Za-z0-9._~-]+)*\/rest\/[A-Za-z]+\/search\/?$/;
/** The PATH the server will route: query and fragment dropped, dot segments resolved, and a full
 *  URL reduced to its path — a `?x=/rest/documents/search` or `#…/search` suffix must never make a
 *  `POST /rest/documents` (a create) look like a search. Encoded slashes are left encoded. */
const routedPath = (path) => {
  try { return new URL(String(path ?? ''), 'http://uxc.invalid').pathname; } catch { return ''; }
};
export const isReadCall = (method, path) => isReadMethod(method)
  || (String(method ?? '').toUpperCase() === 'POST' && SEARCH_PATH_RE.test(routedPath(path)));

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
  if (isReadCall(method, args[1])) return 'read';
  return flags.yes ? 'write' : 'none';
}

/**
 * `uxc doctor` (#110): the default gauntlet is READ-ONLY. Its probes that change the instance —
 * --write-probes (DELETE /gui/rest/caches), --roundtrip / --sandbox / --ai-smoke (throwaway Zz*
 * objects created then removed) — make it a write, so they serialise and an unpinned package's
 * first contact with the global default is refused like any other write (DESIGN §25.5).
 */
export const doctorLockMode = (flags = {}) => (
  ['write-probes', 'roundtrip', 'sandbox', 'ai-smoke'].some((f) => flags[f] !== undefined && flags[f] !== false) ? 'write' : 'read');

export const LOCK_MODES = {
  push: 'write', pull: 'write', rm: 'write', destroy: 'write', import: writeUnlessReport, adopt: 'write',
  enable: 'write', disable: 'write', 'cache-clear': 'write', test: 'write',
  'data-push': 'write', 'data-pull': 'write', 'doc-create': 'write', 'doc-rm': 'write',
  'scope-create': 'write', 'scope-delete': 'write', 'task-answer': 'write',
  'mp-install': writeUnlessReport, 'f2-run': 'write', api: apiLockMode,

  status: 'read', diff: 'read', get: 'read', ls: 'read', schema: 'read', search: 'read',
  verify: 'read', refs: 'read', recent: 'read', installed: 'read', watch: 'read', doctor: doctorLockMode,
  'task-ls': 'read', 'f2-ls': 'read', 'scope-get': 'read', run: 'read', versions: 'read',
};

/** Commands whose writes open the handler blind window (~45 s) and must wait a prior one out. */
export const HANDLER_WINDOW_COMMANDS = new Set(['push', 'import', 'mp-install', 'destroy', 'rm']);

// ---------------------------------------------------------------------------------------------
// Verb + flag consistency (#99, BACKLOG-AGENTIC §27.6). The table is in lib/CONTRACTS.md
// ("CLI verbs and flags"); test/cli-consistency.test.mjs lints every command module against it.
// ALIASES ONLY — never renames: the old spelling keeps working identically, and an alias is
// resolved to the canonical module BEFORE the session opens, so the lock mode and agent.forbid
// ("scope delete", "mp show …") see exactly one name whatever the caller typed.
// ---------------------------------------------------------------------------------------------

/** The canonical subcommand verbs and what each one means. New subcommands pick from here. */
export const VERBS = {
  ls: 'list many (read-only)',
  get: 'read one (read-only)',
  create: 'make a new server object',
  add: 'register/scaffold locally (config, package file)',
  rm: 'delete (gated: see DESTRUCTIVE)',
  push: 'local -> server',
  pull: 'server -> local',
  run: 'execute/start something on the server',
};

/**
 * Subcommand verbs outside VERBS, each with its reason. `alias` names the canonical spelling
 * offered for it (it must exist in SUBCOMMAND_ALIASES) when the verb means a canonical one.
 */
export const VERB_EXCEPTIONS = {
  show: { reason: 'mp show predates the table; it reads one addon', alias: 'get' },
  delete: { reason: 'scope delete predates the table; it deletes a scope', alias: 'rm' },
  use: { reason: 'target use selects the default target — no canonical verb means "select"' },
  answer: { reason: 'task answer is a domain action (FlowerDocs task ANSWER)' },
  init: { reason: 'scaffold a config file, same verb as top-level `uxc init`' },
  login: { reason: 'save credentials — no canonical verb' },
  publish: { reason: 'marketplace release (upsert + upload + finalize), not a plain push' },
  install: { reason: 'download + verify + deploy pipeline, not a plain pull' },
  deprecate: { reason: 'lifecycle transition of an addon version' },
  versions: { reason: 'noun listing, same as top-level `uxc versions`' },
  categories: { reason: 'noun listing of the marketplace taxonomy' },
};

/** Top-level command aliases: alias -> canonical command. */
export const COMMAND_ALIASES = { list: 'ls' };

/** Two-word subcommand aliases per family: alias -> canonical subcommand. */
export const SUBCOMMAND_ALIASES = {
  target: { list: 'ls' },
  task: { list: 'ls' },
  f2: { list: 'ls' },
  mp: { list: 'ls', get: 'show' },
  scope: { rm: 'delete' },
};

/**
 * Flag aliases per command module: alias -> canonical flag, applied by the dispatcher before the
 * session. Only where the two spellings mean the same thing ("at most N items back").
 */
export const FLAG_ALIASES = {
  search: { limit: 'max' },
  recent: { limit: 'max' },
  'task-ls': { limit: 'max' },
  'mp-ls': { max: 'limit' },
  verify: { static: 'offline' },
};

/**
 * Older in-module alternate spellings (read directly by the module, e.g. `flags.limit ??
 * flags['page-size']`). Recorded so the lint knows they are deliberate; do not add new ones —
 * use FLAG_ALIASES.
 */
export const LEGACY_FLAG_ALIASES = {
  'mp-ls': { 'page-size': 'limit', fd: 'compat', uxai: 'compat' },
  'mp-publish': { notes: 'changelog' },
  'mp-pull': { output: 'o' },
  export: { output: 'o' },
  add: { classId: 'class' },
  init: { families: 'kinds' },
};

/**
 * Destructive / irreversible commands and the gate each one requires. `flags` = the gate flags
 * the help must show and the module must read; `gate` = the documented rule.
 */
export const DESTRUCTIVE = {
  rm: { flags: ['local', 'server', 'both', 'force'], gate: 'a side must be chosen (--local|--server|--both); createOnly/external kinds also need --force' },
  destroy: { flags: ['confirm', 'dry-run'], gate: '--confirm <project-code> (typed, stronger than --yes); --dry-run prints the kill list' },
  'doc-rm': { flags: [], gate: 'explicit document ids only — no selector, pattern or bulk form' },
  'scope-delete': { flags: ['yes'], gate: '--yes' },
  'mp-rm': { flags: ['yes'], gate: '--yes (soft-delete: archives the listing, versions kept)' },
  'data-push': { flags: ['prune', 'yes'], gate: 'row deletes only via --prune --yes (--prune alone prints the kill list)' },
};

/** Resolve a typed `cmd [sub]` to its canonical spelling: -> { cmd, sub } (sub may be undefined). */
export function resolveAliases(cmd, sub) {
  // own-property lookups only: `uxc constructor` must stay an unknown command, not a prototype hit
  const own = (map, k) => (map && k !== undefined && Object.hasOwn(map, k) ? map[k] : undefined);
  const c = own(COMMAND_ALIASES, cmd) ?? cmd;
  const s = own(own(SUBCOMMAND_ALIASES, c), sub) ?? sub;
  return { cmd: c, sub: s };
}

/**
 * Fold flag aliases of `modName` into their canonical flag (mutates + returns flags). Giving both
 * spellings with different values is an error — silently picking one would hide a typo.
 */
export function applyFlagAliases(modName, flags) {
  for (const [alias, canon] of Object.entries(FLAG_ALIASES[modName] ?? {})) {
    if (flags[alias] === undefined) continue;
    if (flags[canon] !== undefined && flags[canon] !== flags[alias]) {
      throw new Error(`--${alias} is an alias of --${canon}; give one of them, not both`);
    }
    flags[canon] = flags[alias];
    delete flags[alias];
  }
  // the older in-module spellings are read by the module itself (not rewritten), but giving one
  // AND its canonical flag with different values is the same conflict (#103: mp ls --max 10 --page-size 20)
  for (const [legacy, canon] of Object.entries(LEGACY_FLAG_ALIASES[modName] ?? {})) {
    if (flags[legacy] === undefined || flags[canon] === undefined || flags[legacy] === flags[canon]) continue;
    const also = Object.entries(FLAG_ALIASES[modName] ?? {}).filter(([, c]) => c === canon).map(([a]) => ` (= --${a})`).join('');
    throw new Error(`--${legacy} is an older spelling of --${canon}${also}; give one of them, not both`);
  }
  return flags;
}

/** The alias spellings of a canonical module name, for help: 'mp-show' -> ['mp get']. */
export function aliasesOf(modName) {
  const out = [];
  for (const [a, c] of Object.entries(COMMAND_ALIASES)) if (c === modName) out.push(a);
  for (const [fam, map] of Object.entries(SUBCOMMAND_ALIASES)) {
    for (const [a, c] of Object.entries(map)) if (`${fam}-${c}` === modName) out.push(`${fam} ${a}`);
  }
  const flags = Object.entries(FLAG_ALIASES[modName] ?? {}).map(([a, c]) => `--${a} = --${c}`);
  return { commands: out, flags };
}

// ---------------------------------------------------------------------------------------------
// Unknown flags (#110). The parser accepts any --x, so a flag a command does not read used to be
// dropped in silence (`uxc doctor --offline` ran the full online gauntlet). The known set is the
// one the #99 lint already trusts: the flags the module's source reads (same introspectable forms
// as test/cli-consistency.test.mjs), the flags its help names, its aliases, and the global flags.
// Helper modules (lib/*.mjs, lib/kinds/*.mjs) also read flags handed to them (`uxc add` passes
// every flag to a kind template), so before warning those are consulted too. The verdict is a
// WARNING on stderr, never a refusal: no per-command set is provably complete, and a command that
// works today with a valid flag must keep working.
// ---------------------------------------------------------------------------------------------

/** Flags the dispatcher / session / output read for EVERY command. */
export const GLOBAL_FLAGS = new Set(['help', 'dir', 'json', 'human', 'target', 'no-lock', 'lock-timeout', 'allow-target-mismatch']);

/** The flags a source file reads — the introspectable forms used across lib/. */
export function flagsReadBy(src) {
  const s = new Set();
  for (const re of [
    /\bflags\.([a-zA-Z][\w]*)/g,
    /\bflags\[['"]([a-zA-Z0-9-]+)['"]\]/g,
    /reclaim\(\s*flags\s*,\s*\w+\s*,\s*'([a-z0-9-]+)'/g,
    /collectFlag\('([a-z0-9-]+)'\)/g,
    /collectRepeatedFlag\('([a-z0-9-]+)'\)/g,
  ]) for (const m of String(src ?? '').matchAll(re)) s.add(m[1]);
  return s;
}

/** The --flags a help/summary text names (`--ignore-*` names a prefix). */
export function flagsInHelp(text) {
  const names = new Set();
  const prefixes = [];
  for (const m of String(text ?? '').matchAll(/--([a-zA-Z][\w-]*)(\*)?/g)) {
    if (m[2] || m[1].endsWith('-')) prefixes.push(m[1].replace(/-?$/, '-'));
    else names.add(m[1]);
  }
  return { names, prefixes };
}

/**
 * The given flags `modName` does not know. `srcFlags` = what its source reads; `helperFlags`
 * (optional, lazy) = a function returning what the helper modules read. -> ['offline', …]
 */
export function unknownFlags(modName, mod, flags, { srcFlags = new Set(), helperFlags = null } = {}) {
  const help = flagsInHelp(`${mod?.summary ?? ''} ${mod?.help ?? ''}`);
  const aliases = new Set([
    ...Object.keys(FLAG_ALIASES[modName] ?? {}), ...Object.values(FLAG_ALIASES[modName] ?? {}),
    ...Object.keys(LEGACY_FLAG_ALIASES[modName] ?? {}),
  ]);
  const declared = new Set(Array.isArray(mod?.flags) ? mod.flags : []);
  let unknown = Object.keys(flags ?? {}).filter((f) => !(GLOBAL_FLAGS.has(f) || srcFlags.has(f) || help.names.has(f)
    || aliases.has(f) || declared.has(f) || help.prefixes.some((p) => f.startsWith(p))));
  if (unknown.length && typeof helperFlags === 'function') {
    const h = helperFlags();
    unknown = unknown.filter((f) => !h.has(f));
  }
  return unknown;
}
