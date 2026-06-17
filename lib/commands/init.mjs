// uxc init — scaffold a new uxopian-package: manifest + empty registry + state + dirs +
// README stub + a CLAUDE.md stanza that routes the package repo to uxc.
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stableStringify } from '../util.mjs';
import { prefixForms } from '../naming.mjs';
import { fail } from '../output.mjs';

const DEFAULT_BANDS = { 'fd.handler': [20, 29], 'fd.guiconfig': [30, 49], 'fd.script': [930, 949] };

export default {
  name: 'init',
  summary: 'scaffold a new uxopian-package (manifest, registry, state, dirs, CLAUDE.md stanza)',
  help: 'uxc init --name "Human Name" --code xy [--description "…"] [dir]',
  async run(ctx) {
    const { args, flags, out } = ctx;
    const name = typeof flags.name === 'string' ? flags.name : null;
    const code = typeof flags.code === 'string' ? flags.code : null;
    if (!name || !code) fail('usage: uxc init --name "Human Name" --code xy [dir]');
    if (!/^[a-z][a-z0-9]{0,7}$/.test(code)) {
      fail(`project code "${code}" must be short lowercase alphanumeric starting with a letter (e.g. "ct")`);
    }
    const dir = resolve(args[0] ?? '.');
    const manifestPath = join(dir, 'uxopian-project.json');
    if (existsSync(manifestPath)) fail(`refusing: ${manifestPath} already exists`);
    mkdirSync(dir, { recursive: true });

    const idPrefixes = prefixForms(code);
    const manifest = {
      format: 'uxopian-package/1',
      name,
      code,
      idPrefixes,
      version: '0.1.0',
      description: typeof flags.description === 'string' ? flags.description : '',
      products: ['flowerdocs', 'uxopian-ai'],
      requires: {},
      registrationOrderBands: DEFAULT_BANDS,
      dataSets: [],
    };

    const created = [];
    const write = (rel, content) => {
      const p = join(dir, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content);
      created.push(rel);
    };
    write('uxopian-project.json', stableStringify(manifest));
    write('registry.json', stableStringify({ resources: [] }));
    write(join('.uxc', 'state.json'), stableStringify({ targets: {} }));
    for (const d of ['fd', 'ai', 'data']) mkdirSync(join(dir, d), { recursive: true });

    write('README.md', `# ${name} (\`${code}\`)

A uxopian-package: FlowerDocs + Uxopian AI customizations managed by \`uxc\`.

- manifest: \`uxopian-project.json\` · catalog: \`registry.json\` · per-target sync state: \`.uxc/state.json\`
- resources live under \`fd/\`, \`ai/\`, \`data/\` — every owned server id carries a project prefix
  (\`${idPrefixes.pascal}*\` classes/handlers, \`${idPrefixes.camel}*\` prompts/goals/beans, \`${idPrefixes.kebab}*\` script/guiconfig docs, \`${idPrefixes.upper}*\` runtime ids)
- common loop: \`uxc add <kind> <Name>\` → edit → \`uxc push --changed\` → \`uxc verify\`
- inspect: \`uxc status [--remote]\` · \`uxc diff <id>\` · \`uxc explain <CODE>\`
`);

    const stanza = `
## Uxopian customizations — route through \`uxc\`

This directory is a uxopian-package (\`uxopian-project.json\`). ALL FlowerDocs / Uxopian AI
server work goes through the \`uxc\` CLI — never ad-hoc HTTP deploy scripts (the verified API
mechanics, cache clears and handler version rotation live inside the tool).

- \`uxc status [--remote]\` — local/server drift + untracked files + orphans
- \`uxc add <kind> <Name>\` — scaffold a resource (templates ARE the mechanics)
- \`uxc push --changed\` / \`uxc pull\` — hash-synced deploy / backport; conflicts surface, never clobber
- \`uxc diff <id>\` · \`uxc verify\` · \`uxc explain <CODE>\` · \`uxc doctor\`
- Owned id prefixes: \`${idPrefixes.pascal}\` (pascal), \`${idPrefixes.camel}\` (camel), \`${idPrefixes.kebab}\` (kebab), \`${idPrefixes.upper}\` (upper)
`;
    const claudePath = join(dir, 'CLAUDE.md');
    if (existsSync(claudePath)) {
      appendFileSync(claudePath, stanza);
      created.push('CLAUDE.md (stanza appended)');
    } else {
      writeFileSync(claudePath, `# CLAUDE.md — ${name}\n${stanza}`);
      created.push('CLAUDE.md');
    }

    out.line(`initialized uxopian-package "${name}" (code ${code}) in ${dir}`);
    for (const c of created) out.line(`  ${c}`);
    out.note('next: uxc target add <name> --url … --scope … --user … --password … ; then uxc add or uxc adopt --scan');
    out.result({ dir, manifest, created });
  },
};
