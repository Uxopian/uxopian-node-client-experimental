// uxc init — scaffold a new uxopian-package: manifest + empty registry + state + dirs +
// README stub + a tool-neutral AGENTS.md and a CLAUDE.md stanza pointing to it (DESIGN §27.3).
import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stableStringify } from '../util.mjs';
import { prefixForms } from '../naming.mjs';
import { openPackage } from '../registry.mjs';
import { schemaUrl, SCHEMA_NAMES } from '../schemas.mjs';
import { fail } from '../output.mjs';
import { renderAgentsSection, renderClaudeSection, upsertSection } from '../agents-md.mjs';
import {
  parseDependsOn, loadKit, renderKit, renderText, renderDeep, scaffoldGeneric, templateVars, deepMerge, DEFAULT_EXTENSION_BANDS,
} from '../extension-kit.mjs';

const DEFAULT_BANDS = { 'fd.handler': [20, 29], 'fd.guiconfig': [30, 49], 'fd.script': [930, 949] };

export default {
  name: 'init',
  summary: 'scaffold a new uxopian-package (manifest, registry, state, dirs, AGENTS.md + CLAUDE.md pointer)',
  help: `uxc init --name "Human Name" --code xy [--description "…"] [dir]
uxc init --extension <code> --depends-on <slug>@<range> [--name "…"] [--dep-code <code>] [--kinds a,b]
         [--product-dir <checkout of the depended-on package>] [--force] [dir]
   the partner kit: a package that EXTENDS another (dependency declared, its own id prefixes,
   one example per extension kind, each with a green offline test). Kinds and examples come from
   the depended-on package's extension-kit/ (--product-dir) or, without one, the generic built-ins
   (script, prompt, dataset). \`uxc verify\` then holds the package to its own prefixes.
   An existing file in [dir] that the kit would write is refused (listed) unless --force.
Both forms write AGENTS.md (tool-neutral agent context) and a CLAUDE.md stanza pointing to it; an
existing AGENTS.md / CLAUDE.md is kept and gets a <!-- uxc:begin -->…<!-- uxc:end --> block.
Refresh that block later with: uxc context --agents-md --write`,
  async run(ctx) {
    const { args, flags, out } = ctx;
    const extension = flags.extension !== undefined;
    const code = typeof flags.extension === 'string' ? flags.extension : typeof flags.code === 'string' ? flags.code : null;
    if (extension && typeof flags.extension === 'string' && typeof flags.code === 'string' && flags.code !== flags.extension) {
      fail(`--extension ${flags.extension} and --code ${flags.code} disagree — give the code once`);
    }
    if (!extension) {
      for (const f of ['depends-on', 'product-dir', 'kinds', 'dep-code', 'force']) if (flags[f] !== undefined) fail(`--${f} only applies with --extension`);
    }
    const name = typeof flags.name === 'string' ? flags.name
      : extension && code ? `${code} extension` : null;
    if (!name || !code) fail('usage: uxc init --name "Human Name" --code xy [dir]   |   uxc init --extension <code> --depends-on <slug>@<range> [dir]');
    if (!/^[a-z][a-z0-9]{0,7}$/.test(code)) {
      fail(`project code "${code}" must be short lowercase alphanumeric starting with a letter (e.g. "ct")`);
    }
    // ---- extension mode: resolve the dependency and the kit BEFORE touching the disk ----
    let ext = null;
    if (extension) {
      if (typeof flags['depends-on'] !== 'string') fail('--extension needs --depends-on <slug>@<range> — the package it extends');
      const { slug, range } = parseDependsOn(flags['depends-on']);
      const loaded = flags['product-dir'] !== undefined ? loadKit(String(flags['product-dir'])) : null;
      const pm = loaded?.productManifest ?? null;
      const depCode = typeof flags['dep-code'] === 'string' ? flags['dep-code'] : pm?.code
        ?? (/^[a-z][a-z0-9]{0,7}$/.test(slug) ? slug : null);
      if (!depCode) {
        fail(`cannot tell the package code of "${slug}" — pass --product-dir <its checkout> or --dep-code <code> (dependencies are keyed by package code)`);
      }
      if (!/^[a-z][a-z0-9]{0,7}$/.test(depCode)) fail(`dependency code "${depCode}" is not a valid package code`);
      if (depCode === code) fail(`the extension code "${code}" is the dependency's code — an extension needs its own id prefixes`);
      const dep = { code: depCode, slug, range, version: pm?.version ?? null };
      const all = loaded?.kit ? Object.keys(loaded.kit.examples) : ['script', 'prompt', 'dataset'];
      let kinds = null;
      const asked = flags.kinds ?? flags.families;
      if (asked !== undefined) {
        if (typeof asked !== 'string') fail('--kinds takes a comma list, e.g. --kinds script,dataset');
        kinds = asked.split(',').map((x) => x.trim()).filter(Boolean);
        for (const k of kinds) if (!all.includes(k)) fail(`--kinds: "${k}" is not an extension kind here — available: ${all.join(', ')}`);
      }
      ext = { dep, loaded, kinds, vars: templateVars({ code, name, dep }) };
    }

    const target = resolve(args[0] ?? '.');
    if (existsSync(join(target, 'uxopian-project.json'))) fail(`refusing: ${join(target, 'uxopian-project.json')} already exists`);
    // an extension is assembled in a staging directory and copied in only when the kit rendered
    // cleanly: a kit that fails half-way must not leave a manifest that blocks the retry. fail()
    // exits the process, so a finally alone would not run: the exit hook removes it on that path too.
    const dir = ext ? mkdtempSync(join(tmpdir(), 'uxc-init-')) : target;
    const dropStaging = () => { if (ext) rmSync(dir, { recursive: true, force: true }); };
    if (ext) process.once('exit', dropStaging);
    try {
      const manifestPath = join(dir, 'uxopian-project.json');
      mkdirSync(dir, { recursive: true });

      const idPrefixes = prefixForms(code);
      const manifest = {
        // editor hint (completion + validation while typing); uxc verify checks the same schema (DESIGN §29)
        $schema: schemaUrl(SCHEMA_NAMES.manifest),
        format: 'uxopian-package/1',
        name,
        code,
        idPrefixes,
        version: '0.1.0',
        description: typeof flags.description === 'string' ? flags.description : '',
        products: ext?.loaded?.productManifest?.products ?? ['flowerdocs', 'uxopian-ai'],
        requires: {},
        registrationOrderBands: ext ? DEFAULT_EXTENSION_BANDS : DEFAULT_BANDS,
        dataSets: [],
      };
      if (ext) {
        manifest.dependencies = { [ext.dep.code]: { versions: ext.dep.range, slug: ext.dep.slug } };
        manifest.extension = { of: ext.dep.code };
        if (ext.loaded?.kit?.manifest) {
          const { dataSets: _ignored, ...kitManifest } = ext.loaded.kit.manifest;
          Object.assign(manifest, deepMerge(manifest, renderDeep(kitManifest, ext.vars, 'kit manifest')));
        }
      }

      const created = [];
      const write = (rel, content) => {
        const p = join(dir, rel);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, content);
        created.push(rel);
      };
      write('uxopian-project.json', stableStringify(manifest));
      write('registry.json', stableStringify({ $schema: schemaUrl(SCHEMA_NAMES.registry), resources: [] }));
      write(join('.uxc', 'state.json'), stableStringify({ targets: {} }));
      for (const d of ['fd', 'ai', 'data']) mkdirSync(join(dir, d), { recursive: true });

      let extResult = null;
      if (ext) {
        if (ext.loaded?.kit) {
          const r = renderKit({ kit: ext.loaded.kit, kitDir: ext.loaded.kitDir, dir, vars: ext.vars, kinds: ext.kinds });
          manifest.dataSets = r.dataSets;
          writeFileSync(join(dir, 'uxopian-project.json'), stableStringify(manifest));
          const pkg = openPackage(dir);
          for (const e of r.registry) pkg.addEntry({ policy: 'managed', title: e.id, ...e });
          pkg.saveRegistry();
          created.push(...r.created);
          extResult = { source: 'kit', kinds: r.kinds };
        } else {
          const r = scaffoldGeneric({ dir, vars: ext.vars, kinds: ext.kinds });
          created.push(...r.created);
          extResult = { source: 'generic', kinds: r.kinds };
        }
      }

      write('README.md', `# ${name} (\`${code}\`)

  A uxopian-package: FlowerDocs + Uxopian AI customizations managed by \`uxc\`.

  - manifest: \`uxopian-project.json\` · catalog: \`registry.json\` · per-target sync state: \`.uxc/state.json\`
  - resources live under \`fd/\`, \`ai/\`, \`data/\` — every owned server id carries a project prefix
    (\`${idPrefixes.pascal}*\` classes/handlers, \`${idPrefixes.camel}*\` prompts/goals/beans, \`${idPrefixes.kebab}*\` script/guiconfig docs, \`${idPrefixes.upper}*\` runtime ids)
  - common loop: \`uxc add <kind> <Name>\` → edit → \`uxc push --changed\` → \`uxc verify\`
  - inspect: \`uxc status [--remote]\` · \`uxc diff <id>\` · \`uxc explain <CODE>\`
  - coding agents: read \`AGENTS.md\` (operating rules and cheat-sheet)
  `);

      // AGENTS.md (tool-neutral) + a CLAUDE.md stanza that points to it (DESIGN §27.3): each gets
      // one uxc block between markers; an existing file keeps its text, only the block is ours
      const kitNotes = ext?.loaded?.kit?.claude ? renderText(ext.loaded.kit.claude, ext.vars, 'kit claude').trim() : '';
      for (const [file, section] of [['AGENTS.md', renderAgentsSection(manifest)], ['CLAUDE.md', renderClaudeSection(manifest)]]) {
        const p = join(dir, file);
        if (ext && existsSync(join(target, file))) cpSync(join(target, file), p);
        const had = existsSync(p);
        let text = upsertSection(had ? readFileSync(p, 'utf8') : null, section, `# ${file} — ${name}\n\n`);
        // the kit's notes sit OUTSIDE the block: a refresh (context --agents-md --write) has no kit to re-read
        if (file === 'AGENTS.md' && kitNotes) text += `\n## From the \`${ext.dep.code}\` extension kit\n\n${kitNotes}\n`;
        writeFileSync(p, text);
        created.push(had ? `${file} (uxc section added)` : file);
      }

      if (ext) {
        const finalManifest0 = JSON.parse(readFileSync(manifestPath, 'utf8'));
        // CLAUDE.md / AGENTS.md were copied from the target and given the uxc block: replacing them is the point
        const collisions = listFiles(dir).filter((rel) => rel !== 'CLAUDE.md' && rel !== 'AGENTS.md' && existsSync(join(target, rel)));
        if (collisions.length && !flags.force) {
          fail(`refusing: ${collisions.length} file(s) already exist in ${target} and would be overwritten:\n`
            + collisions.map((c) => `  ${c}`).join('\n') + '\nMove them away, or pass --force to overwrite them.');
        }
        cpSync(dir, target, { recursive: true });
        Object.assign(manifest, finalManifest0);
      }
      out.line(`initialized uxopian-package "${name}" (code ${code}) in ${target}`);
      if (ext) out.line(`  extends ${ext.dep.code} ${ext.dep.range} (${ext.dep.slug}); examples from the ${extResult.source} kit: ${extResult.kinds.join(', ')}`);
      for (const c of created) out.line(`  ${c}`);
      if (ext) out.note('next: uxc test --offline ; uxc verify ; then uxc target add … and uxc push');
      else out.note('next: uxc target add <name> --url … --scope … --user … --password … ; then uxc add or uxc adopt --scan');
      out.result({ dir: target, manifest, created, ...(extResult ? { extension: { dependency: ext.dep, ...extResult } } : {}) });
    } finally {
      dropStaging();
      if (ext) process.removeListener('exit', dropStaging);
    }
  },
};

/** Every file under `root`, as '/'-joined relative paths. */
function listFiles(root, rel = '') {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((d) => {
    const r = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? listFiles(root, r) : [r];
  });
}
