// fd.script — JSAPI plugin = a Script-class DOCUMENT.
// Storage: fd/scripts/<id>/meta.json + <id>.js. The GUI client loads every Script-class document
// of the scope; the RegistrationOrder integer tag orders the load (lower = earlier; untagged ones
// come last — measured 2026-09-23, it does NOT gate). Every change needs DELETE /gui/rest/caches
// (IRIS-Script cache) + a full page reload.
//
// SERVER-ONLY LIBRARY (0.17+): `"registrationOrder": null` in meta.json, spelled out, pushes the
// document WITHOUT any RegistrationOrder tag. That is the shape of a library a handler fetches and
// `load()`s at run time (FLOWERDOCS-LEARNINGS §40): composed once by @include, paid once, instead
// of once per handler. A MISSING key stays a validation error (a browser script that forgot its
// order is a silent no-op, not a library).
//
// ⚠️ No tag does NOT keep it out of the browser (LEARNINGS § "RegistrationOrder does not keep a
// script out of the browser", measured 2026-09-23): the GUI loads EVERY `Script`-class document of
// the scope; the tag only orders. The documented gate is the CLASS ("Documents stored in the DMS
// with the Script class are loaded on the client side", FlowerDocs doc, JSAPI / Getting Started).
// So (0.19+) a server-only library may declare `"classId": "<SomeDocumentClass>"` in meta.json: it
// is then pushed as a document of THAT class — same id, same content, same @include composition —
// and the GUI never downloads it, while a handler still reads it by id over /rest/documents. The
// class must exist (push it in the same package: fd.documentclass pushes before fd.script). An
// in-place update carries the new classId (documented: document data update changes "class
// identifier, document name, ACL"). Omit the key for a `Script` document; spelling "Script" is
// refused (the echo omits it, so it would drift). validate refuses a classId that differs only by
// case from an fd.documentclass of the package (a sure typo); list() searches Script plus
// those library classes, so `ls fd.script` / `adopt --scan` see a moved library (#76).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stableStringify, tagsOf, tag } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';
import { keepSchemaKey } from '../schemas.mjs';
import { pushContentDoc } from './base.mjs';
import { looksOwned } from '../naming.mjs';
import { expandIncludes, isExpansionOf } from '../include.mjs';

const KIND = 'fd.script';
const DIR = 'fd/scripts';
const CLASS_ID = 'Script';

const titleCase = (id) =>
  id.split(/[-_]/).filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');

/** Canonical meta — registrationOrder stays a STRING (tag values are strings; a stable type is
 *  what makes the local file and the server echo hash identically). */
function serverMeta(id, doc) {
  return {
    name: doc.name ?? id,
    acl: doc.data?.ACL ?? 'acl-readonly',
    registrationOrder: tagsOf(doc).RegistrationOrder ?? null,
    contentFile: `${id}.js`,
    // a server-only library stored under another class (0.19): echo it, so local and server hash alike
    ...(doc.data?.classId && doc.data.classId !== CLASS_ID ? { classId: doc.data.classId } : {}),
  };
}

/** True when meta.json SAYS `registrationOrder: null` — a server-only document (see header). */
export function isServerOnly(obj) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, 'registrationOrder') && obj.registrationOrder === null;
}

async function pushDoc(ctx, id, { obj, contents }) {
  if (!id) throw new Error(`${KIND}: cannot push without an id`);
  const file = obj.contentFile ?? `${id}.js`;
  const bytes = contents?.[file] ?? Object.values(contents ?? {})[0];
  if (bytes == null) throw new Error(`${KIND}/${id}: content file ${file} missing`);
  await pushContentDoc(ctx, {
    id, name: obj.name ?? id, classId: obj.classId ?? CLASS_ID, acl: obj.acl ?? 'acl-readonly',
    // no tag at all for a server-only library: an update in place replaces the tag list, so a
    // document that used to carry an order stops being loaded by the GUI too
    tags: isServerOnly(obj) ? [] : [tag('RegistrationOrder', obj.registrationOrder ?? '0')],
    files: [{ bytes, filename: file, mime: 'application/javascript' }],
  });
}

/** The non-Script classes the package's fd.script entries live under (meta.json `classId`), sorted. */
export function libraryClassIds(ctx) {
  let pkg = ctx?.pkg ?? null;
  if (!pkg) { try { pkg = ctx?.requirePkg?.() ?? null; } catch { pkg = null; } }
  if (!pkg?.entries) return [];
  const ids = new Set();
  for (const entry of pkg.entries(KIND)) {
    try {
      const c = JSON.parse(readFileSync(join(pkg.dir, entry.path ?? join(DIR, entry.id), 'meta.json'), 'utf8')).classId;
      if (typeof c === 'string' && c && c !== CLASS_ID) ids.add(c);
    } catch { /* unreadable meta: validate reports it; listing stays best-effort */ }
  }
  return [...ids].sort();
}

const adapter = {
  kind: KIND, dir: DIR, layout: 'dir', defaultPolicy: 'managed', cacheAffecting: true,

  async list(ctx) {
    // Script, PLUS every library class the package's fd.script metas declare (0.19 classId): a
    // library moved out of Script is still an fd.script, and `ls`/`adopt --scan` must see it (#76).
    // Without a package there is nothing to derive them from — Script only.
    const classIds = [CLASS_ID, ...libraryClassIds(ctx)];
    const { results } = await ctx.clients.core.search({ classId: classIds, fields: ['name', 'classid'], max: 200 });
    return results.map((r) => ({
      id: r.id, name: r.fields.name,
      ...(r.fields.classid && r.fields.classid !== CLASS_ID ? { classId: r.fields.classid } : {}),
    }));
  },
  get: (ctx, id) => ctx.clients.core.getDoc(id),
  create: (ctx, local) => pushDoc(ctx, local.id ?? local.obj?.id, local),
  async update(ctx, id, local) {
    await pushDoc(ctx, id, local);
    // a class change in place (Script <-> a library class, §47) is documented but not yet seen
    // live: if the server kept the old class, fail HERE, before the echo leg rewrites meta.json
    // without the user's classId and records a clean base
    const want = local.obj?.classId ?? CLASS_ID;
    const got = (await ctx.clients.core.getDoc(id))?.data?.classId ?? CLASS_ID;
    if (got !== want) {
      throw new Error(`${KIND}/${id}: pushed as class ${want} but the server kept ${got} — the in-place class change did not take;`
        + ' delete the document and push again to recreate it (FLOWERDOCS-LEARNINGS §47)');
    }
  },
  async remove(ctx, id) {
    await ctx.clients.core.del(`/rest/documents/${encodeURIComponent(id)}`);
  },

  async readServer(ctx, id) {
    const doc = await ctx.clients.core.getDoc(id);
    if (!doc) return null;
    // no classId filter: a foreign same-id doc must surface as a hash COLLISION, not as absent
    const obj = serverMeta(id, doc);
    const bytes = (await ctx.clients.core.getContent(id, doc.files?.[0]?.id)) ?? Buffer.alloc(0);
    return { obj, contents: { [obj.contentFile]: bytes } };
  },

  // ---- dir layout: <pkg>/fd/scripts/<id>/meta.json + <contentFile> ----
  pathFor: (pkg, id) => join(DIR, id),
  readLocal(pkg, entry) {
    const d = join(pkg.dir, entry.path);
    const metaPath = join(d, 'meta.json');
    if (!existsSync(metaPath)) return null;
    const obj = JSON.parse(readFileSync(metaPath, 'utf8'));
    const file = obj.contentFile ?? `${entry.id}.js`;
    const contents = {};
    // @include directives expand HERE so status/diff/push/export all see the same
    // self-contained script the server holds (see lib/include.mjs)
    if (existsSync(join(d, file))) contents[file] = expandIncludes(readFileSync(join(d, file)), resolve(join(d, file)), resolve(pkg.dir));
    return { id: entry.id, obj, contents };
  },
  writeLocal(pkg, entry, { obj, contents = {} }) {
    const d = join(pkg.dir, entry.path);
    mkdirSync(d, { recursive: true });
    // canonicalize() drops `$schema`; keep the one meta.json carries (editor hint, DESIGN §29)
    writeFileSync(join(d, 'meta.json'), stableStringify(keepSchemaKey(join(d, 'meta.json'), canonicalize(KIND, obj))));
    for (const [rel, bytes] of Object.entries(contents)) {
      // @include pull-guard: skip when the local source still expands to exactly these bytes
      if (isExpansionOf(bytes, resolve(join(d, rel)), resolve(pkg.dir))) continue;
      writeFileSync(join(d, rel), bytes);
    }
  },
  removeLocal(pkg, entry) {
    rmSync(join(pkg.dir, entry.path), { recursive: true, force: true });
  },

  validate(pkg, entry, local) {
    if (!local) return [`${entry.id}: meta.json missing`];
    const errs = [];
    const file = local.obj.contentFile ?? `${entry.id}.js`;
    if (local.contents?.[file] == null) errs.push(`${entry.id}: content file ${file} missing`);
    if (!isServerOnly(local.obj) && !/^\d+$/.test(String(local.obj.registrationOrder ?? ''))) {
      errs.push(`${entry.id}: registrationOrder must be an integer string — without it the script is stored but NEVER loaded by the GUI`
        + ' (or `"registrationOrder": null`, spelled out, for a server-only library a handler loads at run time)');
    }
    if (Object.prototype.hasOwnProperty.call(local.obj, 'classId')) {
      const c = local.obj.classId;
      if (typeof c !== 'string' || !c || c === CLASS_ID) {
        errs.push(`${entry.id}: "classId" must name a document class other than Script (omit the key for a Script document)`);
      } else if (!isServerOnly(local.obj)) {
        errs.push(`${entry.id}: "classId": "${c}" is only for a server-only library ("registrationOrder": null) — the GUI loads Script-class documents only, so a browser script under another class would never run`);
      } else if (pkg?.entry && !pkg.entry('fd.documentclass', c)) {
        // a CASE-ONLY mismatch with a class of this package is a typo for sure: refuse it offline
        // (#76). Any other unknown class may legitimately live in another package or already exist
        // on the server, so it is not refused here — a truly missing class fails at push with the
        // server's own error. (Refusing it would newly block packages that push fine today.)
        const near = pkg.entries('fd.documentclass').find((d) => d.id !== c && d.id.toLowerCase() === c.toLowerCase());
        if (near) errs.push(`${entry.id}: "classId": "${c}" is not an fd.documentclass of this package — did you mean "${near.id}"?`);
      }
    }
    return errs;
  },

  template(ctx, name, flags = {}) {
    const obj = {
      name: titleCase(name),
      acl: 'acl-readonly',
      registrationOrder: String(flags.order ?? 0),
      contentFile: `${name}.js`,
    };
    const js = `// ${name} — FlowerDocs JSAPI plugin (Script-class document, loaded via its RegistrationOrder tag).
// VERIFIED entry points (FLOWERDOCS-LEARNINGS §5/§5b) — pick the one matching where the user is:
//  - Search/browse toolbar : MenuShortcutsAPI.get().registerForLoad(function (api) {
//        api.addCircled(id, icon, colorClass, name, desc, cb) })
//      colorClass is a CSS CLASS (flat-red/flat-blue/flat-green/flat-purple/flat-orange), NOT hex.
//  - Search-result rows    : ContextualMenuAPI.get().registerForLoad(function (api) {
//        api.add(groupId, id, icon, label, cb); /* api.getSelected() = chosen rows */ })
//  - Open-document form    : JSAPI.get().registerForComponentChange(function (formAPI, component, phase) {
//        if (component.getCategory() == 'DOCUMENT' && component.getClassId() == 'MyClass') {
//          var a = JSAPI.get().getActionFactoryAPI().buildResponsive(id, label, icon, 0, cb);
//          formAPI.getActions().getHeaderActions().add(a); } })
//  - Search form actions   : JSAPI.get().registerForSearchOpen(function (searchFormAPI, id) {
//        searchFormAPI.getFooterActions().add(...) })
// Gotchas: JSAPI.get() is EMPTY on Home (shortcut/contextual containers populate inside views);
// navigation = JSAPI.get().getNavigationAPI().goToComponentPlace(category, id, confirmation)
// (navigateTo does NOT exist); client-side search = JSAPI.get().document().search(request, cb)
// with page-global SearchRequest/AndClause/Criterion (getSearchAPI does NOT exist).
// Icons are FontAwesome 5 (fas fa-…); FA4 "-o" outline names render NOTHING.

MenuShortcutsAPI.get().registerForLoad(function (api) {
  api.addCircled('${name}-action', 'fas fa-bolt', 'flat-blue', '${titleCase(name)}', '${titleCase(name)} action', function () {
    // your action — runs in the search/browse toolbar context (no "open document" here)
    console.log('${name}: clicked');
  });
});
`;
    return { obj, contents: { [obj.contentFile]: Buffer.from(js) } };
  },

  async scan(ctx, manifest) {
    const all = await adapter.list(ctx);
    return all.filter((r) => r.id && looksOwned(manifest, r.id)).map((r) => ({ id: r.id, title: r.name }));
  },
};

export default adapter;
