// uxc mp deprecate <slug> --version v — flip a version's lifecycle status (spec §6.6).
// Default action deprecates; --yank hides it (kept for audit); --reactivate re-publishes it.
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-deprecate',
  summary: 'deprecate / yank / reactivate an addon version (--version required; --yank, --reactivate, --reason)',
  help: 'uxc mp deprecate <slug> --version v [--reason "…"] [--yank] [--reactivate]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const slug = args[0];
    const version = typeof flags.version === 'string' ? flags.version : null;
    if (!slug || !version) fail('usage: uxc mp deprecate <slug> --version v [--reason "…"] [--yank] [--reactivate]');
    const status = flags.yank ? 'yanked' : flags.reactivate ? 'published' : 'deprecated';

    const client = createMarketplaceClient(resolveMarketplace());
    const res = await client.setVersionStatus(slug, version, {
      status, reason: typeof flags.reason === 'string' ? flags.reason : undefined,
    });
    out.line(`${slug}@${version} -> ${res?.version?.status ?? status}`);
    out.result(res);
  },
};
