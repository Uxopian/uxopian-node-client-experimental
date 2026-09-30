// A small JSON Schema (draft 2020-12) validator — ONLY the subset uxc's own schemas use
// (schemas/*.schema.json, DESIGN §29). Zero dependencies; pure; never throws on data.
//
//   validateSchema(schema, value, { registry }) -> [{ path, message, keyword, severity }]
//
// Supported keywords: type (string or array; 'integer' = Number.isInteger), enum, const, pattern,
// minLength, maxLength, minimum, maximum, minItems, maxItems, items (one schema), properties,
// required, additionalProperties (boolean or schema), propertyNames, allOf, anyOf, oneOf, not,
// and $ref — local ('#/$defs/x', '#') or to another schema of the registry by its $id
// ('<id>' or '<id>#/$defs/x'). Annotations are ignored (title, description, markdownDescription,
// examples, default, deprecated, $comment, $id, $schema, $defs, x-*).
// SUPPORTED_KEYWORDS is exported so a test can refuse a schema that uses anything else.
//
// Severity: a failure is a 'warning' unless the schema node holding the failing keyword says
// `"x-uxc-severity": "error"` (a node's severity also covers what its own $ref brings; it does not
// flow into properties/items/anyOf branches, which carry their own). Schemas set it ONLY where uxc
// itself already refuses the same input (an adapter's validate(), validateCompat, the kind
// lookup) — see `uxc verify`, which prints errors as failures and warnings as warnings.
//
// Paths are precise and readable: `resources[3].kind`, `allowedValues[0].symbolicName`,
// `(root)` for the document itself.

export const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'maxItems', 'items', 'properties', 'required', 'additionalProperties',
  'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', '$ref',
]);
export const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$comment', 'title', 'description', 'markdownDescription',
  'examples', 'default', 'deprecated', 'x-uxc-severity',
]);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** 'resources' + 3 -> 'resources[3]'; 'a' + 'b' -> 'a.b'; odd keys quoted. */
export function joinPath(base, key) {
  if (typeof key === 'number') return `${base || ''}[${key}]`;
  const k = IDENT.test(key) ? key : JSON.stringify(key);
  if (!base) return IDENT.test(key) ? key : `[${k}]`;
  return IDENT.test(key) ? `${base}.${key}` : `${base}[${k}]`;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function isType(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => { const s = JSON.stringify(v); return s && s.length > 60 ? `${s.slice(0, 57)}...` : s; };

/** Resolve a $ref against the current root document and the registry ($id -> schema). */
function resolveRef(ref, root, registry) {
  let doc = root;
  let frag = ref;
  const hash = ref.indexOf('#');
  const base = hash === -1 ? ref : ref.slice(0, hash);
  frag = hash === -1 ? '' : ref.slice(hash + 1);
  if (base) {
    doc = registry?.get(base) ?? null;
    if (!doc) return { error: `unresolvable $ref "${ref}"` };
  }
  let node = doc;
  if (frag) {
    for (const raw of frag.replace(/^\//, '').split('/')) {
      const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      node = node?.[seg];
      if (node === undefined) return { error: `unresolvable $ref "${ref}"` };
    }
  }
  return { schema: node, root: doc };
}

function check(schema, value, path, ctx, out) {
  if (schema === true || schema == null) return;
  const where = path || '(root)';
  const severity = schema === false ? 'warning' : (schema['x-uxc-severity'] === 'error' ? 'error' : 'warning');
  const fail = (keyword, message) => out.push({ path: where, message, keyword, severity });
  if (schema === false) { fail('false', 'is not allowed here'); return; }

  if (typeof schema.$ref === 'string') {
    const r = resolveRef(schema.$ref, ctx.root, ctx.registry);
    if (r.error) fail('$ref', r.error);
    else {
      // the referencing node's severity covers what the $ref brings (a shared $def stays neutral)
      const sub = [];
      check(r.schema, value, path, { ...ctx, root: r.root }, sub);
      for (const e of sub) out.push(severity === 'error' ? { ...e, severity } : e);
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) {
      fail('type', `must be ${types.join(' or ')} (got ${typeOf(value)})`);
      return; // nothing else about this node is meaningful
    }
  }
  if (schema.const !== undefined && !same(value, schema.const)) fail('const', `must be ${show(schema.const)} (got ${show(value)})`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) {
    fail('enum', `must be one of ${schema.enum.map(show).join(', ')} (got ${show(value)})`);
  }

  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      fail('pattern', `${show(value)} does not match ${schema.pattern}`);
    }
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) fail('minLength', schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) fail('maxLength', `must be at most ${schema.maxLength} characters (got ${len})`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('minimum', `must be >= ${schema.minimum} (got ${value})`);
    if (schema.maximum !== undefined && value > schema.maximum) fail('maximum', `must be <= ${schema.maximum} (got ${value})`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems', schema.minItems === 1 ? 'must not be empty' : `must have at least ${schema.minItems} items (got ${value.length})`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', `must have at most ${schema.maxItems} items (got ${value.length})`);
    if (schema.items !== undefined) value.forEach((v, i) => check(schema.items, v, joinPath(path, i), ctx, out));
  }
  if (isType(value, 'object')) {
    for (const k of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) fail('required', `"${k}" is required`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) check(props[k], v, joinPath(path, k), ctx, out);
      else if (schema.additionalProperties === false) {
        const known = Object.keys(props);
        out.push({ path: joinPath(path, k), keyword: 'additionalProperties', severity,
          message: `unknown key "${k}"${known.length ? ` (known: ${known.join(', ')})` : ''}` });
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        check(schema.additionalProperties, v, joinPath(path, k), ctx, out);
      }
      if (schema.propertyNames !== undefined) {
        const sub = [];
        check(schema.propertyNames, k, '', ctx, sub);
        for (const e of sub) out.push({ ...e, path: joinPath(path, k), message: `key "${k}": ${e.message}` });
      }
    }
  }

  for (const s of schema.allOf ?? []) check(s, value, path, ctx, out);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = schema.anyOf ?? schema.oneOf;
    const results = branches.map((s) => { const e = []; check(s, value, path, ctx, e); return e; });
    const passing = results.filter((e) => e.length === 0).length;
    if (schema.oneOf && passing > 1) fail('oneOf', `matches ${passing} of the alternatives, exactly one is allowed`);
    if (passing === 0) {
      // report the branch that got furthest (its type matched, fewest findings); else the type list
      const typed = results.filter((e) => !e.some((x) => x.keyword === 'type' && x.path === where));
      if (typed.length) {
        const best = typed.reduce((a, b) => (b.length < a.length ? b : a));
        out.push(...best); // their own severities: a warning-level detail inside an error node stays a warning
      } else {
        const types = [...new Set(branches.flatMap((s) => {
          const t = s?.type ?? (s?.$ref ? resolveRef(s.$ref, ctx.root, ctx.registry).schema?.type : undefined);
          return t === undefined ? [] : Array.isArray(t) ? t : [t];
        }))];
        fail(schema.anyOf ? 'anyOf' : 'oneOf', types.length ? `must be ${types.join(' or ')} (got ${typeOf(value)})` : 'matches none of the allowed shapes');
      }
    }
  }
  if (schema.not !== undefined) {
    const e = [];
    check(schema.not, value, path, ctx, e);
    if (e.length === 0) fail('not', schema.not?.const !== undefined ? `must not be ${show(schema.not.const)}` : 'matches a shape that is not allowed');
  }
}

/**
 * Validate `value` against `schema`. `registry` (Map $id -> schema) resolves cross-file $refs.
 * -> [{ path, message, keyword, severity: 'error'|'warning' }] — empty when valid.
 */
export function validateSchema(schema, value, { registry = null } = {}) {
  const out = [];
  check(schema, value, '', { root: schema, registry }, out);
  return out;
}

/** Every keyword a schema uses, walked recursively (for the "only the supported subset" test). */
export function keywordsOf(schema, acc = new Set()) {
  if (!schema || typeof schema !== 'object') return acc;
  if (Array.isArray(schema)) { for (const s of schema) keywordsOf(s, acc); return acc; }
  for (const [k, v] of Object.entries(schema)) {
    acc.add(k);
    if (k === 'properties' || k === '$defs') for (const s of Object.values(v)) keywordsOf(s, acc);
    else if (['items', 'additionalProperties', 'propertyNames', 'not'].includes(k)) keywordsOf(v, acc);
    else if (['allOf', 'anyOf', 'oneOf'].includes(k)) keywordsOf(v, acc);
  }
  return acc;
}
