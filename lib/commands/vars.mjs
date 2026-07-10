// uxc vars [pkg.uxpkg|dir|slug] — list a package's variables (DESIGN §21) and, with --var /
// --var-file, show how they RESOLVE (the pre-install dry-check; `oc process --parameters` lineage).
// Works on: a local package dir (default: the current one), a .uxpkg artifact, or a marketplace slug.
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipTo } from '../zip.mjs';
import { findPackageDir } from '../config.mjs';
import { resolveMarketplace } from '../mpconfig.mjs';
import { createMarketplaceClient } from '../marketplace.mjs';
import { declaredVariables, resolveValues, variablesTable, scanPlaceholders } from '../variables.mjs';
import { collectRepeatedFlag, kvPairs } from '../util.mjs';
import { fail } from '../output.mjs';

async function manifestOf(src, out) {
  if (!src) {
    const dir = findPackageDir();
    if (!dir) fail('no package here — pass a .uxpkg, a package dir, or a marketplace slug');
    return { manifest: JSON.parse(readFileSync(join(dir, 'uxopian-project.json'), 'utf8')), dir };
  }
  if (/\.uxpkg$/i.test(src)) {
    const tmp = mkdtempSync(join(tmpdir(), 'uxc-vars-'));
    try {
      await unzipTo(src, tmp);
      let root = tmp;
      if (!existsSync(join(root, 'uxopian-project.json'))) {
        const subs = readdirSync(tmp).filter((n) => statSync(join(tmp, n)).isDirectory());
        if (subs.length === 1 && existsSync(join(tmp, subs[0], 'uxopian-project.json'))) root = join(tmp, subs[0]);
        else fail(`not a uxopian package archive: ${src}`);
      }
      const manifest = JSON.parse(readFileSync(join(root, 'uxopian-project.json'), 'utf8'));
      const scan = scanPlaceholders(root); // scan NOW — tmp is removed in finally
      return { manifest, scan };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  if (existsSync(join(src, 'uxopian-project.json'))) {
    return { manifest: JSON.parse(readFileSync(join(src, 'uxopian-project.json'), 'utf8')), dir: src };
  }
  // marketplace slug[@version]
  const [slug, atVersion] = String(src).split('@');
  const client = createMarketplaceClient(resolveMarketplace({ requireToken: false }));
  const version = atVersion ?? (await client.getAddon(slug))?.addon?.latest_version;
  if (!version) fail(`"${src}" is not a package dir, a .uxpkg, or a published marketplace slug`);
  const vd = await client.getVersion(slug, version);
  out?.note?.(`variables of ${slug}@${version} (from the marketplace manifest)`);
  return { manifest: vd?.version?.manifest ?? {} };
}

export default {
  name: 'vars',
  summary: 'list a package’s variables and check value resolution (--var/--var-file)',
  help: 'uxc vars [pkg.uxpkg|dir|slug[@version]] [--var name=value]… [--var-file values.json]',
  async run(ctx) {
    const { out, flags } = ctx;
    const { manifest, dir, scan: preScan } = await manifestOf(ctx.args[0], out);
    const decls = declaredVariables(manifest);
    if (!Object.keys(decls).length) {
      out.line(`${manifest.code ?? '(package)'}: no variables declared — installs with no --var`);
      out.result({ variables: {} });
      return;
    }
    const vars = kvPairs(collectRepeatedFlag('var'));
    const varFile = typeof flags['var-file'] === 'string' ? JSON.parse(readFileSync(flags['var-file'], 'utf8')) : {};
    const { values, missing, unknown, invalid } = resolveValues(manifest, { vars, varFile });
    out.table(variablesTable(manifest, values), [
      { key: 'name' }, { key: 'required' }, { key: 'value', max: 44 }, { key: 'description', max: 70 },
    ]);
    const effScan = preScan ?? (dir ? scanPlaceholders(dir) : null);
    if (effScan) {
      const perFile = Object.entries(effScan.files).map(([f, ns]) => `${f} [${ns.join(', ')}]`);
      if (perFile.length) out.note(`placeholders: ${perFile.join(' · ')}`);
      else out.note('no placeholders in files (already rendered checkout, or unused declarations)');
    }
    for (const u of unknown) out.warn(`unknown --var ${u} (not declared by this package)`);
    for (const i of invalid) out.warn(`invalid: ${i.name}=${i.value} does not match ${i.pattern}`);
    if (missing.length) {
      out.warn(`missing required value(s): ${missing.join(', ')} — install will refuse without them`);
      process.exitCode = 1;
    } else {
      out.line('all required variables resolve — ready to install with these values');
    }
    out.result({ variables: decls, resolved: values, missing, unknown, invalid });
  },
};
