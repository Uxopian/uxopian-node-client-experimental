// uxc target ls — list configured targets (passwords masked, always).
import { loadTargets } from '../config.mjs';

export default {
  name: 'target-ls',
  summary: 'list configured targets (passwords masked)',
  help: 'uxc target ls',
  async run(ctx) {
    const { out } = ctx;
    const conf = loadTargets();
    const names = Object.keys(conf.targets ?? {});
    if (!names.length) {
      out.line('no targets — uxc target add <name> --url … --scope … --user … --password …');
      out.result([]);
      return;
    }
    const rows = names.map((n) => ({
      def: conf.default === n ? '*' : '',
      name: n,
      url: conf.targets[n].url,
      scope: conf.targets[n].scope,
      user: conf.targets[n].user,
      password: conf.targets[n].password ? '••••••' : '(none)',
    }));
    out.table(rows, [
      { key: 'def', label: ' ' }, { key: 'name' }, { key: 'url' },
      { key: 'scope' }, { key: 'user' }, { key: 'password' },
    ]);
    out.result(rows); // masked — credentials never leave targets.json
  },
};
