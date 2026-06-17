// Marketplace package metadata: marketplace.json (the listing/version manifest the publisher
// sends) + the readable object catalog built from the package registry. All offline, no network.
//
// The catalog is the "readable catalog of objects" the marketplace renders (spec §6.4 / §8.2):
// counts per kind + one row {kind, id, title, note, policy} per resource. Titles/notes are
// best-effort extracted from each resource file so the marketplace can show humans, not ids.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MARKETPLACE_MANIFEST = 'marketplace.json';
export const AUDIENCES = ['generic', 'customer-demo', 'prospect-demo'];

// Seed vocabulary (mirrors PULSE-MARKETPLACE-SPEC §4); unknown categories only WARN, never fail —
// the server is the authority on the live vocabulary.
export const KNOWN_CATEGORIES = [
  'content-intelligence', 'contract-intelligence', 'invoice-ap', 'hr-employee',
  'quality-compliance', 'records-management', 'case-management', 'ai-assistants',
  'search-discovery', 'demo-showcase', 'utilities', 'other',
];

// ---------------------------------------------------------------------------
// marketplace.json — read / scaffold / validate
// ---------------------------------------------------------------------------

export function marketplacePath(pkg) {
  return join(pkg.dir, MARKETPLACE_MANIFEST);
}

export function readMarketplaceManifest(pkg) {
  const p = marketplacePath(pkg);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** kebab-case a human name: "Contract Management" -> "contract-management". */
export function kebab(s) {
  return String(s)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Default slug for a package: from the human name, else the project code. */
export function deriveSlug(manifest) {
  return kebab(manifest.name || manifest.code || 'addon');
}

/** A fully-formed default marketplace.json for `uxc mp init`, derived from the package manifest. */
export function scaffoldMarketplace(pkg, { maintainer } = {}) {
  const m = pkg.manifest;
  const products = m.products ?? [];
  return {
    format: 'uxopian-marketplace/1',
    slug: deriveSlug(m),
    audience: 'generic',
    account: null,
    category: 'other',
    tags: [],
    summary: (m.description ?? m.name ?? '').slice(0, 200),
    maintainer: maintainer ?? { name: '', email: '' },
    compatibility: {
      // tested-on tags — fill in with the FlowerDocs / Uxopian AI backend versions you validated on
      flowerdocs: products.includes('flowerdocs') ? [] : [],
      uxopianAi: products.includes('uxopian-ai') ? [] : [],
    },
    docs: existsSync(join(pkg.dir, 'README.md')) ? ['README.md'] : [],
    screenshots: [],
    changelog: `Release ${m.version ?? '0.0.0'}.`,
  };
}

/**
 * Validate a marketplace.json against the package. Returns { errors, warnings, resolved } where
 * resolved.{screenshots,docs} are absolute paths that exist. Never throws — the caller decides.
 */
export function validateMarketplace(mp, pkg) {
  const errors = [];
  const warnings = [];
  if (!mp || typeof mp !== 'object') return { errors: ['marketplace.json missing or not an object — run `uxc mp init`'], warnings, resolved: {} };

  const req = (k, v) => { if (v == null || v === '') errors.push(`marketplace.json: "${k}" is required`); };
  req('slug', mp.slug);
  if (mp.slug && !/^[a-z0-9][a-z0-9-]*$/.test(mp.slug)) errors.push(`marketplace.json: slug "${mp.slug}" must be lowercase kebab-case`);
  req('summary', mp.summary);
  if (typeof mp.summary === 'string' && mp.summary.length > 200) errors.push('marketplace.json: "summary" must be <= 200 chars');
  req('category', mp.category);
  if (mp.category && !KNOWN_CATEGORIES.includes(mp.category)) warnings.push(`category "${mp.category}" is not in the seed vocabulary — the server must know it`);

  if (!AUDIENCES.includes(mp.audience)) errors.push(`marketplace.json: "audience" must be one of ${AUDIENCES.join(' | ')}`);
  if (mp.audience && mp.audience !== 'generic' && !mp.account) errors.push(`marketplace.json: "account" is required when audience is "${mp.audience}"`);

  const maint = mp.maintainer ?? {};
  if (!maint.name) errors.push('marketplace.json: "maintainer.name" is required (or set a default via `uxc mp login --name`)');
  if (!maint.email) errors.push('marketplace.json: "maintainer.email" is required (or `uxc mp login --email`)');

  const compat = mp.compatibility ?? {};
  for (const k of ['flowerdocs', 'uxopianAi']) {
    if (compat[k] != null && !Array.isArray(compat[k])) errors.push(`marketplace.json: compatibility.${k} must be an array of tested-on version tags`);
  }
  const products = pkg.manifest.products ?? [];
  if (products.includes('flowerdocs') && !(compat.flowerdocs?.length)) warnings.push('compatibility.flowerdocs is empty — add the FlowerDocs version(s) you tested on');
  if (products.includes('uxopian-ai') && !(compat.uxopianAi?.length)) warnings.push('compatibility.uxopianAi is empty — add the Uxopian AI version(s) you tested on');

  // resolve asset paths against the package; missing files are hard errors
  const resolved = { screenshots: [], docs: [] };
  const resolveList = (label, list) => {
    for (const rel of list ?? []) {
      const abs = join(pkg.dir, rel);
      if (!existsSync(abs)) { errors.push(`marketplace.json: ${label} file not found: ${rel}`); continue; }
      resolved[label].push({ rel, abs });
    }
  };
  resolveList('screenshots', mp.screenshots);
  resolveList('docs', mp.docs);

  return { errors, warnings, resolved };
}

// ---------------------------------------------------------------------------
// catalog — the readable inventory of package objects
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  'fd.tagclass': 'Tag class', 'fd.tagcategory': 'Tag category', 'fd.documentclass': 'Document class',
  'fd.taskclass': 'Task class', 'fd.vfclass': 'Virtual-folder class', 'fd.vfinstance': 'Virtual folder',
  'fd.workflow': 'Workflow', 'fd.acl': 'ACL', 'fd.script': 'Script', 'fd.guiconfig': 'GUI configuration',
  'fd.handler': 'Server handler', 'fd.surfacing': 'Scope surfacing', 'fd.dataset': 'Seed dataset',
  'ai.prompt': 'AI prompt', 'ai.goal': 'AI goal', 'ai.mcp': 'MCP config',
};

/** Build the catalog object sent to the marketplace and rendered on the version page. */
export function buildCatalog(pkg) {
  const entries = pkg.entries().filter((e) => !e.retired);
  const counts = {};
  const objects = [];
  for (const e of entries) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const { title, note } = objectLabel(pkg, e);
    objects.push({ kind: e.kind, id: e.id, title, note, policy: e.policy ?? 'managed' });
  }
  objects.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
  return { counts, total: objects.length, objects };
}

/** Best-effort human title + short note for one registry entry. Falls back to the id; never throws. */
export function objectLabel(pkg, entry) {
  const fallback = { title: entry.id, note: entry.notes ?? KIND_LABEL[entry.kind] ?? entry.kind };
  try {
    const obj = readResourceJson(pkg, entry);
    if (!obj) return fallback;
    const title = pickDisplayName(obj) || entry.id;
    const note = noteFor(entry.kind, obj) || entry.notes || KIND_LABEL[entry.kind] || '';
    return { title, note };
  } catch {
    return fallback;
  }
}

/** Read the JSON for a resource: <path>.json directly, or <path>/meta.json for dir-layout kinds. */
function readResourceJson(pkg, entry) {
  if (!entry.path) return null;
  const abs = join(pkg.dir, entry.path);
  let file = null;
  if (existsSync(abs) && statSync(abs).isDirectory()) file = join(abs, 'meta.json');
  else if (abs.endsWith('.json')) file = abs;
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** FlowerDocs displayName is [{value, language}]; AI/objects use plain name/label/title. */
function pickDisplayName(obj) {
  const dn = obj.displayName ?? obj.displayNames ?? obj.label ?? obj.title;
  if (Array.isArray(dn)) {
    const en = dn.find((d) => /en/i.test(d?.language ?? '')) ?? dn[0];
    return typeof en === 'string' ? en : en?.value ?? null;
  }
  if (typeof dn === 'string' && dn) return dn;
  // FlowerDocs class objects often repeat the id in `name`; only use it when it adds something
  // (contains whitespace, i.e. a real label rather than an identifier).
  if (typeof obj.name === 'string' && /\s/.test(obj.name)) return obj.name;
  return null;
}

/** A compact, kind-specific descriptor — what shows in the catalog's muted "note" column. */
function noteFor(kind, obj) {
  switch (kind) {
    case 'fd.tagclass': {
      const t = obj.type ?? obj.dataType;
      const vals = obj.choiceList?.choices ?? obj.values ?? obj.choices;
      const n = Array.isArray(vals) ? vals.length : null;
      return [t, n != null ? `${n} choices` : null].filter(Boolean).join(' · ');
    }
    case 'fd.documentclass': {
      const refs = obj.tagReferences ?? obj.tagReference ?? [];
      return Array.isArray(refs) && refs.length ? `${refs.length} tag refs` : 'document class';
    }
    case 'fd.taskclass': {
      const ans = obj.answers ?? [];
      return Array.isArray(ans) && ans.length ? `${ans.length} answers` : 'task class';
    }
    case 'fd.handler': {
      const phase = obj.phase ?? (obj.asynchronous ? 'async' : null);
      return [obj.objectType, obj.action, phase, obj.asynchronous ? 'async' : null]
        .filter(Boolean).join(' · ');
    }
    case 'fd.script': return obj.order != null ? `order ${obj.order}` : 'client script';
    case 'fd.guiconfig': return 'GUI configuration';
    case 'ai.prompt': {
      return [obj.role, obj.defaultLlmProvider, obj.defaultLlmModel].filter(Boolean).join(' · ');
    }
    case 'fd.vfclass': case 'fd.vfinstance': return 'virtual folder';
    default: return null;
  }
}

export { KIND_LABEL };
