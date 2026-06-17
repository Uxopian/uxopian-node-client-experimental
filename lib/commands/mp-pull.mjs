// uxc mp pull <slug> [--version v] [-o file.uxpkg] — download a version artifact (spec §7.5),
// so Claude can `uxc import` a marketplace addon (incl. a previous version) onto an instance.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { sha256 } from '../util.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-pull',
  summary: 'download an addon version as a .uxpkg (defaults to the latest version)',
  help: 'uxc mp pull <slug> [--version v] [-o file.uxpkg]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const slug = args[0];
    if (!slug) fail('usage: uxc mp pull <slug> [--version v] [-o file.uxpkg]');
    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));

    // resolve version + the canonical artifact filename / expected hash from the version detail
    const detail = await client.getAddon(slug);
    let version = typeof flags.version === 'string' ? flags.version : detail?.addon?.latest_version;
    if (!version) fail(`addon "${slug}" has no published version to pull`);
    const vd = await client.getVersion(slug, version);
    const art = vd?.version?.artifact ?? {};

    const outFile = resolve(
      (ctx.args.includes('-o') ? ctx.args[ctx.args.indexOf('-o') + 1] : null) ??
      (typeof flags.o === 'string' ? flags.o : null) ??
      (typeof flags.output === 'string' ? flags.output : null) ??
      art.filename ?? `${slug}-${version}.uxpkg`,
    );

    const bytes = await client.downloadArtifact(slug, version);
    writeFileSync(outFile, bytes);
    const got = sha256(bytes);
    const ok = !art.sha256 || art.sha256 === got;
    out.line(`pulled ${slug}@${version} -> ${outFile}  (${(bytes.length / 1024).toFixed(1)} KiB)`);
    if (!ok) out.warn(`sha256 MISMATCH: expected ${art.sha256}, got ${got}`);
    else if (art.sha256) out.note(`sha256 ok ${got.slice(0, 19)}…`);
    out.note(`install: uxc import ${outFile} --target <name>`);
    out.result({ slug, version, file: outFile, bytes: bytes.length, sha256: got, sha256_ok: ok });
  },
};
