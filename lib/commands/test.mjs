// uxc test — run the package's embedded functional tests (tests/*.test.mjs) against a live
// target (DESIGN §24, #27). Receipts say WHAT is installed; package tests say whether it WORKS.
//
//   uxc test [name…] [--target t] [--keep] [--json] [--yes] [--list]
//
// - discovery: tests/*.test.mjs, run SERIALLY in filename order (fixture interference impossible);
// - a test file default-exports { name, description?, requires?, timeoutMs?, run(t) };
// - `requires` unmet => SKIP with the reason (a package must be testable on FD-only targets);
// - teardown ALWAYS runs (LIFO, tracked fixtures only); --keep keeps fixtures and prints them;
// - SAFETY GATE: functional tests create and delete real objects — the target must set
//   `allowTests: true` (targets.json / UXC_ALLOW_TESTS=1) or the caller passes --yes;
// - fully green run => the installation receipt is re-stamped (UxcTestsPassedAt/UxcTestsResult):
//   `uxc installed` then answers "what is deployed AND when did it last prove itself";
// - exit 1 on any failure; --json for CI.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness, checkRequires, makeRunId, TEST_ID_PREFIX } from '../testkit.mjs';
import { stampTestReceipt } from '../receipt.mjs';
import { fail } from '../output.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

export default {
  name: 'test',
  summary: "run the package's embedded functional tests against the target (tests/*.test.mjs)",
  help: 'uxc test [name…] [--target t] [--keep] [--json] [--yes] [--list]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const testsDir = join(pkg.dir, 'tests');

    // ---- discovery (filename order IS execution order) ----
    const files = existsSync(testsDir)
      ? readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort()
      : [];
    if (!files.length) {
      out.line(`no embedded tests in this package (${join(pkg.manifest.code ?? '.', 'tests')}/*.test.mjs)`);
      return out.result({ tests: [], passed: 0, failed: 0, skipped: 0 });
    }
    const filters = ctx.args.map((a) => a.toLowerCase());
    const selected = [];
    for (const file of files) {
      let mod, loadError = null;
      try { mod = (await import(pathToFileURL(join(testsDir, file)).href)).default; }
      catch (e) { loadError = `does not load: ${String(e.message).slice(0, 160)}`; }
      if (!loadError && (typeof mod?.run !== 'function' || !mod?.name)) {
        loadError = 'must default-export { name, run(t) }';
      }
      const test = { file, name: mod?.name ?? file, description: mod?.description ?? '', mod, loadError };
      if (filters.length && !filters.some((f) => file.toLowerCase().includes(f) || test.name.toLowerCase().includes(f))) continue;
      selected.push(test);
    }
    if (!selected.length) fail(`no test matches ${JSON.stringify(ctx.args)} — available: ${files.join(', ')}`);

    if (flags.list) {
      out.table(selected.map((s) => ({ file: s.file, name: s.name, description: s.loadError ?? s.description })),
        [{ key: 'file' }, { key: 'name' }, { key: 'description', max: 80 }]);
      return out.result({ tests: selected.map((s) => ({ file: s.file, name: s.name, description: s.description, loadError: s.loadError })) });
    }

    // ---- safety gate, then connect ----
    ctx.connect();
    if (!ctx.target.allowTests && !flags.yes) {
      fail(`functional tests create and delete real objects on ${ctx.target.name} (${ctx.target.scope}) — ` +
        `opt the target in with "allowTests": true in targets.json (or UXC_ALLOW_TESTS=1), or pass --yes.`);
    }

    const runId = makeRunId();
    out.line(`running ${selected.length} test(s) on ${ctx.target.name} (scope ${ctx.target.scope}) — run ${runId}, fixtures ${TEST_ID_PREFIX}_*_${runId}`);

    // ---- serial execution ----
    const rows = [];
    for (const test of selected) {
      const t0 = Date.now();
      const row = { file: test.file, name: test.name, status: 'pass', ms: 0, detail: '' };
      rows.push(row);
      if (test.loadError) {
        row.status = 'fail';
        row.detail = test.loadError;
        out.line(`✗ ${test.file} — ${test.loadError}`);
        continue;
      }
      const requires = test.mod.requires ?? {};
      let gate;
      try { gate = await checkRequires(ctx, pkg, requires); }
      catch (e) { gate = { ok: false, reason: `pre-flight error: ${String(e.message).slice(0, 120)}` }; }
      if (!gate.ok) {
        row.status = 'skip';
        row.detail = gate.reason;
        row.ms = Date.now() - t0;
        out.line(`○ ${test.name} — SKIP: ${gate.reason}`);
        continue;
      }

      out.line(`▶ ${test.name}${test.description ? ` — ${test.description}` : ''}`);
      const { t, teardown } = createHarness(ctx, { runId, testsDir, log: (m) => out.note(`· ${m}`) });
      const timeoutMs = test.mod.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer;
      try {
        await Promise.race([
          test.mod.run(t),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); }),
        ]);
      } catch (e) {
        row.status = 'fail';
        row.detail = String(e.message).slice(0, 300);
      } finally {
        clearTimeout(timer);
        const td = await teardown({ keep: !!flags.keep });
        if (flags.keep && td.kept.length) out.note(`kept (--keep): ${td.kept.join(', ')}`);
        if (td.failed.length) {
          out.warn(`teardown incomplete — still on ${ctx.target.name}: ${td.failed.map((f) => f.key).join(', ')} (all ${TEST_ID_PREFIX}_* or handler-spawned; remove manually)`);
          row.detail = `${row.detail}${row.detail ? ' · ' : ''}teardown left ${td.failed.length} object(s)`;
        }
      }
      row.ms = Date.now() - t0;
      out.line(row.status === 'pass' ? `✓ ${test.name} (${Math.round(row.ms / 1000)}s)` : `✗ ${test.name} — ${row.detail}`);
    }

    // ---- summary + receipt stamp ----
    const passed = rows.filter((r) => r.status === 'pass').length;
    const failed = rows.filter((r) => r.status === 'fail').length;
    const skipped = rows.filter((r) => r.status === 'skip').length;
    out.line('');
    out.table(rows.map((r) => ({ ...r, ms: `${Math.round(r.ms / 1000)}s` })),
      [{ key: 'status' }, { key: 'name', max: 44 }, { key: 'ms', label: 'time' }, { key: 'detail', max: 90 }]);
    out.line(`${passed} pass · ${failed} fail · ${skipped} skip`);

    let stamped = null;
    if (failed === 0 && passed > 0) {
      try {
        stamped = await stampTestReceipt(ctx, pkg.manifest.code, { passed, skipped, total: rows.length });
        const okSurfaces = stamped.filter((s) => s.ok).map((s) => s.surface);
        if (okSurfaces.length) out.note(`receipt stamped (${okSurfaces.join(', ')}): ${passed}/${rows.length} pass — visible in uxc installed`);
        else out.note('no installation receipt to stamp (package not installed via uxc on this target?)');
      } catch (e) { out.warn(`receipt stamp failed: ${String(e.message).slice(0, 120)} — tests themselves are green`); }
    }
    if (failed > 0) process.exitCode = 1;
    out.result({ target: ctx.target.name, runId, tests: rows, passed, failed, skipped, stamped });
  },
};
