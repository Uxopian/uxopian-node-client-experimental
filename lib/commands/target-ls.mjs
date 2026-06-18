// uxc target ls — list configured targets (passwords masked, always).
import { loadTargets } from '../config.mjs';

const trim = (u) => (u ? String(u).replace(/\/+$/, '') : null);

/** Stored config -> effective core / ai bases (mirrors resolveTarget's derivation, env-free). */
function bases(e) {
  const host = trim(e.url) || (e.core ? trim(e.core).replace(/\/core$/i, '') : null);
  const core = trim(e.core) || (host ? `${host}/core` : '?');
  const ai = trim(e.ai) || trim(e.gateway)
    || (host && e.scope ? `${host}/gui/plugins/${e.scope}/gateway/uxopian-ai` : '(derived)');
  return { core, ai };
}

export default {
  name: 'target-ls',
  summary: 'list configured targets (passwords masked)',
  help: 'uxc target ls',
  async run(ctx) {
    const { out } = ctx;
    const conf = loadTargets();
    const names = Object.keys(conf.targets ?? {});
    if (!names.length) {
      out.line('no targets — uxc target add <name> --core https://host/core --ai https://host/…/uxopian-ai --scope … --user … --password …');
      out.result([]);
      return;
    }
    const rows = names.map((n) => {
      const e = conf.targets[n];
      const { core, ai } = bases(e);
      return {
        def: conf.default === n ? '*' : '',
        name: n,
        core,
        ai,
        scope: e.scope,
        user: e.user,
        password: e.password ? '••••••' : '(none)',
      };
    });
    out.table(rows, [
      { key: 'def', label: ' ' }, { key: 'name' }, { key: 'core', max: 44 }, { key: 'ai', max: 52 },
      { key: 'scope' }, { key: 'user' }, { key: 'password' },
    ]);
    out.result(rows); // masked — credentials never leave targets.json
  },
};
