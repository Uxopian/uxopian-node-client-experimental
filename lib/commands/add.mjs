// uxc add — scaffold + register a new resource. Templates carry the verified mechanics.
// Banded kinds (manifest.registrationOrderBands) get the lowest free order from the LOCAL
// registry's meta files; --from-file registers an existing/generated file instead of a scaffold.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { kindOf } from '../kinds/index.mjs';
import { conventionalId, allocateOrder } from '../naming.mjs';
import { goalEntryId } from '../kinds/ai-goal.mjs';
import { fail } from '../output.mjs';

const NO_CONVENTION = new Set(['ai.goal', 'fd.surfacing', 'fd.dataset']);

function entryPath(adapter, pkg, id) {
  if (typeof adapter.pathFor === 'function') return adapter.pathFor(pkg, id);
  return adapter.layout === 'dir' ? `${adapter.dir}/${id}` : `${adapter.dir}/${id}.json`;
}

export default {
  name: 'add',
  summary: 'scaffold + register a new resource (templates carry the verified mechanics)',
  help: `uxc add <kind> <Name> [--title …] [--from-file p] [per-kind flags]
  fd.tagclass      --type CHOICELIST --values A,B [--fr …]
  fd.documentclass --tags CtFoo:mandatory,… [--category-ids …]
  fd.taskclass     --answers APPROVE,REJECT [--workflow CtApproval]
  fd.handler       --object DOCUMENT --filter-class CtBar [--phase AFTER] [--sync]
  fd.guiconfig     --template search|home|vf-override --class CtBar
  fd.script        [--order n]      (auto-allocated from the manifest band)
  ai.prompt        [--fcm]          (sets requiresFunctionCallingModel + reasoningDisabled:false)
  ai.goal          --goal <goalName> --prompt ctFoo [--filter expr] [--index n]`,
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    if (!ctx.args[0]) fail('usage: uxc add <kind> <Name> [flags] — kinds: uxc help');
    const adapter = kindOf(ctx.args[0]);
    const kindName = adapter.kind;

    let name = ctx.args[1];
    if (kindName === 'fd.surfacing') name ??= 'surfacing';
    if (kindName === 'ai.goal') name ??= typeof flags.goal === 'string' ? flags.goal : undefined;
    if (!name) fail(`usage: uxc add ${kindName} <Name> [flags]`);

    let id = kindName === 'fd.surfacing' ? 'surfacing'
      : NO_CONVENTION.has(kindName) ? name
      : conventionalId(kindName, pkg.manifest, name);

    // banded kinds: allocate the lowest free RegistrationOrder from the LOCAL meta files
    const bands = pkg.manifest.registrationOrderBands ?? {};
    if (bands[kindName] && flags.order == null) {
      const used = [];
      for (const e of pkg.entries(kindName)) {
        try {
          const l = adapter.readLocal(pkg, e);
          const o = l?.obj?.registrationOrder ?? l?.obj?.order;
          if (o != null && /^\d+$/.test(String(o))) used.push(Number(o));
        } catch { /* unreadable sibling — ignore for allocation */ }
      }
      flags.order = allocateOrder(pkg.manifest, used, kindName);
    }

    // scaffold (or take the provided file)
    let local;
    if (flags['from-file']) {
      const bytes = readFileSync(resolvePath(String(flags['from-file'])));
      if (adapter.layout === 'dir') {
        local = adapter.template(ctx, id, flags); // meta scaffold; content = the provided file
        const file = local.obj?.contentFile ?? Object.keys(local.contents ?? {})[0] ?? id;
        local.contents = { [file]: bytes };
      } else {
        local = { obj: JSON.parse(bytes.toString('utf8')) };
      }
    } else {
      local = adapter.template(ctx, id, flags);
    }

    if (kindName === 'ai.goal') {
      if (!local.obj?.promptId) fail('ai.goal needs --prompt <promptId> (and --goal <goalName>) — only package-owned prompts are routable');
      id = goalEntryId(local.obj);
    }
    if (pkg.entry(kindName, id)) fail(`${kindName}/${id} already registered — edit the file, or uxc rm it first`);

    const entry = pkg.addEntry({
      kind: kindName,
      id,
      title: typeof flags.title === 'string' ? flags.title : local.obj?.name,
      path: entryPath(adapter, pkg, id),
      policy: adapter.defaultPolicy,
    });
    adapter.writeLocal(pkg, entry, local);

    const files = adapter.layout === 'dir'
      ? [`${entry.path}/meta.json`, ...Object.keys(local.contents ?? {}).map((f) => `${entry.path}/${f}`)]
      : kindName === 'ai.prompt'
        ? [entry.path, entry.path.replace(/\.json$/, '.content.md')]
        : [entry.path];

    out.line(`created ${kindName}/${id} (policy ${entry.policy})`);
    for (const f of files) out.line(`  ${f}`);
    if (bands[kindName] && flags.order != null) out.note(`registrationOrder ${flags.order} (band [${bands[kindName]}])`);
    out.note('edit the file(s), then: uxc push ' + id);
    out.result({ kind: kindName, id, path: entry.path, files, order: flags.order ?? null });
  },
};
