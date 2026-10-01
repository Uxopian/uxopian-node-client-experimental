// Output discipline: compact aligned text, one resource per line, summary counts.
// --json switches every command to machine output. Errors: one line + learned explanation.
// Agent mode (#95): when an agent drives uxc (UXC_AGENT=1, or CLAUDECODE=1 unless UXC_AGENT=0)
// JSON is the DEFAULT and it is compact (one line). A non-TTY stdout alone never switches —
// humans pipe to grep. --human / --json force either; --json without an agent stays pretty.
import { truncate } from './util.mjs';

/**
 * Is an agent driving this process? UXC_AGENT wins both ways ('0'/'false'/'' → no; anything
 * else → yes); otherwise CLAUDECODE=1 (set by Claude Code in every tool shell).
 */
export function agentDetected(env = process.env) {
  const u = env.UXC_AGENT;
  if (u !== undefined && u !== '') return !/^(0|false|no|off)$/i.test(String(u).trim());
  return env.CLAUDECODE === '1';
}

/**
 * The output mode for one invocation: { json, compact, agent }.
 *   --human  → human text, always          --json → JSON (compact only when an agent is detected)
 *   neither  → JSON+compact iff an agent is detected, else human text
 */
/** Is a boolean-ish flag ON? `--json=false` parses to the STRING "false" — that is off. */
export const flagOn = (v) => v !== undefined && v !== false && v !== 'false';

export function outputMode(flags = {}, env = process.env) {
  const agent = agentDetected(env);
  const on = flagOn;
  if (on(flags.human)) return { json: false, compact: false, agent };
  if (on(flags.json)) return { json: true, compact: agent, agent };
  return { json: agent, compact: agent, agent };
}

// Process-wide mode, set once by the dispatcher (setOutputMode) so fail() — a free function
// called from anywhere — knows whether to emit the JSON error envelope.
let MODE = { json: false, compact: false, agent: false };
export function setOutputMode(mode) { MODE = { ...MODE, ...mode }; return MODE; }
export function getOutputMode() { return MODE; }

export const stringify = (obj, compact = MODE.compact) =>
  compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);

/**
 * The JSON error envelope (stdout, JSON mode only). The human message still goes to stderr,
 * so anything that reads stderr keeps working; the exit code is unchanged.
 */
export function errorEnvelope(err, exitCode = 2) {
  const e = typeof err === 'string' ? { message: err } : (err ?? {});
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? e.code : null;
  return { ok: false, error: String(e.message ?? e), code, explanation: e.explanation ?? null, exitCode };
}

/** Print an error the way the current mode wants it (stderr text always; + stdout JSON). */
export function reportError(err, exitCode = 2) {
  const e = typeof err === 'string' ? { message: err } : err;
  const lines = [e.message];
  if (e.explanation) lines.push(`  ↳ ${e.explanation}`);
  console.error(lines.join('\n'));
  if (MODE.json) console.log(stringify(errorEnvelope(e, exitCode)));
}

export function fail(msg, code = 2) {
  reportError(msg, code);
  process.exit(code);
}

/**
 * The output helper. The dispatcher passes the resolved mode (outputMode); a library caller that
 * passes only flags gets the legacy behaviour (JSON iff flags.json, pretty) — agent detection is
 * a CLI concern and never changes what an embedding program sees.
 */
export function out(flags = {}, mode = { json: !!flags.json, compact: false }) {
  const json = !!mode.json;
  const compact = !!mode.compact;
  return {
    json,
    compact,
    /** Final machine result (only printed in JSON mode; one line in agent mode). */
    result(obj) { if (json) console.log(stringify(obj, compact)); },
    /** One-line human output (suppressed in --json mode). */
    line(...parts) { if (!json) console.log(parts.join(' ')); },
    note(msg) { if (!json) console.log(`  ${msg}`); },
    warn(msg) { console.error(`! ${msg}`); },
    /** Aligned table. rows = array of objects; cols = [{key, label?, max?}]. */
    table(rows, cols) {
      if (json) return; // caller emits result() instead
      if (!rows.length) return console.log('(none)');
      const widths = cols.map((c) => Math.max(
        (c.label ?? c.key).length,
        ...rows.map((r) => cell(r[c.key], c.max).length),
      ));
      console.log(cols.map((c, i) => (c.label ?? c.key).padEnd(widths[i])).join('  '));
      for (const r of rows) {
        console.log(cols.map((c, i) => cell(r[c.key], c.max).padEnd(widths[i])).join('  '));
      }
    },
    /** Capped unified-diff style output: stat header + first N lines. */
    diff(label, lines, { cap = 80, full = false } = {}) {
      if (json) return;
      console.log(label);
      const shown = full ? lines : lines.slice(0, cap);
      for (const l of shown) console.log(l);
      if (!full && lines.length > cap) console.log(`(… ${lines.length - cap} more lines: --full)`);
    },
  };
}

const cell = (v, max = 60) =>
  v == null ? '' : truncate(typeof v === 'object' ? JSON.stringify(v) : String(v), max);

/** Minimal line-based unified diff (LCS-free; good enough for canonical JSON/XML). */
export function diffLines(aText, bText) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    // find next resync point (small lookahead window)
    let si = -1, sj = -1;
    outer: for (let w = 1; w <= 30; w++) {
      for (let x = 0; x <= w; x++) {
        const y = w - x;
        if (i + x < a.length && j + y < b.length && a[i + x] === b[j + y]) { si = i + x; sj = j + y; break outer; }
      }
    }
    if (si === -1) { si = a.length; sj = b.length; }
    for (; i < si; i++) out.push(`- ${a[i]}`);
    for (; j < sj; j++) out.push(`+ ${b[j]}`);
  }
  return out;
}
