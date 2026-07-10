// Small shared utilities. Zero deps.
import { createHash } from 'node:crypto';

export const sha256 = (data) =>
  'sha256:' + createHash('sha256').update(data).digest('hex');

/** Compare two sha256 strings tolerantly: case-insensitive, optional `sha256:` prefix on either.
 *  Returns false for empty/missing inputs (so a missing expected hash never "matches"). */
export function shaEq(a, b) {
  const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  const na = norm(a), nb = norm(b);
  return na.length > 0 && na === nb;
}

/** Deterministic JSON: sorted keys, 2-space indent, trailing newline. */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2) + '\n';
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** '15m' | '45s' | '2h' | '300' (seconds) -> ms */
export function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new Error(`unparseable duration: ${s}`);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 's'];
  return Math.round(Number(m[1]) * mult);
}

export const nowIso = () => new Date().toISOString();

/** FlowerDocs timestamp format, safely in the past (F00013: creationDate must not be in the future). */
export function fdTimestamp(date = new Date(Date.now() - 3_600_000)) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}.` +
    `${p(date.getUTCMilliseconds(), 3)} +0000`;
}

/** Truncate for display; marker carries the full length so callers know to fetch more. */
export function truncate(str, max = 120) {
  const s = String(str ?? '');
  return s.length <= max ? s : s.slice(0, max) + ` (+${s.length - max} chars)`;
}

export const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** tags [{name, value:[..]}] -> { name: firstValue } (FlowerDocs tag read shape; key is `value`, not `values`). */
export function tagsOf(doc) {
  const out = {};
  for (const t of doc?.tags ?? []) out[t.name] = t.value?.[0];
  return out;
}

/** Build the FlowerDocs tag write shape. */
export const tag = (name, v, readOnly = false) => ({
  name,
  value: toArray(v).map(String),
  readOnly,
});

/** EN/FR displayNames pair. */
export const dn = (en, fr = en) => [
  { value: en, language: 'EN' },
  { value: fr, language: 'FR' },
];

/** Every occurrence of --<name> v / --<name>=v from argv (the dispatcher's parser keeps only the
 *  last). Used by repeatable flags: --var, --tag. */
export function collectRepeatedFlag(name, argv = process.argv.slice(2)) {
  const vals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    } else if (argv[i].startsWith(`--${name}=`)) vals.push(argv[i].slice(name.length + 3));
  }
  return vals;
}

/** Parse repeated k=v pairs into an object (later wins); throws on malformed entries. */
export function kvPairs(list, flagName = 'var') {
  const out = {};
  for (const kv of list) {
    const eq = String(kv).indexOf('=');
    if (eq < 1) throw new Error(`bad --${flagName} "${kv}" — expected name=value`);
    out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}
