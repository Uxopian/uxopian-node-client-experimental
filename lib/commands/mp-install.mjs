// uxc mp install <slug>[@version] --target <name> — the trusted marketplace -> instance pipeline.
// Reads the marketplace's PUBLISHED artifact hash, downloads the .uxpkg, verifies the download
// matches that hash, then imports with the SAME hash as the gate so the archive is re-verified
// before a single resource is written to the FlowerDocs / Uxopian AI servers (defense in depth).
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { importPackage } from '../packageio.mjs';
import { assertClientSupports } from '../version.mjs';
import { assertServerSupported } from '../dialects.mjs';
import { declaredVariables, resolveValues, variablesTable } from '../variables.mjs';
import { collectRepeatedFlag, kvPairs } from '../util.mjs';
import { readFileSync as readFs } from 'node:fs';
import { sha256, shaEq } from '../util.mjs';
import { fail } from '../output.mjs';

export default {
  name: 'mp-install',
  summary: 'download an addon version, verify its hash, and deploy it to a target (trusted pipeline)',
  help: 'uxc mp install <slug>[@version] [--var name=value]… [--var-file f.json] [--target <name>] [--force] [--code-remap old=new]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const spec = args[0];
    if (!spec) fail('usage: uxc mp install <slug>[@version] [--target <name>] [--force]');
    const [slug, atVersion] = spec.split('@');

    // Resolve the deploy target up front (--target name, else UXC_* env, else the default target).
    // No network yet — this just validates the instance is configured and fails fast if not.
    ctx.connect();

    const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));

    // 1. resolve version + the PUBLISHED (trusted) artifact hash
    let version = atVersion;
    if (!version) {
      const addon = await client.getAddon(slug);
      version = addon?.addon?.latest_version;
      if (!version) fail(`addon "${slug}" has no published version to install`);
    }
    const vd = await client.getVersion(slug, version);
    const publishedSha = vd?.version?.artifact?.sha256 ?? null;
    if (!publishedSha) fail(`marketplace did not return an artifact sha256 for ${slug}@${version} — cannot verify; aborting.`);

    // CLIENT-VERSION GATE (pre-download): refuse a package this uxc can't fully deploy BEFORE
    // spending the download. The marketplace stores the manifest verbatim, so minClientVersion is
    // here. importPackage re-checks the unpacked manifest as defense in depth.
    assertClientSupports(vd?.version?.manifest ?? {}, {
      ignore: !!flags['ignore-client-version'], out, action: 'install',
    });
    // SERVER-version pre-check off the marketplace-stored manifest — refuse BEFORE downloading
    await assertServerSupported(ctx, vd?.version?.manifest ?? {}, {
      ignore: !!flags['ignore-server-version'], out, action: 'install',
    });

    // package-variables pre-check (DESIGN §21) — missing required values fail BEFORE the download
    const vars = kvPairs(collectRepeatedFlag('var'));
    const varFile = typeof flags['var-file'] === 'string' ? JSON.parse(readFs(flags['var-file'], 'utf8')) : {};
    const mpManifest = vd?.version?.manifest ?? {};
    if (Object.keys(declaredVariables(mpManifest)).length) {
      const { missing, unknown, invalid, values } = resolveValues(mpManifest, { vars, varFile });
      if (unknown.length) fail(`unknown --var name(s): ${unknown.join(', ')} — ${slug} declares: ${Object.keys(declaredVariables(mpManifest)).join(', ')}`);
      if (invalid.length) fail(`variable value(s) failed validation:\n${invalid.map((i) => `  ${i.name}=${i.value} does not match ${i.pattern}`).join('\n')}`);
      if (missing.length) {
        const table = variablesTable(mpManifest, values)
          .map((r) => `  ${r.name.padEnd(16)} ${r.required.padEnd(4)} ${r.value.padEnd(28)} ${r.description}`).join('\n');
        fail(`${slug}@${version} requires variable value(s): ${missing.join(', ')}\n  name             req  value                        description\n${table}\nre-run with --var name=value (nothing was downloaded).`);
      }
    }

    // 2. download + verify the bytes match what the marketplace published
    const bytes = await client.downloadArtifact(slug, version);
    const gotSha = sha256(bytes);
    if (!shaEq(gotSha, publishedSha)) {
      fail(
        `integrity check FAILED for ${slug}@${version} download — aborting before deploy.\n` +
        `  published ${publishedSha}\n  downloaded ${gotSha}\n` +
        'the downloaded archive does not match the marketplace hash (tampered/corrupted in transit).',
      );
    }
    out.line(`${slug}@${version} downloaded ${(bytes.length / 1024).toFixed(1)} KiB — hash verified ${gotSha.slice(0, 19)}…`);

    // 3. deploy, re-verifying the same hash right before any server write (target resolved above)
    const work = mkdtempSync(join(tmpdir(), 'uxc-mp-install-'));
    const file = join(work, vd?.version?.artifact?.filename ?? `${slug}-${version}.uxpkg`);
    try {
      writeFileSync(file, bytes);
      const remap = typeof flags['code-remap'] === 'string' ? flags['code-remap'] : null;
      out.line(`deploying to ${ctx.target?.name ?? flags.target} (collisions pre-flighted before any write)…`);
      const res = await importPackage(ctx, file, {
        remap, force: !!flags.force, expectSha256: publishedSha,
        ignoreClientVersion: !!flags['ignore-client-version'],
        ignoreServerVersion: !!flags['ignore-server-version'],
        vars, varFile,
      });
      out.line(`installed ${slug}@${version}: pushed ${res.pushed?.length ?? 0}, ${res.collisions?.length ?? 0} collision(s)`);
      out.result({ slug, version, sha256: gotSha, verified: true, target: ctx.target?.name, pushed: res.pushed, collisions: res.collisions });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};
