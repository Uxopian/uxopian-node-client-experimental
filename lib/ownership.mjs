// Row ownership for `data push --prune` and fd.dataset remove() (DESIGN §31): a dataset can be fed by
// SEVERAL installed packages (a product and its extension both contribute rows to CmTeams). Prune deletes
// "server rows absent locally" — which, in a shared dataset, are the OTHER package's rows. This module
// tells whose a row is, from the installation receipts (the installed-ledger, DESIGN §19) plus the
// manifest's declared dependencies: every other installed package owns the ids carrying its prefix forms,
// and the LONGEST matching prefix wins (own `cm` vs installed `cm2`: `Cm2Team` is cm2's).
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
 * The OTHER packages installed on the connected target (receipts, deduplicated across surfaces) plus
 * the packages this manifest declares as dependencies (an offline floor when receipts cannot be read),
 * and whether the receipts were PROVABLY read (readReceiptsChecked — "none" vs "could not read").
 * -> { owners: [{ code, forms, source: 'receipt'|'dependency' }] sorted by code, never the package
 *      itself, receiptsReadable: bool, receiptErrors: [string] }
 */
export async function rowOwners(ctx, manifest) {
  const self = manifest?.code;
  const { receipts, readable, errors } = await readReceiptsChecked(ctx);
  const by = new Map();
  for (const r of receipts) {
    if (!r?.code || r.code === '?' || r.code === self || by.has(r.code)) continue;
    by.set(r.code, { code: r.code, forms: prefixForms(r.code), source: 'receipt' });
  }
  for (const d of declaredDependencies(manifest)) {
    if (d.code === self || by.has(d.code)) continue;
    by.set(d.code, { code: d.code, forms: prefixForms(d.code), source: 'dependency' });
  }
  const owners = [...by.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { owners, receiptsReadable: readable, receiptErrors: errors };
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
