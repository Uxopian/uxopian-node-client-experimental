// uxc push — deploy local edits in PUSH_ORDER with TOCTOU re-check, per-resource state
// commit (resumable), policy gates, cache-clear discipline. Handler deploys open the ~45 s
// blind window (footnoted; --settle blocks through it).
import { pushResources, classify } from '../sync.mjs';
import { writeReceipts } from '../receipt.mjs';
import { assertClientSupports } from '../version.mjs';
import { assertServerSupported } from '../dialects.mjs';
import { FOOTNOTES } from '../explain.mjs';
import { fail } from '../output.mjs';

const reclaim = (flags, args, name) => {
  const v = flags[name];
  if (typeof v === 'string') args.push(v);
  return v !== undefined && v !== false;
};

export default {
  name: 'push',
  summary: 'push local edits to the server (ordered, resumable, conflict-safe)',
  help: 'uxc push <id…> | --changed | --all  [--force] [--settle] [--recreate] [--revive] [--ignore-client-version] [--ignore-server-version]',
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
    const ignoreClientVersion = reclaim(flags, args, 'ignore-client-version');
    // CLIENT-VERSION GATE: refuse to deploy a package this uxc is too old for, before connecting.
    assertClientSupports(pkg.manifest, { ignore: ignoreClientVersion, out, action: 'push' });
    ctx.connect();
    // SERVER-version gate (DESIGN §18): the package's supportedVersions vs the detected server
    await assertServerSupported(ctx, pkg.manifest, { ignore: reclaim(flags, args, 'ignore-server-version'), out, action: 'push' });

    let entries;
    if (args.length) {
      entries = args.map((a) => pkg.resolve(a) ?? fail(`unknown resource "${a}" — registered ids: uxc status`));
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
    } else {
      fail('usage: uxc push <id…> | --changed | --all  [--force] [--settle] [--recreate] [--revive]');
    }
    if (!entries.length) { out.line('nothing to push'); out.result([]); return; }

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

    // a FULL-package push stamps the installation receipts (DESIGN §19) — best-effort, never fatal
    if (all) {
      for (const r of await writeReceipts(ctx, pkg.manifest, {})) {
        if (r.ok) out.note(`receipt ${r.surface}: ${r.receipt.code}@${r.receipt.version}`);
        else out.warn(`receipt FAILED on ${r.surface}: ${r.error} (deploy unaffected — uxc installed --write to retry)`);
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
    if (deployed && !settle) out.warn(FOOTNOTES.handlerWindow(45));

    if (actions.some((a) => /conflict|refus|collision/i.test(String(a.action ?? '')))) process.exitCode = 1;
    out.result(actions);
  },
};
