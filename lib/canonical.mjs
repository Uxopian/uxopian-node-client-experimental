// Canonicalization: the load-bearing piece of hash sync.
// Rule: the BASE hash is always hash(canon(server echo)) — push re-GETs and persists the echo.
// canonicalize() must make local-authored and server-echoed forms of the same logical object
// hash identically: strip volatile/server-owned fields, normalize known coercions, sort keys.
// New normalize rules are discovered by `uxc doctor --roundtrip` (push-echo leg) and added HERE.
import { sha256, stableStringify } from './util.mjs';

const VOLATILE_DATA_FIELDS = ['version', 'creationDate', 'lastUpdateDate', 'owner', 'lastUpdateUser', 'creationUser'];

// FD 2026's REST echo is RICHER than 2025's. canonicalize() runs on BOTH the local file AND the
// server echo, so stripping a 2026-only extra is a NO-OP on 2025 and a normalizer on 2026 — one
// rule set keeps a single package hash-clean on either version (no forking). The three extras
// (verified live on fd.demo, 2026-07 — CHANGE-REQUEST-fd2026-canon.md):
//   1. empty arrays nested at ANY depth (descriptions[]/allowedValues[]/nested[]/context[]/clauses[])
//   2. Java FQCN `type` discriminators (com.flower.docs.*) on nested DTOs (allowedValues, answers, …)
//   3. active:true — the echo drops the default (keep active:false: a genuinely inactive class)
//   4. technical:false — the echo ADDS this class TOP-LEVEL default (keep technical:true)
const FD_FQCN = /^com\.flower\.docs\./;

/** Recursively strip the FD-2026 echo extras. Returns a fresh structure; never mutates the input. */
function deepStrip(v) {
  if (Array.isArray(v)) return v.map(deepStrip);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    // nested Java discriminator (allowedValues[].type, answers[].type, vfclass search DTO types…).
    // GUARD: only FQCN VALUES — the tagclass TOP-LEVEL `type` (STRING/CHOICELIST/INT/…) is load-
    // bearing and is NOT an FQCN, so it survives.
    if (k === 'type' && typeof val === 'string' && FD_FQCN.test(val)) continue;
    // active:true is the default the 2026 echo omits; drop it so absent == true. Keep active:false.
    if (k === 'active' && val === true) continue;
    if (Array.isArray(val)) {
      const arr = val.map(deepStrip);
      if (arr.length === 0) continue; // empty array (any depth) hashes like absent
      out[k] = arr;
    } else if (val && typeof val === 'object') {
      out[k] = deepStrip(val);
    } else {
      out[k] = val;
    }
  }
  return out;
}

function cleanData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  if (out.data) {
    const data = { ...out.data };
    for (const f of VOLATILE_DATA_FIELDS) delete data[f];
    // empty-after-strip data must hash like absent data (server echoes {} where local omits)
    if (Object.keys(data).length === 0) delete out.data;
    else out.data = data;
  }
  // FD-2026 echo normalization (recursive): empty arrays at any depth, FQCN `type` discriminators,
  // and active:true. Replaces the old top-level-only empty-array strip.
  const canon = deepStrip(out);
  // technical:false is a class-level default the FD-2026 echo ADDS at the TOP LEVEL only; drop it so
  // absent == false (keep technical:true). A nested tagReference/child-slot `technical` is present on
  // both sides already, so it is left intact (and the §20 children round-trip stays exact).
  if (canon.technical === false) delete canon.technical;
  return canon;
}

const AUDIT_FIELDS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy'];

/** Remove null-valued keys at any depth (array elements are kept, their keys cleaned). */
function dropNulls(v) {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) if (val !== null) out[k] = dropNulls(val);
  return out;
}

/** The ft5 permissions block echoes allowAllTools/allowAllMcpServers:false when unset. */
function dropPermissionDefaults(o) {
  if (o.permissions && typeof o.permissions === 'object') {
    if (o.permissions.allowAllTools === false) delete o.permissions.allowAllTools;
    if (o.permissions.allowAllMcpServers === false) delete o.permissions.allowAllMcpServers;
    if (Object.keys(o.permissions).length === 0) delete o.permissions;
  }
  return o;
}

function dropFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) delete out[f];
  return out;
}

/** Per-kind normalizers. Receive a deep-cloned plain object; return the canonical shape. */
const NORMALIZERS = {
  'fd.tagclass': (o) => cleanData(o),
  'fd.tagcategory': (o) => {
    o = cleanData(o);
    // server echo omits an empty tags membership; local templates write tags: []
    if (Array.isArray(o.tags) && o.tags.length === 0) delete o.tags;
    return o;
  },
  'fd.documentclass': (o) => cleanData(o),
  // FOLDER class: children[] entries are {category,id} — round-trips via cleanData (non-empty
  // arrays kept, keys sorted). If a live echo ever injects a per-child type, doctor --roundtrip
  // flags it and a dropFields goes here (same story as fd.taskclass answers).
  'fd.folderclass': (o) => cleanData(o),
  'fd.taskclass': (o) => {
    o = cleanData(o);
    // server echoes answers[].type: com.flower.docs.domain.taskclass.ReasonedAnswer — drop it
    if (Array.isArray(o.answers)) o.answers = o.answers.map((a) => dropFields(a, ['type']));
    // `children` (attachment slots, §20) round-trips losslessly via the generic path: cleanData keeps
    // the non-empty top-level array, stableStringify sorts object keys recursively (intra-slot field
    // order is irrelevant), the server preserves array order, and — unlike answers — it injects no
    // per-slot `type`. No bespoke rule needed; if a future build does inject one, doctor --roundtrip
    // flags it and a dropFields goes here.
    return o;
  },
  'fd.vfclass': (o) => cleanData(o),
  'fd.vfinstance': (o) => cleanData(o),
  'fd.workflow': (o) => cleanData(o),
  'fd.acl': (o) => cleanData(o),
  // content-bearing document kinds: meta only — files[] echoes lie (size 0, churned tmp ids)
  'fd.script': (o) => dropFields(cleanData(o), ['files', 'currentVersion']),
  'fd.guiconfig': (o) => dropFields(cleanData(o), ['files', 'currentVersion']),
  'fd.handler': (o) => dropFields(cleanData(o), ['files', 'currentVersion']),
  'fd.document': (o) => dropFields(cleanData(o), ['files', 'currentVersion']),
  'ai.prompt': (o) => {
    // audit fields ride on the ADMIN list (adminPromptList dialect) — never part of the config.
    // 2026.0.0-ft5 adds the served version's bookkeeping to every admin-list row: `version` (its
    // number), `draft` (false once a version was published) and `usage` (deletability +
    // referencing Applications) — per-target facts, never content (AI learnings §A11).
    o = dropFields(o, ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'version', 'draft', 'usage']);
    if (o.displaySettings == null) delete o.displaySettings; // admin list echoes null when unset
    // the admin echo projects displaySettings VERBOSELY (nulls for unset keys, priority:0,
    // aiReferenceInfo:false — the last is new in the 2026-07 gateway; AI learnings §A10).
    // Strip the DEFAULTS symmetrically so a terse hand-authored {enabled:false} hashes equal
    // to the echo; non-default values (enabled flags, real labels/priorities) survive.
    if (o.displaySettings != null && typeof o.displaySettings === 'object') {
      const ds = o.displaySettings;
      for (const k of Object.keys(ds)) if (ds[k] === null) delete ds[k];
      if (ds.priority === 0) delete ds.priority;
      if (ds.aiReferenceInfo === false) delete ds.aiReferenceInfo;
      if (Object.keys(ds).length === 0) delete o.displaySettings;
    }
    if (o.temperature !== undefined && o.temperature !== null) o.temperature = String(o.temperature);
    if (typeof o.role === 'string') o.role = o.role.toLowerCase(); // server echoes 'user' for 'USER'
    return o;
  },
  'ai.goal': (o) => dropFields(o, ['id', 'createdAt']), // server id is per-target -> state, not content
  // Agentic Plan engine (2026.0.0-ft5, AI learnings §A13): the echo projects every unset field as
  // null and ADDS defaults the author never wrote. Verified on fd.demo 2026-09-16:
  //   agent: permissions {allowAllTools:false, allowAllMcpServers:false, …null} even when absent,
  //          secrets:null, successCriteria:null; createdBy/updatedAt null (server audit bug)
  //   plan:  exposeAsTool:false, toolDescription/toolInputParameters null, and per node
  //          persistOutput:false, dependencies:[], description/listKey/…/toolName null
  // Nulls go at any depth; the false/[] DEFAULTS go only where verified. Empty arrays elsewhere
  // are kept: an empty tool WHITELIST is not proven to mean the same as no whitelist.
  'ai.agent': (o) => {
    o = dropPermissionDefaults(dropNulls(dropFields(o, AUDIT_FIELDS)));
    if (o.secrets && typeof o.secrets === 'object' && Object.keys(o.secrets).length === 0) delete o.secrets;
    return o;
  },
  // Applications (ft5, AI learnings §A15): same echo projection as agents — nulls for every unset
  // field, a full permissions block with allowAll*:false when the author sent none.
  'ai.application': (o) => dropPermissionDefaults(dropNulls(dropFields(o, AUDIT_FIELDS))),
  'ai.plan': (o) => {
    o = dropNulls(dropFields(o, AUDIT_FIELDS));
    if (o.exposeAsTool === false) delete o.exposeAsTool;
    if (Array.isArray(o.nodes)) {
      o.nodes = o.nodes.map((n) => {
        if (!n || typeof n !== 'object') return n;
        const c = { ...n };
        if (c.persistOutput === false) delete c.persistOutput;
        if (Array.isArray(c.dependencies) && c.dependencies.length === 0) delete c.dependencies;
        return c;
      });
    }
    return o;
  },
  'ai.mcp': (o) => dropFields(o, ['createdAt']),
  // fast2 map: the broker MINTS four fields on create (FAST2-LEARNINGS §F5) — the mapId UUID, the
  // version block, the version-series id, and the read-only flag. They are per-target facts, not
  // content: mapId lives in per-target state (like fd.handler's deployedId). EVERYTHING else is
  // authored and must hash — steps (with their author-controlled ids, className, fields, links and
  // canvas graphic.x/y) and mapDescription. Step ids survive create verbatim and campaign stats are
  // keyed by them (§F5/§F9), so they are content, not noise.
  //
  // SECRETS: a map embeds FlowerDocs credentials inline and fast2's obfuscation (xr1c/…) is
  // REVERSIBLE (§F11). Unlike ai.mcp/ai.llm — where the SERVER returns '********' — fast2 echoes
  // the real value, so masking only the local side would drift forever. Masking here runs on BOTH
  // sides: the credential leaves the hash entirely, `writeLocal` never puts one on disk, and push
  // resolves '__masked__' back to the live value (f2-map.resolveMasked).
  'f2.map': (o) => maskF2Secrets(dropFields(o, ['id', 'mapVersion', 'mapVersionsSerieId', 'isReadOnly'])),
};

const F2_SECRET_FIELD_RE = /password|secret|apikey|api_key|token/i;
const F2_MASKED = '__masked__';
/** `{{uxc:name}}` — an unrendered variable is kept verbatim (the TEMPLATE form must survive). */
const F2_PLACEHOLDER_RE = /\{\{uxc:[A-Za-z_][A-Za-z0-9_]*\}\}/;

/** Mask credential-shaped step-field values in a fast2 map, at any nesting depth. */
function maskF2Secrets(o) {
  for (const step of o?.steps ?? []) maskConfig(step.objectConfiguration, '');
  return o;
}
function maskConfig(oc, path) {
  for (const f of oc?.fields ?? []) {
    const at = path ? `${path}.${f.name}` : f.name;
    const leaf = String(f.name ?? '');
    const pc = f.primitiveConfiguration;
    if (pc && typeof pc.value === 'string' && pc.value && F2_SECRET_FIELD_RE.test(leaf)
        && !F2_PLACEHOLDER_RE.test(pc.value)) {
      pc.value = F2_MASKED;
    }
    if (f.objectConfiguration) maskConfig(f.objectConfiguration, at);
    for (const item of f.listConfiguration ?? []) {
      if (item?.objectConfiguration) maskConfig(item.objectConfiguration, at);
    }
    // Map fields: {key:<config>, value:<config>} — a credential can hide in a map VALUE
    for (const e of f.mapConfiguration ?? []) {
      if (e?.value?.objectConfiguration) maskConfig(e.value.objectConfiguration, at);
    }
  }
}

export function canonicalize(kind, obj) {
  if (obj == null) return null;
  const clone = JSON.parse(JSON.stringify(obj));
  const norm = NORMALIZERS[kind] ?? ((x) => cleanData(x));
  return norm(clone);
}

export const canonicalText = (kind, obj) => stableStringify(canonicalize(kind, obj));

/** Hash of a canonical object + optional content buffers (scripts/guiconfig/handler files). */
export function hashResource(kind, obj, contents = []) {
  let acc = canonicalText(kind, obj);
  for (const buf of contents) acc += ' ' + sha256(buf);
  return sha256(acc);
}

/** Hash raw file bytes (dataset rows, content files). */
export const hashBytes = (buf) => sha256(buf);
