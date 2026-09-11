// uxc context — the package map an agent otherwise rebuilds by grep in its first ten minutes
// (BACKLOG-AGENTIC #11, confirmed twice on the Gerflor POC). Offline, deterministic, and small:
// kinds and counts, the ids that matter, the include order, owned prefixes, the operating policy,
// the composed-size budget, the gotchas file, and what sync state says about the target.
//
// Budget: ~1 000 tokens by default. --full lifts the per-kind id caps; --json gives the same
// facts structured. Nothing here talks to a server — a map you cannot read offline is not a map.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_VERSION } from '../version.mjs';
import { prefixForms } from '../naming.mjs';
import { includeOrders, declaredIncludeOrder, resourceSizes, sizeWarnings, kb, DEFAULT_SIZE_WARN_BYTES } from '../lint.mjs';

const ID_CAP = 12;          // ids listed per kind before eliding
const GOTCHA_LINES = 40;

/** The shared-library order actually used, inferred from the composed source that uses the most. */
function inferredIncludeOrder(pkg) {
  const orders = includeOrders(pkg);
  if (!orders.length) return null;
  const best = orders.reduce((a, b) => (b.includes.length > a.includes.length ? b : a));
  return { from: best.path, order: best.includes.map((p) => p.replace(/.*\//, '')) };
}

export default {
  name: 'context',
  summary: 'compact package map for an agent: kinds, ids, include order, policy, gotchas',
  help: 'uxc context [--full] [--json]',
  async run(ctx) {
    const { out, flags } = ctx;
    const pkg = ctx.requirePkg();
    const m = pkg.manifest;
    const policy = ctx.policy ?? {};
    const cap = flags.full ? 1e9 : ID_CAP;

    const entries = pkg.entries().filter((e) => !e.retired);
    const byKind = new Map();
    for (const e of entries) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      byKind.get(e.kind).push(e.id);
    }
    const kinds = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, ids]) => ({ kind, count: ids.length, ids: ids.sort() }));

    const inc = inferredIncludeOrder(pkg);
    const declared = declaredIncludeOrder(pkg);
    const sizes = resourceSizes(pkg, entries);
    const budget = sizeWarnings(sizes, DEFAULT_SIZE_WARN_BYTES * 0.6); // report earlier than push warns
    const retired = pkg.entries().filter((e) => e.retired).map((e) => `${e.kind}/${e.id}`);

    // sync state, per target, without touching the network
    const targets = Object.entries(pkg.state?.targets ?? {}).map(([name, st]) => ({
      name,
      synced: Object.keys(st.resources ?? {}).length,
      pendingCacheClear: !!st.pendingCacheClear,
    }));

    const gotchasPath = policy.gotchas ?? ['GOTCHAS.md', 'docs/GOTCHAS.md'].find((p) => existsSync(join(pkg.dir, p)));
    let gotchas = null;
    if (gotchasPath && existsSync(join(pkg.dir, gotchasPath))) {
      const text = readFileSync(join(pkg.dir, gotchasPath), 'utf8').split('\n');
      gotchas = { path: gotchasPath, lines: text.length, head: text.slice(0, flags.full ? 1e9 : GOTCHA_LINES) };
    }

    if (out.json) {
      return out.result({
        package: { name: m.name, code: m.code, version: m.version, prefixes: m.idPrefixes ?? prefixForms(m.code), dir: pkg.dir },
        client: CLIENT_VERSION,
        minClientVersion: m.minClientVersion ?? m.requires?.uxc ?? null,
        kinds, retired, targets,
        policy: { target: policy.target ?? null, targetFrom: policy.targetFrom ?? null, protect: policy.protect ?? [], neverPull: policy.neverPull ?? [], forbid: policy.forbid ?? [] },
        includeOrder: { declared, inferred: inc },
        sizes: sizes.slice(0, 10),
        gotchas: gotchas ? { path: gotchas.path, lines: gotchas.lines } : null,
      });
    }

    // idPrefixes is the manifest override; otherwise the four forms derive from the code
    const forms = m.idPrefixes ?? (m.code ? prefixForms(m.code) : {});
    const prefixes = Object.entries(forms).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)';
    out.line(`${m.code ?? '(no code)'} — ${m.name ?? '(unnamed)'}${m.version ? ` v${m.version}` : ''}  ·  prefixes ${prefixes}  ·  uxc ${CLIENT_VERSION}`);
    out.line(`dir ${pkg.dir}`);
    if (policy.target) out.line(`target PINNED to "${policy.target}" (${policy.targetFrom}) — --target may only confirm it`);
    out.line('');

    out.line(`resources: ${entries.length}${retired.length ? ` (+${retired.length} retired)` : ''}`);
    for (const k of kinds) {
      const shown = k.ids.slice(0, cap);
      out.line(`  ${String(k.count).padStart(3)} ${k.kind.padEnd(18)} ${shown.join(' ')}${k.ids.length > shown.length ? ` … +${k.ids.length - shown.length}` : ''}`);
    }

    const bands = m.registrationOrderBands ?? {};
    if (Object.keys(bands).length) {
      out.line('');
      out.line(`registrationOrder bands: ${Object.entries(bands).map(([k, v]) => `${k} [${v}]`).join(', ')}`);
    }

    if (inc) {
      out.line('');
      out.line(`include order (from ${inc.from}):`);
      out.line(`  ${inc.order.join(' -> ')}`);
      if (declared.length) out.line(`  declared in the manifest (verified by uxc verify): ${declared.join(' -> ')}`);
      else out.note('not declared — add "includeOrder": [...] to uxopian-project.json and uxc verify will enforce it');
    }

    if (budget.length) {
      out.line('');
      out.line('composed size (server body limit ~1.0 MB):');
      for (const b of budget) out.line(`  ${b.kind}/${b.id}  ${kb(b.bytes)}${b.saved > 0 ? `  (strip would save ${kb(b.saved)})` : ''}`);
    }

    const pol = [
      policy.protect?.length ? `protect ${policy.protect.join(', ')}` : null,
      policy.neverPull?.length ? `neverPull ${policy.neverPull.join(', ')}` : null,
      policy.forbid?.length ? `forbid ${policy.forbid.map((f) => `"${f}"`).join(', ')}` : null,
    ].filter(Boolean);
    if (pol.length) {
      out.line('');
      out.line('policy (uxopian-project.json "agent", enforced by the CLI):');
      for (const p of pol) out.line(`  ${p}`);
    }

    if (targets.length) {
      out.line('');
      out.line('sync state:');
      for (const t of targets) {
        out.line(`  ${t.name}: ${t.synced} resource(s) with a recorded base${t.pendingCacheClear ? '  · pendingCacheClear SET (uxc cache-clear)' : ''}`);
      }
      out.note('these are recorded bases, not live truth — uxc status --remote checks the server');
    }

    if (gotchas) {
      out.line('');
      out.line(`gotchas (${gotchas.path}, ${gotchas.lines} lines${gotchas.head.length < gotchas.lines ? `, first ${gotchas.head.length}` : ''}):`);
      for (const l of gotchas.head) out.line(`  ${l}`);
    }
  },
};
