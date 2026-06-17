// uxc mp versions <slug> — version history of an addon (spec §7.3).
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-versions',
  summary: 'list an addon\'s version history (status, compatibility, publisher, date)',
  help: 'uxc mp versions <slug>',
  async run(ctx) {
    const { args, out } = ctx;
    const slug = args[0];
    if (!slug) fail('usage: uxc mp versions <slug>');
    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));
    const detail = await client.getAddon(slug);
    const versions = detail?.versions ?? [];
    out.line(`${slug} — ${versions.length} version(s), latest ${detail?.addon?.latest_version ?? '—'}`);
    out.table(versions.map((v) => ({
      version: v.version, status: v.status,
      flowerdocs: (v.compatibility?.flowerdocs ?? []).join('/') || '—',
      uxopianAi: (v.compatibility?.uxopianAi ?? []).join('/') || '—',
      by: v.published_by?.email ?? '', published: (v.published_at ?? '').slice(0, 10),
    })), [{ key: 'version' }, { key: 'status' }, { key: 'flowerdocs' }, { key: 'uxopianAi' }, { key: 'by', max: 28 }, { key: 'published' }]);
    out.result(detail);
  },
};
