// fd.guiconfig — native UI config = a GUIConfiguration-class DOCUMENT whose single file is a
// Spring-bean XML. Storage: fd/guiconfig/<id>/meta.json + <id>.xml.
// All GUIConfiguration docs load into ONE shared GWT bean context: a bean error in one doc can
// break the whole GUI for everyone, and a duplicate bean id clobbers by RegistrationOrder
// precedence — hence validate() (well-formedness, package-wide bean-id uniqueness, singleton
// refusal) runs BEFORE any push. Changes need DELETE /gui/rest/caches + a full page reload.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify, tagsOf, tag } from '../util.mjs';
import { canonicalize } from '../canonical.mjs';
import { pushContentDoc } from './base.mjs';
import { looksOwned, vfOverrideBeanIds } from '../naming.mjs';

const KIND = 'fd.guiconfig';
const DIR = 'fd/guiconfig';
const CLASS_ID = 'GUIConfiguration';

// live singletons in gui-solution.xml — a second top-level definition clobbers EVERY class
const SINGLETON_BEAN_IDS = ['componentProperties', 'componentActivityConfigurations'];

const titleCase = (id) =>
  id.split(/[-_]/).filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
const camelOf = (id) =>
  id.split(/[-_]/).filter(Boolean).map((s, i) => (i ? s.charAt(0).toUpperCase() + s.slice(1) : s.toLowerCase())).join('');

function serverMeta(id, doc) {
  return {
    name: doc.name ?? id,
    acl: doc.data?.ACL ?? 'acl-admin',
    registrationOrder: tagsOf(doc).RegistrationOrder ?? null,
    contentFile: `${id}.xml`,
  };
}

async function pushDoc(ctx, id, { obj, contents }) {
  if (!id) throw new Error(`${KIND}: cannot push without an id`);
  const file = obj.contentFile ?? `${id}.xml`;
  const bytes = contents?.[file] ?? Object.values(contents ?? {})[0];
  if (bytes == null) throw new Error(`${KIND}/${id}: content file ${file} missing`);
  await pushContentDoc(ctx, {
    id, name: obj.name ?? id, classId: CLASS_ID, acl: obj.acl ?? 'acl-admin',
    tags: [tag('RegistrationOrder', obj.registrationOrder ?? '0')],
    files: [{ bytes, filename: file, mime: 'application/xml' }],
  });
}

// ---- cheap XML well-formedness: tag-balance stack over <tag>/</tag>/<self/>; skips comments,
// CDATA, <?…?>, <!…>; quote-aware so attribute values containing '>' don't break the scan ----
const lineOf = (s, off) => s.slice(0, off).split('\n').length;
export function wellFormedErrors(xml) {
  const s = String(xml);
  const errs = [];
  const stack = [];
  let i = 0;
  while (i < s.length && errs.length < 5) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e < 0) { errs.push('unterminated comment'); break; }
      i = e + 3; continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      if (e < 0) { errs.push('unterminated CDATA section'); break; }
      i = e + 3; continue;
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      if (e < 0) { errs.push('unterminated <?…?> declaration'); break; }
      i = e + 2; continue;
    }
    if (s.startsWith('<!', lt)) {
      const e = s.indexOf('>', lt + 2);
      if (e < 0) { errs.push('unterminated <!…> declaration'); break; }
      i = e + 1; continue;
    }
    let j = lt + 1;
    let q = null;
    while (j < s.length) {
      const c = s[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= s.length) { errs.push(`unterminated tag near line ${lineOf(s, lt)}`); break; }
    const inner = s.slice(lt + 1, j);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const open = stack.pop();
      if (open !== name) errs.push(`mismatched </${name}> (expected </${open ?? 'nothing'}>) at line ${lineOf(s, lt)}`);
    } else if (!inner.endsWith('/')) {
      const m = inner.match(/^[^\s/>]+/);
      if (m) stack.push(m[0]);
    }
    i = j + 1;
  }
  if (stack.length) errs.push(`unclosed tags: <${stack.join('> <')}>`);
  return errs;
}

const beanIdsOf = (xml) => [...String(xml).matchAll(/<bean[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);

function siblingBeanIds(pkg, exceptId) {
  const out = []; // [{entryId, beanId}]
  for (const e of pkg.entries(KIND)) {
    if (e.id === exceptId) continue;
    try {
      const d = join(pkg.dir, e.path);
      const meta = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8'));
      const xml = readFileSync(join(d, meta.contentFile ?? `${e.id}.xml`), 'utf8');
      for (const b of beanIdsOf(xml)) out.push({ entryId: e.id, beanId: b });
    } catch { /* sibling not readable yet — skip */ }
  }
  return out;
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
    const obj = serverMeta(id, doc);
    const bytes = (await ctx.clients.core.getContent(id, doc.files?.[0]?.id)) ?? Buffer.alloc(0);
    return { obj, contents: { [obj.contentFile]: bytes } };
  },

  // ---- dir layout: <pkg>/fd/guiconfig/<id>/meta.json + <contentFile> ----
  pathFor: (pkg, id) => join(DIR, id),
  readLocal(pkg, entry) {
    const d = join(pkg.dir, entry.path);
    const metaPath = join(d, 'meta.json');
    if (!existsSync(metaPath)) return null;
    const obj = JSON.parse(readFileSync(metaPath, 'utf8'));
    const file = obj.contentFile ?? `${entry.id}.xml`;
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
    const file = local.obj.contentFile ?? `${entry.id}.xml`;
    const bytes = local.contents?.[file];
    if (bytes == null) return [`${entry.id}: content file ${file} missing`];
    const xml = bytes.toString('utf8');
    errs.push(...wellFormedErrors(xml).map((e) => `${entry.id}: ${e}`));
    const own = beanIdsOf(xml);
    for (const sid of own.filter((b) => SINGLETON_BEAN_IDS.includes(b))) {
      errs.push(`${entry.id}: bean id "${sid}" is a live SINGLETON (gui-solution.xml) — a second top-level definition clobbers every class; merge entries INTO the existing bean, never redefine it`);
    }
    for (const dup of [...new Set(own.filter((b, i) => own.indexOf(b) !== i))]) {
      errs.push(`${entry.id}: duplicate bean id "${dup}" within the file`);
    }
    const ownSet = new Set(own);
    for (const sib of siblingBeanIds(pkg, entry.id)) {
      if (ownSet.has(sib.beanId)) errs.push(`${entry.id}: bean id "${sib.beanId}" already defined in ${KIND}/${sib.entryId} — bean ids must be unique across the package`);
    }
    if (!/^\d+$/.test(String(local.obj.registrationOrder ?? ''))) {
      errs.push(`${entry.id}: registrationOrder must be an integer string (bean-id collision precedence; reserve a band per package)`);
    }
    return errs;
  },

  template(ctx, name, flags = {}) {
    const tpl = flags.template ?? 'search';
    const classId = flags.class;
    let xml;
    if (tpl === 'search') xml = searchXml(name, classId ?? 'MyClassId');
    else if (tpl === 'home') xml = homeXml(name, classId ?? 'MyClassId');
    else if (tpl === 'vf-override') {
      if (!classId) throw new Error('vf-override template needs --class <VfClassId> (the VIRTUAL FOLDER class id the magic bean ids derive from)');
      xml = vfOverrideXml(classId, flags.category ?? 'DOCUMENT');
    } else throw new Error(`unknown guiconfig template "${tpl}" — use search | home | vf-override`);
    const obj = {
      name: titleCase(name),
      acl: 'acl-admin',
      registrationOrder: String(flags.order ?? 0),
      contentFile: `${name}.xml`,
    };
    return { obj, contents: { [obj.contentFile]: Buffer.from(xml) } };
  },

  async scan(ctx, manifest) {
    const all = await adapter.list(ctx);
    return all.filter((r) => r.id && looksOwned(manifest, r.id)).map((r) => ({ id: r.id, title: r.name }));
  },
};

// ---------------- template emitters (the verified §6b/§15 mechanics, commented) ----------------

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd">`;

const i18n = (en, fr = en) => `<list>
        <bean class="com.flower.docs.domain.i18n.I18NLabel"><property name="language" value="EN"/><property name="value" value="${en}"/></bean>
        <bean class="com.flower.docs.domain.i18n.I18NLabel"><property name="language" value="FR"/><property name="value" value="${fr}"/></bean>
      </list>`;

const classidCriterion = (classId) => `<bean class="com.flower.docs.domain.search.Criterion">
                    <property name="name" value="classid"/>
                    <property name="type"><value type="com.flower.docs.domain.search.Types">STRING</value></property>
                    <property name="operator"><value type="com.flower.docs.domain.search.Operators">EQUALS_TO</value></property>
                    <property name="values"><list><value>${classId}</value></list></property>
                  </bean>`;

function searchXml(id, classId) {
  const beanId = camelOf(id);
  const title = titleCase(id);
  return `${XML_HEAD}
  <!--
    ${id} — search screen (verified ComponentSearchPresenter mechanics, LEARNINGS §6b).
    SURFACING IS NOT HERE: add the profile property search.template = "${beanId}()" (EMPTY
    parens — the nav label comes from this bean's title) via fd.surfacing, then clear /gui
    caches + full page reload.
    Verified gotchas:
      - order by STRING tags or system creationDate (TIMESTAMP) ONLY — INT order = 500 T00104;
        lowercase 'creationdate' also fails; sorting on a tag absent from some docs sinks them.
      - SINGLE-LEVEL FieldAggregation only inside a search hiddenRequest (nested = T00104).
      - a criterion resolves its tag against the FakeCategorySelectorPresenter category's
        classes — wrong category renders an EMPTY SHELL with no error.
      - filter input label = criterion 'description'; column header = the tag class displayName.
  -->
  <!-- one criterion bean per filter input. FilterCriterionPresenter = single clean value field
       (no operator selector); SimpleCriterionPresenter = free criterion. -->
  <bean id="${beanId}CrName" class="com.flower.docs.gui.client.search.criterion.SimpleCriterionPresenter" scope="prototype">
    <property name="description">${i18n('Name', 'Nom')}</property>
    <property name="model">
      <bean class="com.flower.docs.domain.search.Criterion">
        <property name="name" value="name"/>
        <property name="type"><value type="com.flower.docs.domain.search.Types">STRING</value></property>
        <property name="operator"><value type="com.flower.docs.domain.search.Operators">EQUALS_TO</value></property>
      </bean>
    </property>
  </bean>
  <bean id="${beanId}" class="com.flower.docs.gui.client.search.ComponentSearchPresenter" scope="prototype">
    <property name="responsePresenterProvider">
      <!-- table mode: sortable columns, no per-row JS card API -->
      <bean class="com.flower.docs.gui.client.search.response.TableSearchResponsePresenterProvider"/>
    </property>
    <property name="title">${i18n(title)}</property>
    <property name="description">${i18n(`${title} search`, `Recherche ${title}`)}</property>
    <property name="categorySelectorPresenter">
      <bean class="com.flower.docs.gui.client.search.criteria.item.FakeCategorySelectorPresenter">
        <property name="value"><value type="com.flower.docs.domain.component.Category">DOCUMENT</value></property>
      </bean>
    </property>
    <property name="keywordCriteriaPresenter">
      <bean class="com.flower.docs.gui.client.search.criteria.KeywordCriteriaPresenter"><property name="enabled" value="false"/></bean>
    </property>
    <property name="advancedCriteriaPresenter">
      <bean class="com.flower.docs.gui.client.search.criteria.advanced.AdvancedCriteriaPresenter">
        <property name="enabled" value="true"/><property name="forceOpen" value="true"/><property name="inline" value="false"/>
        <property name="displayClassSelector" value="false"/><property name="addEmptyCriterion" value="false"/>
        <property name="showSearchButton" value="true"/>
        <property name="fixedCriterionPresenters"><list><ref bean="${beanId}CrName"/></list></property>
      </bean>
    </property>
    <property name="hiddenColumns"><list><value>status</value><value>classid</value></list></property>
    <property name="hiddenRequest">
      <!-- the invisible scope: result columns (selectClause, in order), default sort, one-click
           facet (single-level aggregation), and the classid filter that keeps it shared-safe -->
      <bean class="com.flower.docs.domain.search.SearchRequest">
        <property name="selectClause">
          <bean class="com.flower.docs.domain.search.SelectClause"><property name="fields"><list><value>name</value></list></property></bean>
        </property>
        <property name="orderClauses">
          <list><bean class="com.flower.docs.domain.search.OrderClause">
            <property name="name" value="creationDate"/><property name="type"><value type="com.flower.docs.domain.search.Types">TIMESTAMP</value></property><property name="ascending" value="false"/>
          </bean></list>
        </property>
        <property name="filterClauses">
          <list><bean class="com.flower.docs.domain.search.AndClause">
            <property name="criteria"><list>${classidCriterion(classId)}</list></property>
          </bean></list>
        </property>
      </bean>
    </property>
  </bean>
</beans>
`;
}

function homeXml(id, classId) {
  const beanId = camelOf(id);
  const search = (agg) => `<bean class="com.flower.docs.domain.search.Search">
        <property name="category"><value type="com.flower.docs.domain.component.Category">DOCUMENT</value></property>
        <property name="request">
          <bean class="com.flower.docs.domain.search.SearchRequest">
            <property name="max" value="500"/>
            <property name="filterClauses"><list><bean class="com.flower.docs.domain.search.AndClause">
              <property name="criteria"><list>${classidCriterion(classId)}</list></property></bean></list></property>${agg}
          </bean>
        </property>
        <property name="displayNames">${i18n(`${classId} overview`, `Vue ${classId}`)}</property>
      </bean>`;
  return `${XML_HEAD}
  <!--
    ${id} — home dashboard widgets (LEARNINGS §6b).
    SURFACING: add the profile property home.widget.catalog = "${beanId}Widgets" (the catalog
    bean id, NO parens) via fd.surfacing, then clear /gui caches + full page reload.
    A HomeGraphPresenter tolerates a two-level (nested) aggregation; a SEARCH hiddenRequest
    does NOT (T00104) — keep this skeleton single-level unless you know you need two.
  -->
  <bean id="${beanId}Graph" class="com.flower.docs.gui.client.home.graph.HomeGraphPresenter">
    <property name="search">
      ${search(`
            <property name="aggregation"><bean class="com.flower.docs.domain.search.FieldAggregation"><property name="field" value="MyChoicelistTag"/></bean></property>`)}
    </property>
    <property name="description">${i18n(`${classId} by MyChoicelistTag`)}</property>
  </bean>
  <bean id="${beanId}Counter" class="com.flower.docs.gui.client.home.SearchCountPresenter">
    <property name="header">${i18n('Total')}</property>
    <property name="title">${i18n(`Total ${classId}: `)}</property>
    <!-- icon color is a CSS class (flat-red/flat-blue/flat-green/flat-purple/flat-orange), not hex;
         FontAwesome 5 names only (fas fa-…) -->
    <property name="icon" value="fa fa-folder-open flat-blue"/>
    <property name="search">
      ${search('')}
    </property>
  </bean>
  <bean id="${beanId}Widgets" class="com.flower.docs.gui.client.util.SimpleWidgetCatalog">
    <property name="widgets"><list>
      <ref bean="${beanId}Graph"/><ref bean="${beanId}Counter"/>
    </list></property>
  </bean>
</beans>
`;
}

function vfOverrideXml(vfClassId, category) {
  const ids = vfOverrideBeanIds(vfClassId);
  const presenter = (beanId) => `  <bean id="${beanId}" class="com.flower.docs.gui.client.search.ComponentSearchPresenter" scope="prototype">
    <property name="categorySelectorPresenter">
      <bean class="com.flower.docs.gui.client.search.criteria.item.FakeCategorySelectorPresenter">
        <!-- MUST match the category of the VF class search this view renders (DOCUMENT or TASK) -->
        <property name="value"><value type="com.flower.docs.domain.component.Category">${category}</value></property>
      </bean>
    </property>
    <property name="responsePresenterProvider">
      <bean class="com.flower.docs.gui.client.search.response.TableSearchResponsePresenterProvider"/>
    </property>
    <property name="keywordCriteriaPresenter">
      <bean class="com.flower.docs.gui.client.search.criteria.KeywordCriteriaPresenter"><property name="enabled" value="false"/></bean>
    </property>
    <property name="hiddenColumns"><list><value>status</value><value>classid</value></list></property>
  </bean>`;
  return `${XML_HEAD}
  <!--
    Virtual-folder content-view override for VF class ${vfClassId} (LEARNINGS §15).
    Magic bean ids: content<Classid>VirtualFolder (+ Modify/ReadOnly mode variants), where
    <Classid> = the class id split on '_', each segment first-upper-rest-lower. Both the
    mangled and raw casings are emitted below — unused ids are simply ignored by the GUI.
    PRESENTATION ONLY: these beans must NOT carry a hiddenRequest — including one stops the
    override (and the VF tree config) from applying. Query, aggregation tree, columns and sort
    all come from the VF CLASS search definition (fd.vfclass), not from here.
    Optional: add an advancedCriteriaPresenter with criterion beans for filter inputs (the
    standard criteria bar already offers native value dropdowns on the VF screen).
  -->
${ids.map(presenter).join('\n')}
</beans>
`;
}

export default adapter;
