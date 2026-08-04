// uxc f2 run <MapName> — start a fast2 campaign on a map and report the outcome.
// The FlowerDocs/AI analogue of `uxc run <promptId>`, and the smoke-test primitive for maps.
//
// The two traps this command exists to absorb (FAST2-LEARNINGS §F9):
//   1. `start` returns the ACTUAL campaign name (`<name>_Run<n>`, incrementing even over FAILED
//      starts). Polling the name you asked for 400s "Could not find campaign". So the response
//      body is authoritative and every later call uses it.
//   2. `stats.taskStepStat` is keyed by STEP ID. Raw output is unreadable, so ids are resolved back
//      to the authored step names.
import { resolveMapId } from '../kinds/f2-map.mjs';
import { sleep } from '../util.mjs';
import { fail } from '../output.mjs';

const TERMINAL = /^(Finished|Stopped|Undefined)$/i;

export default {
  name: 'f2-run',
  summary: 'start a fast2 campaign on a map and report per-step results',
  help: 'uxc f2 run <MapName> [--campaign <name>] [--wait <s>] [--expect-ok <n>] [--no-wait] [--json]',
  async run(ctx) {
    const { flags, out } = ctx;
    const mapName = ctx.args[0];
    if (!mapName) fail('usage: uxc f2 run <MapName> [--campaign <name>] [--wait <s>] [--expect-ok <n>]');
    ctx.connect();
    const f2 = ctx.clients.f2;
    if (!f2) {
      fail('this target has no fast2 surface — uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>');
    }
    try { ctx.requirePkg(); } catch { /* a map can be run without a package checkout */ }

    const mapId = await resolveMapId(ctx, mapName);
    if (!mapId) fail(`no fast2 map named "${mapName}" on ${ctx.target.name} — uxc ls f2.map`);

    // step id -> authored name, so id-keyed stats can be rendered readably (§F9)
    const map = await f2.tryGet(`/api/maps/${encodeURIComponent(mapId)}`);
    const stepName = new Map((map?.steps ?? []).map((s) => [s.id, s.name ?? s.id]));

    const requested = String(flags.campaign || mapName);
    // THE RETURNED NAME IS AUTHORITATIVE — never poll `requested` (§F9)
    const campaign = String(await f2.post(
      `/api/campaigns/${encodeURIComponent(requested)}/start?mapId=${encodeURIComponent(mapId)}&newCampaign=true`,
    )).replace(/^"|"$/g, '');
    out.line(`started    ${campaign}  (map ${mapName})`);

    if (flags['no-wait']) {
      out.note(`not waiting — uxc f2 status ${campaign}`);
      out.result({ map: mapName, mapId, campaign, status: 'Starting', waited: false });
      return;
    }

    const waitMs = (Number(flags.wait) || 300) * 1000;
    const t0 = Date.now();
    let status = 'Starting';
    while (Date.now() - t0 < waitMs) {
      await sleep(2000);
      status = String(await f2.get(`/api/campaigns/${encodeURIComponent(campaign)}/status`)).replace(/^"|"$/g, '');
      if (TERMINAL.test(status)) break;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!TERMINAL.test(status)) {
      out.warn(`campaign ${campaign} still ${status} after ${elapsed}s — uxc f2 status ${campaign}`);
      if (/^Starting$/i.test(status)) {
        out.warn('a campaign stuck in "Starting" usually means OpenSearch refuses index creation '
          + '(cluster.blocks.create_index) — run: uxc doctor --f2. It also blocks the map\'s deletion (§F8/§F10).');
      }
      process.exitCode = 1;
      out.result({ map: mapName, mapId, campaign, status, elapsedSec: Number(elapsed) });
      return;
    }

    const stats = await f2.tryGet(`/api/campaigns/${encodeURIComponent(campaign)}/stats`);
    const rows = [];
    let ok = 0;
    let ko = 0;
    for (const [sid, st] of Object.entries(stats?.taskStepStat ?? {})) {
      const s = st?.stats ?? {};
      const row = {
        step: stepName.get(sid) ?? sid,
        ok: s.ProcessedOK?.total ?? 0,
        exception: s.ProcessedException?.total ?? 0,
        queued: s.Queued?.total ?? 0,
      };
      ok += row.ok;
      ko += row.exception;
      rows.push(row);
    }
    rows.sort((a, b) => a.step.localeCompare(b.step));
    out.line(`${status}   ${elapsed}s`);
    out.table(rows, [{ key: 'step' }, { key: 'ok', label: 'ProcessedOK' }, { key: 'exception', label: 'Exception' }, { key: 'queued', label: 'Queued' }]);
    out.line(`totals: ${ok} ok · ${ko} exception`);

    const expectOk = flags['expect-ok'] !== undefined ? Number(flags['expect-ok']) : null;
    if (expectOk !== null && ok !== expectOk) {
      out.warn(`FAIL expected ${expectOk} ProcessedOK, got ${ok}`);
      process.exitCode = 1;
    } else if (ko > 0) {
      out.warn(`${ko} punnet(s) ended in exception — uxc f2 exceptions ${campaign}`);
      process.exitCode = 1;
    }
    out.result({ map: mapName, mapId, campaign, status, elapsedSec: Number(elapsed), ok, exception: ko, steps: rows });
  },
};
