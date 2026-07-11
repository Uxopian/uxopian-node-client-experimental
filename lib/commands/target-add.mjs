// uxc target add — register an instance in ~/.uxopian/targets.json (chmod 600).
// Configure the two surfaces explicitly: --core (…/core) and --ai (…/uxopian-ai). A legacy
// --url <host> shorthand still derives /core, /gui and the gateway from the host + scope.
import { loadTargets, saveTargets, resolveTarget, TARGETS_FILE } from '../config.mjs';
import { fail } from '../output.mjs';

const USAGE =
  'usage: uxc target add <name> --core https://host/core ' +
  '--ai https://host/gui/plugins/<scope>/gateway/uxopian-ai --scope SCOPE --user u --password p ' +
  '[--gui https://host/gui] [--default] [--allow-tests]\n' +
  '  (legacy shorthand: --url https://host --scope SCOPE --user u --password p — derives /core, /gui, gateway)';

const trim = (u) => (typeof u === 'string' && u ? u.replace(/\/+$/, '') : undefined);

export default {
  name: 'target-add',
  summary: 'register a target: --core …/core --ai …/uxopian-ai --scope --user --password (legacy: --url host)',
  help: USAGE,
  async run(ctx) {
    const { args, flags, out } = ctx;
    const name = args[0];
    const core = trim(flags.core);
    const ai = trim(flags.ai);
    const gui = trim(flags.gui);
    const url = trim(flags.url);
    const str = (v) => (typeof v === 'string' && v ? v : undefined);
    const scope = str(flags.scope), user = str(flags.user), password = str(flags.password);

    const missing = [];
    if (!name) missing.push('<name>');
    if (!core && !url) missing.push('--core (or legacy --url)');
    if (!scope) missing.push('--scope');
    if (!user) missing.push('--user');
    if (!password) missing.push('--password');
    if (missing.length) fail(`${USAGE}\nmissing: ${missing.join(' ')}`);

    const entry = { scope, user, password };
    if (flags['allow-tests']) entry.allowTests = true; // standing opt-in for `uxc test` (DESIGN §24)
    if (core) entry.core = core;
    if (ai) entry.ai = ai;
    if (gui) entry.gui = gui;
    if (url) entry.url = url;

    const conf = loadTargets();
    conf.targets ??= {};
    conf.targets[name] = entry;
    if (flags.default !== undefined || !conf.default) conf.default = name;
    saveTargets(conf);

    // show the EFFECTIVE bases (after derivation), so the user sees exactly what will be called
    const t = resolveTarget(name);
    out.line(`target ${name} saved${conf.default === name ? ' (default)' : ''}  (${TARGETS_FILE})`);
    out.note(`core ${t.core}`);
    out.note(`ai   ${t.gateway}`);
    out.note(`scope ${t.scope} · user ${t.user}${t.gui ? ` · gui ${t.gui}` : ''}`);
    out.result({ name, core: t.core, ai: t.gateway, gui: t.gui, scope: t.scope, default: conf.default === name });
  },
};
