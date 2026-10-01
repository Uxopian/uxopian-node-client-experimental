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

/**
 * Tiny version-pattern language for `supportedVersions` lists (DESIGN §18):
 *   '*'        any version
 *   '2025.*'   prefix match on the dotted segments before '.*'
 *   '>=2026'   comparison (also >, <=, <) via compareSemver
 *   '2026.0.0' exact (semver compare == 0)
 * A LIST matches when ANY pattern matches (multivalued OR).
 */
export function matchesVersionPattern(version, pattern) {
  const p = String(pattern ?? '').trim();
  if (!p) return false;
  if (p === '*') return true;
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -2);
    const vSeg = parseSemver(version).nums;
    const pSeg = prefix.split('.').map(Number);
    return pSeg.every((n, i) => vSeg[i] === n);
  }
  const m = p.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const c = compareSemver(version, m[2]);
    return m[1] === '>=' ? c >= 0 : m[1] === '<=' ? c <= 0 : m[1] === '>' ? c > 0 : c < 0;
  }
  return compareSemver(version, p) === 0;
}

export const versionSupported = (version, patterns) =>
  (Array.isArray(patterns) ? patterns : [patterns]).some((p) => matchesVersionPattern(version, p));

/**
 * Version RANGES for compat.json `requires.<dep>.versions` (DESIGN §26) — a superset of the
 * pattern language above (every supportedVersions pattern means the same thing here), plus the
 * npm-style forms extension authors write. `versionSupported` keeps its exact behavior for its
 * callers (server gate, dependency gate); only the upgrade judgement uses this matcher.
 *
 *   range      := set ( '||' set )*                 any set matches (OR); an ARRAY is OR too
 *   set        := comparator ( <space> comparator )*  every comparator matches (AND)
 *   comparator := '*' | 'x' | [op] partial           op: >= <= > < = ^ ~ (a space after op is ok)
 *   partial    := N [ '.' N|x|* [ '.' N|x|* ] ] [ '-' prerelease ]   (x/* only trailing)
 *
 *   1.2.3 / =1.2   exact (missing parts = 0, as in the pattern language: 1.2 == 1.2.0)
 *   1.x  1.2.*     wildcard: every version (prereleases included) of that major / minor
 *   ^1.2  ^0.2.3   same leftmost non-zero part: >=1.2.0 <2.0.0 ; >=0.2.3 <0.3.0
 *   ~1.2  ~1       same minor (major when only the major is given): >=1.2.0 <1.3.0
 *   >=1.0 <2.0     comparators (missing parts = 0), AND-ed within a set
 * Prereleases order by semver precedence (2.0.0-rc.1 < 2.0.0); the upper bound of ^ ~ x excludes
 * the NEXT version's prereleases (^1.2 does not admit 2.0.0-rc.1).
 */
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const isWild = (p) => p === undefined || /^[xX*]$/.test(p);

/** One comparator -> [[op, version]] primitives (AND), or null when it does not parse. */
function comparatorBounds(tok) {
  if (tok === '*' || tok === 'x' || tok === 'X') return [];
  const m = tok.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
  const op = m[1] ?? '';
  const p = m[2].match(PARTIAL);
  if (!p) return null;
  const raw = [p[1], p[2], p[3]];
  // a wildcard may only be followed by wildcards/nothing (1.x.3 is meaningless), and never
  // carries a prerelease
  const firstWild = raw.findIndex((x) => x !== undefined && isWild(x));
  if (firstWild !== -1 && raw.slice(firstWild).some((x) => x !== undefined && !isWild(x))) return null;
  if (p[4] && firstWild !== -1) return null;
  const n = raw.map((x) => (isWild(x) ? null : Number(x)));
  const pre = p[4] ? `-${p[4]}` : '';
  const at = (a, b, c, s = '') => `${a}.${b}.${c}${s}`;
  const [M, mi, pa] = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
  const hasWildcard = firstWild !== -1;
  if (op === '^') {
    const upper = M > 0 || n[1] == null ? at(M + 1, 0, 0, '-0')
      : mi > 0 || n[2] == null ? at(0, mi + 1, 0, '-0') : at(0, 0, pa + 1, '-0');
    return [['>=', at(M, mi, pa, pre)], ['<', upper]];
  }
  if (op === '~') {
    const upper = n[1] == null ? at(M + 1, 0, 0, '-0') : at(M, mi + 1, 0, '-0');
    return [['>=', at(M, mi, pa, pre)], ['<', upper]];
  }
  if ((op === '' || op === '=') && hasWildcard) {
    if (n[0] == null) return [];
    return n[1] == null
      ? [['>=', at(M, 0, 0, '-0')], ['<', at(M + 1, 0, 0, '-0')]]
      : [['>=', at(M, mi, 0, '-0')], ['<', at(M, mi + 1, 0, '-0')]];
  }
  return [[op || '=', at(M, mi, pa, pre)]];
}

/** Parse a range (string or array of strings) -> [[ [op, version] … ] …] (OR of ANDs), or null. */
export function parseVersionRange(range) {
  const alts = (Array.isArray(range) ? range : [range]).flatMap((r) => (typeof r === 'string' ? r.split('||') : [null]));
  const sets = [];
  for (const alt of alts) {
    if (alt == null) return null;
    const s = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
    if (!s) return null;
    const set = [];
    for (const tok of s.split(/\s+/)) {
      const b = comparatorBounds(tok);
      if (!b) return null;
      set.push(...b);
    }
    sets.push(set);
  }
  return sets.length ? sets : null;
}

/** The accepted range forms, for error messages (one grammar: init --depends-on, manifest
 *  `dependencies.*`, compat `requires.*.versions` — DESIGN §22/§26). */
export const RANGE_FORMS = "exact '1.2.3', any '*', wildcard '1.x' / '1.2.*', caret '^1.2', tilde '~1.2', "
  + "comparator '>=1.1', a space-AND set '>=0.4 <0.5', alternatives '^1 || ^3'";

/** Is `range` (string, or array of strings = OR) in the grammar above? */
export const isValidRange = (range) => parseVersionRange(range) !== null;

/** Does `version` satisfy `range` (grammar above)? An unparseable range matches nothing. */
export function satisfiesRange(version, range) {
  const sets = parseVersionRange(range);
  if (!sets) return false;
  return sets.some((set) => set.every(([op, v]) => {
    const c = compareSemver(version, v);
    return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
  }));
}
