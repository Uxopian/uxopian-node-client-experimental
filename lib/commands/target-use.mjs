// uxc target use — set the default target.
import { loadTargets, saveTargets } from '../config.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'target-use',
  summary: 'set the default target',
  help: 'uxc target use <name>',
  async run(ctx) {
    const { args, out } = ctx;
    const name = args[0];
    if (!name) fail('usage: uxc target use <name>');
    const conf = loadTargets();
    if (!conf.targets?.[name]) {
      fail(`unknown target "${name}" — configured: ${Object.keys(conf.targets ?? {}).join(', ') || '(none)'}`);
    }
    conf.default = name;
    saveTargets(conf);
    const e = conf.targets[name];
    out.line(`default target: ${name} (${e.core ?? e.url ?? '?'} scope ${e.scope})`);
    out.result({ default: name });
  },
};
