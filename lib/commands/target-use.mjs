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
    out.line(`default target: ${name} (${conf.targets[name].url} scope ${conf.targets[name].scope})`);
    out.result({ default: name });
  },
};
