// Row ownership for `data push --prune` and fd.dataset remove() (DESIGN §31): a dataset can be fed by
// SEVERAL installed packages (a product and its extension both contribute rows to CmTeams). Prune deletes
// "server rows absent locally" — which, in a shared dataset, are the OTHER package's rows. This module
// tells whose a row is, from the installation receipts (the installed-ledger, DESIGN §19): every other
// INSTALLED package owns the ids carrying its prefix forms, and the LONGEST matching prefix wins (own `cm`
// vs installed `cm2`: `Cm2Team` is cm2's). Receipts unreadable: the set installed at the last successful
// read stands in, and declared dependencies additionally shield their rows from every write.
import { prefixForms } from './naming.mjs';
import { readReceiptsChecked } from './receipt.mjs';
import { declaredDependencies } from './dependencies.mjs';

// NOTE: foreign packages' forms are always derived from their code. Receipts do not carry `idPrefixes`
// (neither the FD receipt doc nor the AI receipt prompt records them), so a receipt-side override was
// dead code and was removed; only THIS package's manifest `idPrefixes` is honoured.

/**
 * Length of the longest prefix form of `f` that `id` carries, 0 when none. Boundary rules per form:
 *   upper `CM_` / kebab `cm-` carry their own separator (kebab compared case-insensitively);
 *   pascal `Cm` / camel `cm` need the next char to start a new word.
 * `strict` (claims of OUR package — what we may delete): the next char must be an uppercase letter.
 * lenient (protection of ANOTHER package — what we must keep): an uppercase letter, a digit or `_`
 * also count (carriesForms' rule), so an unknown `Cm2024Team` still shields under `cm`. A longer
 * installed code (`cm2` -> `Cm2`) still out-matches it. The asymmetry only ever errs on keeping.
 */
export function prefixMatchLength(f, id, { strict = false } = {}) {
  const s = String(id);
  const next = strict ? /^[A-Z]/ : /^[A-Z0-9_]/;
  let best = 0;
  const take = (n) => { if (n > best) best = n; };
  if (f.upper && s.startsWith(f.upper)) take(f.upper.length);
  if (f.kebab && s.toLowerCase().startsWith(f.kebab.toLowerCase())) take(f.kebab.length);
  if (f.pascal && s.startsWith(f.pascal) && next.test(s.slice(f.pascal.length))) take(f.pascal.length);
  if (f.camel && s.startsWith(f.camel) && next.test(s.slice(f.camel.length))) take(f.camel.length);
  return best;
}

/**
 * Whose rows are whose on the connected target (DESIGN §31), and whether the receipts were PROVABLY
 * read (readReceiptsChecked — "none" vs "could not read").
 *
 * Receipts READ: `owners` = every OTHER package with a receipt here (deduplicated across surfaces).
 *   A declared dependency counts only when it is INSTALLED — i.e. has a receipt, so it is already
 *   in. The set is persisted in sync state (pkg.setInstalledSeen) at each successful read.
 * Receipts UNREADABLE: `owners` = the packages recorded as installed at the LAST successful read
 *   (empty when never read) — so the dataset hash stays what it was when the receipts last read.
 *   `guardOwners` adds every declared dependency: WRITES (push incl. --force, pull, prune, remove)
 *   never touch a row carrying any of those prefixes while the receipts cannot be read (fail safe).
 * Receipts read, `guardOwners` IS `owners`. A package alone on its target has no owners at all, so
 * every hash and decision is byte-identical to uxc 0.24.0.
 * -> { owners, guardOwners: [{ code, forms, source: 'receipt'|'last-read'|'dependency' }] sorted by
 *      code, never the package itself, receiptsReadable: bool, receiptErrors: [string] }
 */
export async function rowOwners(ctx, manifest, { checked = null } = {}) {
  const self = manifest?.code;
  const { receipts, readable, errors } = checked ?? await readReceiptsChecked(ctx);
  const target = ctx?.target?.name;
  const pkg = ctx?.pkg;
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const by = new Map();
  if (readable) {
    for (const r of receipts) {
      if (!r?.code || r.code === '?' || r.code === self || by.has(r.code)) continue;
      by.set(r.code, { code: r.code, forms: prefixForms(r.code), source: 'receipt' });
    }
    try { if (pkg?.setInstalledSeen && target) pkg.setInstalledSeen(target, [...by.keys()]); } catch { /* best-effort */ }
    const owners = [...by.values()].sort(byCode);
    return { owners, guardOwners: owners, receiptsReadable: true, receiptErrors: [] };
  }
  let seen = [];
  try { seen = (pkg?.installedSeen && target ? pkg.installedSeen(target) : null) ?? []; } catch { seen = []; }
  for (const code of seen) {
    if (!code || code === self || by.has(code)) continue;
    by.set(code, { code, forms: prefixForms(code), source: 'last-read' });
  }
  const owners = [...by.values()].sort(byCode);
  const guard = new Map(by);
  for (const d of declaredDependencies(manifest)) {
    if (d.code === self || guard.has(d.code)) continue;
    guard.set(d.code, { code: d.code, forms: prefixForms(d.code), source: 'dependency' });
  }
  return { owners, guardOwners: [...guard.values()].sort(byCode), receiptsReadable: false, receiptErrors: errors };
}

/** rowOwners without the readability verdict — the owner list only. */
export async function foreignOwners(ctx, manifest) {
  return (await rowOwners(ctx, manifest)).owners;
}

/**
 * Split server row ids into ours (deletable), another package's, and unproven. PURE.
 * Each id goes to the LONGEST matching prefix: this package's (strict boundary, manifest idPrefixes
 * honoured) against every other owner's (lenient boundary); a tie goes to this package.
 *   own prefix longest            -> own
 *   another package's prefix      -> foreign {id, code}
 *   no known prefix               -> own when receiptsReadable (the pre-§31 behaviour),
 *                                    else unproven (kept: we cannot know nobody owns it)
 * -> { own: [id], foreign: [{ id, code }], unproven: [id] }
 */
export function splitRowOwnership(ids, manifest, owners, { receiptsReadable = true } = {}) {
  const mine = manifest?.code
    ? { ...prefixForms(manifest.code), ...(manifest?.idPrefixes && typeof manifest.idPrefixes === 'object' ? manifest.idPrefixes : {}) }
    : null;
  const own = []; const foreign = []; const unproven = [];
  for (const id of ids) {
    const ownLen = mine ? prefixMatchLength(mine, id, { strict: true }) : 0;
    let hit = null; let hitLen = 0;
    for (const o of owners ?? []) {
      const n = prefixMatchLength(o.forms, id);
      if (n > hitLen) { hit = o; hitLen = n; }
    }
    if (ownLen && ownLen >= hitLen) own.push(id);
    else if (hit) foreign.push({ id, code: hit.code });
    else if (receiptsReadable) own.push(id);
    else unproven.push(id);
  }
  return { own, foreign, unproven };
}

// ---------------------------------------------------------------------------------------------------
// Tag-class VALUE ownership (#126, DESIGN §28): a product's CHOICELIST tag class also holds the values an
// installed extension's fd.tagclass-delta added. Same ledger, same longest-prefix rule as rows (§31), plus
// the one thing a prefix cannot tell: the UNPREFIXED legacy values an extension's push added (§30) — each
// receipt (uxc >= 0.25.1) records them in `tagContributions`.
// ---------------------------------------------------------------------------------------------------

/**
 * Run `fn` with a per-operation memo on ctx (one receipt read per status / pull / push run, however
 * many tag classes it reads). Nested calls share the outer scope; the memo never outlives `fn`.
 */
export async function inOwnerScope(ctx, fn) {
  if (!ctx || ctx._ownerScope) return fn();
  ctx._ownerScope = new Map();
  try { return await fn(); } finally { delete ctx._ownerScope; }
}

/**
 * Who owns which values of the tag classes on the connected target — rowOwners + the receipts'
 * tagContributions. Receipts unreadable: `contributions` is empty (nothing is attributed: the values stay
 * in the hash — fail safe) and the caller guards writes with guardOwners.
 * -> { owners, guardOwners, receiptsReadable, receiptErrors, contributions: Map(tagClass -> Map(name -> code)) }
 */
export async function tagValueOwners(ctx, manifest) {
  const memo = ctx?._ownerScope;
  const k = `tag:${manifest?.code ?? ''}`;
  if (memo?.has(k)) return memo.get(k);
  const run = (async () => {
    const checked = await readReceiptsChecked(ctx);
    const base = await rowOwners(ctx, manifest, { checked });
    const contributions = new Map();
    const unknown = new Map(); // tagClass -> [code]: installed by a uxc < 0.25.1 (no tagContributions)
    if (base.receiptsReadable) {
      const self = manifest?.code;
      const others = [...checked.receipts].filter((r) => r?.code && r.code !== '?' && r.code !== self)
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      const known = new Set(others.filter((r) => Array.isArray(r.tagContributions)).map((r) => r.code));
      for (const r of others) {
        if (Array.isArray(r.tagContributions)) {
          for (const c of r.tagContributions) {
            const m = contributions.get(c.tagClass) ?? new Map();
            for (const n of c.values ?? []) if (!m.has(n)) m.set(n, r.code);
            contributions.set(c.tagClass, m);
          }
        } else if (!known.has(r.code)) {
          // UNKNOWN contributions: the package's deltas target these classes, but no receipt says which
          // values they added — its unprefixed values cannot be told from the product's (fail safe)
          for (const k of r.resources ?? []) {
            const m = /^fd\.tagclass-delta\/(.+)$/.exec(String(k));
            if (!m) continue;
            const list = unknown.get(m[1]) ?? [];
            if (!list.includes(r.code)) list.push(r.code);
            unknown.set(m[1], list);
          }
        }
      }
    }
    return { ...base, contributions, unknown };
  })();
  memo?.set(k, run);
  return run;
}

/**
 * Split a tag class's value names into this package's and another installed package's. PURE.
 * Receipts READ: a value `claimed` (listed in this package's own file) is this package's — even when
 * another package also contributes it (shared claim); else a value recorded in another package's
 * tagContributions for `tagClass` is that package's; otherwise the §31 longest-prefix rule against the installed owners (unprefixed -> own).
 * Receipts UNREADABLE: nothing is foreign (the values stay in the hash — fail safe).
 * Alone on the target (no owner, no contribution) every value is own: the 0.25.0 view, byte for byte.
 * -> { own: [name], foreign: [{ name, code }] }
 */
export function splitTagValues(names, tagClass, manifest, view, { claimed = null } = {}) {
  const own = []; const foreign = [];
  if (!view?.receiptsReadable) return { own: [...names], foreign };
  const contrib = view.contributions?.get(tagClass) ?? new Map();
  const rest = [];
  for (const n of names) {
    if (claimed?.has(n)) own.push(n); // shared claim: a value this package's own file lists is its own
    else if (contrib.has(n)) foreign.push({ name: n, code: contrib.get(n) });
    else rest.push(n);
  }
  const split = view.owners?.length ? splitRowOwnership(rest, manifest, view.owners, { receiptsReadable: true }) : { own: rest, foreign: [] };
  own.push(...split.own);
  for (const f of split.foreign) foreign.push({ name: f.id, code: f.code });
  return { own, foreign };
}

/**
 * Receipts UNREADABLE: the values a WRITE must treat as possibly another package's. PURE.
 *   guarded   carries a guardOwners prefix (installed at the last read, or a declared dependency) by the
 *             longest-prefix rule, or was recorded as another package's at the last successful read
 *   unowned   not carrying this package's own prefix while some other package may be installed
 *             (guardOwners non-empty, or `neverRead`: no receipt read ever succeeded for this target, so
 *             nobody can say the package is alone) — an unprefixed value could be a legacy contribution
 * -> { guarded: Set, maybeForeign(name) -> bool }
 */
export function guardTagValues(names, manifest, view, recorded = [], { neverRead = false } = {}) {
  const guarded = new Set(recorded ?? []);
  const go = view?.guardOwners ?? [];
  if (go.length) for (const f of splitRowOwnership(names, manifest, go, { receiptsReadable: true }).foreign) guarded.add(f.id);
  const mine = manifest?.code
    ? { ...prefixForms(manifest.code), ...(manifest?.idPrefixes && typeof manifest.idPrefixes === 'object' ? manifest.idPrefixes : {}) }
    : null;
  const anyOther = neverRead || go.length > 0;
  const maybeForeign = (n) => guarded.has(n) || (anyOther && !(mine && prefixMatchLength(mine, n, { strict: true })));
  return { guarded, maybeForeign };
}

/** True when `name` carries THIS package's own prefix (strict boundary, manifest idPrefixes honoured). PURE. */
export function ownPrefixed(manifest, name) {
  if (!manifest?.code) return false;
  const mine = { ...prefixForms(manifest.code), ...(manifest?.idPrefixes && typeof manifest.idPrefixes === 'object' ? manifest.idPrefixes : {}) };
  return prefixMatchLength(mine, name, { strict: true }) > 0;
}
