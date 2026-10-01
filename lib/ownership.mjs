// Row ownership for `data push --prune` (DESIGN §31): a dataset can be fed by SEVERAL installed
// packages (a product and its extension both contribute rows to CmTeams). Prune deletes "server rows
// absent locally" — which, in a shared dataset, are the OTHER package's rows. This module tells whose
// a row is, from the installation receipts (the installed-ledger, DESIGN §19) plus the manifest's
// declared dependencies: every other installed package owns the ids carrying its prefix forms.
import { prefixForms } from './naming.mjs';
import { carriesForms } from './extension.mjs';
import { readReceipts } from './receipt.mjs';
import { declaredDependencies } from './dependencies.mjs';

/** The id-prefix forms of the package `code` as the receipts know it: a receipt that carries
 *  `idPrefixes` wins, else the forms derived from the code (the manifest default). */
const formsOf = (code, receipt) => ({ ...prefixForms(code), ...(receipt?.idPrefixes && typeof receipt.idPrefixes === 'object' ? receipt.idPrefixes : {}) });

/**
 * The OTHER packages installed on the connected target (receipts, deduplicated across surfaces) plus
 * the packages this manifest declares as dependencies (an offline floor when receipts cannot be read).
 * -> [{ code, forms, source: 'receipt'|'dependency' }] sorted by code, never the package itself.
 */
export async function foreignOwners(ctx, manifest) {
  const self = manifest?.code;
  let receipts = [];
  try { receipts = await readReceipts(ctx, {}); } catch { receipts = []; }
  const by = new Map();
  for (const r of receipts) {
    if (!r?.code || r.code === '?' || r.code === self) continue;
    if (!by.has(r.code) || r.idPrefixes) by.set(r.code, { code: r.code, forms: formsOf(r.code, r), source: 'receipt' });
  }
  for (const d of declaredDependencies(manifest)) {
    if (d.code === self || by.has(d.code)) continue;
    by.set(d.code, { code: d.code, forms: formsOf(d.code), source: 'dependency' });
  }
  return [...by.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Split server-only row ids into ours (deletable) and another installed package's. PURE.
 * An id carrying THIS package's prefix is always ours; one carrying only another package's prefix is
 * theirs; an id under no known prefix stays deletable (the pre-§31 behaviour).
 * -> { own: [id], foreign: [{ id, code }] }
 */
export function splitRowOwnership(ids, manifest, owners) {
  const mine = { ...prefixForms(manifest?.code ?? ''), ...(manifest?.idPrefixes && typeof manifest.idPrefixes === 'object' ? manifest.idPrefixes : {}) };
  const own = []; const foreign = [];
  for (const id of ids) {
    if (manifest?.code && carriesForms(mine, id)) { own.push(id); continue; }
    const hit = (owners ?? []).find((o) => carriesForms(o.forms, id));
    if (hit) foreign.push({ id, code: hit.code }); else own.push(id);
  }
  return { own, foreign };
}
