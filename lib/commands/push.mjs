// uxc push — deploy local edits in PUSH_ORDER with TOCTOU re-check, per-resource state
// commit (resumable), policy gates, cache-clear discipline. Handler deploys open the ~45 s
// blind window (footnoted; --settle blocks through it).
import { pushResources, classify } from '../sync.mjs';
import { writeReceipts, assertReceiptFlow } from '../receipt.mjs';
import { scanPlaceholders } from '../variables.mjs';
import { assertDependencies } from '../dependencies.mjs';
import { pruneRemoved, shouldHoldReceipt } from '../prune.mjs';
import { assertClientSupports } from '../version.mjs';
import { assertServerSupported } from '../dialects.mjs';
import { FOOTNOTES } from '../explain.mjs';
import { lintTagValues, lintPromptVariables, promptProviderOrder, resourceSizes, sizeWarnings } from '../lint.mjs';
import { partitionProtected } from '../agent.mjs';
import { recordHandlerWindow } from '../lock.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'push',
  summary: 'push local edits to the server (ordered, resumable, conflict-safe)',
  help: 'uxc push <id|kind/id …> | --changed | --all  [--paths a,b] [--force] [--settle] [--recreate] [--revive] [--yes-removals|--keep-removed] [--ignore-*]',
  lock: 'write',
  async run(ctx) {
    const { flags, out } = ctx;
    const pkg = ctx.requirePkg();
    const args = [...ctx.args];
    const all = reclaim(flags, args, 'all');
    const changed = reclaim(flags, args, 'changed');
    const force = reclaim(flags, args, 'force');
    const settle = reclaim(flags, args, 'settle');
    const recreate = reclaim(flags, args, 'recreate');
    const revive = reclaim(flags, args, 'revive');
    const ignoreLint = reclaim(flags, args, 'ignore-lint');
    const ignoreClientVersion = reclaim(flags, args, 'ignore-client-version');
    // CLIENT-VERSION GATE: refuse to deploy a package this uxc is too old for, before connecting.
    // TEMPLATE guard (DESIGN §21): placeholders never enter the sync loop — a checkout with
    // unrendered {{uxc:…}} placeholders in RESOURCE files cannot push (assets/ may keep them:
    // assets are never pushed as resources).
    const scan = scanPlaceholders(pkg.dir);
    const inResources = Object.entries(scan.files).filter(([f]) => !f.startsWith('assets/') && f !== 'README.md' && f !== 'CLAUDE.md');
    if (inResources.length) {
      fail(
        `this is a TEMPLATE checkout — unrendered variables in resource files:\n` +
        inResources.map(([f, ns]) => `  ${f}: ${ns.map((n) => `{{uxc:${n}}}`).join(', ')}`).join('\n') +
        `\na synced checkout must be concrete (DESIGN §21): install the artifact with --var values (uxc import/mp install), or replace the placeholders here.`,
      );
    }
    assertClientSupports(pkg.manifest, { ignore: ignoreClientVersion, out, action: 'push' });
    ctx.connect();
    // SERVER-version gate (DESIGN §18): the package's supportedVersions vs the detected server
    await assertServerSupported(ctx, pkg.manifest, { ignore: reclaim(flags, args, 'ignore-server-version'), out, action: 'push' });
    // full-package pushes check dependencies + respect the installed receipt (DESIGN §22/§19)
    if (all) {
      await assertDependencies(ctx, pkg.manifest, { ignore: reclaim(flags, args, 'ignore-dependencies'), out, action: 'push' });
      await assertReceiptFlow(ctx, pkg.manifest, { force, out, action: 'push' });
    }

    let entries;
    if (args.length) {
      entries = args.map((a) => pkg.resolve(a) ?? fail(
        `unknown resource "${a}" — accepted forms: <id> (when unique) or <kind>/<id>; deployed handler ids (Name_vN) resolve to their logical name. Registered ids: uxc status`,
      ));
      for (const e of entries) {
        if (e.retired && revive) {
          e.retired = false;
          pkg.saveRegistry();
          out.line(`revived     ${e.kind}/${e.id} (tombstone cleared)`);
        } else if (e.retired) {
          out.warn(`${e.kind}/${e.id} is retired (tombstoned) — skipped; use --revive to un-tombstone`);
        }
      }
      entries = entries.filter((e) => !e.retired);
    } else if (all || changed) {
      entries = pkg.entries().filter((e) => !e.retired);
      if (changed) {
        const kept = [];
        for (const e of entries) {
          const c = await classify(ctx, e);
          if (c.state === 'local' || c.state === 'new') kept.push(e);
        }
        entries = kept;
      }
      // --paths (BACKLOG #5): with two agents editing disjoint files of one checkout, --changed
      // ships the other agent's half-done work. Scoping to the paths THIS task owns makes a sweep
      // safe again without giving up its resumability.
      const paths = typeof flags.paths === 'string' ? flags.paths.split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (paths.length) {
        const before = entries.length;
        entries = entries.filter((e) => paths.some((p) => e.path === p || String(e.path ?? '').startsWith(p.replace(/\/$/, '') + '/')));
        out.note(`--paths ${paths.join(', ')}: ${entries.length} of ${before} changed resource(s) are in scope`);
      }
    } else {
      fail('usage: uxc push <id|kind/id …> | --changed | --all  [--force] [--settle] [--recreate] [--revive]');
    }
    // agent.protect (BACKLOG #12): a sweep skips a protected resource, naming one is an error
    const prot = partitionProtected(ctx.policy?.protect ?? [], entries);
    if (prot.blocked.length) {
      if (args.length) {
        fail(`refused: ${prot.blocked.map((b) => `${b.entry.kind}/${b.entry.id}`).join(', ')} — listed in uxopian-project.json agent.protect.`
          + ' Remove it from that list to push it.');
      }
      for (const b of prot.blocked) out.line(`${'skipped'.padEnd(12)} ${b.entry.kind}/${b.entry.id}  agent.protect "${b.pattern}"`);
      entries = prot.allowed;
    }
    if (!entries.length) { out.line('nothing to push'); out.result([]); return; }

    // ---- offline pre-flight (BACKLOG #7/#17/#20) ----
    // Both halves of these checks are in the package. Finding out from a 500 halfway through a
    // push — with earlier resources already on the server — is finding out too late.
    const inPlan = (where) => entries.some((e) => where === `${e.kind}/${e.id}` || where.startsWith(`${e.id}/`));
    const tagProblems = lintTagValues(pkg);
    const blocking = tagProblems.filter((t) => inPlan(t.where));
    for (const t of tagProblems.filter((t) => !inPlan(t.where))) out.warn(`${t.message} (not in this push)`);
    if (blocking.length && !ignoreLint) {
      fail(`refused — ${blocking.length} constrained tag value(s) the server will reject with 500 F00020:\n`
        + blocking.map((t) => `  ${t.message}`).join('\n')
        + '\nFix them (or --ignore-lint to push anyway and fail mid-run).');
    }
    for (const f of lintPromptVariables(pkg)) {
      if (f.kind === 'unprovided' && entries.some((e) => e.kind === 'ai.prompt' && e.id === f.prompt)) out.warn(f.message);
    }
    for (const w of sizeWarnings(resourceSizes(pkg, entries))) out.warn(w.message);
    for (const h of promptProviderOrder(pkg, entries)) out.note(`push order: ${h.why}`);

    let actions;
    try {
      actions = await pushResources(ctx, entries, { force, settle, recreate });
    } catch (e) {
      const lines = [e.message];
      if (e.explanation) lines.push(`  ↳ ${e.explanation}`);
      lines.push('state is committed for the resources already pushed — re-run `uxc push --changed` to resume');
      fail(lines.join('\n'));
    }

    for (const a of actions) out.line(`${String(a.action ?? '').padEnd(12)} ${a.id}${a.detail ? '  ' + a.detail : ''}`);
    out.line(`push: ${actions.length} resources`);

    // UPGRADE PRUNING (DESIGN §23, DEFAULT): resources this checkout previously synced to the
    // target but which the new version no longer carries are deleted — after a printed list and
    // a confirmation (TTY y/N, or --yes-removals; --keep-removed opts out).
    if (all) {
      const keepRemoved = reclaim(flags, args, 'keep-removed');
      const stateKeys = Object.keys(pkg.targetState(ctx.target.name).resources ?? {});
      const pruneRes = await pruneRemoved(ctx, stateKeys, pkg.entries(), {
        yes: reclaim(flags, args, 'yes-removals'),
        keep: keepRemoved,
        out,
        onDeleted: (c) => pkg.setResState(ctx.target.name, c.kind, c.id, null),
      });
      // receipts advance ONLY when the upgrade is COMPLETE (removals confirmed, kept explicitly,
      // or none) — an advanced receipt over a skipped prune strands the orphan (§23)
      if (shouldHoldReceipt(pruneRes, { keep: keepRemoved })) {
        out.warn(`receipt NOT advanced — the upgrade is incomplete until the removals above are resolved (re-run with --yes-removals, or --keep-removed to accept the leftovers)`);
      } else {
        const resources = pkg.entries().filter((e) => !e.retired).map((e) => `${e.kind}/${e.id}`);
        for (const r of await writeReceipts(ctx, pkg.manifest, { resources })) {
          if (r.ok) out.note(`receipt ${r.surface}: ${r.receipt.code}@${r.receipt.version}`);
          else out.warn(`receipt FAILED on ${r.surface}: ${r.error} (deploy unaffected — uxc installed --write to retry)`);
        }
      }
    }

    // any actually-deployed handler opens the blind window
    const handlerIds = new Set(entries.filter((e) => e.kind === 'fd.handler').map((e) => e.id));
    const deployed = actions.some((a) => {
      const id = String(a.id ?? '');
      const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
      const touchesHandler = id.startsWith('fd.handler/') || handlerIds.has(bare);
      return touchesHandler && !/unchanged|insync|skip|noop|verified/i.test(String(a.action ?? ''));
    });
    if (deployed) {
      // The ~45 s window outlives this process (LEARNINGS §36). Recording it lets the next handler
      // push wait it out instead of opening a second, overlapping window — with --settle we already
      // sat through it under the lock, so nothing is left to record.
      if (!settle) {
        recordHandlerWindow(ctx.lockKey, 45_000, `uxc push (pid ${process.pid})`);
        out.warn(FOOTNOTES.handlerWindow(45));
      }
    }

    if (actions.some((a) => /conflict|refus|collision/i.test(String(a.action ?? '')))) process.exitCode = 1;
    out.result(actions);
  },
};
