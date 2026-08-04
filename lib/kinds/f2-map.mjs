// f2.map — a fast2 MAP (migration/ingestion workflow), stored as the broker's JSON representation
// in f2/maps/<Name>.json. Every mechanic here is live-verified: docs/FAST2-LEARNINGS.md §F4-§F9.
//
// The three things that shape this adapter:
//
//  1. NAME is the key, mapId is per-target (§F5/§F6). The registry entry id is the map NAME; the
//     server mints a `mapId` UUID on create. Same split as fd.handler (logical id vs deployed
//     `_vN`): the UUID lives in per-target state (`mapId`), resolved by name when state is cold.
//     `namePattern` is a FULL-MATCH REGEX, so exact lookup means escaping the name — an unescaped
//     name with a '.' or '-' would silently match the wrong map (or none).
//
//  2. NEVER upload to push (§F7). `POST /api/maps/upload/{name}` ignores the file's id/name and,
//     on a name collision, does NOT 409 — it silently creates `<name>_new1`. That is exactly the
//     "second live object" DESIGN §19 forbids. The JSON `POST /api/maps` 409s properly, so writes
//     go POST (create) / PUT (in-place update, no version churn) and a post-create check asserts
//     exactly one map carries the name. The upload endpoint is used ONLY by the offline
//     xml->json conversion path (uxc add --from-xml), against a throwaway name.
//
//  3. createOnly + inPlaceUpdate (§F8). Updates are safe and in place; DELETION is gated because a
//     map with any campaign refuses to delete, and a campaign wedged in `Starting` is neither
//     stoppable nor deletable through the API — it blocks its map's deletion permanently. Exactly
//     the fd.taskclass shape (DESIGN §262): "may update" is separated from "delete is dangerous".
import { canonicalize } from '../canonical.mjs';
import { jsonLayout } from './base.mjs';
import { prefixForms, looksOwned } from '../naming.mjs';
import { PLACEHOLDER_RE } from '../variables.mjs';

/** Server-minted fields, stripped from every authored/echoed body (§F5). */
const SERVER_OWNED = ['id', 'mapVersion', 'mapVersionsSerieId', 'isReadOnly'];

/** `namePattern` is a full-match regex (§F6) — escape the name so it matches ITSELF only. */
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Field names whose value is a credential. Case-insensitive, substring — fast2 connector beans
 *  use `password`, and nothing else in a map legitimately carries one (§F11). */
const SECRET_FIELD_RE = /password|secret|apikey|api_key|token/i;

/** Arondor's reversible password obfuscation prefix — a REAL credential, not a placeholder (§F11). */
const OBFUSCATED_RE = /^xr1c\//;

/** The same placeholder ai.mcp / ai.llm use: never a real secret on disk, resolved at push. */
export const MASKED = '__masked__';

/** Walk every step field entry: yields {stepName, field, value} for primitive-valued fields. */
export function* walkFields(obj) {
  for (const step of obj?.steps ?? []) {
    yield* walkObjectConfig(step.objectConfiguration, step.name ?? step.id ?? '(unnamed)');
  }
}
function* walkObjectConfig(oc, stepName, path = '') {
  for (const f of oc?.fields ?? []) {
    const at = path ? `${path}.${f.name}` : f.name;
    if (f.primitiveConfiguration && typeof f.primitiveConfiguration.value === 'string') {
      yield { stepName, field: at, value: f.primitiveConfiguration.value };
    }
    if (f.objectConfiguration) yield* walkObjectConfig(f.objectConfiguration, stepName, at);
    for (const [i, item] of (f.listConfiguration ?? []).entries()) {
      if (item?.primitiveConfiguration && typeof item.primitiveConfiguration.value === 'string') {
        yield { stepName, field: `${at}[${i}]`, value: item.primitiveConfiguration.value };
      }
      if (item?.objectConfiguration) yield* walkObjectConfig(item.objectConfiguration, stepName, `${at}[${i}]`);
    }
    for (const e of f.mapConfiguration ?? []) { // {key:<config>, value:<config>}
      if (e?.value?.objectConfiguration) yield* walkObjectConfig(e.value.objectConfiguration, stepName, at);
    }
  }
}

const hasPlaceholder = (v) => { PLACEHOLDER_RE.lastIndex = 0; return PLACEHOLDER_RE.test(v); };

const isSecretField = (field) => SECRET_FIELD_RE.test(field.split('.').pop().replace(/\[\d+\]$/, ''));

/**
 * Credential-shaped field values that are neither masked nor a `{{uxc:…}}` variable (§F11).
 * Pure function, used by `uxc export` / `mp publish` to refuse shipping a credential.
 * -> [{ stepName, field, reason }]
 */
export function findLeakedSecrets(obj) {
  const hits = [];
  for (const { stepName, field, value } of walkFields(obj)) {
    if (!isSecretField(field) || !value) continue;
    if (value === MASKED || hasPlaceholder(value)) continue;
    hits.push({
      stepName,
      field,
      reason: OBFUSCATED_RE.test(value)
        ? 'an obfuscated fast2 password (xr1c/…) — reversible, so it is a plaintext secret'
        : 'a literal value',
    });
  }
  return hits;
}

/** Rewrite every credential-shaped field value via fn(value) -> value. Returns a fresh object. */
export function mapSecrets(obj, fn) {
  const out = JSON.parse(JSON.stringify(obj));
  for (const step of out?.steps ?? []) walkConfigMut(step.objectConfiguration, '', fn);
  return out;
}
function walkConfigMut(oc, path, fn) {
  for (const f of oc?.fields ?? []) {
    const at = path ? `${path}.${f.name}` : f.name;
    if (f.primitiveConfiguration && typeof f.primitiveConfiguration.value === 'string' && isSecretField(at)) {
      f.primitiveConfiguration.value = fn(f.primitiveConfiguration.value, at);
    }
    if (f.objectConfiguration) walkConfigMut(f.objectConfiguration, at, fn);
    for (const [i, item] of (f.listConfiguration ?? []).entries()) {
      if (item?.objectConfiguration) walkConfigMut(item.objectConfiguration, `${at}[${i}]`, fn);
    }
    for (const e of f.mapConfiguration ?? []) {
      if (e?.value?.objectConfiguration) walkConfigMut(e.value.objectConfiguration, at, fn);
    }
  }
}

/** Value at a secret path in a server object — used to resolve `__masked__` back on push. */
function secretsOf(obj) {
  const m = new Map();
  for (const { field, value } of walkFields(obj ?? {})) if (isSecretField(field)) m.set(field, value);
  return m;
}

/**
 * Push-side resolution, mirroring ai.mcp / ai.llm: a `__masked__` credential takes the LIVE
 * server's value at the same path, so a placeholder never overwrites a real secret. Throws when
 * there is nothing live to resolve to — better than silently deploying the literal '__masked__'.
 */
export function resolveMasked(local, server, id) {
  const live = secretsOf(server);
  const missing = [];
  const out = mapSecrets(local, (v, at) => {
    if (v !== MASKED) return v;
    const s = live.get(at);
    if (s === undefined || s === MASKED) { missing.push(at); return v; }
    return s;
  });
  if (missing.length) {
    throw new Error(
      `f2.map/${id}: masked secret(s) at [${missing.join(', ')}] have no live server value — `
      + 'put the real value in the local file (or render the {{uxc:…}} variable) before pushing',
    );
  }
  return out;
}

/** All step ids referenced by links but not defined — links point at step ids (§F4). */
export function danglingLinks(obj) {
  const ids = new Set((obj?.steps ?? []).map((s) => s.id));
  const bad = [];
  for (const s of obj?.steps ?? []) {
    for (const l of s.links ?? []) {
      if (l?.target && !ids.has(l.target)) bad.push({ from: s.name ?? s.id, target: l.target });
    }
  }
  return bad;
}

/** Strip server-owned fields; the body POST/PUT accept (§F5). */
const bodyOf = (obj) => canonicalize('f2.map', obj);

const f2Of = (ctx) => {
  if (!ctx.clients?.f2) {
    throw new Error(
      'this target has no fast2 surface — f2.map resources need one: '
      + 'uxc target add <name> … --f2 http://host:1789 --f2-user <email> --f2-password <p>',
    );
  }
  return ctx.clients.f2;
};

/** Every map summary on the broker: [{id:{mapId}, name, versionNumber}] (§F6, empty = all). */
async function summaries(ctx) {
  ctx._f2Maps ??= (await f2Of(ctx).get('/api/maps/summary/search-by-pattern?namePattern='))?.collection ?? [];
  return ctx._f2Maps;
}
const invalidate = (ctx) => { ctx._f2Maps = null; };

/**
 * Resolve a map NAME to its server mapId. Per-target state first (cheap, like fd.handler's
 * deployedId), then an exact-name lookup. Throws when the name is ambiguous — two maps sharing a
 * name is the `_new1` damage of §F7 and must be surfaced, never guessed past.
 */
export async function resolveMapId(ctx, name) {
  // The NAME LOOKUP IS PRIMARY, never the cached id. A structural update mints a new version with
  // a new mapId and flips the old one to isReadOnly (§F16) — the summary search always returns the
  // CURRENT version, whereas a cached id keeps resolving to the frozen old one. State is only a
  // fallback for a map the summary can't see.
  const hits = (await summaries(ctx)).filter((m) => m.name === name);
  if (hits.length > 1) {
    throw new Error(
      `fast2 has ${hits.length} maps named "${name}" (${hits.map((h) => h.id?.mapId).join(', ')}) — `
      + 'the broker auto-renames on upload collisions (FAST2-LEARNINGS §F7); delete the duplicates in the UI, then re-push',
    );
  }
  if (hits.length === 1) return hits[0].id?.mapId ?? null;
  const cached = ctx.pkg?.resState?.(ctx.target?.name, 'f2.map', name)?.mapId;
  if (cached && await f2Of(ctx).tryGet(`/api/maps/${encodeURIComponent(cached)}`)) return cached;
  return null;
}

const rememberId = (ctx, name, mapId) => {
  if (mapId && ctx.pkg && ctx.target?.name) {
    try { ctx.pkg.setResState(ctx.target.name, 'f2.map', name, { mapId }); } catch { /* best-effort */ }
  }
};

const adapter = {
  kind: 'f2.map',
  dir: 'f2/maps',
  layout: 'json',
  // createOnly: deletion is gated (§F8, campaign association can make a map undeletable).
  // inPlaceUpdate: PUT /api/maps updates in place with no version churn (§F5) — so pushes still
  // update freely; only DELETE stays behind the policy gate in rm.mjs / destroy.mjs.
  defaultPolicy: 'createOnly',
  inPlaceUpdate: true,
  cacheAffecting: false,
  product: 'fast2',

  async list(ctx) {
    // summaries carry no bodies; hydrate so `uxc ls` and adopt --scan can show real content
    const out = [];
    for (const s of await summaries(ctx)) {
      const id = s.id?.mapId;
      const full = id ? await f2Of(ctx).tryGet(`/api/maps/${encodeURIComponent(id)}`) : null;
      out.push(full ? { ...full, id: s.name } : { id: s.name, name: s.name });
    }
    return out;
  },

  async get(ctx, id) {
    const mapId = await resolveMapId(ctx, id);
    return mapId ? f2Of(ctx).tryGet(`/api/maps/${encodeURIComponent(mapId)}`) : null;
  },

  async readServer(ctx, id) {
    const mapId = await resolveMapId(ctx, id);
    if (!mapId) return null;
    const obj = await f2Of(ctx).tryGet(`/api/maps/${encodeURIComponent(mapId)}`);
    if (!obj) return null;
    rememberId(ctx, id, mapId);
    return { obj }; // canonicalize strips the four server-minted fields
  },

  async create(ctx, local) {
    const name = local.obj?.name;
    // nothing live to resolve against on a create — a masked secret would deploy literally
    const leaked = findLeakedSecrets(local.obj).length;
    const masked = [...secretsOf(local.obj).values()].filter((v) => v === MASKED);
    if (masked.length && !leaked) {
      throw new Error(
        `f2.map/${name}: the map carries masked secret(s) and does not exist on ${ctx.target?.name} yet, `
        + 'so there is no live value to resolve them against — supply the real credential '
        + '(render the {{uxc:…}} variables, e.g. uxc import --var f2FlowerPassword=…) before the first push',
      );
    }
    const body = { ...bodyOf(local.obj), name };
    let created;
    try {
      created = await f2Of(ctx).post('/api/maps', body);
    } catch (e) {
      // 409 "Map name already exists" — it appeared between classify and create (TOCTOU), or a
      // previous run created it and state was lost. HEAL into an in-place update, never duplicate.
      if (e?.status !== 409) throw e;
      invalidate(ctx);
      const mapId = await resolveMapId(ctx, name);
      if (!mapId) throw e; // 409 but unresolvable: surface the original failure
      await f2Of(ctx).put('/api/maps', { ...body, id: mapId });
      rememberId(ctx, name, mapId);
      return;
    }
    invalidate(ctx);
    const mapId = created?.id ?? (await resolveMapId(ctx, name));
    rememberId(ctx, name, mapId);
    // DUPLICATE-PROOF (DESIGN §19): assert the name resolves to exactly one map. resolveMapId
    // throws when it does not, which is the check.
    await resolveMapId(ctx, name);
  },

  async update(ctx, id, local) {
    const mapId = await resolveMapId(ctx, id);
    if (!mapId) throw new Error(`fast2 map "${id}" not found on ${ctx.target?.name} — push should create it instead`);
    // masked credentials keep the LIVE value (ai.mcp / ai.llm pattern) — a pulled map never
    // carries a real secret on disk, and pushing it back must not wipe the server's
    const server = await f2Of(ctx).tryGet(`/api/maps/${encodeURIComponent(mapId)}`);
    const obj = resolveMasked(local.obj, server, id);
    // PUT needs the server's IDENTITY block back: without mapVersion / mapVersionsSerieId the
    // broker rejects the body with 400 "…is corrupted" (§F16). canonicalize strips them because
    // they are not content — so they are re-attached here, from the live object, at write time.
    await f2Of(ctx).put('/api/maps', {
      ...bodyOf(obj),
      name: id,
      id: mapId,
      mapVersion: server?.mapVersion,
      mapVersionsSerieId: server?.mapVersionsSerieId,
    });
    // A STRUCTURAL edit mints a NEW version: new mapId, versionNumber+1, the old one flipped to
    // isReadOnly (§F16). So the cached mapId is stale after every update — re-resolve it.
    invalidate(ctx);
    const after = await resolveMapId(ctx, id);
    rememberId(ctx, id, after ?? mapId);
  },

  async remove(ctx, id) {
    const mapId = await resolveMapId(ctx, id);
    if (!mapId) return; // already gone
    try {
      await f2Of(ctx).del(`/api/maps/${encodeURIComponent(mapId)}`);
    } catch (e) {
      const e2 = new Error(`cannot delete fast2 map "${id}": ${e.message}`);
      // §F8: campaign association blocks deletion, and a campaign wedged in `Starting` blocks it
      // permanently through the API. Say so — the escape hatch is not discoverable.
      e2.explanation =
        'a map with associated campaigns cannot be deleted — delete its campaigns first '
        + '(uxc f2 campaigns <map>). A campaign stuck in status "Starting" can be neither stopped nor '
        + 'deleted via the API: remove its doc from OpenSearch (DELETE :<osPort>/f2_campaigns/_doc/<campaign>) '
        + 'and RESTART the broker (it caches campaigns in memory) — FAST2-LEARNINGS §F8.';
      throw e2;
    }
    invalidate(ctx);
    if (ctx.pkg && ctx.target?.name) {
      try { ctx.pkg.setResState(ctx.target.name, 'f2.map', id, null); } catch { /* best-effort */ }
    }
  },

  validate(pkg, entry, local) {
    const errs = [];
    const o = local?.obj;
    if (!o) return ['map file is missing or unreadable'];
    if (!o.name) errs.push('name is required (it is the map key on the broker)');
    if (o.name && o.name !== entry.id) {
      errs.push(`name "${o.name}" does not match the registry id "${entry.id}" — the map name IS the key`);
    }
    if (!Array.isArray(o.steps) || o.steps.length === 0) {
      errs.push('a map needs at least one step (and must start with a Source task)');
    }
    const ids = (o.steps ?? []).map((s) => s.id);
    if (new Set(ids).size !== ids.length) errs.push('duplicate step ids — links resolve by step id');
    for (const s of o.steps ?? []) {
      if (!s.id) errs.push(`step "${s.name ?? '(unnamed)'}" has no id (links target step ids)`);
      if (!s.objectConfiguration?.className) errs.push(`step "${s.name ?? s.id}" has no objectConfiguration.className`);
    }
    for (const d of danglingLinks(o)) {
      errs.push(`step "${d.from}" links to unknown step id ${d.target}`);
    }
    // NOTE: a literal credential is NOT a push error — a rendered checkout legitimately holds the
    // real value (DESIGN §21: a synced checkout must be concrete). The credential gate lives where
    // it matters: writeLocal MASKS on pull, and export/publish refuses to ship a literal (§F11).
    return errs;
  },

  /**
   * Scaffold: a minimal but REAL ingestion map — LocalSource -> FlowerInjector into FlowerDocs,
   * with every environment-specific value already a variable (§F11). Class names and field names
   * are the ones verified present in the broker catalog (§F12).
   */
  template(ctx, name, flags = {}) {
    const prim = (v) => ({ primitiveConfiguration: { value: v } });
    /** A Pattern bean — how map VALUES are encoded, so `${…}` expressions are supported (§F15). */
    const pattern = (v) => ({
      objectConfiguration: {
        className: 'com.fast2.model.context.Pattern',
        singleton: false,
        fullyConfigured: true,
        fields: [{ name: 'pattern', ...prim(v) }],
      },
    });
    const srcId = '00000000-0000-4000-8000-000000000001';
    const altId = '00000000-0000-4000-8000-000000000002';
    const injId = '00000000-0000-4000-8000-000000000003';
    return {
      obj: {
        name,
        mapDescription: {
          // ASCII only: the broker rejects a description with "invalid characters" (400) — an em
          // dash or any non-latin punctuation fails the check (FAST2-LEARNINGS §F13)
          content: flags.description ?? `${name} scaffolded by uxc add f2.map`,
          graphic: { x: 100, y: 600, image: '' },
          isExpanded: true, height: 300, width: 372,
        },
        steps: [
          {
            id: srcId,
            name: 'LocalSource',
            queue: 'Default',
            taskType: 'Source',
            graphic: { x: 200, y: 150, image: 'com.fast2.filesystem.LocalSource' },
            objectConfiguration: {
              className: 'com.fast2.filesystem.LocalSource',
              singleton: false,
              fullyConfigured: true,
              fields: [
                { name: 'inputEncoding', ...prim('UTF-8') },
                { name: 'filesPathList', listConfiguration: [prim('{{uxc:f2SourcePath}}')] },
                { name: 'allowAnyFile', ...prim('true') },
                { name: 'filesPerPunnet', ...prim('1') },
              ],
            },
            links: [{ target: altId }],
          },
          {
            // FlowerInjector creates the document from the punnet, but the punnet must say WHICH
            // FlowerDocs class: set `className` (and canCreate for the filing tree) here. Field
            // names come from GET /api/catalog?allTask=true -> accessibleFields, NOT from the
            // product docs, which are out of date (§F12/§F15).
            id: altId,
            name: 'SetDocumentClass',
            queue: 'Default',
            taskType: 'Task',
            graphic: { x: 400, y: 150, image: 'com.fast2.alter.AlterDocumentProperties' },
            objectConfiguration: {
              className: 'com.fast2.alter.AlterDocumentProperties',
              singleton: false,
              fullyConfigured: true,
              fields: [
                { name: 'deleteProperties', ...prim('false') },
                {
                  // a Map field: entries are {key:<config>, value:<config>} — the key is itself a
                  // wrapped config, and values are Pattern beans so ${…} expressions work (§F15).
                  // The FlowerDocs target class is the `classid` property, NOT `className`.
                  name: 'propertyMap',
                  mapConfiguration: [
                    { key: prim('classid'), value: pattern('{{uxc:f2TargetClass}}') },
                  ],
                },
              ],
            },
            links: [{ target: injId }],
          },
          {
            id: injId,
            name: 'FlowerInjector',
            queue: 'Default',
            taskType: 'Task',
            graphic: { x: 600, y: 150, image: 'com.fast2.flowerdocs.FlowerInjector' },
            objectConfiguration: {
              className: 'com.fast2.flowerdocs.FlowerInjector',
              singleton: false,
              fullyConfigured: true,
              fields: [
                // `category` is REQUIRED but is NOT in the catalog's accessibleFields for this
                // class — without it the injector silently no-ops (ProcessedOK, nothing created).
                // The shipped TEMPLATE-Flower-archiving map is the reference (§F15).
                { name: 'category', ...prim('DOCUMENT') },
                { name: 'loadContent', ...prim('true') },
                { name: 'loadAnnotations', ...prim('false') },
                { name: 'loadFacts', ...prim('false') },
                { name: 'modeUpdate', ...prim('false') },
                {
                  // `connection` is the MANDATORY field name (the docs call it
                  // flowerDocsConnectionProvider — wrong for this build)
                  name: 'connection',
                  objectConfiguration: {
                    className: 'com.fast2.flowerdocs.FlowerDocsConnectionProvider',
                    singleton: false,
                    fullyConfigured: true,
                    fields: [
                      { name: 'endPoint', ...prim('{{uxc:f2FlowerEndpoint}}') },
                      { name: 'login', ...prim('{{uxc:f2FlowerLogin}}') },
                      { name: 'password', ...prim('{{uxc:f2FlowerPassword}}') },
                      { name: 'scope', ...prim('{{uxc:f2FlowerScope}}') },
                    ],
                  },
                },
              ],
            },
            links: [],
          },
        ],
      },
    };
  },

  async scan(ctx, manifest) {
    const forms = manifest.idPrefixes ?? prefixForms(manifest.code);
    return (await summaries(ctx))
      .filter((m) => looksOwned({ ...manifest, idPrefixes: forms }, String(m.name)))
      .map((m) => ({ id: m.name, title: `map v${m.versionNumber}` }));
  },
};

Object.assign(adapter, jsonLayout(adapter));
export default adapter;
