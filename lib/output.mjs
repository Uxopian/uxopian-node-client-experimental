// Output discipline: compact aligned text, one resource per line, summary counts.
// --json switches every command to machine output. Errors: one line + learned explanation.
import { truncate } from './util.mjs';

export function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

export function out(flags = {}) {
  const json = !!flags.json;
  return {
    json,
    /** Final machine result (only printed in --json mode). */
    result(obj) { if (json) console.log(JSON.stringify(obj, null, 2)); },
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
