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
//   2. `GET /api/workers` has no status field (§F32), and an EMBEDDED worker (it runs in the broker
//      JVM) keeps its workerId and pid across the respawn — identity says nothing. Success is read
//      from the jar listing instead: the jar is listed with lastModificationDate >= the upload start
//      (a push), AND a worker was heard from after the call returned (`lastSeen` is an age in ms on
//      rc5, so heard-at = asked-at − lastSeen; seenSince).
//   3. `GET /api/workers/libraries` is paged ({total, collection}; 401 jars on rc5): ls pages it.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { sleep } from '../util.mjs';
import { fail } from '../output.mjs';
import { HttpError, NetworkError, isF2AuthError } from '../http.mjs';
import { campaignStatuses } from '../f2/campaign.mjs';

const RUNNING = /^(Started|Starting)$/i;
const PAGE_SIZE = 200;
const POLL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const FRESH_MS = 5_000; // a worker whose lastSeen age is under this is alive
const LIST_EVERY_MS = 5_000; // the jar listing is 3 calls / ~200 KB on rc5: not every poll
const CLOCK_SKEW_MS = 30_000; // the jar date is the BROKER's clock, the upload start is ours
const BODY_MAX = 2_000; // a refusal body printed on stderr (a Tomcat HTML page can be huge)

/** Campaigns currently Started/Starting (the A16 rule). */
export async function runningCampaigns(f2) {
  return (await campaignStatuses(f2)).filter((c) => RUNNING.test(c.status));
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

/** `library-versions/{name}` -> the list, whatever the envelope (the element shape is unverified live). */
const versionList = (body) => {
  const list = Array.isArray(body) ? body : (body?.collection ?? body?.versions ?? body?.content ?? []);
  return Array.isArray(list) ? list : [];
};

/**
 * `library-versions/{name}` -> candidate names, whatever the element shape (unverified live, §F32):
 * a string, or an object's jarName | name | fileName | basename(path). An element of an unknown
 * shape yields nothing — the caller then shows the raw element and does not block on it.
 */
export function versionNames(body) {
  return versionList(body).map((x) => {
    if (x === null || x === undefined) return null;
    if (typeof x !== 'object') return String(x);
    const n = x.jarName ?? x.name ?? x.fileName ?? (typeof x.path === 'string' ? x.path.split(/[\\/]/).pop() : null);
    return typeof n === 'string' && n ? n : null;
  }).filter(Boolean);
}

/** Age of a worker's lastSeen in ms. rc5 sends an age (§F32); an epoch is converted, never negative. */
const ageOf = (lastSeen, now = Date.now()) => {
  const n = Number(lastSeen);
  if (lastSeen === null || lastSeen === undefined || lastSeen === '' || !Number.isFinite(n)) return null;
  return Math.max(0, n > 1e12 ? now - n : n);
};

/**
 * The freshest worker heard from AFTER `sinceMs` (our clock): lastSeen is an age the broker computed
 * while answering, so heard-at >= askedAt − age (askedAt = when we sent the GET). Relative, so no
 * clock skew. An embedded worker that respawns with the same workerId and pid in a few seconds is
 * still caught; a worker that stopped and never came back is not (its age keeps growing).
 */
export function seenSince(workers, sinceMs, askedAt = Date.now()) {
  let best = null;
  let bestAge = Infinity;
  for (const w of workers ?? []) {
    const age = ageOf(w?.lastSeen, askedAt);
    if (age === null || age >= FRESH_MS || askedAt - age <= sinceMs) continue;
    if (age < bestAge) { best = w; bestAge = age; }
  }
  return best;
}

/** How the worker that answered relates to the pre-swap snapshot — informative only. */
export function respawnKind(before, w) {
  const p = (before ?? []).find((b) => b.workerId === w.workerId);
  if (!p) return 'new-worker';
  if (p.pid != null && w.pid != null && p.pid !== w.pid) return 'new-pid';
  return 'same-worker';
}

/** lastModificationDate -> epoch ms: a number, a numeric or ISO string, or {value|date}; else null. */
export function dateMs(d) {
  if (d && typeof d === 'object') return dateMs(d.value ?? d.date ?? null);
  if (typeof d === 'number') return Number.isFinite(d) ? d : null;
  if (typeof d === 'string' && d.trim()) {
    const n = /^\d+$/.test(d.trim()) ? Number(d) : Date.parse(d);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Is the jar installed, by the listing? -> {state, hit?}
 *   installed   listed (and, with `since`, lastModificationDate >= since − CLOCK_SKEW_MS)
 *   stale       listed, but dated before the upload started: the listing still shows the old jar
 *   undated     listed, the date unreadable
 *   incomplete  not found, but the listing is short of `total` (a broker that caps `size`)
 *   absent      not found in a complete listing
 * A restore passes no `since`: it MOVES a file back, and a move keeps the file's old date.
 */
export function installState({ libraries, total }, names, since = null) {
  const hit = libraries.find((l) => names.has(l.jarName));
  if (!hit) return { state: libraries.length < (total ?? 0) ? 'incomplete' : 'absent' };
  if (since === null) return { state: 'installed', hit };
  const ms = dateMs(hit.lastModificationDate);
  if (ms === null) return { state: 'undated', hit };
  return { state: ms >= since - CLOCK_SKEW_MS ? 'installed' : 'stale', hit };
}

/**
 * What the wait loop may ride out while the broker swaps the jar: transport, timeout, a 5xx.
 * An auth/cooldown error (isF2AuthError) never is, even a failed re-login answered with a 5xx:
 * it surfaces at once (exit 2) instead of being polled until the timeout.
 */
const transient = (e) => !isF2AuthError(e) && (e instanceof NetworkError
  || /TimeoutError|AbortError|aborted due to timeout/i.test(`${e?.name} ${e?.message}`)
  || (e instanceof HttpError && e.status >= 500));

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
      const body = await f2.tryGet(`/api/workers/library-versions/${encodeURIComponent(jar)}`);
      const raw = versionList(body);
      const candidates = versionNames(body);
      // an element shape uxc cannot read (unverified live, §F32): show it so it gets recorded
      const unreadable = raw.length > 0 && candidates.length < raw.length;
      if (unreadable) out.warn(`GET …/workers/library-versions/${jar}: element shape not recognised — first element: ${JSON.stringify(raw[0]).slice(0, 300)}`);
      const known = from !== null && (candidates.includes(from) || candidates.some((c) => c.endsWith(`/${from}`)));
      if (from === null || (!known && !flags.force && !unreadable)) {
        if (candidates.length) {
          out.line(`rollback candidates for ${jar}:`);
          for (const c of candidates) out.note(c);
        } else if (!raw.length) out.line(`no rollback candidate for ${jar} (GET …/workers/library-versions/${jar} is empty)`);
        fail(from
          ? `"${from}" is not a rollback candidate of ${jar}${candidates.length ? ` — pick one of: ${candidates.join(', ')}` : ''}`
            + ' (--force skips this check; the broker still validates jarToRestore)'
          : `usage: uxc f2 lib restore ${jar} --from <jar.old> --yes${candidates.length ? ` (candidates: ${candidates.join(', ')})` : ''}`);
      }
      if (!known) {
        out.warn(unreadable
          ? `cannot check "${from}" against the listed versions (unknown shape) — sending it; the broker validates jarToRestore`
          : `--force: "${from}" is not a listed rollback candidate of ${jar} — sending it anyway; the broker validates jarToRestore`);
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
    // the pre-swap worker snapshot: a failure here is NOT swallowed — the broker cannot answer its
    // worker registry, so uxc could not tell a respawn from a dead worker afterwards
    const wait = !flags['no-wait'];
    let before = [];
    if (wait) {
      try { before = await workersOf(f2); } catch (e) {
        fail(`cannot read GET /api/workers before the ${verb} — not ${verb === 'push' ? 'uploading' : 'restoring'} `
          + `(uxc needs the worker registry to confirm the swap; --no-wait skips that): ${e.message}`);
      }
    }
    const t0 = Date.now();
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
      const text = String(r.text ?? '');
      out.warn(`broker refused the ${verb}: HTTP ${r.status}`);
      if (text) out.warn(text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)} … (${text.length - BODY_MAX} more chars)` : text);
      if (kind === 'campaign-running') out.warn('a campaign is running (it may have started after the pre-check) — retry when it is finished');
      else if (kind === 'error') out.warn('the broker documents no "campaign running" status (FAST-5880): a 500 here is most likely a campaign that started after the pre-check — uxc f2 ls --campaigns');
      result.status = kind === 'campaign-running' ? 'busy' : 'refused';
      result.body = r.json ?? r.text ?? null;
      process.exitCode = 1;
      out.result(result);
      return;
    }
    out.line(`${verb === 'push' ? 'uploaded' : 'restored'}   HTTP ${r.status} — the broker stops the workers and respawns one`);

    if (!wait) {
      out.note('not waiting for the worker — uxc f2 lib ls, then uxc f2 run');
      result.status = verb === 'push' ? 'uploaded' : 'restored';
      out.result(result);
      return;
    }

    // ---- 3. wait: a worker heard from since the call returned, AND the jar in the listing ----
    // after a restore the old jar is back under its own name; which name the broker gives it is
    // unverified live, so either spelling counts
    const names = new Set([jar, from && from.replace(/\.old$/i, '')].filter(Boolean));
    const since = verb === 'push' ? t0 : null; // a restore moves a file: its date proves nothing
    const timeoutMs = (Number(flags.timeout) || 180) * 1000;
    const tDone = Date.now();
    let worker = null;
    let seenAfter = null;
    let inst = null;
    let listedAt = -Infinity;
    let last = [];
    const list = async () => { listedAt = Date.now(); inst = installState(await listLibraries(f2), names, since); };
    while (Date.now() - tDone < timeoutMs) {
      await sleep(POLL_MS);
      try {
        const askedAt = Date.now();
        last = await workersOf(f2);
        const w = seenSince(last, tDone, askedAt);
        if (w && !worker) { worker = w; seenAfter = Number(((Date.now() - tDone) / 1000).toFixed(1)); }
        if (worker && Date.now() - listedAt >= LIST_EVERY_MS) await list();
      } catch (e) {
        if (!transient(e)) throw e; // a 4xx / auth error is not a swap blip: never poll it for minutes
        continue;
      }
      if (worker && inst?.state === 'installed') break;
    }
    if (inst?.state !== 'installed') {
      try { await list(); } catch (e) { if (!transient(e)) throw e; }
    }
    result.listed = !!inst?.hit;
    if (worker) {
      result.workerBackAfterSec = seenAfter;
      result.worker = { workerId: worker.workerId, pid: worker.pid ?? null, respawn: respawnKind(before, worker) };
      out.line(`worker     ${worker.workerId} heard from ${seenAfter}s after the ${verb} (${result.worker.respawn})`);
    }
    const label = [...names].join(' / ');
    const state = inst?.state ?? 'unknown';
    if (!worker) {
      out.warn(`no worker was heard from within ${timeoutMs / 1000}s of the ${verb} — last GET /api/workers: `
        + `${JSON.stringify(last.map((w) => ({ workerId: w.workerId, pid: w.pid, lastSeen: w.lastSeen })))}`
        + `${state === 'installed' ? ` (${label} IS installed; the next run has no worker until one registers)` : ''}`);
      result.status = 'timeout';
      result.workers = last;
      process.exitCode = 1;
    } else if (state === 'installed') {
      out.line(`listed     ${inst.hit.jarName}${since !== null ? `  (modified ${fmtDate(inst.hit.lastModificationDate)})` : ''}`);
      result.status = 'ok';
    } else if (state === 'incomplete' || state === 'undated' || state === 'unknown') {
      out.warn(state === 'incomplete'
        ? `${label} is not in the ${inst ? 'partial ' : ''}listing (the broker did not return every jar) — unverified, check uxc f2 lib ls --filter ${jar}`
        : `${label} could not be confirmed by date (${state === 'undated' ? `lastModificationDate ${JSON.stringify(inst.hit.lastModificationDate)} unreadable` : 'the listing failed'}) — unverified`);
      result.status = 'unverified';
    } else if (state === 'stale') {
      out.warn(`${label} is listed but dated ${fmtDate(inst.hit.lastModificationDate)}, before the ${verb} started — `
        + 'the broker still lists the OLD jar (or its clock is more than 30 s behind) — check the broker log');
      result.status = 'stale';
      process.exitCode = 1;
    } else {
      out.warn(`${label} is NOT in GET /api/workers/libraries after the ${verb} — check the broker log`);
      result.status = 'not-listed';
      process.exitCode = 1;
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
