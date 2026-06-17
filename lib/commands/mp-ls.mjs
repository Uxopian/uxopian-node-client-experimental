// uxc mp ls — browse the marketplace (spec §7.2). Filters map 1:1 to the query params.
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';

export default {
  name: 'mp-ls',
  summary: 'browse marketplace addons (--category --audience --product --compat --q --limit --offset)',
  help: 'uxc mp ls [--q text] [--category c] [--audience generic|customer-demo|prospect-demo] [--product flowerdocs|uxopian-ai] [--compat 5.6] [--limit 24] [--offset 0]',
  async run(ctx) {
    const { flags, out } = ctx;
    // map to the deployed marketplace-browse query params (compatibility is a single tag match)
    const params = {
      q: flags.q, category: flags.category, audience: flags.audience, product: flags.product,
      compatibility: flags.compat ?? flags.fd ?? flags.uxai,
      limit: flags.limit ?? flags['page-size'], offset: flags.offset,
    };
    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));
    const res = await client.listAddons(params);
    const rows = (res?.addons ?? []).map((a) => ({
      slug: a.slug,
      name: a.name,
      version: a.latest_version,
      audience: a.audience === 'generic' ? 'generic' : `${a.audience}${a.account ? `:${a.account}` : ''}`,
      category: a.category,
      products: (a.products ?? []).map((p) => (p === 'flowerdocs' ? 'FD' : p === 'uxopian-ai' ? 'AI' : p)).join('+'),
      objects: a.object_count,
    }));
    out.table(rows, [
      { key: 'slug' }, { key: 'name', max: 32 }, { key: 'version' },
      { key: 'audience', max: 24 }, { key: 'category', max: 22 }, { key: 'products' }, { key: 'objects' },
    ]);
    out.line(`${rows.length} of ${res?.total ?? rows.length} addon(s)`);
    out.result(res);
  },
};
