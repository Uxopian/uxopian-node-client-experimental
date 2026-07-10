// uxc mp publish — publish the package as an addon version to the Pulse marketplace.
// Staged + resumable (spec §6): upsert listing -> create draft version (server returns signed
// upload URLs) -> upload the .uxpkg + screenshots/docs -> finalize (server verifies sha256).
//
// --dry-run does everything locally (export, catalog, validate, build payloads) and prints what
// WOULD be sent, touching no network — so the publisher is testable before Pulse ships the API.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportPackage } from '../packageio.mjs';
import { readMarketplaceManifest, validateMarketplace, buildCatalog } from '../catalog.mjs';
import { resolveMarketplace, loadMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient, contentTypeFor } from '../marketplace.mjs';
import { CLIENT_VERSION, minClientVersionOf, parseSemver, compareSemver, matchesVersionPattern } from '../version.mjs';
import { lintVariables, declaredVariables } from '../variables.mjs';
import { declaredDependencies } from '../dependencies.mjs';
import { sha256 } from '../util.mjs';
import { fail } from '../output.mjs';

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const prettyTitle = (f) => basename(f).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default {
  name: 'mp-publish',
  summary: 'publish the package as an addon version (upsert listing, upload artifact+assets, finalize)',
  help: 'uxc mp publish [--dry-run] [--allow-dirty] [--file f.uxpkg] [--audience …] [--account …] [--changelog …] [--fd 5.6] [--uxai 1.10]',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const m = pkg.manifest;
    const dryRun = !!flags['dry-run'];

    // ---- 1. listing/version metadata (marketplace.json + CLI overrides) ----
    const mp = readMarketplaceManifest(pkg);
    if (!mp) fail('no marketplace.json in this package — run `uxc mp init`, fill it in, then publish.');

    if (typeof flags.slug === 'string') mp.slug = flags.slug;
    if (typeof flags.audience === 'string') mp.audience = flags.audience;
    if (typeof flags.account === 'string') mp.account = flags.account;
    if (typeof flags.category === 'string') mp.category = flags.category;
    if (typeof flags.summary === 'string') mp.summary = flags.summary;
    if (typeof flags.tags === 'string') mp.tags = csv(flags.tags);
    const changelog = typeof flags.changelog === 'string' ? flags.changelog
      : typeof flags.notes === 'string' ? flags.notes : mp.changelog;
    mp.compatibility ??= {};
    if (typeof flags.fd === 'string') mp.compatibility.flowerdocs = csv(flags.fd);
    if (typeof flags.uxai === 'string') mp.compatibility.uxopianAi = csv(flags.uxai);
    // maintainer falls back to the configured default
    if (!mp.maintainer?.name || !mp.maintainer?.email) {
      const def = loadMarketplace().maintainer;
      if (def) mp.maintainer = { ...def, ...(mp.maintainer ?? {}) };
    }

    const { errors, warnings, resolved } = validateMarketplace(mp, pkg);
    if (!m.version) errors.push('uxopian-project.json: "version" is required to publish');
    // minClientVersion (the compatibility gate) rides verbatim in the manifest payload; validate it
    // here so a malformed/over-eager value is caught before publishing.
    const minClient = minClientVersionOf(m);
    if (minClient != null && minClient !== '') {
      if (!parseSemver(minClient).valid) {
        errors.push(`uxopian-project.json: minClientVersion "${minClient}" is not valid semver (e.g. "0.2.0")`);
      } else if (compareSemver(CLIENT_VERSION, minClient) < 0) {
        warnings.push(`minClientVersion ${minClient} is NEWER than the publishing client ${CLIENT_VERSION} — you are publishing a package this very client could not fully deploy; upgrade uxc or lower minClientVersion`);
      }
    }
    // supportedVersions patterns must parse ('*', '2025.*', '>=2026', exact)
    for (const [prod, pats] of Object.entries(m.supportedVersions ?? {})) {
      for (const pat of (Array.isArray(pats) ? pats : [pats])) {
        try { matchesVersionPattern('1.0.0', pat); }
        catch { errors.push(`uxopian-project.json: supportedVersions.${prod} pattern "${pat}" does not parse`); }
        if (!/^(\*|[0-9][0-9.]*\.\*|(>=|<=|>|<)\s*[0-9][0-9.]*|[0-9][0-9.]*)$/.test(String(pat))) {
          errors.push(`uxopian-project.json: supportedVersions.${prod} pattern "${pat}" is not valid ('*', '2025.*', '>=2026', or exact)`);
        }
      }
    }
    // dependencies well-formedness (DESIGN §22): patterns must parse; a missing slug degrades
    // the fix-it hint to the code — warn.
    for (const d of declaredDependencies(m)) {
      for (const pat of d.versions) {
        if (!/^(\*|[0-9][0-9.]*\.\*|(>=|<=|>|<)\s*[0-9][0-9.]*|[0-9][0-9.]*)$/.test(String(pat))) {
          errors.push(`uxopian-project.json: dependencies.${d.code} pattern "${pat}" is not valid ('*', '1.1.*', '>=1.1', or exact)`);
        }
      }
      if (!d.slug) warnings.push(`dependencies.${d.code}: no "slug" — the guided fix will use the code as the marketplace slug`);
    }
    // package variables lint (DESIGN §21): every placeholder declared, no placeholders in
    // manifest/registry; unused declarations warn.
    const vlint = lintVariables(m, pkg.dir);
    for (const n of vlint.undeclared) errors.push(`placeholder {{uxc:${n}}} is not declared in uxopian-project.json variables`);
    for (const f of vlint.forbidden) errors.push(`placeholders are FORBIDDEN in ${f} (ids/sync keys must be concrete)`);
    for (const n of vlint.unused) warnings.push(`variable "${n}" is declared but no file uses {{uxc:${n}}}`);
    for (const w of warnings) out.warn(w);
    if (errors.length) fail('cannot publish — fix marketplace.json:\n' + errors.map((e) => `  - ${e}`).join('\n'));

    const slug = mp.slug;
    const version = m.version;

    // ---- 2. the artifact (.uxpkg): reuse --file, else export to a temp file ----
    let artifactPath, cleanupDir = null;
    if (typeof flags.file === 'string') {
      artifactPath = flags.file;
    } else {
      // export's dirty check (allowDirty=false) compares vs the default target -> needs a connection.
      let allowDirty = !!flags['allow-dirty'];
      if (!allowDirty) {
        try {
          ctx.connect();
        } catch (e) {
          if (!dryRun) throw e;                            // live publish must verify sync
          allowDirty = true;                               // dry-run tolerates no target
          out.warn('no FlowerDocs target connectable — dry-run skips the sync (dirty) check');
        }
      }
      cleanupDir = mkdtempSync(join(tmpdir(), 'uxc-publish-'));
      const outFile = join(cleanupDir, `${m.code}-${version}.uxpkg`);
      const res = await exportPackage(ctx, { output: outFile, allowDirty });
      artifactPath = res.output;
    }

    try {
      const artifactBytes = readFileSync(artifactPath);
      const artifact = {
        filename: basename(artifactPath),
        sha256: sha256(artifactBytes),
        bytes: artifactBytes.length,
        content_type: 'application/zip',
      };

      // ---- 3. catalog + asset descriptors ----
      const catalog = buildCatalog(pkg);
      const assetFiles = [
        ...resolved.screenshots.map((a, i) => ({ ...a, kind: 'screenshot', sort_order: i })),
        ...resolved.docs.map((a, i) => ({ ...a, kind: 'doc', sort_order: i })),
      ].map((a) => {
        const bytes = readFileSync(a.abs);
        return {
          kind: a.kind, filename: basename(a.rel), title: prettyTitle(a.rel),
          sha256: sha256(bytes), bytes: bytes.length, content_type: contentTypeFor(a.rel),
          sort_order: a.sort_order, _bytes: bytes,
        };
      });

      const listing = {
        name: m.name, code: m.code,
        summary: mp.summary,
        description: mp.description ?? m.description ?? mp.summary,
        category: mp.category, audience: mp.audience, account: mp.account ?? null,
        tags: mp.tags ?? [], products: m.products ?? [],
        maintainer: mp.maintainer,
      };
      const versionPayload = {
        version, changelog,
        compatibility: { flowerdocs: mp.compatibility.flowerdocs ?? [], uxopianAi: mp.compatibility.uxopianAi ?? [] },
        manifest: m,
        catalog,
        artifact,
        assets: assetFiles.map(({ _bytes, abs, rel, ...a }) => a),
      };

      // ---- summary line ----
      const compatLine = [
        versionPayload.compatibility.flowerdocs?.length ? `FlowerDocs ${versionPayload.compatibility.flowerdocs.join('/')}` : null,
        versionPayload.compatibility.uxopianAi?.length ? `Uxopian AI ${versionPayload.compatibility.uxopianAi.join('/')}` : null,
      ].filter(Boolean).join(' · ') || '(no compatibility tags)';
      out.line(`${slug}@${version}  ${mp.audience}${mp.account ? ` · ${mp.account}` : ''}  [${mp.category}]`);
      out.note(`artifact ${artifact.filename}  ${(artifact.bytes / 1024).toFixed(1)} KiB  ${artifact.sha256.slice(0, 19)}…`);
      out.note(`catalog ${catalog.total} objects (${Object.entries(catalog.counts).map(([k, n]) => `${k.split('.')[1]}:${n}`).join(' ')})`);
      out.note(`tested on ${compatLine}`);
      if (minClient) out.note(`requires uxc >= ${minClient}`);
      const varNames = Object.keys(declaredVariables(m));
      if (varNames.length) out.note(`variables: ${varNames.join(', ')} (install prompts via --var; uxc vars ${slug})`);
      const deps = declaredDependencies(m);
      if (deps.length) out.note(`dependencies: ${deps.map((d) => `${d.code} ${d.versions.join('|')}`).join(', ')}`);
      out.note(`assets: ${assetFiles.filter((a) => a.kind === 'screenshot').length} screenshot(s), ${assetFiles.filter((a) => a.kind === 'doc').length} doc(s)`);

      if (dryRun) {
        out.line('(dry run — nothing sent)');
        out.result({ dryRun: true, slug, version, listing, version_payload: versionPayload,
          uploads: { artifact: artifact.filename, assets: assetFiles.map((a) => a.filename) } });
        return;
      }

      // ---- 4. live publish ----
      const client = createMarketplaceClient(resolveMarketplace());
      const upserted = await client.upsertAddon(slug, listing);
      out.line(`listing upserted: ${upserted?.addon?.slug ?? slug}`);

      const created = await client.createVersion(slug, versionPayload);
      const uploads = created?.uploads ?? {};
      // Artifact-hash model (spec §6.0): the server returns upload URLs ONLY for what is new or
      // changed. A null/absent artifact URL means the stored .uxpkg already matches (same hash) —
      // skip it. Likewise an asset with no URL is unchanged. So "no URL" = skip, never an error.
      const editing = created?.updated === true;
      out.line(`version ${version} ${editing ? 'exists — updating in place' : 'created'}${uploads.artifact ? ' — uploading…' : ''}`);

      if (uploads.artifact) {
        await client.uploadToSignedUrl(uploads.artifact, artifactBytes);
        out.note(`uploaded ${artifact.filename}`);
      } else {
        out.note(`artifact unchanged (same hash) — reusing stored ${artifact.filename}`);
      }
      const byName = new Map((uploads.assets ?? []).map((u) => [u.filename, u]));
      for (const a of assetFiles) {
        const u = byName.get(a.filename);
        if (!u) { out.note(`asset unchanged — ${a.filename}`); continue; }
        await client.uploadToSignedUrl(u, a._bytes);
        out.note(`uploaded ${a.filename}`);
      }

      const finalized = await client.finalizeVersion(slug, version, { artifact: { sha256: artifact.sha256, bytes: artifact.bytes } });
      const published = finalized?.version ?? {};
      const wasEdit = editing || finalized?.updated === true;
      out.line(`${wasEdit ? 'updated' : 'published'} ${slug}@${published.version ?? version} (status ${published.status ?? 'published'})`);
      out.note(`addon: ${slug}  ·  detail: uxc mp show ${slug} --catalog`);
      out.result({ slug, version, updated: wasEdit, listing: upserted?.addon ?? null, published, catalog: { total: catalog.total } });
    } finally {
      if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
    }
  },
};
