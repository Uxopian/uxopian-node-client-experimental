// uxc f2 exceptions <campaign…> [--out file] — save the exception export of one or more campaigns
// and count it (FAST-5879). The mapId of each campaign comes from its stats.taskFlowMapRef; the
// broker pairs `campaigns=` and `mapIds=` in order and answers ONE file, never a count: a CSV for
// one campaign, a ZIP of `<campaign>_exceptions.csv` for several (FAST2-LEARNINGS §F35). The rows
// and the top (step, exception class) pairs are counted here.
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { fail } from '../output.mjs';
import { HttpError } from '../http.mjs';
import { unzipTo } from '../zip.mjs';
import { campaignStats, countExceptions, exceptionsPath, unknownCampaign } from '../f2/campaign.mjs';

const USAGE = 'uxc f2 exceptions <campaign…> [--out <file>] [--json]';

/** The extension the broker announces (Content-Disposition filename), else null. */
function extOf(headers) {
  const cd = headers?.get?.('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return (m ? /\.([A-Za-z0-9]{1,8})$/.exec(m[1].trim())?.[1] : null)?.toLowerCase() ?? null;
}

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');
const isZip = (b) => b?.length >= 4 && b.readUInt32LE(0) === 0x04034b50;

/** The CSV texts of a saved export: the file itself, or each .csv entry of a zip -> [{name, text}]. */
async function csvTexts(file, bytes) {
  if (!isZip(bytes)) return [{ name: null, text: bytes.toString('utf8') }];
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-f2exc-'));
  try {
    await unzipTo(file, dir);
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')).sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Merge the per-file counts: rows summed, byStep merged, the top pairs recomputed. */
function merge(counts, top = 5) {
  const byStep = {};
  for (const c of counts) {
    for (const [step, classes] of Object.entries(c.byStep)) {
      byStep[step] ??= {};
      for (const [cls, n] of Object.entries(classes)) byStep[step][cls] = (byStep[step][cls] ?? 0) + n;
    }
  }
  const pairs = Object.entries(byStep).flatMap(([step, classes]) => Object.entries(classes).map(([exception, count]) => ({ step, exception, count })));
  pairs.sort((a, b) => b.count - a.count || a.step.localeCompare(b.step) || a.exception.localeCompare(b.exception));
  return {
    rows: counts.reduce((n, c) => n + c.rows, 0),
    byStep,
    top: pairs.slice(0, top),
    grouped: counts.every((c) => !c.rows || (c.columns.step && c.columns.exception)),
  };
}

export default {
  name: 'f2-exceptions',
  summary: 'download the exceptions of one or more fast2 campaigns as one file, with a row count',
  help: `${USAGE}\n`
    + '  --out <file>   where to save (default exceptions_<campaign>.<ext>, campaigns joined by "_");\n'
    + '                 the broker sends a .csv for one campaign, a .zip of one csv per campaign for several\n'
    + '  prints the row count and the top 5 (step, exception class) pairs',
  async run(ctx) {
    const { flags, out } = ctx;
    const campaigns = ctx.args.map(String).filter(Boolean);
    if (!campaigns.length) fail(`usage: ${USAGE}`);
    ctx.connect();
    const f2 = ctx.clients.f2;
    if (!f2) fail('this target has no fast2 surface — uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>');

    const mapIds = [];
    for (const c of campaigns) {
      let stats;
      try { stats = await campaignStats(f2, c); } catch (e) {
        const msg = unknownCampaign(e);
        if (msg) fail(`fast2: ${msg}`);
        throw e;
      }
      const mapId = stats?.taskFlowMapRef?.mapId;
      if (!mapId) fail(`fast2: campaign ${c} has no taskFlowMapRef.mapId in its stats — cannot ask for its exceptions`);
      mapIds.push(mapId);
    }

    const path = exceptionsPath(campaigns, mapIds);
    const r = await f2.raw('GET', path, undefined, { binary: true });
    if (r.status >= 400) {
      const msg = unknownCampaign({ status: r.status, body: r.json ?? r.text });
      if (msg) fail(`fast2: ${msg}`);
      throw new HttpError(r.status, r.json ?? r.text, f2.base + path, 'GET');
    }
    const file = resolve(String(flags.out || `exceptions_${campaigns.map(safe).join('_')}.${extOf(r.headers) ?? (isZip(r.bytes) ? 'zip' : 'csv')}`));
    writeFileSync(file, r.bytes);

    const parts = await csvTexts(file, r.bytes);
    const counted = merge(parts.map((p) => countExceptions(p.text)));
    out.line(`saved      ${file}${isZip(r.bytes) ? `  (zip: ${parts.length} csv)` : ''}`);
    out.line(`${counted.rows} exception row(s) for ${campaigns.join(', ')}`);
    if (!counted.grouped) {
      out.warn('the file has no Step/ExceptionType header — rows counted, not grouped');
    }
    if (counted.top.length) {
      out.table(counted.top, [{ key: 'count' }, { key: 'step' }, { key: 'exception', label: 'exception class', max: 80 }]);
    }
    out.result({ campaigns, mapIds, path: file, rows: counted.rows, byStep: counted.byStep, top: counted.top });
  },
};
