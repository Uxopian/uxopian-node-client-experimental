// uxc target add — register an instance in ~/.uxopian/targets.json (chmod 600).
// Configure the two surfaces explicitly: --core (…/core) and --ai (…/uxopian-ai). A legacy
// --url <host> shorthand still derives /core, /gui and the gateway from the host + scope.
import { loadTargets, saveTargets, resolveTarget, TARGETS_FILE } from '../config.mjs';
import { fail } from '../output.mjs';

const USAGE =
  'usage: uxc target add <name> --core https://host/core ' +
  '--ai https://host/gui/plugins/<scope>/gateway/uxopian-ai --scope SCOPE --user u --password p ' +
  '[--gui https://host/gui] [--f2 http://host:1789 --f2-user EMAIL --f2-password P] [--default] [--allow-tests]\n' +
  '  (legacy shorthand: --url https://host --scope SCOPE --user u --password p — derives /core, /gui, gateway)\n' +
  '  fast2 (--f2) is a SEPARATE product with its OWN user store — its credentials are not the FlowerDocs ones';

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
    const f2 = trim(flags.f2);
    const str = (v) => (typeof v === 'string' && v ? v : undefined);
    const scope = str(flags.scope), user = str(flags.user), password = str(flags.password);
    const f2User = str(flags['f2-user']), f2Password = str(flags['f2-password']);

    const missing = [];
    if (!name) missing.push('<name>');
    if (!core && !url) missing.push('--core (or legacy --url)');
    if (!scope) missing.push('--scope');
    if (!user) missing.push('--user');
    if (!password) missing.push('--password');
    if (f2 && !(f2User && f2Password)) {
      missing.push(...[!f2User && '--f2-user', !f2Password && '--f2-password'].filter(Boolean));
    }
    if (missing.length) fail(`${USAGE}\nmissing: ${missing.join(' ')}`);

    const entry = { scope, user, password };
    if (flags['allow-tests']) entry.allowTests = true; // standing opt-in for `uxc test` (DESIGN §24)
    if (core) entry.core = core;
    if (ai) entry.ai = ai;
    if (gui) entry.gui = gui;
    if (url) entry.url = url;
    // fast2 broker (optional): own base URL + own credentials, never derived (FAST2-LEARNINGS §F3)
    if (f2) {
      entry.f2 = f2;
      if (f2User) entry.f2User = f2User;
      if (f2Password) entry.f2Password = f2Password;
    }

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
    if (t.f2) out.note(`f2   ${t.f2}  (user ${t.f2User})`);
    // derivation is host-based and WRONG on split-port setups (Core and GUI on different ports)
    if (!gui) out.warn(`gui ${t.gui} was DERIVED from the core host — pass --gui if the GUI runs on a different host/port`);
    if (!ai) out.warn(`ai gateway ${t.gateway} was DERIVED from the core host — pass --ai if the gateway runs on a different host/port`);
    out.result({ name, core: t.core, ai: t.gateway, gui: t.gui, f2: t.f2 ?? null, scope: t.scope, default: conf.default === name });
  },
};
