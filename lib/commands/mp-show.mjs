// uxc mp show <slug> [--version v] — addon detail + version history (+ object catalog for the
// selected/latest version). spec §7.3 / §7.4.
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-show',
  summary: 'show an addon: metadata, version history, and the object catalog of a version',
  help: 'uxc mp show <slug> [--version v] [--catalog]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const slug = args[0];
    if (!slug) fail('usage: uxc mp show <slug> [--version v] [--catalog]');
    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));

    const detail = await client.getAddon(slug);
    const a = detail?.addon ?? {};
    out.line(`${a.name ?? slug}  (${slug})`);
    out.note(`${a.summary ?? ''}`);
    out.note(`category ${a.category ?? '?'} · audience ${a.audience ?? '?'}${a.account ? ` · ${a.account}` : ''} · products ${(a.products ?? []).join(', ') || '—'}`);
    out.note(`maintainer ${a.maintainer?.name ?? '?'} <${a.maintainer?.email ?? '?'}> · latest ${a.latest_version ?? '—'}`);

    const versions = detail?.versions ?? [];
    out.line('versions:');
    out.table(versions.map((v) => ({
      version: v.version, status: v.status,
      flowerdocs: (v.compatibility?.flowerdocs ?? []).join('/') || '—',
      uxopianAi: (v.compatibility?.uxopianAi ?? []).join('/') || '—',
      objects: v.object_count, published: (v.published_at ?? '').slice(0, 10),
    })), [{ key: 'version' }, { key: 'status' }, { key: 'flowerdocs' }, { key: 'uxopianAi' }, { key: 'objects' }, { key: 'published' }]);

    let versionDetail = null;
    const want = typeof flags.version === 'string' ? flags.version : (flags.catalog ? a.latest_version : null);
    if (want) {
      versionDetail = await client.getVersion(slug, want);
      const v = versionDetail?.version ?? {};
      const counts = v.catalog?.counts ?? {};
      out.line(`catalog @ ${want}: ${v.catalog?.total ?? 0} objects`);
      out.note(Object.entries(counts).map(([k, n]) => `${k}:${n}`).join('  ') || '(none)');
      if (flags.catalog && v.catalog?.objects) {
        out.table(v.catalog.objects, [{ key: 'kind' }, { key: 'id' }, { key: 'title', max: 36 }, { key: 'note', max: 32 }, { key: 'policy' }]);
      }
    }
    out.result(versionDetail ?? detail);
  },
};
