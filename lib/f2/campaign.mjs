// Shared fast2 campaign helpers: the status/stats read, the punnet summary shape, the watch loop and
// the exceptions CSV count. Used by `uxc f2 status`, `uxc f2 exceptions` and `uxc f2 run`, so the
// three commands report one shape (FAST-5878 / FAST-5879).
//
// The broker facts these rely on (FAST2-LEARNINGS §F9, §F33, §F34, §F35):
//   - `GET /api/campaigns/{c}/status` is a BARE JSON string ("Finished"); an unknown campaign is a
//     400 text/plain "Could not find campaign with name <c>".
//   - `GET /api/campaigns/{c}/stats` carries `taskFlowMapRef.mapId` and `taskStepStat`, which is
//     keyed by STEP ID — names come from the map (`GET /api/maps/{mapId}`).
//   - `GET /api/campaigns/download-exceptions?campaigns=&mapIds=` answers a file, never a count
//     (octet-stream + Content-Disposition): a CSV for one campaign, a ZIP of CSVs for several.
//     Rows are counted here.
import { sleep } from '../util.mjs';

export const TERMINAL = /^(Finished|Stopped|Undefined)$/i;
/** A campaign still `Starting` after this long is wedged, not slow (§F8/§F10). */
export const STARTING_WEDGED_MS = 60_000;
export const STARTING_EXPLANATION = 'a campaign stuck in "Starting" usually means OpenSearch refuses index creation '
  + '(cluster.blocks.create_index) — run: uxc doctor --f2. It also blocks the map\'s deletion (§F8/§F10).';

const PUNNET_STATES = { ok: 'ProcessedOK', exception: 'ProcessedException', queued: 'Queued', processing: 'Processing' };

/** The broker answers status as a bare JSON string; tolerate a still-quoted text body too. */
export const unquote = (s) => String(s ?? '').replace(/^"|"$/g, '');

const enc = encodeURIComponent;

export async function campaignStatus(f2, campaign) {
  return unquote(await f2.get(`/api/campaigns/${enc(campaign)}/status`));
}

/**
 * Every campaign with its status -> [{name, status}]. One status call per campaign (the broker has
 * no bulk status yet, B03): the one loop `f2 ls --campaigns` and `f2 lib` share (review #14).
 */
export async function campaignStatuses(f2) {
  const names = (await f2.get('/api/campaigns/search-by-pattern?namePattern=.*'))?.collection ?? [];
  const out = [];
  for (const name of names) out.push({ name, status: await campaignStatus(f2, name) });
  return out;
}

export async function campaignStats(f2, campaign) {
  return f2.get(`/api/campaigns/${enc(campaign)}/stats`);
}

/** step id -> authored name, from the campaign's map. A deleted map leaves the ids as they are. */
export async function stepNames(f2, mapId) {
  if (!mapId) return new Map();
  const map = await f2.tryGet(`/api/maps/${enc(mapId)}`);
  return new Map((map?.steps ?? []).map((s) => [s.id, s.name ?? s.id]));
}

const ms = (d) => {
  const v = typeof d === 'object' && d !== null ? d.value ?? d : d;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * The punnet summary — ONE shape for status, watch and run:
 * {campaign, mapId, status, elapsedSec, ok, exception, queued, processing,
 *  steps:[{step, ok, exception, queued, processing, speed}]}.
 * `speed` is the step's ProcessedOK + ProcessedException speed as the broker reports it.
 * `elapsedSec` runs from stats.startDate to finishDate|stopDate, or to `now` while running.
 */
export function summarize({ campaign, status, stats, names = new Map(), now = Date.now() }) {
  const steps = [];
  const tot = { ok: 0, exception: 0, queued: 0, processing: 0 };
  for (const [sid, st] of Object.entries(stats?.taskStepStat ?? {})) {
    const s = st?.stats ?? {};
    const row = { step: names.get(sid) ?? sid };
    for (const [k, state] of Object.entries(PUNNET_STATES)) {
      row[k] = Number(s[state]?.total ?? 0);
      tot[k] += row[k];
    }
    row.speed = Number(s.ProcessedOK?.speed ?? 0) + Number(s.ProcessedException?.speed ?? 0);
    steps.push(row);
  }
  steps.sort((a, b) => String(a.step).localeCompare(String(b.step)));
  const start = ms(stats?.startDate);
  const end = ms(stats?.finishDate) ?? ms(stats?.stopDate) ?? (TERMINAL.test(status) ? null : now);
  const elapsedSec = start !== null && end !== null ? Math.max(0, Math.round((end - start) / 100) / 10) : null;
  return {
    campaign: stats?.campaign ?? campaign,
    mapId: stats?.taskFlowMapRef?.mapId ?? null,
    status,
    elapsedSec,
    ...tot,
    steps,
  };
}

/**
 * Read status + stats once, names resolved. `names` is a per-process cache (a Map keyed by mapId)
 * so a watch loop fetches the map once, not on every poll.
 */
export async function campaignSummary(f2, campaign, { cache = new Map(), now } = {}) {
  const status = await campaignStatus(f2, campaign);
  const stats = await f2.tryGet(`/api/campaigns/${enc(campaign)}/stats`);
  const mapId = stats?.taskFlowMapRef?.mapId ?? null;
  if (mapId && !cache.has(mapId)) cache.set(mapId, await stepNames(f2, mapId));
  return { summary: summarize({ campaign, status, stats, names: cache.get(mapId), now }), stats };
}

export function renderSummary(out, s) {
  out.line(`${s.campaign}   ${s.status}   ${s.elapsedSec ?? '?'}s${s.mapId ? `   (map ${s.mapId})` : ''}`);
  out.table(s.steps, [
    { key: 'step' }, { key: 'queued', label: 'Queued' }, { key: 'processing', label: 'Processing' },
    { key: 'ok', label: 'ProcessedOK' }, { key: 'exception', label: 'ProcessedException' }, { key: 'speed', label: 'speed' },
  ]);
  out.line(`totals: ${s.ok} ok · ${s.exception} exception · ${s.queued} queued · ${s.processing} processing`);
}

/**
 * Poll status + stats until a terminal state or the timeout, on ONE client (one token for the whole
 * watch — the f2 client re-logs-in only on a 401/generic 403, never per poll). The Starting warning
 * is emitted once, when the campaign has been Starting for STARTING_WEDGED_MS, counted from
 * stats.startDate when the broker gives one, else from the first poll that saw it.
 * -> { summary, timedOut }
 */
export async function watchCampaign(f2, campaign, {
  intervalMs = 5000, timeoutMs = 600_000, onTick = () => {}, onWedged = () => {},
  wedgedMs = STARTING_WEDGED_MS,
} = {}) {
  const cache = new Map();
  const t0 = Date.now();
  let firstStarting = null;
  let warned = false;
  for (;;) {
    const { summary, stats } = await campaignSummary(f2, campaign, { cache });
    if (TERMINAL.test(summary.status)) return { summary, timedOut: false };
    if (/^Starting$/i.test(summary.status)) {
      firstStarting ??= Date.now();
      const since = Math.min(firstStarting, ms(stats?.startDate) ?? firstStarting);
      if (!warned && Date.now() - since >= wedgedMs) { warned = true; onWedged(summary); }
    }
    onTick(summary);
    if (Date.now() - t0 + intervalMs > timeoutMs) return { summary, timedOut: true };
    await sleep(intervalMs);
  }
}

/** The "could not find campaign" 400 the broker answers for an unknown name, as its own text. */
export function unknownCampaign(e) {
  const body = typeof e?.body === 'string' ? e.body : e?.body?.message;
  return e?.status === 400 && /could not find campaign/i.test(String(body ?? '')) ? String(body).trim() : null;
}

// ---- exceptions (FAST-5879) -------------------------------------------------------------------

/** RFC 4180 CSV -> array of records (quoted fields, "" escapes, embedded commas/newlines, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * Count an exceptions export: rows (data records), byStep {step: {exceptionClass: n}} and the top
 * `n` (step, exception class) pairs. Columns are found by header name (`Step`, `ExceptionType`, §F35).
 */
export function countExceptions(text, { top = 5 } = {}) {
  const [header = [], ...data] = parseCsv(text);
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iStep = col('Step');
  const iType = col('ExceptionType');
  const byStep = {};
  const pairs = new Map();
  for (const r of data) {
    const step = iStep >= 0 ? r[iStep] || '(no step)' : '(no step)';
    const cls = iType >= 0 ? r[iType] || '(no class)' : '(no class)';
    byStep[step] ??= {};
    byStep[step][cls] = (byStep[step][cls] ?? 0) + 1;
    const k = JSON.stringify([step, cls]);
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const topPairs = [...pairs.entries()]
    .map(([k, count]) => { const [step, exception] = JSON.parse(k); return { step, exception, count }; })
    .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step) || a.exception.localeCompare(b.exception))
    .slice(0, top);
  return { rows: data.length, byStep, top: topPairs, columns: { step: iStep >= 0, exception: iType >= 0 } };
}

/** The download path: campaigns and mapIds as same-length, order-paired comma lists. */
export function exceptionsPath(campaigns, mapIds) {
  if (campaigns.length !== mapIds.length) throw new Error('download-exceptions needs as many mapIds as campaigns');
  return `/api/campaigns/download-exceptions?campaigns=${campaigns.map(enc).join(',')}&mapIds=${mapIds.map(enc).join(',')}`;
}
