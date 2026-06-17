#!/usr/bin/env node
// uxc — build, package, and sync FlowerDocs + Uxopian AI customizations.
// Dispatcher: commands live in lib/commands/<name>.mjs and export { name, summary, help, run(ctx) }.
// Two-word commands (doc create, data pull, task ls, target add) resolve to lib/commands/<a>-<b>.mjs.
import { resolveTarget } from '../lib/config.mjs';
import { createClients } from '../lib/http.mjs';
import { findPackageDir } from '../lib/config.mjs';
import { openPackage } from '../lib/registry.mjs';
import { out, fail } from '../lib/output.mjs';

const COMMANDS = [
  'init', 'target', 'status', 'diff', 'pull', 'push', 'add', 'adopt', 'rm', 'destroy',
  'export', 'import', 'verify', 'data', 'refs', 'disable', 'enable', 'mp', 'scope',
  'ls', 'get', 'schema', 'search', 'doc', 'task', 'watch', 'recent', 'run',
  'cache-clear', 'explain', 'doctor', 'install-claude', 'help',
];
const TWO_WORD = new Set(['target', 'data', 'doc', 'task', 'mp', 'scope']);

function parseArgv(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else args.push(a);
  }
  return { args, flags };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const { default: help } = await import('../lib/commands/help.mjs');
    return help.run(makeCtx(parseArgv(rest)));
  }
  if (!COMMANDS.includes(cmd)) fail(`unknown command "${cmd}" — run: uxc help`);

  let modName = cmd;
  let argv = rest;
  if (TWO_WORD.has(cmd)) {
    const sub = rest[0];
    if (!sub) fail(`usage: uxc ${cmd} <subcommand> — run: uxc help`);
    modName = `${cmd}-${sub}`;
    argv = rest.slice(1);
  }
  const parsed = parseArgv(argv);
  let mod;
  try {
    mod = (await import(`../lib/commands/${modName}.mjs`)).default;
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') fail(`unknown command "uxc ${cmd} ${argv[0] ?? ''}".`);
    throw e;
  }
  const ctx = makeCtx(parsed);
  await mod.run(ctx);
}

function makeCtx({ args, flags }) {
  const ctx = {
    args, flags,
    out: out(flags),
    /** Lazily opened package (commands that need one call ctx.requirePkg()). */
    pkg: null,
    requirePkg() {
      if (ctx.pkg) return ctx.pkg;
      const dir = flags.dir ?? findPackageDir();
      if (!dir) fail('no uxopian package here (uxopian-project.json not found) — run uxc init, or pass --dir');
      ctx.pkg = openPackage(dir);
      return ctx.pkg;
    },
    /** Lazily resolved target + clients. */
    _conn: null,
    connect() {
      if (ctx._conn) return ctx._conn;
      const target = resolveTarget(flags.target);
      ctx.target = target;
      ctx.clients = createClients(target);
      ctx._conn = ctx.clients;
      return ctx._conn;
    },
    get target() { return ctx._target; },
    set target(t) { ctx._target = t; },
  };
  return ctx;
}

main().catch((e) => {
  const lines = [e.message];
  if (e.explanation) lines.push(`  ↳ ${e.explanation}`);
  console.error(lines.join('\n'));
  process.exit(2);
});
