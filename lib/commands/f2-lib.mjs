// uxc f2 lib ls|push <x.jar>|restore <jar> --from <jar.old> — the worker JAR lifecycle over REST,
// so a connector or patch jar never needs scp plus a remote restart (FAST-5881, FAST2-LEARNINGS §F32).
//
// What the broker does (source-read, §F32; the OpenAPI is the only live evidence): upload-library
// and restore-library REFUSE while any campaign runs, then stop every worker, move the current jar
// to worker-libs/versions/<jar>.old, write the new one and respawn a worker. No restart call is
// needed — but the CLI must wait for the respawn before the next run can use the jar.
//
// Three things this command absorbs:
//   1. The refusal has no documented status code (the spec lists 200/400/500; FAST-5880 asks for
//      409 + {code:"CAMPAIGN_RUNNING"}). So uxc checks for a running campaign FIRST and names it,
//      and any non-2xx from the broker is shown verbatim (classifyRefusal leaves room for the 409).
//   2. `GET /api/workers` has no status field (§F32): "the worker is back" is inferred from a new
//      workerId, a new pid, or lastSeen going stale then fresh again (workerBack).
//   3. `GET /api/workers/libraries` is paged ({total, collection}; 401 jars on rc5): ls pages it.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { sleep } from '../util.mjs';
import { fail } from '../output.mjs';
import { isF2AuthError } from '../http.mjs';

const RUNNING = /^(Started|Starting)$/i;
const PAGE_SIZE = 200;
const POLL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const unquote = (s) => String(s ?? '').replace(/^"|"$/g, '');

/** Campaigns currently Started/Starting (the A16 rule). One status call per campaign (B03). */
export async function runningCampaigns(f2) {
  const names = (await f2.get('/api/campaigns/search-by-pattern?namePattern=.*'))?.collection ?? [];
  const running = [];
  for (const name of names) {
    const status = unquote(await f2.get(`/api/campaigns/${encodeURIComponent(name)}/status`));
    if (RUNNING.test(status)) running.push({ name, status });
  }
  return running;
}

/**
 * Every library, all pages. Stops on a short/empty page, on `total`, or when `page` is not
 * honoured (live rc5, 2026-10-01: `page=1&size=200` did NOT return rows 200-399 of 401 — the
 * paging parameters are not in the probe). Short of `total` after that, ONE `size=<total>` call.
 */
export async function listLibraries(f2, { pageSize = PAGE_SIZE } = {}) {
  const rowsOf = (body) => (Array.isArray(body) ? body : (body?.collection ?? []));
  let all = [];
  let total = null;
  for (let page = 0; page < 1000; page++) {
    const body = await f2.get(`/api/workers/libraries?page=${page}&size=${pageSize}`);
    const rows = rowsOf(body);
    if (!Array.isArray(body) && typeof body?.total === 'number') total = body.total;
    // a broker that ignores `page` (or counts from 1) repeats page 0: stop on a repeated first row
    if (page > 0 && rows.length && all.length && rows[0]?.jarName === all[0]?.jarName) break;
    all.push(...rows);
    if (Array.isArray(body) || rows.length < pageSize || (total !== null && all.length >= total)) break;
  }
  if (total !== null && all.length < total) {
    const rows = rowsOf(await f2.get(`/api/workers/libraries?size=${total}`));
    if (rows.length > all.length) all = rows;
  }
  return { libraries: all, total: total ?? all.length };
}

const fmtDate = (d) => {
  const v = d && typeof d === 'object' ? (d.value ?? d.date ?? JSON.stringify(d)) : d;
  if (typeof v === 'number') return new Date(v).toISOString();
  return v ?? '';
};
const fmtVersions = (v) => {
  const list = Array.isArray(v) ? v : (v ? [v] : []);
  return list.map((x) => (typeof x === 'object' ? (x?.jarName ?? x?.name ?? JSON.stringify(x)) : String(x))).join(', ');
};

/** `library-versions/{name}` -> candidate names, whatever the element shape (unverified live). */
export function versionNames(body) {
  const list = Array.isArray(body) ? body : (body?.collection ?? body?.versions ?? []);
  return list.map((x) => (typeof x === 'object' ? (x?.jarName ?? x?.name ?? x?.fileName) : x)).filter(Boolean).map(String);
}

/** Age of a worker's lastSeen in ms — the field may be an epoch timestamp or already an age. */
const ageOf = (lastSeen, now = Date.now()) => {
  const n = Number(lastSeen);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? now - n : n;
};

/**
 * Has a worker come back since `before` (the pre-upload snapshot)? The A17 rule, plus the pid:
 * a workerId not seen before, a known workerId with a new pid, or a lastSeen that went stale
 * (> 10 s) during the swap and is fresh (< 5 s) again. `state` carries the "went stale" memory.
 */
export function workerBack(before, workers, state = {}, now = Date.now()) {
  const prev = new Map(before.map((w) => [w.workerId, w]));
  state.stale ??= new Set();
  for (const w of workers) {
    const p = prev.get(w.workerId);
    if (!p) return w;
    if (p.pid != null && w.pid != null && p.pid !== w.pid) return w;
    const age = ageOf(w.lastSeen, now);
    if (age === null) continue;
    if (age > 10_000) state.stale.add(w.workerId);
    else if (age < 5_000 && state.stale.has(w.workerId)) return w;
  }
  return null;
}

const workersOf = async (f2) => (await f2.get('/api/workers'))?.collection ?? [];

/** What a non-2xx from upload/restore means. FAST-5880 asks for 409 + CAMPAIGN_RUNNING. */
export function classifyRefusal(r) {
  const code = r.json && typeof r.json === 'object' ? r.json.code : undefined;
  if (r.status === 409 || code === 'CAMPAIGN_RUNNING' || /campaign/i.test(String(r.text ?? ''))) return 'campaign-running';
  if (r.status === 400) return 'invalid-file';
  return 'error';
}

const HELP = 'uxc f2 lib ls [--filter <name>] | push <x.jar> --yes [--force] [--no-wait] [--timeout <s>]'
  + ' | restore <jar> --from <jar.old> --yes [--force] [--no-wait] [--timeout <s>]  [--json]';

export default {
  name: 'f2-lib',
  summary: 'fast2 worker jars: list, upload (push) or roll back (restore) over REST; push/restore need --yes',
  help: HELP,
  // ls only reads; push/restore swap the jar under every worker. Without --yes they are refused
  // before any request, so they take no lock (the `uxc api` rule).
  lock: (flags = {}, args = []) => (args[0] === 'ls' || args[0] === 'list' ? 'read' : (flags.yes ? 'write' : 'none')),
  async run(ctx) {
    const { flags, out } = ctx;
    const verb = ctx.args[0] === 'list' ? 'ls' : ctx.args[0];
    if (!['ls', 'push', 'restore'].includes(verb)) fail(`usage: ${HELP}`);

    // ---- usage + destructive gate: all before any network call ----
    let jarPath = null;
    let bytes = null;
    let jar = null;
    let from = null;
    if (verb === 'push') {
      jarPath = ctx.args[1];
      if (!jarPath) fail('usage: uxc f2 lib push <x.jar> --yes [--force] [--no-wait] [--timeout <s>]');
      if (!/\.jar$/i.test(jarPath)) fail(`"${jarPath}" is not a .jar — the broker only takes a jar (400 "Invalid file provided")`);
      let st;
      try { st = statSync(jarPath); } catch { fail(`no such file: ${jarPath}`); }
      if (!st.isFile()) fail(`not a file: ${jarPath}`);
      jar = basename(jarPath);
    }
    if (verb === 'restore') {
      jar = ctx.args[1];
      from = typeof flags.from === 'string' ? flags.from : null;
      if (!jar) fail('usage: uxc f2 lib restore <jar> --from <jar.old> --yes [--force] [--no-wait] [--timeout <s>]');
    }
    if (verb === 'push' || from !== null) { // restore without --from only lists the candidates
      if (!flags.yes) {
        fail(`refusing to ${verb} ${verb === 'push' ? `"${jar}"` : `"${jar}" from "${from}"`} without --yes — the broker STOPS EVERY WORKER, `
          + 'swaps the jar in worker-libs and respawns a worker (in-flight work is interrupted)');
      }
    }

    ctx.connect();
    const f2 = ctx.clients.f2;
    if (!f2) fail('this target has no fast2 surface — uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>');

    if (verb === 'ls') return ls(ctx, f2);

    if (verb === 'restore') {
      const candidates = versionNames(await f2.tryGet(`/api/workers/library-versions/${encodeURIComponent(jar)}`));
      if (!from || !candidates.includes(from)) {
        if (candidates.length) {
          out.line(`rollback candidates for ${jar}:`);
          for (const c of candidates) out.note(c);
        } else out.line(`no rollback candidate for ${jar} (GET …/workers/library-versions/${jar} is empty)`);
        fail(from
          ? `"${from}" is not a rollback candidate of ${jar}${candidates.length ? ` — pick one of: ${candidates.join(', ')}` : ''}`
          : `usage: uxc f2 lib restore ${jar} --from <jar.old> --yes${candidates.length ? ` (candidates: ${candidates.join(', ')})` : ''}`);
      }
    }
    if (verb === 'push') {
      bytes = readFileSync(jarPath);
    }

    const result = { action: verb, jar, status: null, workerBackAfterSec: null, listed: false };
    if (from) result.from = from;
    if (bytes) result.sizeBytes = bytes.length;

    // ---- 1. running-campaign pre-check (the broker refuses anyway, with no documented code) ----
    const running = await runningCampaigns(f2);
    if (running.length && !flags.force) {
      const names = running.map((c) => `${c.name} (${c.status})`).join(', ');
      out.warn(`refusing to ${verb}: campaign(s) running — ${names}. The broker refuses a library change while a campaign runs; `
        + 'wait for it to finish, or pass --force to try anyway. A campaign wedged in Starting never finishes (§F8): uxc doctor --f2');
      result.status = 'busy';
      result.campaigns = running;
      process.exitCode = 1;
      out.result(result);
      return;
    }
    if (running.length) out.warn(`--force: ${running.length} campaign(s) running — the broker will most likely refuse`);

    // ---- 2. the call ----
    const before = await workersOf(f2).catch(() => []);
    let r;
    if (verb === 'push') {
      out.line(`uploading  ${jar}  (${bytes.length.toLocaleString('en-US').replace(/,/g, "'")} bytes)`);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/java-archive' }), jar);
      r = await f2.raw('POST', '/api/workers/upload-library', form, { timeout: UPLOAD_TIMEOUT_MS });
    } else {
      out.line(`restoring  ${jar}  <-  ${from}`);
      r = await f2.raw('POST', `/api/workers/restore-library?jarToVersion=${encodeURIComponent(jar)}&jarToRestore=${encodeURIComponent(from)}`,
        undefined, { timeout: UPLOAD_TIMEOUT_MS });
    }
    result.httpStatus = r.status;
    if (r.status < 200 || r.status >= 300) {
      const kind = classifyRefusal(r);
      out.warn(`broker refused the ${verb}: HTTP ${r.status}`);
      console.error(r.text ?? '');
      if (kind === 'campaign-running') out.warn('a campaign is running (it may have started after the pre-check) — retry when it is finished');
      else if (kind === 'error') out.warn('the broker documents no "campaign running" status (FAST-5880): a 500 here is most likely a campaign that started after the pre-check — uxc f2 ls --campaigns');
      result.status = kind === 'campaign-running' ? 'busy' : 'refused';
      result.body = r.json ?? r.text ?? null;
      process.exitCode = 1;
      out.result(result);
      return;
    }
    out.line(`${verb === 'push' ? 'uploaded' : 'restored'}   HTTP ${r.status} — the broker stops the workers and respawns one`);

    if (flags['no-wait']) {
      out.note('not waiting for the worker — uxc f2 lib ls, then uxc f2 run');
      result.status = verb === 'push' ? 'uploaded' : 'restored';
      out.result(result);
      return;
    }

    // ---- 3. wait for a worker to be registered again, then confirm the jar is listed ----
    const timeoutMs = (Number(flags.timeout) || 180) * 1000;
    const t0 = Date.now();
    const state = {};
    let back = null;
    let last = [];
    while (Date.now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      // the broker may blip during the swap; an auth/cooldown error is not a blip: surface it (exit 2)
      try { last = await workersOf(f2); } catch (e) { if (isF2AuthError(e)) throw e; continue; }
      back = workerBack(before, last, state);
      if (back) break;
    }
    const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (!back) {
      out.warn(`no worker came back within ${timeoutMs / 1000}s — last GET /api/workers: ${JSON.stringify(last.map((w) => ({ workerId: w.workerId, pid: w.pid, lastSeen: w.lastSeen })))}`);
      result.status = 'timeout';
      result.workers = last;
      process.exitCode = 1;
      out.result(result);
      return;
    }
    result.workerBackAfterSec = secs;
    out.line(`worker     ${back.workerId} back after ${secs}s`);

    // after a restore the old jar is back under its own name; which name the broker gives it is
    // unverified live, so either spelling counts as listed
    const expect = new Set([jar, from && from.replace(/\.old$/i, '')].filter(Boolean));
    const { libraries } = await listLibraries(f2);
    result.listed = libraries.some((l) => expect.has(l.jarName));
    if (!result.listed) {
      out.warn(`${[...expect].join(' / ')} is NOT in GET /api/workers/libraries after the ${verb} — check the broker log`);
      result.status = 'not-listed';
      process.exitCode = 1;
    } else {
      out.line(`listed     ${[...expect].filter((n) => libraries.some((l) => l.jarName === n)).join(', ')}`);
      result.status = 'ok';
    }
    out.result(result);
  },
};

async function ls(ctx, f2) {
  const { flags, out } = ctx;
  const filter = typeof flags.filter === 'string' ? flags.filter : null;
  const { libraries, total } = await listLibraries(f2);
  const shown = filter ? libraries.filter((l) => String(l.jarName ?? '').toLowerCase().includes(filter.toLowerCase())) : libraries;
  const rows = shown
    .map((l) => ({
      jarName: l.jarName,
      version: l.version ?? '',
      fileSize: l.fileSize ?? '',
      lastModificationDate: fmtDate(l.lastModificationDate),
      ...(l.versionsLibs && (!Array.isArray(l.versionsLibs) || l.versionsLibs.length) ? { versionsLibs: fmtVersions(l.versionsLibs) } : {}),
    }))
    .sort((a, b) => String(a.jarName).localeCompare(String(b.jarName)));
  const cols = [{ key: 'jarName', max: 60 }, { key: 'version' }, { key: 'fileSize' }, { key: 'lastModificationDate' }];
  if (rows.some((r) => r.versionsLibs)) cols.push({ key: 'versionsLibs', max: 60 });
  out.table(rows, cols);
  out.line(`${rows.length} jar(s)${filter ? ` matching "${filter}" (client-side filter)` : ''} of ${total} on ${f2.base}`);
  if (libraries.length < total) out.warn(`read ${libraries.length} of ${total} jars — the broker did not page as expected`);
  out.result({ action: 'ls', jar: filter, status: 'ok', workerBackAfterSec: null, listed: rows.length > 0, total, libraries: rows });
}
