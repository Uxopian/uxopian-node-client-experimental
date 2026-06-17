// uxc mp init — scaffold marketplace.json in the current package (the listing/version manifest
// the publisher sends). Derives slug/summary/products from uxopian-project.json and the maintainer
// from ~/.uxopian/marketplace.json. Refuses to overwrite an existing file unless --force.
import { writeFileSync, existsSync } from 'node:fs';
import { scaffoldMarketplace, marketplacePath, validateMarketplace } from '../catalog.mjs';
import { loadMarketplace } from '../mpconfig.mjs';
import { stableStringify } from '../util.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-init',
  summary: 'scaffold marketplace.json in the package (slug, audience, category, compatibility, assets)',
  help: 'uxc mp init [--force]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const path = marketplacePath(pkg);
    if (existsSync(path) && !flags.force) {
      fail(`marketplace.json already exists — edit it, or re-scaffold with --force: ${path}`);
    }
    const maintainer = loadMarketplace().maintainer ?? undefined;
    const mp = scaffoldMarketplace(pkg, { maintainer });
    writeFileSync(path, stableStringify(mp));
    out.line(`wrote ${path}`);
    out.note(`slug "${mp.slug}" · audience ${mp.audience} · category ${mp.category}`);

    const { errors, warnings } = validateMarketplace(mp, pkg);
    for (const w of warnings) out.note(`fill in: ${w}`);
    if (errors.length) {
      out.note('before `uxc mp publish`, complete these required fields:');
      for (const e of errors) out.note(`  - ${e}`);
    }
    out.result({ path, marketplace: mp, errors, warnings });
  },
};
