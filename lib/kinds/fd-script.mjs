// fd.script — JSAPI plugin = a Script-class DOCUMENT.
// Storage: fd/scripts/<id>/meta.json + <id>.js. The script loads in the GUI client ONLY while
// the doc carries a RegistrationOrder integer tag (lower = earlier; no tag = stored but never
// loaded). Every change needs DELETE /gui/rest/caches (IRIS-Script cache) + a full page reload.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify, tagsOf, tag } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';
import { pushContentDoc } from './base.mjs';
import { looksOwned } from '../naming.mjs';

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
  };
}

async function pushDoc(ctx, id, { obj, contents }) {
  if (!id) throw new Error(`${KIND}: cannot push without an id`);
  const file = obj.contentFile ?? `${id}.js`;
  const bytes = contents?.[file] ?? Object.values(contents ?? {})[0];
  if (bytes == null) throw new Error(`${KIND}/${id}: content file ${file} missing`);
  await pushContentDoc(ctx, {
    id, name: obj.name ?? id, classId: CLASS_ID, acl: obj.acl ?? 'acl-readonly',
    tags: [tag('RegistrationOrder', obj.registrationOrder ?? '0')],
    files: [{ bytes, filename: file, mime: 'application/javascript' }],
  });
}

const adapter = {
  kind: KIND, dir: DIR, layout: 'dir', defaultPolicy: 'managed', cacheAffecting: true,

  async list(ctx) {
    const { results } = await ctx.clients.core.search({ classId: CLASS_ID, fields: ['name'], max: 200 });
    return results.map((r) => ({ id: r.id, name: r.fields.name }));
  },
  get: (ctx, id) => ctx.clients.core.getDoc(id),
  create: (ctx, local) => pushDoc(ctx, local.id ?? local.obj?.id, local),
  update: (ctx, id, local) => pushDoc(ctx, id, local),
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
    if (existsSync(join(d, file))) contents[file] = readFileSync(join(d, file));
    return { id: entry.id, obj, contents };
  },
  writeLocal(pkg, entry, { obj, contents = {} }) {
    const d = join(pkg.dir, entry.path);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'meta.json'), stableStringify(canonicalize(KIND, obj)));
    for (const [rel, bytes] of Object.entries(contents)) writeFileSync(join(d, rel), bytes);
  },
  removeLocal(pkg, entry) {
    rmSync(join(pkg.dir, entry.path), { recursive: true, force: true });
  },

  validate(pkg, entry, local) {
    if (!local) return [`${entry.id}: meta.json missing`];
    const errs = [];
    const file = local.obj.contentFile ?? `${entry.id}.js`;
    if (local.contents?.[file] == null) errs.push(`${entry.id}: content file ${file} missing`);
    if (!/^\d+$/.test(String(local.obj.registrationOrder ?? ''))) {
      errs.push(`${entry.id}: registrationOrder must be an integer string — without it the script is stored but NEVER loaded by the GUI`);
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
