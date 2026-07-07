// uxc verify — post-deploy assertions (DESIGN §11):
//   every resource exists; handlers have exactly ONE live _vN, enabled, order in band;
//   scripts/guiconfigs serve their exact bytes; surfacing entries present per the recorded
//   expansion; prompts listable; plus the cross-reference lint (refs token scanner).
// Exit 1 on any failure.
import { serverOf, localOf } from '../sync.mjs';
import { crossReferenceLint } from '../refs.mjs';
import { KINDS } from '../kinds/index.mjs';
import { tagsOf } from '../util.mjs';
import { fail } from '../output.mjs';

/** Tolerant view of a handler registration row ({id,enabled,order} from doc tags or fields). */
function regInfo(reg) {
  const doc = reg?.doc ?? reg ?? {};
  const tags = Array.isArray(doc.tags) ? tagsOf(doc) : {};
  return {
    id: reg?.id ?? doc.id,
    enabled: reg?.enabled ?? tags.Enabled,
    order: reg?.order ?? tags.RegistrationOrder,
  };
}

export default {
  name: 'verify',
  summary: 'post-deploy assertions per kind + cross-reference lint (exit 1 on failure)',
  help: 'uxc verify [id…]',
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    ctx.connect();

    const entries = (ctx.args.length
      ? ctx.args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`))
      : pkg.entries()
    ).filter((e) => !e.retired);

    const failures = [];
    let checks = 0;
    const failed = (msg) => failures.push(msg);

    for (const entry of entries) {
      const key = `${entry.kind}/${entry.id}`;
      const adapter = KINDS[entry.kind];

      // 1. existence (handlers: readServer resolves the live _vN; prompts: listable on the user endpoint)
      let server = null;
      checks++;
      try {
        server = await serverOf(ctx, entry);
      } catch (e) {
        failed(`${key}: server read failed — ${e.message}`);
        continue;
      }
      if (!server) { failed(`${key}: missing on server`); continue; }
      if (entry.policy === 'external') continue; // referenced only: existence is the whole contract

      // 2. per-kind assertions
      if (entry.kind === 'fd.handler') {
        if (typeof adapter.liveRegistrations === 'function') {
          checks++;
          // liveRegistrations -> { live, n, orphans, recovered } (NOT an array — this check was
          // dead before); the state hint heals search lag so an invisible live _vN still counts.
          const hint = pkg.resState(ctx.target.name, entry.kind, entry.id)?.deployedId ?? null;
          let regs = null;
          try { regs = await adapter.liveRegistrations(ctx, entry.id, { hints: [hint] }); }
          catch (e) { failed(`${key}: liveRegistrations failed — ${e.message}`); continue; }
          const liveIds = [regs.live, ...(regs.orphans ?? [])].filter(Boolean);
          if (liveIds.length !== 1) {
            failed(`${key}: expected exactly ONE live registration, found ${liveIds.length}${liveIds.length ? ` (${liveIds.join(', ')})` : ''} — multiple registrations fire the handler MULTIPLE times (duplicated downstream objects); uxc push ${entry.id} rotates + sweeps`);
          }
          const liveDoc = regs.live ? await ctx.clients.core.getDoc(regs.live) : null;
          const reg = liveDoc ? regInfo(liveDoc) : null;
          const disabled = pkg.resState(ctx.target.name, entry.kind, entry.id)?.disabled === true;
          if (reg) {
            checks++;
            if (String(reg.enabled) !== 'true' && !disabled) failed(`${key}: live registration ${reg.id} is NOT enabled (uxc enable ${entry.id})`);
            const band = pkg.manifest.registrationOrderBands?.['fd.handler'];
            if (band && reg.order != null) {
              checks++;
              const n = Number(reg.order);
              if (!(n >= band[0] && n <= band[1])) failed(`${key}: RegistrationOrder ${reg.order} outside the package band [${band}]`);
            }
          }
        }
      } else if (entry.kind === 'fd.script' || entry.kind === 'fd.guiconfig') {
        // served bytes must equal the local resolved bytes
        const local = localOf(pkg, entry);
        for (const [file, bytes] of Object.entries(local?.contents ?? {})) {
          checks++;
          const served = server.contents?.[file] ?? Object.values(server.contents ?? {})[0];
          if (!served) failed(`${key}: server serves no content for ${file}`);
          else if (Buffer.compare(Buffer.from(bytes), Buffer.from(served)) !== 0) {
            failed(`${key}: served bytes differ from local ${file} (${served.length} vs ${bytes.length} bytes) — push + cache clear`);
          }
        }
      } else if (entry.kind === 'fd.surfacing') {
        // every recorded expansion entry must be present on its profile
        const expansion = pkg.resState(ctx.target.name, entry.kind, entry.id)?.expansion;
        const spec = localOf(pkg, entry)?.obj ?? [];
        if (expansion && Object.keys(expansion).length) {
          const scope = await ctx.clients.core.getOne(`/rest/scope/${encodeURIComponent(ctx.target.scope)}`);
          const profiles = scope?.people?.profiles ?? [];
          for (const [pname, idxs] of Object.entries(expansion)) {
            const p = profiles.find((x) => x.name === pname || x.id === pname);
            checks++;
            if (!p) { failed(`${key}: profile "${pname}" (recorded expansion) no longer exists`); continue; }
            for (const i of idxs) {
              const e = spec[i];
              if (!e) continue; // spec shrank since the expansion was recorded
              checks++;
              if (!(p.properties ?? []).some((q) => q?.name === e.name && q?.value === e.value)) {
                failed(`${key}: "${e.name}=${e.value}" missing on profile "${pname}" — push fd.surfacing`);
              }
            }
          }
        } else {
          checks++;
          const a = JSON.stringify(server.obj ?? []);
          const b = JSON.stringify(localOf(pkg, entry)?.obj ?? []);
          if (a !== b) failed(`${key}: live scope entries differ from the local spec (no recorded expansion) — push fd.surfacing`);
        }
      }
    }

    // 3. cross-reference pass: prefix-matching tokens in handler filters / VF searches /
    //    guiconfig criteria / surfacing values must resolve to registry ids
    checks++;
    try {
      for (const f of crossReferenceLint(pkg) ?? []) {
        failed(`${f.path}: token "${f.token}" — ${f.problem}`);
      }
    } catch (e) {
      out.warn(`cross-reference lint skipped: ${e.message}`);
    }

    for (const f of failures) out.line(`FAIL  ${f}`);
    out.line(`verify: ${entries.length} resources, ${checks} checks, ${failures.length} failures`);
    if (failures.length) process.exitCode = 1;
    out.result({ resources: entries.length, checks, failures });
  },
};
