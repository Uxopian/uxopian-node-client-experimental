// uxc mp categories — list the marketplace category vocabulary (with live addon counts).
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';

export default {
  name: 'mp-categories',
  summary: 'list marketplace categories (with addon counts)',
  help: 'uxc mp categories',
  async run(ctx) {
    const { out } = ctx;
    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));
    const res = await client.categories();
    const rows = res?.categories ?? [];
    out.table(rows, [{ key: 'key' }, { key: 'label' }, { key: 'count' }]);
    out.result(res);
  },
};
