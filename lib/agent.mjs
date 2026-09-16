// Package-level operating policy for automated callers (BACKLOG-AGENTIC #3/#12).
//
// A brief gets skimmed; a manifest gets enforced. Everything an agent must NOT do to this package
// lives in uxopian-project.json under "agent", and the CLI applies it before the command runs:
//
//   "agent": {
//     "target":    "gfdefault",                       // the ONLY instance this checkout deploys to
//     "protect":   ["fd.handler/PoEmail_onCreate"],   // never written by a routine command
//     "neverPull": ["ai.prompt/*"],                   // the server copy is older ON PURPOSE
//     "forbid":    ["push --changed"],                // command+flag shapes refused outright
//     "gotchas":   "docs/GOTCHAS.md"                  // surfaced by `uxc context`
//   }
//
// `.uxc/target` (one line, a target name) overrides the manifest pin for a single checkout —
// two clones of one package can be pinned to two instances without touching a tracked file.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read the policy of an open package (or a package dir). Absent keys default to empty. */
export function agentPolicy(pkgOrDir) {
  const dir = typeof pkgOrDir === 'string' ? pkgOrDir : pkgOrDir?.dir;
  const manifest = typeof pkgOrDir === 'string'
    ? readManifest(dir)
    : pkgOrDir?.manifest ?? readManifest(dir);
  const a = manifest?.agent ?? {};
  let target = typeof a.target === 'string' ? a.target : null;
  let targetFrom = target ? 'uxopian-project.json agent.target' : null;
  const pinFile = dir ? join(dir, '.uxc', 'target') : null;
  if (pinFile && existsSync(pinFile)) {
    const t = readFileSync(pinFile, 'utf8').trim();
    if (t) { target = t; targetFrom = '.uxc/target'; }
  }
  return {
    target,
    targetFrom,
    protect: [...(a.protect ?? [])].map(String),
    neverPull: [...(a.neverPull ?? [])].map(String),
    forbid: [...(a.forbid ?? [])].map(String),
    gotchas: typeof a.gotchas === 'string' ? a.gotchas : null,
    empty: !target && !(a.protect ?? []).length && !(a.neverPull ?? []).length && !(a.forbid ?? []).length,
  };
}

function readManifest(dir) {
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8')); } catch { return null; }
}

/** Glob with '*' only (no '?', no character classes) — anchored, '*' spans any run including '/'. */
export function globMatch(pattern, value) {
  const re = new RegExp(`^${String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(String(value));
}

/** Does `pattern` designate this entry? Accepts 'kind/id', a bare 'id', and '*' globs in both. */
export function matchesEntry(pattern, entry) {
  const key = `${entry.kind}/${entry.id}`;
  return globMatch(pattern, key) || globMatch(pattern, entry.id);
}

/**
 * Target resolution under a pin (#3). The pin WINS — that is its job — but the caller is never
 * left guessing which instance was used:
 *   - an explicit --target equal to the pin CONFIRMS it (the intended use);
 *   - an explicit --target that differs is REFUSED (the accident this exists to stop);
 *   - a differing ambient default is refused for WRITES (confirm with --target <pin>) and merely
 *     warned for reads, which must stay usable.
 * -> { use, refuse: string|null, warn: string|null }
 */
export function resolvePinnedTarget({ pin, pinFrom, requested, ambient, write = false, override = false }) {
  if (!pin) return { use: requested ?? ambient ?? null, refuse: null, warn: null };
  const src = pinFrom ?? 'the package';
  if (requested && requested !== pin) {
    if (override) return { use: requested, refuse: null, warn: `target pin overridden: using "${requested}" instead of the pinned "${pin}" (${src})` };
    return {
      use: pin,
      refuse: `this package is pinned to target "${pin}" (${src}) but --target "${requested}" was passed.\n`
        + `  --target may only CONFIRM the pin. To deploy elsewhere on purpose: --allow-target-mismatch, `
        + `or change ${src}.`,
      warn: null,
    };
  }
  if (requested === pin) return { use: pin, refuse: null, warn: null };
  if (ambient && ambient !== pin) {
    if (write && !override) {
      return {
        use: pin,
        refuse: `this package is pinned to target "${pin}" (${src}) but the CLI default is "${ambient}".\n`
          + `  Confirm with: --target ${pin}   (or --allow-target-mismatch to use "${ambient}")`,
        warn: null,
      };
    }
    return { use: pin, refuse: null, warn: `using the pinned target "${pin}" (${src}); the CLI default "${ambient}" is NOT this package's instance` };
  }
  return { use: pin, refuse: null, warn: null };
}

/**
 * Forbidden command shapes (#12). A pattern is `<command> [conditions…]`:
 *   'push --changed'   -> command push carrying the --changed flag
 *   'rm --server'      -> command rm carrying --server
 *   'pull ai.prompt/*' -> command pull with a positional matching the glob
 *   'destroy'          -> the command, unconditionally
 *   'data push'        -> a two-word command, unconditionally
 * All conditions must hold. -> [{pattern, reason}]
 */
export function forbiddenBy(policy, { command, args = [], flags = {} }) {
  const hits = [];
  for (const pattern of policy.forbid ?? []) {
    const toks = String(pattern).trim().split(/\s+/);
    // the command may be one word ('push') or two ('data push') — match the longest form first
    const two = toks.length > 1 ? `${toks[0]} ${toks[1]}` : null;
    const cmd = two === command ? two : toks[0];
    const conds = two === command ? toks.slice(2) : toks.slice(1);
    if (cmd !== command) continue;
    const ok = conds.every((c) => (c.startsWith('--')
      ? flags[c.slice(2)] !== undefined && flags[c.slice(2)] !== false
      : args.some((a) => globMatch(c, a))));
    if (ok) hits.push({ pattern, reason: `"${pattern}" is listed in uxopian-project.json agent.forbid` });
  }
  return hits;
}

/**
 * Split entries against a protection list. Naming a protected resource EXPLICITLY is an error
 * (a mistake worth stopping); sweeping over one (--all/--changed) silently skips it, because a
 * sweep never meant to single it out.
 * -> { allowed, blocked: [{entry, pattern}] }
 */
export function partitionProtected(patterns, entries) {
  const allowed = [];
  const blocked = [];
  for (const entry of entries) {
    const pattern = (patterns ?? []).find((p) => matchesEntry(p, entry));
    if (pattern) blocked.push({ entry, pattern });
    else allowed.push(entry);
  }
  return { allowed, blocked };
}
