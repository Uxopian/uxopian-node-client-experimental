// The 3-way hash sync engine (DESIGN §8). One rule above all: the BASE is always
// hash(canon(server echo)) — push writes, re-GETs, persists the echo file + its hash; pull
// persists the echo file + its hash. Server-injected fields therefore never show as drift.
//
// Decision matrix (per resource, per target) — implemented in classifyCore():
//   base  file-vs-base  server-vs-base   state            action
//    ✓        =              =           insync           —
//    ✓        ≠              =           local            push
//    ✓        =              ≠           server           pull
//    ✓        ≠              ≠ (=file)   rebased          base auto-recorded
//    ✓        ≠              ≠           conflict         diff, then --force either way
//    ✓       any         server missing  server-missing   push --recreate | rm --local
//    —        —          server absent   new              push creates
//    —        —          present = file  adopted          base recorded silently
//    —        —          present ≠ file  collision        refuse; diff / --force / adopt
//   any      any      no such concept     unsupported      nothing to do on THIS server (dialect gate)
//
// Dialect gate (adapter.serverSupport, DESIGN §18): a kind the connected server does not have —
// ai.goal on uxopian-ai 2026.0.0-ft5+, ai.agent/ai.plan before it — classifies 'unsupported' and
// is skipped by pull and push instead of failing the whole run on a 404. One package can then
// carry both generations and still deploy everything each server understands.
//
// Cache-clear protocol: pendingCacheClear is set in state BEFORE the first cache-affecting
// write, clears run right after the fd.handler block (the ~45 s clock starts there) and once
// more at the end if later cache-affecting kinds (fd.surfacing) wrote; the flag is cleared
// ONLY on a successful DELETE /caches. A dangling flag is surfaced by statusAll.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KINDS, PUSH_ORDER } from './kinds/index.mjs';
import { hasIncludeDirective } from './include.mjs';
import { hashResource } from './canonical.mjs';
import { nowIso, sleep } from './util.mjs';
import { FOOTNOTES } from './explain.mjs';

const HANDLER_IDX = PUSH_ORDER.indexOf('fd.handler');
const SETTLE_MS = 45_000;

const key = (e) => `${e.kind}/${e.id}`;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const orderIdx = (kind) => {
  const i = PUSH_ORDER.indexOf(kind);
  return i === -1 ? PUSH_ORDER.length : i; // unknown/unordered kinds (fd.acl) push last; gated anyway
};

function adapterOf(kind) {
  const a = KINDS[kind];
  if (!a) throw new Error(`unknown kind "${kind}" — registry entry references a kind uxc does not know`);
  return a;
}
const policyOf = (entry) => entry.policy ?? adapterOf(entry.kind).defaultPolicy ?? 'managed';

/** The dialect gate of a kind on this ctx's server: null (supported) or the reason it is not.
 *  Resolved once per kind per run. */
export async function unsupportedReason(ctx, kind) {
  const adapter = adapterOf(kind);
  if (typeof adapter.serverSupport !== 'function') return null;
  ctx._unsupported ??= new Map();
  if (!ctx._unsupported.has(kind)) ctx._unsupported.set(kind, (await adapter.serverSupport(ctx)) ?? null);
  return ctx._unsupported.get(kind);
}

/** hashResource over a {obj, contents?} resource (both sides hash the same joined form). */
const hashOf = (kind, res) =>
  res == null ? null : hashResource(kind, res.obj, Object.values(res.contents ?? {}));

// ---------------------------------------------------------------------------
// The five primitives
// ---------------------------------------------------------------------------

export function localOf(pkg, entry) {
  return adapterOf(entry.kind).readLocal(pkg, entry) ?? null;
}

export function localHash(pkg, entry) {
  return hashOf(entry.kind, localOf(pkg, entry));
}

export async function serverOf(ctx, entry) {
  ctx.requirePkg?.(); // some adapters (fd.surfacing) need ctx.pkg to scope their server read
  ctx.connect?.();
  return (await adapterOf(entry.kind).readServer(ctx, entry.id)) ?? null;
}

export async function serverHash(ctx, entry) {
  return hashOf(entry.kind, await serverOf(ctx, entry));
}

export function baseHash(pkg, targetName, entry) {
  return pkg.resState(targetName, entry.kind, entry.id)?.syncedHash ?? null;
}

// ---------------------------------------------------------------------------
// classify — one resource's 3-way state (full matrix)
// ---------------------------------------------------------------------------

export async function classify(ctx, entry) {
  const pkg = ctx.requirePkg();
  ctx.connect();
  return classifyCore(ctx, pkg, entry, undefined);
}

/** serverRes: undefined = fetch it; null/{...} = pre-fetched (statusAll batch mode). */
async function classifyCore(ctx, pkg, entry, serverRes) {
  const policy = policyOf(entry);
  if (policy === 'external') return { state: 'external', detail: 'referenced only — never pushed or deleted' };
  if (entry.retired) return { state: 'retired', detail: 'tombstoned — excluded from push (uxc push <id> --revive)' };
  const unsupported = await unsupportedReason(ctx, entry.kind);
  if (unsupported) return { state: 'unsupported', detail: unsupported };

  const targetName = ctx.target.name;
  const local = localOf(pkg, entry);
  const lh = hashOf(entry.kind, local);
  const base = baseHash(pkg, targetName, entry);
  const sRes = serverRes !== undefined ? serverRes : await serverOf(ctx, entry);
  const sh = hashOf(entry.kind, sRes);
  // matrix Action column: rebased/adopted record the base automatically
  const recordBase = () => pkg.setResState(targetName, entry.kind, entry.id, { syncedHash: sh });

  if (base != null) {
    if (sh == null) return { state: 'server-missing', detail: 'deleted remotely — uxc push --recreate, or uxc rm --local' };
    if (lh === base && sh === base) return { state: 'insync' };
    if (sh === base) {
      return { state: 'local', detail: local ? 'local edit — uxc push' : 'local file deleted — uxc rm --server, or uxc pull to restore' };
    }
    if (lh === base) return { state: 'server', detail: 'server edit — uxc pull' };
    if (lh != null && lh === sh) {
      recordBase();
      return { state: 'rebased', detail: 'same content already on server — base auto-recorded' };
    }
    return { state: 'conflict', detail: 'both sides changed — uxc diff, then push --force / pull --force' };
  }

  // no base recorded for this target
  if (sh == null) {
    return { state: 'new', detail: local ? 'uxc push creates it' : 'no local file and no server object' };
  }
  if (local == null) return { state: 'server', detail: 'no local file — uxc pull to materialize it' };
  if (lh === sh) {
    recordBase();
    return { state: 'adopted', detail: 'matches the server — base recorded' };
  }
  return { state: 'collision', detail: 'a DIFFERENT same-id object exists on the server — uxc diff, then pull --force / push --force / adopt' };
}

/** Network-free classification: hash(file) vs base only ('local'|'insync', plus the gates). */
function classifyLocal(pkg, targetName, entry, policy) {
  if (policy === 'external') return { state: 'external', detail: 'referenced only — never pushed or deleted' };
  if (entry.retired) return { state: 'retired', detail: 'tombstoned — excluded from push (uxc push <id> --revive)' };
  const lh = localHash(pkg, entry);
  const base = targetName ? baseHash(pkg, targetName, entry) : null;
  if (base != null && lh === base) return { state: 'insync' };
  const detail = lh == null
    ? 'local file missing'
    : base == null
      ? 'no base recorded — uxc status --remote (or push) to classify against the server'
      : 'differs from base — uxc push (uxc status --remote to see the server side)';
  return { state: 'local', detail };
}

// ---------------------------------------------------------------------------
// statusAll — drift + untracked + orphans + pendingCacheClear
// ---------------------------------------------------------------------------

export async function statusAll(ctx, { remote = false, only = [] } = {}) {
  const pkg = ctx.requirePkg();
  let targetName = null;
  try {
    ctx.connect();
    targetName = ctx.target.name;
  } catch (e) {
    if (remote) throw e; // remote mode needs a resolvable target
    targetName = Object.keys(pkg.state?.targets ?? {})[0] ?? null; // local mode: best effort
  }

  const match = (e) => !only.length || only.some((o) => o === e.kind || o === key(e) || o === e.id);
  const entries = pkg.entries().filter(match);

  // remote mode: ONE list call per class kind present (full-object arrays — DESIGN §7);
  // content kinds (dir layouts, surfacing, dataset, ai.* with per-ctx list caches) go per-id.
  let prefetch = null;
  if (remote) {
    prefetch = new Map(); // kind -> Map(id -> {obj})
    const batchKinds = new Set(
      entries
        .filter((e) => policyOf(e) !== 'external' && !e.retired && adapterOf(e.kind).restPath)
        .map((e) => e.kind),
    );
    for (const kind of batchKinds) {
      const listed = await adapterOf(kind).list(ctx);
      prefetch.set(kind, new Map((listed ?? []).filter((o) => o?.id).map((o) => [o.id, { obj: o }])));
    }
  }

  const rows = [];
  const orphans = [];
  for (const entry of entries) {
    const policy = policyOf(entry);
    let res;
    if (!remote) {
      res = classifyLocal(pkg, targetName, entry, policy);
    } else {
      const byId = prefetch.get(entry.kind);
      const serverRes = byId ? (byId.get(entry.id) ?? null) : undefined; // undefined = per-id fetch
      res = await classifyCore(ctx, pkg, entry, serverRes);
    }
    rows.push({ kind: entry.kind, id: entry.id, policy, state: res.state, ...(res.detail ? { detail: res.detail } : {}) });

    if (remote && entry.kind === 'fd.handler' && policy !== 'external' && !entry.retired) {
      try {
        orphans.push(...(await handlerOrphans(ctx, entry)));
      } catch { /* orphan scan is best-effort — drift rows already carry the signal */ }
    }
  }
  rows.sort((a, b) => orderIdx(a.kind) - orderIdx(b.kind) || String(a.id).localeCompare(String(b.id)));

  const pendingCacheClear = targetName ? !!pkg.targetState(targetName).pendingCacheClear : false;
  if (pendingCacheClear) ctx.out?.warn?.(FOOTNOTES.cachePending);

  return { rows, untracked: pkg.untracked(), orphans, pendingCacheClear };
}

/** Stale `_vN` survivors for one handler logical name, via the adapter's registration probe
 *  (fd-handler: adapter.liveRegistrations(ctx, logical) or adapter.extras(ctx, id), both
 *  resolving to an object carrying orphans: [ids]). */
async function handlerOrphans(ctx, entry) {
  const adapter = adapterOf('fd.handler');
  let regs = null;
  // pass the state-recorded deployedId as a hint so a lagging search can't hide the live
  // registration (fd-handler recovers hints by direct GET — LEARNINGS §25)
  const hint = ctx.pkg && ctx.target?.name
    ? ctx.pkg.resState(ctx.target.name, 'fd.handler', entry.id)?.deployedId ?? null
    : null;
  if (typeof adapter.liveRegistrations === 'function') regs = await adapter.liveRegistrations(ctx, entry.id, { hints: [hint] });
  else if (typeof adapter.extras === 'function') regs = await adapter.extras(ctx, entry.id);
  if (!regs || !Array.isArray(regs.orphans)) return [];
  return regs.orphans
    .map((r) => (typeof r === 'string' ? r : r?.id))
    .filter(Boolean)
    .map((id) => ({ kind: 'fd.handler', logical: entry.id, id, detail: 'orphan registration — push/verify deletes it' }));
}

// ---------------------------------------------------------------------------
// pull — server -> local (echo persisted, base = hash(echo))
// ---------------------------------------------------------------------------

/** Package-relative content files of `entry` that are BUILT from @include directives. */
export function composedSources(pkg, entry) {
  const adapter = KINDS[entry.kind];
  if (!adapter || adapter.layout !== 'dir' || !entry.path) return [];
  const dir = join(pkg.dir, entry.path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    try { if (hasIncludeDirective(readFileSync(join(dir, name)))) out.push(`${entry.path}/${name}`); } catch { /* unreadable */ }
  }
  return out.sort();
}

/** Park the server copy under .uxc/pulled/ so a refusal is still actionable (never exported). */
function stashServerCopy(pkg, entry, sRes) {
  try {
    const dir = join(pkg.dir, '.uxc', 'pulled', entry.kind, entry.id);
    mkdirSync(dir, { recursive: true });
    for (const [rel, bytes] of Object.entries(sRes?.contents ?? {})) {
      writeFileSync(join(dir, rel.replace(/.*\//, '')), bytes);
    }
    return relative(pkg.dir, dir);
  } catch { return null; }
}

export async function pullResources(ctx, entries, { force = false, flatten = false } = {}) {
  const pkg = ctx.requirePkg();
  ctx.connect();
  const targetName = ctx.target.name;
  const results = [];

  for (const entry of entries) {
    const row = { kind: entry.kind, id: entry.id };
    try {
      const adapter = adapterOf(entry.kind);
      if (entry.retired) {
        results.push({ ...row, action: 'skipped', detail: 'retired (tombstone) — uxc push <id> --revive first' });
        continue;
      }
      const unsupported = await unsupportedReason(ctx, entry.kind);
      if (unsupported) {
        results.push({ ...row, action: 'unsupported', detail: unsupported });
        continue;
      }
      const sRes = await serverOf(ctx, entry);
      if (!sRes) {
        results.push({ ...row, action: 'skipped', detail: 'not on server — nothing to pull' });
        continue;
      }
      const sh = hashOf(entry.kind, sRes);
      const lh = localHash(pkg, entry);
      const base = baseHash(pkg, targetName, entry);

      if (lh === sh) { // canonically identical already — at most record the base
        if (base !== sh) {
          pkg.setResState(targetName, entry.kind, entry.id, { syncedHash: sh });
          results.push({ ...row, action: 'recorded', detail: base ? 'rebased — base auto-recorded' : 'adopted — base recorded' });
        } else {
          results.push({ ...row, action: 'insync' });
        }
        continue;
      }
      // COMPOSED SOURCES (LEARNINGS §35, BACKLOG #1): a source built from `// @include` directives
      // is 22 lines that EXPAND to 13 000. Writing the server's flat output over it destroys the
      // composition silently — every later edit to a part is then ignored, and push answers
      // "unchanged" until --force. --force means "server wins over my edits"; it does NOT mean
      // "dissolve my build". So this needs its own, explicit consent: --flatten.
      const composed = composedSources(pkg, entry);
      if (composed.length && !flatten) {
        const stash = stashServerCopy(pkg, entry, sRes);
        results.push({
          ...row, action: 'refused',
          detail: `composed source (${composed.join(', ')}) — pulling would flatten ${composed.length > 1 ? 'them' : 'it'} into the server's expanded copy`
            + `${stash ? `; the server copy is in ${stash} for comparison` : ''}`
            + '. Edit the included parts, or pass --flatten to give up the composition.',
        });
        continue;
      }
      // local diverged from base (or exists with no base): pulling would discard local edits
      const losesLocal = base == null ? lh != null : lh !== base;
      if (losesLocal && !force) {
        results.push({
          ...row, action: 'refused',
          detail: base == null
            ? 'collision: local differs from server with no base — uxc diff, then pull --force'
            : 'local edits would be lost — uxc diff, then pull --force',
        });
        continue;
      }
      adapter.writeLocal(pkg, entry, sRes);
      pkg.setResState(targetName, entry.kind, entry.id, { syncedHash: sh });
      results.push({ ...row, action: 'pulled', ...(losesLocal ? { detail: 'forced — local edits overwritten' } : {}) });
    } catch (e) {
      e.message = `${key(entry)}: ${e.message} — earlier pulls are already committed; re-run uxc pull to resume`;
      throw e;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// push — local -> server, PUSH_ORDER, per-resource state commit, cache protocol
// ---------------------------------------------------------------------------

export async function pushResources(ctx, entries, { force = false, settle = false, recreate = false } = {}) {
  const pkg = ctx.requirePkg();
  ctx.connect();
  const targetName = ctx.target.name;
  const ordered = [...entries].sort((a, b) => orderIdx(a.kind) - orderIdx(b.kind)); // stable within kind

  const st = {
    armed: !!pkg.targetState(targetName).pendingCacheClear, // a dangling flag from a previous run stays armed
    cacheDirty: false,      // cache-affecting write since the last successful clear
    handlerTouched: false,  // handler write since the last clear -> clear /core too
    handlerPushed: false,   // any handler deployed this run -> --settle applies
  };

  const tryCacheClear = async () => {
    try {
      await ctx.clients.cacheClear({ coreToo: st.handlerTouched });
      pkg.setPendingCacheClear(targetName, false); // cleared ONLY on success
      st.armed = false;
      st.cacheDirty = false;
      st.handlerTouched = false;
      ctx.out?.note?.('caches cleared');
    } catch (e) {
      ctx.out?.warn?.(`cache clear FAILED — pendingCacheClear stays set; clear manually (Administration > caches) or run uxc cache-clear. ${e.message}`);
    }
  };

  const afterHandlerBlock = async () => {
    if (st.cacheDirty) await tryCacheClear(); // the ~45 s clock starts here
    if (settle && st.handlerPushed) {
      ctx.out?.line?.(`--settle: waiting ${SETTLE_MS / 1000}s — ${FOOTNOTES.handlerWindow(SETTLE_MS / 1000)}`);
      await sleep(SETTLE_MS);
    }
  };

  const results = [];
  let pastHandlerBlock = false;
  for (const entry of ordered) {
    if (!pastHandlerBlock && orderIdx(entry.kind) > HANDLER_IDX) {
      await afterHandlerBlock();
      pastHandlerBlock = true;
    }
    results.push(await pushOne(ctx, pkg, targetName, entry, { force, recreate }, st));
  }
  if (!pastHandlerBlock) await afterHandlerBlock();
  if (st.cacheDirty) await tryCacheClear(); // later cache-affecting kinds (fd.surfacing)

  return results;
}

async function pushOne(ctx, pkg, targetName, entry, { force, recreate }, st) {
  const adapter = adapterOf(entry.kind);
  const k = key(entry);
  const policy = policyOf(entry);
  const row = { kind: entry.kind, id: entry.id };

  // policy gates that need no network
  if (policy === 'external') return { ...row, action: 'skipped', detail: 'policy external — never pushed' };
  if (entry.retired) return { ...row, action: 'skipped', detail: 'retired (tombstone) — uxc push <id> --revive to restore' };

  const unsupported = await unsupportedReason(ctx, entry.kind);
  if (unsupported) return { ...row, action: 'unsupported', detail: unsupported };

  const local = localOf(pkg, entry);
  if (!local) return { ...row, action: 'invalid', detail: 'local file missing' };

  // validate: collect errors, abort THIS entry only
  const errs = adapter.validate(pkg, entry, local) ?? [];
  if (errs.length) return { ...row, action: 'invalid', detail: errs.join('; ') };
  if (typeof adapter.lintHelpers === 'function') { // ai.prompt deviation: network lint = warnings, never blocking
    try {
      for (const w of (await adapter.lintHelpers(ctx, local)) ?? []) ctx.out?.warn?.(`${k}: ${w}`);
    } catch { /* lint endpoint unavailable — skip */ }
  }

  const lh = hashOf(entry.kind, local);
  const base = baseHash(pkg, targetName, entry);

  try {
    // TOCTOU guard: ONE fresh server read immediately before the decision + write
    const sRes = await serverOf(ctx, entry);
    const sh = hashOf(entry.kind, sRes);

    // createOnly: create-if-absent; else verify + report drift — NEVER update (even --force).
    // Exception: kinds whose adapter sets inPlaceUpdate (fd.taskclass) fall through to the normal
    // update path below — a same-id POST /{id} full-replace is binding-safe (LEARNINGS §20). DELETE
    // stays policy-gated in rm.mjs regardless; only delete+recreate is dangerous (§14). The fall-through
    // keeps every base/force collision + conflict guard (status already classifies these as 'local').
    if (policy === 'createOnly' && sRes && !adapter.inPlaceUpdate) {
      if (lh === sh) {
        if (base !== sh) pkg.setResState(targetName, entry.kind, entry.id, { syncedHash: sh });
        return { ...row, action: 'verified', detail: 'createOnly — server matches local' };
      }
      return { ...row, action: 'drift', detail: 'createOnly — refusing update; server differs from local (schema change needs a NEW id)' };
    }

    const routedPush = typeof adapter.push === 'function'; // fd.handler routes create AND update via push()

    if (sRes) {
      if (lh === sh) {
        // identical content. fd.handler exception (§7.11): unchanged skips ONLY when exactly one
        // live registration exists — surviving orphans force a rotation that sweeps them.
        const orphans = routedPush && entry.kind === 'fd.handler' ? await handlerOrphans(ctx, entry) : [];
        if (!orphans.length) {
          if (base === sh) return { ...row, action: 'unchanged' };
          pkg.setResState(targetName, entry.kind, entry.id, { syncedHash: sh });
          return { ...row, action: base ? 'rebased' : 'adopted', detail: 'content already on server — base recorded' };
        }
        ctx.out?.note?.(`${k}: content unchanged but ${orphans.length} orphan registration(s) survive — rotating to sweep them`);
      }
      if (lh !== sh) {
        if (base == null && !force) {
          return { ...row, action: 'refused', detail: 'collision: a DIFFERENT same-id object exists — uxc diff, then push --force / pull --force / adopt' };
        }
        if (base != null && sh !== base && !force) {
          return {
            ...row, action: 'refused',
            detail: lh === base
              ? 'server edited since last sync — uxc pull (push --force to overwrite)'
              : 'conflict: both sides changed — uxc diff, then push --force / pull --force',
          };
        }
      }
    } else if (base != null && !recreate) {
      return { ...row, action: 'skipped', detail: 'deleted remotely — uxc push --recreate to recreate, or uxc rm --local' };
    }

    // ---- write ----
    // arm the pending flag BEFORE the first cache-affecting write of this run
    if (adapter.cacheAffecting && !st.armed) {
      pkg.setPendingCacheClear(targetName, true);
      st.armed = true;
    }

    let statePatch = {};
    let action;
    let inPlace = false;
    if (routedPush) {
      // version-rotation kinds own the full deploy (skip-if-unchanged, _v(max+1), orphan sweep)
      const r = await adapter.push(ctx, entry, local);
      statePatch = isObj(r) ? { ...r } : {};
      if (entry.kind === 'fd.handler') {
        statePatch.deployedAt = nowIso();
        st.handlerPushed = true;
        st.handlerTouched = true;
        action = 'deployed';
      } else {
        action = sRes ? 'updated' : 'created';
      }
    } else if (!sRes) {
      const r = await adapter.create(ctx, local); // adapters may return a state patch ({serverId}, {expansion}…)
      if (isObj(r)) statePatch = r;
      action = base != null ? 'recreated' : 'created';
    } else {
      const r = await adapter.update(ctx, entry.id, local);
      if (isObj(r)) statePatch = r;
      action = 'updated';
      // BACKLOG #10: `createOnly` + inPlaceUpdate (fd.taskclass) reads as "dangerous kind" and
      // agents avoid touching it. Adding tags in place is the SAFE operation — say so, so nobody
      // works around it with a delete+recreate, which is the one thing that breaks bindings (§14/§20).
      if (adapter.inPlaceUpdate) inPlace = true;
    }
    if (adapter.cacheAffecting) st.cacheDirty = true;

    // Self-managed adapters (fd.dataset) write the local file AND commit rows/syncedHash
    // inside create/update. The generic echo leg below re-reads the server and overwrites
    // the local file — but datasets enumerate via SEARCH, which LAGS doc creation, so a
    // re-read right after a bulk create can return an incomplete set and silently drop
    // not-yet-indexed rows from the local file. Trust the adapter; merge any state patch only.
    if (adapter.selfManagedWriteback) {
      if (isObj(statePatch) && Object.keys(statePatch).length) {
        pkg.setResState(targetName, entry.kind, entry.id, statePatch);
      }
      const forcedSelf = force && sRes && lh !== sh && (base == null || sh !== base);
      return { ...row, action, ...(forcedSelf ? { detail: 'forced — server-side version overwritten' } : {}) };
    }

    // echo leg: base is ALWAYS canon(server) — re-GET, persist the file, hash the echo
    const echo = await adapter.readServer(ctx, entry.id);
    let syncedHash;
    if (echo) {
      adapter.writeLocal(pkg, entry, echo);
      syncedHash = hashOf(entry.kind, echo);
    } else {
      syncedHash = lh; // should not happen — keep the run resumable, flag it
      ctx.out?.warn?.(`${k}: no server echo after write — base recorded from the local form; run uxc status --remote to confirm`);
    }
    // commit state IMMEDIATELY: a failure on a later entry leaves this one synced (resumable)
    pkg.setResState(targetName, entry.kind, entry.id, { syncedHash, ...statePatch });

    const forced = force && sRes && lh !== sh && (base == null || sh !== base);
    const detail = [
      forced ? 'forced — server-side version overwritten' : null,
      inPlace ? 'updated IN PLACE — existing tasks and their answer bindings are preserved (no recreate)' : null,
    ].filter(Boolean).join(' · ');
    return { ...row, action, ...(detail ? { detail } : {}) };
  } catch (e) {
    // first hard failure aborts the run; state is already committed for prior items
    e.message = `${k}: ${e.message} — re-run \`uxc push --changed\` to resume`;
    throw e;
  }
}
