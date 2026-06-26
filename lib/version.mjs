// Client/package compatibility gate (DESIGN §11).
//
// The client (uxc) is officially versioned by package.json `version` — the single source of truth.
// A package declares the MINIMUM client it needs to deploy every resource via `minClientVersion`
// (top-level in uxopian-project.json; `requires.uxc` is accepted as an alias). Install/deploy paths
// (import, mp install, push) refuse when the running client is older than that minimum, so nobody
// deploys a package whose features the client doesn't yet implement.
//
// Bootstrapping note: only clients that ship this gate enforce it; clients predating the field
// ignore it. The field is introduced in 0.2.0, while the client is still pre-release — so there is
// effectively no older fleet to escape the gate.
import { readFileSync } from 'node:fs';

/** The running uxc client version — read once from package.json (the single source of truth). */
export const CLIENT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/**
 * Parse a semver-ish string ("1.2.3", "v1.2.3", "1.2.3-rc.1", "1.2.3+build", "0.2") into
 * { nums:[major,minor,patch], pre:[...identifiers], valid }. Lenient: missing parts default to 0,
 * build metadata (after `+`) is ignored. `valid` is false when the core isn't three integers.
 */
export function parseSemver(v) {
  const s = String(v ?? '').trim().replace(/^[vV]/, '');
  if (!s) return { nums: [0, 0, 0], pre: [], valid: false };
  const core = s.split('+')[0];
  const dash = core.indexOf('-');
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? '' : core.slice(dash + 1);
  const parts = main.split('.');
  const valid = parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p));
  const nums = [0, 0, 0].map((d, i) => (parts[i] != null && /^\d+$/.test(parts[i]) ? Number(parts[i]) : d));
  return { nums, pre: pre ? pre.split('.') : [], valid };
}

/** Semver compare: -1 if a<b, 0 if equal, 1 if a>b. A release outranks its own prereleases. */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // equal core: a version WITHOUT a prerelease tag is greater than one WITH (1.0.0 > 1.0.0-rc.1)
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // fewer prerelease fields = lower precedence
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1; // numeric identifiers always rank below alphanumeric
  }
  return 0;
}

/** Does `client` satisfy the minimum `required` (client >= required)? No requirement => always ok. */
export function satisfiesMinClient(required, client = CLIENT_VERSION) {
  if (required == null || required === '') return true;
  return compareSemver(client, required) >= 0;
}

/** The minimum client a package declares: `minClientVersion`, or the `requires.uxc` alias, or null. */
export function minClientVersionOf(manifest) {
  return manifest?.minClientVersion ?? manifest?.requires?.uxc ?? null;
}

/**
 * Gate a deploy/install against the package's declared minimum client. THROWS (an Error with a
 * `.explanation` the CLI renders) when the running client is too old or the declared minimum is not
 * valid semver. With `ignore: true` it WARNS via `out` and returns instead of throwing (the
 * --ignore-client-version escape hatch). Returns { required, ok, ignored? }.
 *
 * @param manifest the package manifest (uxopian-project.json)
 * @param {object} opts { client = CLIENT_VERSION, ignore = false, out, action = 'deploy' }
 */
export function assertClientSupports(manifest, { client = CLIENT_VERSION, ignore = false, out, action = 'deploy' } = {}) {
  const required = minClientVersionOf(manifest);
  if (required == null || required === '') return { required: null, ok: true };

  if (!parseSemver(required).valid) {
    const msg = `uxopian-project.json: minClientVersion "${required}" is not valid semver (expected e.g. "0.2.0")`;
    if (ignore) { out?.warn?.(`${msg} — proceeding anyway (--ignore-client-version)`); return { required, ok: false, ignored: true }; }
    throw new Error(msg);
  }

  if (satisfiesMinClient(required, client)) return { required, ok: true };

  const msg = `client too old for this package: it requires uxc >= ${required}, but you are running ${client}`;
  const explanation =
    `upgrade uxc (e.g. npm i -g @uxopian/uxc@latest) before you ${action} this package — an older ` +
    `client can be missing features needed to ${action} every resource. Unsafe override: --ignore-client-version.`;
  if (ignore) {
    out?.warn?.(`${msg}\n  ↳ ${explanation}\n  ↳ OVERRIDDEN by --ignore-client-version — the ${action} may be incomplete or incorrect.`);
    return { required, ok: false, ignored: true };
  }
  const e = new Error(msg);
  e.explanation = explanation;
  throw e;
}
