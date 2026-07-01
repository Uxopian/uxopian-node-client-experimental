// The single authority for the project naming convention, id forms, band allocation,
// and the FlowerDocs magic-id derivations.

/** Derive the four prefix forms from a project code ('ct'). */
export function prefixForms(code) {
  const c = code.toLowerCase();
  return {
    pascal: c.charAt(0).toUpperCase() + c.slice(1), // Ct
    camel: c,                                       // ct
    kebab: `${c}-`,                                 // ct-
    upper: `${c.toUpperCase()}_`,                   // CT_
  };
}

/** Which prefix form a kind's ids use. */
export const KIND_FORM = {
  'fd.tagclass': 'pascal',
  'fd.tagcategory': 'pascal',
  'fd.documentclass': 'pascal',
  'fd.folderclass': 'pascal',
  'fd.taskclass': 'pascal',
  'fd.vfclass': 'pascal',
  'fd.vfinstance': 'pascal',
  'fd.workflow': 'pascal',
  'fd.acl': 'pascal',
  'fd.handler': 'pascal',   // logical name Ct<Name>_on<Action>
  'fd.script': 'kebab',
  'fd.guiconfig': 'kebab',
  'ai.prompt': 'camel',
  'ai.goal': 'camel',       // goalName
  'ai.mcp': 'camel',
};

/** Build a conventional id for a kind from a bare Name. Names already carrying the prefix pass through. */
export function conventionalId(kind, manifest, name) {
  const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
  const form = KIND_FORM[kind] ?? 'pascal';
  const prefix = forms[form];
  if (matchesForm(name, prefix, form)) return name;
  if (form === 'kebab') return prefix + name.replace(/^[-_]+/, '').replace(/_/g, '-').toLowerCase();
  if (form === 'camel') return prefix + name.charAt(0).toUpperCase() + name.slice(1);
  return prefix + name.charAt(0).toUpperCase() + name.slice(1); // pascal
}

function matchesForm(id, prefix, form) {
  if (form === 'kebab') return id.toLowerCase().startsWith(prefix);
  return id.startsWith(prefix);
}

/** Does this id look owned by the project (any form)? Bootstrap scanning only — ownership lives in the registry. */
export function looksOwned(manifest, id) {
  const f = manifest.idPrefixes ?? prefixForms(manifest.code);
  return (
    id.startsWith(f.pascal) || id.startsWith(f.upper) ||
    id.toLowerCase().startsWith(f.kebab) ||
    (id.startsWith(f.camel) && /^[a-z]+[A-Z]/.test(id))
  );
}

/** Handler ids: logical 'CtIngest_onCreate' <-> deployed 'CtIngest_onCreate_v13'. */
export function splitHandlerId(id) {
  const m = id.match(/^(.*)_v(\d+)$/);
  return m ? { logical: m[1], n: Number(m[2]) } : { logical: id, n: null };
}
export const deployedHandlerId = (logical, n) => `${logical}_v${n}`;

/** Parse 'CtBar_onCreate' -> { component:'CtBar', action:'CREATE' } (used by `uxc add fd.handler`). */
export function parseHandlerName(logical) {
  const m = logical.match(/^(.*)_on([A-Z][a-zA-Z]+)$/);
  return m ? { component: m[1], action: m[2].toUpperCase() } : { component: logical, action: null };
}

/**
 * The VF content-view override magic bean ids for a VF class id (learnings §15):
 * 'content<Classid>VirtualFolder' (+ Modify/ReadOnly), where <Classid> = class id split on '_',
 * each segment first-upper-rest-lower. Both the mangled and raw casings are emitted (unused ids
 * are ignored by the GUI).
 */
export function vfOverrideBeanIds(classId) {
  const mangled = classId
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join('');
  const bases = [...new Set([mangled, classId.replace(/_/g, '')])];
  return bases.flatMap((b) => ['', 'Modify', 'ReadOnly'].map((m) => `content${b}VirtualFolder${m}`));
}

/**
 * Allocate the lowest free RegistrationOrder in the manifest band for a kind,
 * from the orders already used in the registry (NOT the server).
 * Throws on exhaustion with manifest guidance.
 */
export function allocateOrder(manifest, usedOrders, kind) {
  const band = manifest.registrationOrderBands?.[kind];
  if (!band) throw new Error(`no registrationOrderBands["${kind}"] in uxopian-project.json`);
  const used = new Set(usedOrders.map(Number));
  for (let n = band[0]; n <= band[1]; n++) if (!used.has(n)) return n;
  throw new Error(
    `RegistrationOrder band [${band[0]},${band[1]}] for ${kind} is full — widen registrationOrderBands in uxopian-project.json`,
  );
}

/**
 * Build the registry-driven identifier map for code-remap (old code -> new code), covering all
 * owned ids in their exact forms plus derived forms (VF override bean ids, upper runtime prefix).
 * Returns Map<oldToken, newToken>, longest-first for safe token-boundary replacement.
 */
export function buildRemapMap(manifest, registryIds, newCode) {
  const oldF = manifest.idPrefixes ?? prefixForms(manifest.code);
  const newF = prefixForms(newCode);
  const map = new Map();
  const remapId = (id) => {
    if (id.startsWith(oldF.pascal)) return newF.pascal + id.slice(oldF.pascal.length);
    if (id.startsWith(oldF.upper)) return newF.upper + id.slice(oldF.upper.length);
    if (id.toLowerCase().startsWith(oldF.kebab)) return newF.kebab + id.slice(oldF.kebab.length);
    if (id.startsWith(oldF.camel)) return newF.camel + id.slice(oldF.camel.length);
    return null;
  };
  for (const { kind, id } of registryIds) {
    const renamed = remapId(id);
    if (renamed) map.set(id, renamed);
    if (kind === 'fd.vfclass') {
      const olds = vfOverrideBeanIds(id);
      const news = vfOverrideBeanIds(renamed ?? id);
      olds.forEach((o, i) => map.set(o, news[i] ?? o));
    }
  }
  // runtime id prefix (handler-minted ids like CT_APPR_)
  map.set(oldF.upper, newF.upper);
  return new Map([...map.entries()].sort((a, b) => b[0].length - a[0].length));
}

/** Token-boundary replace using a remap map. Returns { text, replaced, residual } where residual
 *  lists tokens still matching the OLD prefix forms after replacement (lint: must be empty). */
export function applyRemap(text, map, manifest) {
  let out = text;
  let replaced = 0;
  for (const [from, to] of map) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![a-z0-9])`, 'g');
    out = out.replace(re, () => { replaced++; return to; });
  }
  const oldF = manifest.idPrefixes ?? prefixForms(manifest.code);
  const residual = [...new Set(
    [...out.matchAll(new RegExp(`(?<![A-Za-z0-9])(${escapeRe(oldF.pascal)}[A-Z][A-Za-z0-9_]+|${escapeRe(oldF.upper)}[A-Z0-9_]+)`, 'g'))]
      .map((m) => m[1]),
  )];
  return { text: out, replaced, residual };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
