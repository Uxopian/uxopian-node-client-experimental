// uxc installed — list the package receipts on the connected target (DESIGN §19):
// which packages are installed, at which version, deployed by which uxc, when.
// Works WITHOUT a package checkout (that is the point). Receipts are written automatically by
// `uxc import` and `uxc push --all`; `uxc installed --write` stamps them for the current package.
import { readReceipts, writeReceipts } from '../receipt.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'installed',
  summary: 'list package receipts on the target (which package/version is deployed here)',
  help: 'uxc installed [--code <c>] [--write]   (--write: stamp receipts for the current package)',
  async run(ctx) {
    const { out, flags } = ctx;
    ctx.connect();

    if (flags.write) {
      const pkg = ctx.requirePkg();
      const res = await writeReceipts(ctx, pkg.manifest, {});
      for (const r of res) {
        if (r.ok) out.line(`stamped   ${r.surface}  ${r.receipt.code}@${r.receipt.version} (uxc ${r.receipt.uxcVersion})`);
        else out.warn(`receipt FAILED on ${r.surface}: ${r.error}`);
      }
      if (!res.length) fail('this package declares no products (manifest.products) — nothing to stamp');
    }

    const code = typeof flags.code === 'string' ? flags.code : null;
    const receipts = await readReceipts(ctx, { code });
    if (!receipts.length) {
      out.line(`no package receipts on ${ctx.target.name}${code ? ` for "${code}"` : ''} — deploy with uxc import / uxc push --all (uxc ≥ 0.5), or stamp with uxc installed --write`);
      out.result([]);
      return;
    }
    receipts.sort((a, b) => `${a.code}/${a.surface}`.localeCompare(`${b.code}/${b.surface}`));
    out.table(receipts.map((r) => ({
      code: r.code, surface: r.surface, version: r.version,
      uxc: r.uxcVersion, installedAt: r.installedAt,
      sha: r.artifactSha ? String(r.artifactSha).replace(/^sha256:/, '').slice(0, 8) : '',
    })), [
      { key: 'code' }, { key: 'surface' }, { key: 'version' }, { key: 'uxc' },
      { key: 'installedAt', max: 24 }, { key: 'sha' },
    ]);
    out.line(`${receipts.length} receipt(s) on ${ctx.target.name}`);
    out.result(receipts);
  },
};
