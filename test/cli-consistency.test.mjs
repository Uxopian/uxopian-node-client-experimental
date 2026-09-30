// CLI consistency lint (#99, BACKLOG-AGENTIC §27.6): every command module against the verb/flag
// table in lib/CONTRACTS.md ("CLI verbs and flags"), whose data lives in lib/cli-meta.mjs.
// Offline + static (module source is read, never run) except the alias dispatch checks, which
// are hermetic subprocesses on --help (no package, no target) and one forbid refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import {
  COMMANDS, TWO_WORD, VERBS, VERB_EXCEPTIONS, COMMAND_ALIASES, SUBCOMMAND_ALIASES,
  FLAG_ALIASES, LEGACY_FLAG_ALIASES, DESTRUCTIVE, resolveAliases, applyFlagAliases, aliasesOf,
} from '../lib/cli-meta.mjs';
import help from '../lib/commands/help.mjs';
import { completionArgs, bashCompletion } from '../lib/commands/completion.mjs';

const DIR = resolve('lib/commands');
const UXC = resolve('bin/uxc.mjs');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();
const BASES = FILES.map((f) => f.slice(0, -4));

const MODS = {};
for (const base of BASES) {
  MODS[base] = {
    mod: (await import(pathToFileURL(join(DIR, `${base}.mjs`)).href)).default,
    src: readFileSync(join(DIR, `${base}.mjs`), 'utf8'),
  };
}

/** Split a module base into { family, verb } when it is a two-word subcommand. */
const twoWordOf = (base) => {
  const fam = TWO_WORD.find((c) => base.startsWith(`${c}-`));
  return fam ? { family: fam, verb: base.slice(fam.length + 1) } : null;
};

/** The flags a module reads — the introspectable forms used across lib/commands. */
function parsedFlags(src) {
  const s = new Set();
  for (const re of [
    /\bflags\.([a-zA-Z][\w]*)/g,
    /\bflags\[['"]([a-zA-Z0-9-]+)['"]\]/g,
    /reclaim\(\s*flags\s*,\s*\w+\s*,\s*'([a-z0-9-]+)'/g,
    /collectFlag\('([a-z0-9-]+)'\)/g,
  ]) for (const m of src.matchAll(re)) s.add(m[1]);
  return s;
}

const GLOBAL = new Set(['help', 'dir', 'json', 'target', 'no-lock', 'lock-timeout', 'allow-target-mismatch']);

function captureHelp() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { help.run(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('every command module exports name/summary/help/run, and its name matches its file', () => {
  for (const [base, { mod }] of Object.entries(MODS)) {
    assert.ok(mod && typeof mod === 'object', `${base}: default export`);
    for (const k of ['name', 'summary', 'help']) {
      assert.equal(typeof mod[k], 'string', `${base}: ${k} is a string`);
      assert.ok(mod[k].trim(), `${base}: ${k} is not empty`);
    }
    assert.equal(typeof mod.run, 'function', `${base}: run()`);
    assert.equal(mod.name.replace(/\s+/g, '-'), base, `${base}: name "${mod.name}" matches the file`);
    assert.match(mod.help, /^uxc /, `${base}: help starts with the usage ("uxc …")`);
  }
});

test('every module dispatches, and every dispatchable command has a module', () => {
  for (const base of BASES) {
    const tw = twoWordOf(base);
    assert.ok(tw || COMMANDS.includes(base), `${base}.mjs is not reachable from COMMANDS/TWO_WORD`);
  }
  for (const c of COMMANDS) {
    if (TWO_WORD.includes(c)) assert.ok(BASES.some((b) => b.startsWith(`${c}-`)), `family ${c} has subcommands`);
    else assert.ok(BASES.includes(c), `command ${c} has lib/commands/${c}.mjs`);
  }
});

test('subcommand verbs are canonical, or allow-listed with a reason (and aliased when they mean one)', () => {
  const used = new Set();
  for (const base of BASES) {
    const tw = twoWordOf(base);
    if (!tw) continue;
    used.add(tw.verb);
    const exc = VERB_EXCEPTIONS[tw.verb];
    assert.ok(Object.hasOwn(VERBS, tw.verb) || exc,
      `"${tw.family} ${tw.verb}": "${tw.verb}" is not a canonical verb (${Object.keys(VERBS).join(' ')}) — use one, or add it to VERB_EXCEPTIONS with a reason`);
    if (exc) {
      assert.ok(exc.reason && exc.reason.length > 10, `VERB_EXCEPTIONS.${tw.verb} gives a reason`);
      if (exc.alias) {
        assert.equal(SUBCOMMAND_ALIASES[tw.family]?.[exc.alias], tw.verb,
          `"${tw.family} ${tw.verb}" means "${exc.alias}" — register SUBCOMMAND_ALIASES.${tw.family}.${exc.alias}`);
      }
    }
  }
  for (const v of Object.keys(VERB_EXCEPTIONS)) assert.ok(used.has(v), `VERB_EXCEPTIONS.${v} is stale (no subcommand uses it)`);
});

test('aliases resolve to real modules, shadow none, and are canonical spellings', () => {
  for (const [a, c] of Object.entries(COMMAND_ALIASES)) {
    assert.ok(COMMANDS.includes(c), `alias ${a} -> ${c}: target is a command`);
    assert.ok(!COMMANDS.includes(a) && !BASES.includes(a), `alias ${a} shadows a real command`);
  }
  for (const [fam, map] of Object.entries(SUBCOMMAND_ALIASES)) {
    assert.ok(TWO_WORD.includes(fam), `SUBCOMMAND_ALIASES.${fam} is a two-word family`);
    for (const [a, c] of Object.entries(map)) {
      assert.ok(BASES.includes(`${fam}-${c}`), `${fam} ${a} -> ${fam} ${c}: module exists`);
      assert.ok(!BASES.includes(`${fam}-${a}`), `${fam} ${a} shadows a real subcommand`);
      assert.ok(Object.hasOwn(VERBS, a) || a === 'list', `alias "${fam} ${a}" must be a canonical verb (or "list")`);
    }
  }
  assert.deepEqual(resolveAliases('list'), { cmd: 'ls', sub: undefined });
  assert.deepEqual(resolveAliases('mp', 'get'), { cmd: 'mp', sub: 'show' });
  assert.deepEqual(resolveAliases('scope', 'rm'), { cmd: 'scope', sub: 'delete' });
  assert.deepEqual(resolveAliases('mp', 'show'), { cmd: 'mp', sub: 'show' }, 'old spelling unchanged');
  assert.deepEqual(resolveAliases('constructor', 'toString'), { cmd: 'constructor', sub: 'toString' }, 'no prototype hits');
  assert.deepEqual(resolveAliases('rm', 'list'), { cmd: 'rm', sub: 'list' }, 'a one-word command keeps its args');
});

test('flag aliases: canonical is read by the module, the alias is not; both-given must agree', () => {
  for (const [modName, map] of Object.entries(FLAG_ALIASES)) {
    assert.ok(MODS[modName], `FLAG_ALIASES.${modName}: module exists`);
    const read = parsedFlags(MODS[modName].src);
    for (const [a, c] of Object.entries(map)) {
      assert.ok(read.has(c), `${modName} reads --${c}`);
      assert.ok(!read.has(a), `${modName} already reads --${a} itself — not an alias`);
    }
  }
  assert.deepEqual(applyFlagAliases('search', { limit: '5' }), { max: '5' });
  assert.deepEqual(applyFlagAliases('search', { max: '5' }), { max: '5' });
  assert.deepEqual(applyFlagAliases('mp-ls', { max: '3' }), { limit: '3' });
  assert.deepEqual(applyFlagAliases('ls', { limit: '3' }), { limit: '3' }, 'untouched where not declared');
  assert.deepEqual(applyFlagAliases('search', { limit: '5', max: '5' }), { max: '5' });
  assert.throws(() => applyFlagAliases('search', { limit: '5', max: '9' }), /--limit is an alias of --max/);
});

test('help mentions every flag the command reads (introspectable forms)', () => {
  const problems = [];
  for (const [base, { mod, src }] of Object.entries(MODS)) {
    const text = `${mod.summary} ${mod.help}`;
    const legacy = LEGACY_FLAG_ALIASES[base] ?? {};
    for (const f of parsedFlags(src)) {
      if (GLOBAL.has(f)) continue;
      if (text.includes(`--${f}`)) continue;
      if (f === 'o' && /(^|\s|\[)-o\b/.test(text)) continue;             // the short -o form
      if (f.startsWith('ignore-') && text.includes('--ignore-*')) continue;
      if (Object.hasOwn(legacy, f) && (text.includes(`--${legacy[f]}`) || (legacy[f] === 'o' && text.includes('-o')))) continue;
      problems.push(`${base}: reads --${f} but its help does not mention it`);
    }
  }
  assert.deepEqual(problems, []);
});

test('destructive commands are gated: listed in DESTRUCTIVE, gate flags in help and read by code', () => {
  for (const base of BASES) {
    const verb = twoWordOf(base)?.verb ?? base;
    if (['rm', 'delete', 'destroy'].includes(verb)) {
      assert.ok(DESTRUCTIVE[base], `${base} deletes — add it to DESTRUCTIVE with its gate`);
    }
  }
  for (const [base, { flags, gate }] of Object.entries(DESTRUCTIVE)) {
    assert.ok(MODS[base], `DESTRUCTIVE.${base}: module exists`);
    assert.ok(gate && gate.length > 2, `DESTRUCTIVE.${base} documents its gate`);
    const { mod, src } = MODS[base];
    const read = parsedFlags(src);
    for (const f of flags) {
      assert.ok(`${mod.summary} ${mod.help}`.includes(`--${f}`), `${base}: gate --${f} is in its help`);
      assert.ok(read.has(f), `${base}: gate --${f} is read by the code`);
    }
  }
});

test('help lists every alias; per-command help names them', () => {
  const text = captureHelp();
  for (const a of Object.keys(COMMAND_ALIASES)) assert.match(text, new RegExp(`\\b${a} = ${COMMAND_ALIASES[a]}\\b`));
  for (const [fam, map] of Object.entries(SUBCOMMAND_ALIASES)) {
    for (const [a, c] of Object.entries(map)) {
      if (a === 'list') {
        const line = text.split('\n').find((l) => l.includes('<family> list'));
        assert.ok(line && new RegExp(`\\b${fam}\\b`).test(line), `help names ${fam} in the "<family> list" alias line`);
      } else {
        assert.ok(text.includes(`${fam} ${a} = ${fam} ${c}`), `help lists "${fam} ${a} = ${fam} ${c}"`);
      }
    }
  }
  for (const [modName, map] of Object.entries(FLAG_ALIASES)) {
    for (const [a, c] of Object.entries(map)) assert.ok(text.includes(`--${a} = --${c}`), `help lists --${a} = --${c} (${modName})`);
  }
  assert.deepEqual(aliasesOf('mp-show').commands, ['mp get']);
  assert.deepEqual(aliasesOf('ls').commands, ['list']);
  assert.deepEqual(aliasesOf('search').flags, ['--limit = --max']);
});

test('completion offers every alias, with its canonical flags', () => {
  const args = completionArgs();
  for (const a of Object.keys(COMMAND_ALIASES)) assert.ok(args.commands.includes(a), `completion offers ${a}`);
  for (const [fam, map] of Object.entries(SUBCOMMAND_ALIASES)) {
    for (const a of Object.keys(map)) assert.ok(args.subcommands[fam].includes(a), `completion offers ${fam} ${a}`);
  }
  const s = bashCompletion(args);
  assert.match(s, /"mp get"\) __uxc_flags="\$__uxc_flags --version --catalog";;/);
  assert.match(s, /"list"\) __uxc_flags="\$__uxc_flags --mine --fields";;/);
  assert.match(s, /"search"\) __uxc_flags="[^"]*--limit/);
});

// ---- dispatch: the alias runs the SAME module (hermetic --help, no package/target) ----

function uxc(args, { cwd, env = {} } = {}) {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-verbs-'));
  try {
    const r = spawnSync(process.execPath, [UXC, ...args], {
      cwd: cwd ?? home,
      env: {
        ...process.env, UXC_HOME: home, HOME: home, USERPROFILE: home,
        UXC_TARGET: '', UXC_URL: '', UXC_CORE_URL: '', UXC_AI_URL: '', UXC_GUI_URL: '',
        UXC_SCOPE: '', UXC_USER: '', UXC_PASSWORD: '', ...env,
      },
      encoding: 'utf8', timeout: 60_000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('an alias dispatches to the canonical module (identical --help, exit 0)', () => {
  for (const [alias, canon] of [
    [['list'], ['ls']], [['mp', 'get'], ['mp', 'show']], [['mp', 'list'], ['mp', 'ls']],
    [['scope', 'rm'], ['scope', 'delete']], [['task', 'list'], ['task', 'ls']],
    [['target', 'list'], ['target', 'ls']], [['f2', 'list'], ['f2', 'ls']],
  ]) {
    const a = uxc([...alias, '--help']);
    const c = uxc([...canon, '--help']);
    assert.equal(a.status, 0, `${alias.join(' ')}: ${a.stderr}`);
    assert.equal(a.stdout, c.stdout, `${alias.join(' ')} = ${canon.join(' ')}`);
    assert.match(a.stdout, new RegExp(`aliases: .*uxc ${alias.join(' ')}`));
  }
  const bad = uxc(['constructor']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command "constructor"/);
});

test('agent.forbid on the canonical name also blocks the alias spelling', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-verbs-pkg-'));
  const dir = join(home, 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'uxopian-project.json'), JSON.stringify({ code: 'po', name: 'P', agent: { forbid: ['scope delete'] } }));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ resources: [] }));
  try {
    const r = uxc(['scope', 'rm', 'ZzScope', '--yes'], {
      cwd: dir, env: { UXC_URL: 'http://127.0.0.1:1', UXC_SCOPE: 'S', UXC_USER: 'u', UXC_PASSWORD: 'p' },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refused: "scope delete" is listed in uxopian-project\.json agent\.forbid/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
