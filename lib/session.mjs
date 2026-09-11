// Command preamble: package policy + cross-process lock (BACKLOG-AGENTIC #2/#3/#4/#12).
//
// Everything here runs BEFORE a command's run(), and everything here is about several agents
// sharing one instance: which instance this checkout is allowed to touch, what it may never do to
// it, and who else is writing to it right now.
import { agentPolicy, resolvePinnedTarget, forbiddenBy } from './agent.mjs';
import { LOCK_MODES, HANDLER_WINDOW_COMMANDS } from './cli-meta.mjs';
import { resolveTargetName, findPackageDir } from './config.mjs';
import { acquire, waitHandlerWindow } from './lock.mjs';
import { fail } from './output.mjs';

/**
 * Open a session for `modName`. Mutates ctx.flags.target when a pin applies, and returns
 * { release(), lockKey, policy, mode } — release() is idempotent and must run in a finally.
 */
export async function openSession(ctx, { command, modName, mod }) {
  const { flags, out } = ctx;
  // A command's mode may depend on its FLAGS: `uxc test --offline` touches no server, and making
  // it queue behind an e2e campaign would defeat the tier (BACKLOG #13).
  const declared = mod?.lock ?? LOCK_MODES[modName] ?? 'none';
  const mode = flags['no-lock'] ? 'none' : (typeof declared === 'function' ? declared(flags) : declared);

  // ---- package policy (optional: uxc runs fine outside a package) ----
  let dir = null;
  try { dir = flags.dir ?? findPackageDir(); } catch { dir = null; }
  const policy = dir ? agentPolicy(dir) : agentPolicy(null);
  ctx.policy = policy;

  // 1. forbidden command shapes — data, not a brief that gets skimmed
  for (const hit of forbiddenBy(policy, { command, args: ctx.args, flags })) {
    fail(`refused: ${hit.reason}.\n  Remove it from agent.forbid, or run the equivalent explicitly (e.g. name the resources instead of a sweep).`);
  }

  // 2. target pin — the accident this exists to stop is a push to the wrong instance
  const ambient = resolveTargetName(null);
  const requested = typeof flags.target === 'string' ? flags.target : null;
  const pinned = resolvePinnedTarget({
    pin: policy.target, pinFrom: policy.targetFrom, requested, ambient,
    write: mode === 'write', override: !!flags['allow-target-mismatch'],
  });
  if (pinned.refuse) fail(`refused: ${pinned.refuse}`);
  if (pinned.warn) out.warn(pinned.warn);
  if (policy.target && pinned.use) flags.target = pinned.use;

  const lockKey = pinned.use ?? requested ?? ambient ?? 'default';
  ctx.lockKey = lockKey;

  if (mode === 'none') return { release() {}, lockKey, policy, mode };

  // 3. the handler blind window a PREVIOUS process opened (~45 s, LEARNINGS §36): waiting it out
  //    is cheaper than two overlapping rotations, which lose events in each other's shadow
  if (mode === 'write' && HANDLER_WINDOW_COMMANDS.has(modName)) {
    await waitHandlerWindow(lockKey, {
      onWait: (left, by) => out.warn(`waiting ${Math.ceil(left / 1000)}s for the handler registration window opened by ${by} — overlapping rotations lose events`),
    });
  }

  // 4. the lock itself
  const timeoutMs = flags['lock-timeout'] ? Number(flags['lock-timeout']) * 1000 : undefined;
  const lock = await acquire(lockKey, {
    mode,
    cmd: `uxc ${process.argv.slice(2).join(' ')}`.slice(0, 200),
    ...(timeoutMs ? { timeoutMs } : {}),
    onWait: (owner, waited) => out.warn(
      `waiting ${Math.round(waited / 1000)}s for the "${lockKey}" lock held by ${owner?.cmd ?? 'another uxc'}`
      + `${owner?.pid ? ` (pid ${owner.pid})` : ''} — reads never wait; --no-lock overrides`,
    ),
    onSteal: (owner) => out.warn(`took over an abandoned "${lockKey}" lock (${owner?.cmd ?? 'unknown'}, pid ${owner?.pid ?? '?'} — not running)`),
  });
  if (lock.contendedBy) {
    out.warn(`note: "${lockKey}" is being written right now by ${lock.contendedBy.cmd}`
      + `${lock.contendedBy.pid ? ` (pid ${lock.contendedBy.pid})` : ''} — this read may see a moving target`);
  }

  // released on normal completion (the finally in bin/uxc.mjs) AND on a hard exit
  const release = () => lock.release();
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { release(); process.exit(130); });
  }
  return { release, lockKey, policy, mode };
}
