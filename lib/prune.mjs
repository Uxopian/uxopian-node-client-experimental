// Upgrade pruning (DESIGN §23): resources REMOVED from a package's new version are removed from
// the SERVER too — by DEFAULT. Rationale (operator decision, 2026-07-10): if cleanup is an option,
// nobody runs it and servers accumulate versions of crap; a removal is as much a part of the new
// version as an addition. Safety = the CONFIRMATION, not an opt-in flag:
//   - the removal list is ALWAYS computed and printed prominently;
//   - a human at a TTY gets a y/N prompt; non-interactive callers (Claude, CI) must pass
//     --yes-removals (never silent deletion, never silent skipping);
//   - declining/skipping still completes the UPGRADE — removals are then listed loudly as
//     SKIPPED, with the exact `uxc rm` commands (and --keep-removed opts out explicitly).
//
// What may be auto-deleted (policy-aware, mirrors the rm gates):
//   - `managed` kinds with an adapter.remove — deleted (handler removal sweeps every _vN;
//     class deletes that fail server-side, e.g. class-with-documents, surface as warnings);
//   - `createOnly` (fd.taskclass §14 — recreate breaks ANSWER dispatch permanently; vfinstance)
//     and `external` — NEVER auto-deleted, reported with the manual command;
//   - fd.dataset / fd.surfacing — REPORT-ONLY: datasets are user data (uxc rm / data push --prune
//     are the explicit paths) and surfacing entry-diffs need the OLD spec, which an upgrade of a
//     fresh checkout no longer has.
//
// Removal sources per flow:
//   - `uxc push --all` from an upgraded checkout: sync-state keys minus registry keys — the state
//     remembers every resource this checkout ever synced to the target;
//   - `uxc mp install` upgrade: the INSTALLED version's marketplace catalog (via the receipt's
//     version) minus the new registry;
//   - plain `uxc import` of an artifact over an existing install: no reliable old list exists yet
//     (noted in the output) — upgrade via mp install to get pruning, or rm manually.
import { createInterface } from 'node:readline';
import { KINDS } from './kinds/index.mjs';

const REPORT_ONLY_KINDS = new Set(['fd.dataset', 'fd.surfacing']);

const keyOf = (e) => `${e.kind}/${e.id}`;

/** Removal candidates: old resource keys minus the incoming registry's keys.
 *  oldKeys: ['fd.script/spurious', …]; entries: the NEW registry entries. */
export function removalCandidates(oldKeys, entries) {
  const current = new Set(entries.map(keyOf));
  return [...new Set(oldKeys)]
    .filter((k) => !current.has(k))
    .map((k) => {
      const i = k.indexOf('/');
      return { kind: k.slice(0, i), id: k.slice(i + 1) };
    })
    .filter((c) => KINDS[c.kind]) // unknown kinds (newer client wrote the state) are ignored
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** Partition candidates into what CAN be auto-deleted vs report-only, with the reason. */
export function partitionRemovals(candidates) {
  const deletable = [];
  const reportOnly = [];
  for (const c of candidates) {
    const adapter = KINDS[c.kind];
    const policy = adapter?.defaultPolicy ?? 'managed';
    if (REPORT_ONLY_KINDS.has(c.kind)) {
      reportOnly.push({ ...c, why: c.kind === 'fd.dataset' ? 'user data — remove explicitly (uxc rm / uxc data push --prune)' : 'needs the old spec — unsurface from the previous checkout (uxc rm surfacing --server)' });
    } else if (policy === 'external') {
      reportOnly.push({ ...c, why: 'external — referenced, never deleted by uxc' });
    } else if (policy === 'createOnly') {
      reportOnly.push({ ...c, why: c.kind === 'fd.taskclass' ? 'createOnly — NEVER auto-delete a taskclass (§14: recreate breaks ANSWER dispatch permanently); uxc rm --server --force only if you know what you are doing' : 'createOnly — uxc rm --server --force to remove explicitly' });
    } else if (typeof adapter?.remove !== 'function') {
      reportOnly.push({ ...c, why: 'kind has no delete path' });
    } else {
      deletable.push(c);
    }
  }
  return { deletable, reportOnly };
}

/** y/N prompt when stdin is a TTY; otherwise defers to the --yes-removals flag. */
export async function confirmRemovals({ deletable, yes = false, out }) {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    out?.warn?.('non-interactive session: pass --yes-removals to delete the resources listed above (or --keep-removed to keep them)');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`delete these ${deletable.length} resource(s) from the server? [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

/**
 * The full default-prune flow: compute -> print -> confirm -> delete (policy-aware) -> report.
 * Never throws for individual delete failures (warn + continue). Returns
 * { deleted: [keys], skipped: [keys], reportOnly: [{key, why}] }.
 */
export async function pruneRemoved(ctx, oldKeys, entries, { yes = false, keep = false, out, onDeleted } = {}) {
  const candidates = removalCandidates(oldKeys, entries);
  if (!candidates.length) return { deleted: [], skipped: [], reportOnly: [] };
  const { deletable, reportOnly } = partitionRemovals(candidates);

  out?.line?.(`this version REMOVES ${candidates.length} resource(s) that are on the server:`);
  for (const c of deletable) out?.line?.(`  DELETE  ${keyOf(c)}`);
  for (const r of reportOnly) out?.line?.(`  KEEP    ${keyOf(r)}  (${r.why})`);

  const result = { deleted: [], skipped: [], reportOnly: reportOnly.map((r) => ({ key: keyOf(r), why: r.why })) };
  if (!deletable.length) return result;

  if (keep) {
    result.skipped = deletable.map(keyOf);
    out?.warn?.(`--keep-removed: ${deletable.length} removed resource(s) LEFT on the server — remove later with: ${deletable.map((c) => `uxc rm ${keyOf(c)} --server`).join(' · ')}`);
    return result;
  }
  const go = await confirmRemovals({ deletable, yes, out });
  if (!go) {
    result.skipped = deletable.map(keyOf);
    out?.warn?.(`removals SKIPPED — the server still carries: ${deletable.map(keyOf).join(', ')}\n  remove later with: ${deletable.map((c) => `uxc rm ${keyOf(c)} --server`).join(' · ')}`);
    return result;
  }

  let cacheDirty = false;
  for (const c of deletable) {
    const adapter = KINDS[c.kind];
    try {
      await adapter.remove(ctx, c.id);
      if (adapter.cacheAffecting) cacheDirty = true;
      result.deleted.push(keyOf(c));
      out?.line?.(`  deleted ${keyOf(c)}`);
      onDeleted?.(c);
    } catch (e) {
      result.skipped.push(keyOf(c));
      out?.warn?.(`  could not delete ${keyOf(c)}: ${String(e.message).slice(0, 140)} — remove manually (uxc rm ${keyOf(c)} --server)`);
    }
  }
  if (cacheDirty) {
    try { await ctx.clients.cacheClear({ coreToo: true }); out?.note?.('caches cleared after removals'); }
    catch (e) { out?.warn?.(`cache clear after removals failed: ${e.message} — clear manually`); }
  }
  return result;
}

/** Should the installation receipt be HELD (not advanced) after this prune result? Yes when
 *  deletable removals were skipped WITHOUT an explicit --keep-removed: advancing the receipt then
 *  would strand the orphans (the next upgrade sees no version change and never re-offers the
 *  prune — field-reported 2026-07-10). Confirmed deletions, keep-removed and report-only rows
 *  all advance. */
export function shouldHoldReceipt(pruneResult, { keep = false } = {}) {
  return !!pruneResult && pruneResult.skipped.length > 0 && !keep;
}
