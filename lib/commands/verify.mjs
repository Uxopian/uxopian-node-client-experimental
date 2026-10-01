// uxc verify — post-deploy assertions (DESIGN §11) AND the offline lints (DESIGN §25):
//   every resource exists; handlers have exactly ONE live _vN, enabled, order in band;
//   scripts/guiconfigs serve their exact bytes; surfacing entries present per the recorded
//   expansion; prompts listable; plus the cross-reference lint (refs token scanner) and the
//   offline lints: constrained tag values, include order, prompt variables, class-model references
//   (tag classes / categories a class names, #117), and the package files against the JSON Schemas
//   (schemas/, DESIGN §29).
// Exit 1 on any failure. Prompt-variable findings are WARNINGS by design — a prompt may be called
// from outside the package, so the absence of a caller proves nothing (BACKLOG #7).
import { serverOf, localOf, unsupportedReason } from '../sync.mjs';
import { crossReferenceLint } from '../refs.mjs';
import { lintTagValues, lintPromptVariables, lintIncludeOrder, lintAgentic, lintClassReferences } from '../lint.mjs';
import { lintExtension, findingKey } from '../extension.mjs';
import { KINDS } from '../kinds/index.mjs';
import { tagsOf } from '../util.mjs';
import { fail } from '../output.mjs';
import { topologyWarnings } from '../kinds/f2-map.mjs';
import { lintTagDeltas, EXT_TAG_CLASS_UNKNOWN } from '../tagdelta.mjs';
import { lintSchemas } from '../schemas.mjs';

/** --offline (its alias --static is folded into it by the dispatcher: FLAG_ALIASES, #110). */
export const isOffline = (flags = {}) => flags.offline !== undefined && flags.offline !== false;

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
  help: 'uxc verify [id…] [--full] [--offline]   (--full: also informational no-caller findings; '
    + '--offline (= --static): the offline lints only — EXT_*, schemas, prompt variables, include order, tag deltas… — no server, no target)',
  // --offline touches no server: no lock, no target (#110)
  lock: (flags) => (isOffline(flags) ? 'none' : 'read'),
  async run(ctx) {
    const { out } = ctx;
    const pkg = ctx.requirePkg();
    const offline = isOffline(ctx.flags);
    if (!offline) {
      try { ctx.connect(); } catch (e) {
        // no resolvable target: the static half still has something to say
        e.message = `${e.message}\n  (no server? \`uxc verify --offline\` runs the offline lints only)`;
        throw e;
      }
    }

    const entries = (ctx.args.length
      ? ctx.args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`))
      : pkg.entries()
    ).filter((e) => !e.retired);

    const failures = [];
    let checks = 0;
    const failed = (msg) => failures.push(msg);

    // 1-2. server assertions — skipped entirely offline (no client exists)
    for (const entry of offline ? [] : entries) {
      const key = `${entry.kind}/${entry.id}`;
      const adapter = KINDS[entry.kind];

      // 0. dialect gate: a kind this server does not have (ai.goal on uxopian-ai ft5+, ai.agent /
      //    ai.plan before it) has nothing to verify here — say so, never fail on it
      const unsupported = await unsupportedReason(ctx, entry.kind);
      if (unsupported) { out.note(`${key}: skipped — ${unsupported}`); continue; }

      // 0b. tag-class delta: the TARGET class must exist (EXT_TAG_CLASS_UNKNOWN) and hold every value
      if (entry.kind === 'fd.tagclass-delta' && entry.policy !== 'external') {
        checks++;
        try {
          const tc = await ctx.clients.core.getOne(`/rest/tagclass/${encodeURIComponent(entry.id)}`);
          if (!tc) { failed(`${key}: ${EXT_TAG_CLASS_UNKNOWN} — tag class "${entry.id}" is not on the server`); continue; }
          const have = new Set((tc.allowedValues ?? []).map((v) => v?.symbolicName));
          const want = (localOf(pkg, entry)?.obj?.allowedValues ?? []).map((v) => v?.symbolicName).filter(Boolean);
          const missing = want.filter((n) => !have.has(n));
          checks++;
          if (missing.length) failed(`${key}: values missing on server: ${missing.join(', ')} — uxc push ${entry.id}`);
        } catch (e) {
          failed(`${key}: server read failed — ${e.message}`);
        }
        continue;
      }

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
              // FlowerDocs stores a bare bean id with an empty argument list ("PoCaseSearch()"):
              // compare the normalised form, as the push does, or every search.template fails.
              const norm = (v) => String(v ?? '').replace(/\(\)$/, '');
              if (!(p.properties ?? []).some((q) => q?.name === e.name && norm(q?.value) === norm(e.value))) {
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

    // 3. offline lints — both halves of each check live in the package, so they hold with or
    //    without a server and they hold BEFORE a push, not after a 500 (BACKLOG #7/#9/#20)
    for (const t of lintTagValues(pkg)) { checks++; failed(t.message); }
    const deltaKeys = new Set();
    for (const d of lintTagDeltas(pkg)) { checks++; failed(d.message); deltaKeys.add(findingKey(d)); }
    for (const o of lintIncludeOrder(pkg)) { checks++; failed(o.message); }
    for (const f of lintPromptVariables(pkg)) {
      checks++;
      if (f.kind === 'unprovided' || f.kind === 'not-interpolated') out.warn(f.message);
      else if (ctx.flags.full) out.warn(f.message); // no-caller is informational: --full to see it
    }
    for (const f of lintAgentic(pkg)) { checks++; out.warn(f.message); }
    // class-model references (#117): a tag class / category / VF class the verified resources name.
    // An UNTRACKED local file is a FAIL (the push skips it, the server answers F00205); anything
    // else may legitimately exist on the target (platform tag classes) — a warning.
    for (const f of lintClassReferences(pkg, entries)) {
      checks++;
      if (f.status === 'untracked') failed(f.message);
      else out.warn(f.message);
    }
    // package files vs the JSON Schemas editors see through `$schema` (DESIGN §29): an error only
    // where uxc already refuses the same input (an adapter's validate, validateCompat, an unknown
    // kind); everything else is a warning, so no package that pushes today fails on a schema
    for (const f of lintSchemas(pkg)) {
      checks++;
      if (f.severity === 'error') failed(`${f.where}: ${f.message}`);
      else out.warn(`${f.where}: ${f.message}`);
    }
    // an extension package (declares a dependency) may only create ids under its own prefixes (DESIGN §27)
    // it carries the tag-delta lint too (#93) — skip what the pass above already reported
    for (const f of lintExtension(pkg)) { if (deltaKeys.has(findingKey(f))) continue; checks++; failed(f.message); }

    // 4. cross-reference pass: prefix-matching tokens in handler filters / VF searches /
    //    guiconfig criteria / surfacing values must resolve to registry ids
    checks++;
    try {
      for (const f of crossReferenceLint(pkg) ?? []) {
        failed(`${f.path}: token "${f.token}" — ${f.problem}`);
      }
    } catch (e) {
      out.warn(`cross-reference lint skipped: ${e.message}`);
    }

    // f2.map topology lints: shapes that DEPLOY fine but fail silently at run time (§F17/§F18)
    for (const e of entries.filter((x) => x.kind === 'f2.map')) {
      try {
        const local = KINDS['f2.map'].readLocal(pkg, e);
        for (const w of topologyWarnings(local?.obj ?? {})) out.warn(`${e.id}: ${w}`);
      } catch { /* unreadable map — the structural validate already reports it */ }
    }
    for (const f of failures) out.line(`FAIL  ${f}`);
    out.line(`verify${offline ? ' --offline' : ''}: ${entries.length} resources, ${checks} checks, ${failures.length} failures`
      + (offline ? ' (offline lints only — server assertions not run)' : ''));
    if (failures.length) process.exitCode = 1;
    out.result({ resources: entries.length, checks, failures, offline });
  },
};
