// uxc add — scaffold + register a new resource. Templates carry the verified mechanics.
// Banded kinds (manifest.registrationOrderBands) get the lowest free order from the LOCAL
// registry's meta files; --from-file registers an existing/generated file instead of a scaffold.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { kindOf, KINDS } from '../kinds/index.mjs';
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
  help: `uxc add <kind> <Name> [--title …] [--from-file p] [--from <LiveName>] [per-kind flags]
  f2.map           --from <ExistingMapName>   (RECOMMENDED: clone a map that already runs on the
                                               broker and variable-ize it, instead of scaffolding
                                               from a template — FAST2-LEARNINGS §F15/§F17)
  fd.tagclass      --type CHOICELIST --values A,B [--fr …]
  fd.documentclass --tags CtFoo:mandatory,… [--category-ids …]
  fd.folderclass   --children DOCUMENT:*,FOLDER:PoSub [--tags …] [--category-ids …]
  fd.taskclass     --answers APPROVE,REJECT [--workflow CtApproval]
  fd.workflow      --steps CtStep0,CtStep1,CtStep2 [--start CtStep0]
  fd.acl           --entries "*:UPDATE_CONTENT:ALLOW,role_x:READ:DENY"
  fd.handler       --object DOCUMENT --filter-class CtBar [--phase AFTER] [--sync]
  fd.guiconfig     --template search|home|vf-override --class CtBar
  fd.dataset       --class <ClassId> [--no-class]   (writes the manifest dataSets entry AND
                                               scaffolds the document class when it is missing)
  fd.script        [--order n]      (auto-allocated from the manifest band)
  ai.prompt        [--fcm]          (sets requiresFunctionCallingModel + reasoningDisabled:false)
  ai.goal          --goal <goalName> --prompt ctFoo [--filter expr] [--index n]   (uxopian-ai ≤ ft4 — removed in ft5)
  ai.agent         --objective ctFoo    (the prompt the agent executes — uxopian-ai 2026.0.0-ft5+)
  ai.plan          --agent ctFooAgent   (first AGENT node; declare root prompt variables in toolInputParameters)
  ai.application   [--provider FlowerDocsProvider] [--prompt ctFoo]   (id = name; uxopian-ai 2026.0.0-ft5+)`,
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

    // fd.dataset is THREE artifacts, not one: the JSONL file, the manifest dataSets entry that
    // binds it to a class, and the document class the rows instantiate. Scaffolding one third and
    // printing an error about the rest (BACKLOG #8/#21) meant hand-editing two files — exactly
    // what scaffolding exists to avoid. Do all three, and refuse early when we cannot.
    let datasetPlan = null;
    if (kindName === 'fd.dataset') {
      const classId = typeof flags.class === 'string' ? flags.class
        : typeof flags.classId === 'string' ? flags.classId : null;
      if (!classId) {
        fail(`uxc add fd.dataset ${name} needs --class <ClassId> — the class its rows instantiate.\n`
          + `  A dataset is a manifest binding {name, classId, path} plus one JSONL of documents of that class;\n`
          + `  without the class id there is nothing to bind. Example:\n`
          + `    uxc add fd.dataset ${name} --class ${name}Class`);
      }
      const existing = (pkg.manifest.dataSets ?? []).find((d) => d.name === id);
      if (existing && existing.classId !== classId) {
        fail(`dataset "${id}" is already bound to class "${existing.classId}" in uxopian-project.json — `
          + `pass --class ${existing.classId}, or rename the dataset.`);
      }
      datasetPlan = {
        classId,
        path: existing?.path ?? `data/${id}.jsonl`,
        needsClass: !flags['no-class'] && !pkg.entry('fd.documentclass', classId),
        manifestWritten: !existing,
      };
      flags.class = classId; // the dataset template reads it back
    }

    // scaffold (or take the provided file)
    let local;
    let cloneReport = null;
    if (flags.from && typeof adapter.cloneFrom === 'function') {
      // CLONE A WORKING RESOURCE instead of scaffolding from a template. For fast2 maps this is the
      // recommended path: the product docs carry stale field names and a hand-authored map can fail
      // SILENTLY (FAST2-LEARNINGS §F15/§F17), so a proven artifact is the better starting point.
      ctx.connect();
      const res = await adapter.cloneFrom(ctx, id, String(flags.from));
      local = res.local;
      cloneReport = res.report;
    } else if (flags.from) {
      fail(`--from is not supported for ${kindName} (only kinds that can clone a live resource: f2.map)`);
    } else if (flags['from-file']) {
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

    // the manifest binding must land BEFORE the entry: pathFor() reads dataSets to place the JSONL
    if (datasetPlan?.manifestWritten) {
      pkg.manifest.dataSets = [...(pkg.manifest.dataSets ?? []), { name: id, classId: datasetPlan.classId, path: datasetPlan.path, content: false }];
      pkg.saveManifest();
    }

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

    // the document class the rows instantiate — scaffolded here so the first push cannot fail on it
    let classCreated = null;
    if (datasetPlan?.needsClass) {
      const dcAdapter = KINDS['fd.documentclass'];
      const dcLocal = dcAdapter.template(ctx, datasetPlan.classId, { title: datasetPlan.classId });
      const dcEntry = pkg.addEntry({
        kind: 'fd.documentclass', id: datasetPlan.classId, title: datasetPlan.classId,
        path: dcAdapter.pathFor(pkg, datasetPlan.classId), policy: dcAdapter.defaultPolicy,
      });
      dcAdapter.writeLocal(pkg, dcEntry, dcLocal);
      classCreated = dcEntry.path;
    }

    out.line(`created ${kindName}/${id} (policy ${entry.policy})`);
    for (const f of files) out.line(`  ${f}`);
    if (datasetPlan?.manifestWritten) {
      out.line(`  uxopian-project.json  dataSets += {"name":"${id}","classId":"${datasetPlan.classId}","path":"${datasetPlan.path}"}`);
    }
    if (classCreated) {
      out.line(`created fd.documentclass/${datasetPlan.classId} (the class these rows instantiate)`);
      out.line(`  ${classCreated}`);
      out.note(`add the row tags to ${classCreated} (tagReferences) before pushing — a row carrying a tag the class does not declare is rejected`);
    } else if (datasetPlan && !datasetPlan.needsClass && !flags['no-class']) {
      out.note(`fd.documentclass/${datasetPlan.classId} is already in this package — rows will use it`);
    }
    if (cloneReport) {
      out.line(`cloned from "${flags.from}" — ${cloneReport.length} value(s) turned into variables:`);
      for (const r of cloneReport) out.note(`${r.field}: ${r.was} -> ${r.now}`);
      const names = [...new Set(cloneReport.map((r) => r.now.replace(/^\{\{uxc:|\}\}$/g, '')))];
      const undeclared = names.filter((n) => !(pkg.manifest.variables ?? {})[n]);
      if (undeclared.length) {
        out.warn(`declare these in uxopian-project.json "variables" before pushing or exporting: ${undeclared.join(', ')}`
          + ' (mark the password one "sensitive": true)');
      }
    }
    if (bands[kindName] && flags.order != null) out.note(`registrationOrder ${flags.order} (band [${bands[kindName]}])`);
    out.note('edit the file(s), then: uxc push ' + id);
    out.result({
      kind: kindName, id, path: entry.path, files, order: flags.order ?? null,
      ...(datasetPlan ? { dataSet: { classId: datasetPlan.classId, path: datasetPlan.path, manifestWritten: datasetPlan.manifestWritten, classCreated } } : {}),
    });
  },
};
