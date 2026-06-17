// uxc mp rm <slug> — archive a listing (soft-delete; hidden from default browse). Gated: requires
// --yes (typing intent). Hard deletion is admin-only and not exposed via the API (spec §6.7).
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-rm',
  summary: 'archive a marketplace listing (soft-delete; requires --yes)',
  help: 'uxc mp rm <slug> --yes',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const slug = args[0];
    if (!slug) fail('usage: uxc mp rm <slug> --yes');
    if (!flags.yes) fail(`refusing to archive "${slug}" without --yes (this hides the listing from browse; versions are kept)`);
    const client = createMarketplaceClient(resolveMarketplace());
    const res = await client.archiveAddon(slug);
    out.line(`archived ${slug} (status ${res?.addon?.status ?? 'archived'})`);
    out.result(res);
  },
};
