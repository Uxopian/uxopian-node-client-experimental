// uxc f2 ls — list the maps on the fast2 broker (name, version, mapId) and flag the two things
// that bite later: duplicate names (the `_new1` damage of FAST2-LEARNINGS §F7) and campaigns
// wedged in `Starting`, which block their map's deletion permanently (§F8).
import { fail } from '../output.mjs';

export default {
  name: 'f2-ls',
  summary: 'list fast2 maps on the target broker (--campaigns for their campaigns)',
  help: 'uxc f2 ls [--campaigns] [--json]',
  async run(ctx) {
    ctx.connect();
    const f2 = ctx.clients.f2;
    if (!f2) fail('this target has no fast2 surface — uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>');

    const maps = (await f2.get('/api/maps/summary/search-by-pattern?namePattern='))?.collection ?? [];
    const seen = new Map();
    for (const m of maps) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);

    const rows = maps
      .map((m) => ({ name: m.name, version: m.versionNumber, mapId: m.id?.mapId }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    ctx.out.table(rows, [{ key: 'name' }, { key: 'version' }, { key: 'mapId', max: 40 }]);
    ctx.out.line(`${rows.length} map(s) on ${f2.base}`);

    for (const [name, n] of seen) {
      if (n > 1) {
        ctx.out.warn(`${n} maps share the name "${name}" — an upload collision auto-renames instead of failing (§F7); delete the extras before pushing`);
      }
    }

    let campaigns = null;
    if (ctx.flags.campaigns) {
      campaigns = (await f2.get('/api/campaigns/search-by-pattern?namePattern=.*'))?.collection ?? [];
      const crows = [];
      for (const c of campaigns) {
        const status = String(await f2.get(`/api/campaigns/${encodeURIComponent(c)}/status`)).replace(/^"|"$/g, '');
        crows.push({ campaign: c, status });
        if (/^Starting$/i.test(status)) {
          ctx.out.warn(`campaign "${c}" is wedged in Starting — it can be neither stopped nor deleted via the API, and it BLOCKS its map's deletion (§F8; uxc doctor --f2 explains the escape)`);
        }
      }
      ctx.out.table(crows, [{ key: 'campaign' }, { key: 'status' }]);
    }
    ctx.out.result({ maps: rows, campaigns });
  },
};
