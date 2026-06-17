// uxc target add — register an instance in ~/.uxopian/targets.json (chmod 600).
import { loadTargets, saveTargets, TARGETS_FILE } from '../config.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'target-add',
  summary: 'register a target instance (url/scope/user/password) in ~/.uxopian/targets.json',
  help: 'uxc target add <name> --url https://host --scope SCOPE --user u --password p [--default]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const name = args[0];
    const missing = ['url', 'scope', 'user', 'password'].filter((k) => typeof flags[k] !== 'string' || !flags[k]);
    if (!name || missing.length) {
      fail(
        'usage: uxc target add <name> --url https://host --scope SCOPE --user u --password p [--default]' +
        (missing.length ? `\nmissing: --${missing.join(' --')}` : ''),
      );
    }
    const conf = loadTargets();
    conf.targets ??= {};
    conf.targets[name] = {
      url: String(flags.url).replace(/\/+$/, ''),
      scope: String(flags.scope),
      user: String(flags.user),
      password: String(flags.password),
    };
    if (flags.default !== undefined || !conf.default) conf.default = name;
    saveTargets(conf);
    out.line(`target ${name} saved${conf.default === name ? ' (default)' : ''} — ${conf.targets[name].url} scope ${conf.targets[name].scope} (${TARGETS_FILE})`);
    out.result({ name, url: conf.targets[name].url, scope: conf.targets[name].scope, default: conf.default === name });
  },
};
