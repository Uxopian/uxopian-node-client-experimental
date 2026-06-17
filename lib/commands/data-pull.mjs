// uxc data pull — row-level dataset sync, server -> JSONL (per-row base hashes in state;
// server-deleted rows are dropped with a printed notice).
import { pullRows } from '../kinds/fd-dataset.mjs';
import { fail } from '../output.mjs';

export function resolveDataset(pkg, name) {
  if (!name) return null;
  const direct = pkg.entry('fd.dataset', name);
  if (direct) return direct;
  let e = null;
  try { e = pkg.resolve(name); } catch { /* ambiguous — fall through to the error below */ }
  return e && e.kind === 'fd.dataset' ? e : null;
}

export function printRowResult(out, label, res) {
  if (res == null) { out.line(`${label}: done`); return; }
  if (Array.isArray(res)) {
    for (const r of res) {
      out.line(typeof r === 'string' ? r : `${String(r.action ?? '').padEnd(12)} ${r.id ?? ''}${r.detail ? '  ' + r.detail : ''}`);
    }
    out.line(`${label}: ${res.length} rows affected`);
    return;
  }
  const parts = Object.entries(res).map(([k, v]) =>
    `${k}=${Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : v}`);
  out.line(`${label}: ${parts.join('  ')}`);
}

export default {
  name: 'data-pull',
  summary: 'pull dataset rows from the server (row-level 3-way; deletions noticed, never silent)',
  help: 'uxc data pull <name>',
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    const name = ctx.args[0];
    if (!name) fail('usage: uxc data pull <name>');
    const entry = resolveDataset(pkg, name);
    if (!entry) {
      fail(`unknown dataset "${name}" — datasets: ${pkg.entries('fd.dataset').map((e) => e.id).join(', ') || '(none — declare in manifest.dataSets and register)'}`);
    }
    ctx.connect();
    const res = await pullRows(ctx, pkg, entry);
    printRowResult(out, `data pull ${entry.id}`, res);
    out.result(res ?? { dataset: entry.id });
  },
};
