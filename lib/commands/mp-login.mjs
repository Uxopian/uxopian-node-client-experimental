// uxc mp login — save the Pulse marketplace endpoint + per-maintainer API key to
// ~/.uxopian/marketplace.json (chmod 600). The key is a credential: never committed, never
// exported in a .uxpkg. `--verify` hits GET /whoami to confirm the key resolves.
import { loadMarketplace, saveMarketplace, resolveMarketplace, MARKETPLACE_FILE } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-login',
  summary: 'save the marketplace endpoint + per-maintainer API key (~/.uxopian/marketplace.json)',
  help: 'uxc mp login --url https://pulse.<host> --token uxmk_… [--name "…" --email …] [--verify]',
  async run(ctx) {
    const { flags, out } = ctx;
    const conf = loadMarketplace();
    if (typeof flags.url === 'string') conf.url = flags.url.replace(/\/+$/, '');
    if (typeof flags.token === 'string') conf.token = flags.token;
    if (typeof flags.name === 'string' || typeof flags.email === 'string') {
      conf.maintainer = {
        name: typeof flags.name === 'string' ? flags.name : conf.maintainer?.name ?? '',
        email: typeof flags.email === 'string' ? flags.email : conf.maintainer?.email ?? '',
      };
    }
    if (!conf.url) fail('usage: uxc mp login --url https://pulse.<host> --token uxmk_… [--name … --email …]');
    saveMarketplace(conf);

    const masked = conf.token ? conf.token.slice(0, 9) + '…' : '(none)';
    out.line(`marketplace saved — ${conf.url}  key ${masked}${conf.maintainer?.email ? `  maintainer ${conf.maintainer.email}` : ''}  (${MARKETPLACE_FILE})`);

    let who = null;
    if (flags.verify) {
      try {
        const cfg = resolveMarketplace();
        who = await createMarketplaceClient(cfg).whoami();
        out.line(`verified — ${who?.maintainer?.name ?? '?'} <${who?.maintainer?.email ?? '?'}>`);
      } catch (e) {
        out.warn(`verify failed: ${e.message}`);
      }
    }
    out.result({ url: conf.url, maintainer: conf.maintainer ?? null, whoami: who });
  },
};
