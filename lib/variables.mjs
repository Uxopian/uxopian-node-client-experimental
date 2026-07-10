// Package variables (DESIGN §21) — OpenShift-Templates-style parameterization for packages.
//
// Prior art (studied 2026-07-09): OpenShift Templates (parameter declarations + ONE-SHOT ${} render
// at `oc process` time) is the model that fits uxc: our `import` IS `oc process | oc create`.
// Terraform contributes typed declarations (pattern validation, sensitive, env source, precedence);
// Helm contributes values-files + document-every-value; Kustomize's anti-templating stance is the
// guard-rail: placeholders must NEVER enter the hash-sync loop — a synced checkout is always
// CONCRETE, templates exist only in the artifact and are rendered exactly once, at install.
//
// Manifest block (uxopian-project.json):
//   "variables": {
//     "gatewayUrl": {
//       "description": "Uxopian AI gateway URL as seen FROM the FlowerDocs server",
//       "example":     "http://gateway-service:8085",
//       "required":    true,          // no default -> a value MUST be provided at install
//       "default":     null,          // used when no value is provided (implies required: false)
//       "pattern":     "^https?://",  // regex the value must match (Terraform-style validation)
//       "sensitive":   false          // true: never persisted/echoed (but AVOID secrets in vars —
//     }                               // keys/passwords belong in the keychain, not in packages)
//   }
//
// Placeholder syntax: {{uxc:gatewayUrl}} — deliberately NOT OpenShift's ${NAME}: `${…}` appears
// VERBATIM in shipped content (JS template literals in fd.script files, FlowerDocs prompt helpers
// `[[${service.method(...)}]]`), so a ${}-renderer would corrupt real resources. `{{uxc:` has zero
// collisions across every existing package (verified 2026-07-09).
//
// Rules:
//   - placeholders may appear in any TEXT resource/asset file; NEVER in uxopian-project.json or
//     registry.json (ids and sync keys must be concrete) — publish and import both refuse.
//   - value precedence (Terraform-style): --var > --var-file > UXC_VAR_<NAME> env > default.
//   - missing required values FAIL with the full variable table (uxc is Claude/operator-driven:
//     the "interactive prompt" is the caller asking the operator, then retrying with --var).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isBinary } from './refs.mjs';

export const PLACEHOLDER_RE = /\{\{uxc:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Files that must stay placeholder-free (sync keys / gates live here). */
const FORBIDDEN_FILES = new Set(['uxopian-project.json', 'registry.json']);

/** Normalized variable declarations from a manifest: { name: {description, example, required, default, pattern, sensitive} } */
export function declaredVariables(manifest) {
  const out = {};
  for (const [name, raw] of Object.entries(manifest?.variables ?? {})) {
    const d = raw && typeof raw === 'object' ? raw : { default: raw };
    out[name] = {
      description: d.description ?? '',
      example: d.example ?? null,
      default: d.default ?? null,
      // explicit required wins; otherwise "no default" means required
      required: d.required ?? d.default == null,
      pattern: d.pattern ?? null,
      sensitive: !!d.sensitive,
    };
  }
  return out;
}

/**
 * Resolve values for a manifest's variables. Sources (highest wins): `vars` (--var k=v),
 * `varFile` (parsed --var-file object), env `UXC_VAR_<NAME>`, declaration default.
 * -> { values, missing: [names], unknown: [names], invalid: [{name, pattern, value}] }
 */
export function resolveValues(manifest, { vars = {}, varFile = {}, env = process.env } = {}) {
  const decls = declaredVariables(manifest);
  const values = {};
  const missing = [];
  const invalid = [];
  const unknown = Object.keys({ ...varFile, ...vars }).filter((k) => !decls[k]);
  for (const [name, d] of Object.entries(decls)) {
    const envKey = `UXC_VAR_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
    const v = vars[name] ?? varFile[name] ?? env[envKey] ?? d.default;
    if (v == null || v === '') {
      if (d.required) missing.push(name);
      continue;
    }
    const s = String(v);
    if (d.pattern && !(new RegExp(d.pattern)).test(s)) invalid.push({ name, pattern: d.pattern, value: d.sensitive ? '(sensitive)' : s });
    values[name] = s;
  }
  return { values, missing, unknown, invalid, decls };
}

/** Walk a package dir (skipping .uxc/.git) collecting text files. */
function textFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of readdirSync(d).sort()) {
      if (name === '.uxc' || name === '.git') continue;
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.push({ abs, rel: r });
    }
  })(dir, '');
  return out;
}

/** Scan a package dir for placeholders: { files: {rel: [names]}, names: Set, forbidden: [rel] }. */
export function scanPlaceholders(dir) {
  const files = {};
  const names = new Set();
  const forbidden = [];
  for (const { abs, rel } of textFiles(dir)) {
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    const found = [...buf.toString('utf8').matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
    if (!found.length) continue;
    files[rel] = [...new Set(found)];
    for (const n of found) names.add(n);
    if (FORBIDDEN_FILES.has(rel)) forbidden.push(rel);
  }
  return { files, names, forbidden };
}

/**
 * Render a package dir IN PLACE (two-phase like code-remap: compute everything, then write — an
 * abort writes NOTHING). strict: every placeholder must resolve. -> { replaced, files: [rel] }
 */
export function renderDir(dir, values, { strict = true } = {}) {
  const writes = [];
  const unresolved = new Map(); // name -> [rels]
  let replaced = 0;
  for (const { abs, rel } of textFiles(dir)) {
    if (FORBIDDEN_FILES.has(rel)) continue; // scanned/linted separately; never rendered
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    let changed = false;
    const next = text.replace(PLACEHOLDER_RE, (whole, name) => {
      if (values[name] == null) {
        unresolved.set(name, [...(unresolved.get(name) ?? []), rel]);
        return whole;
      }
      changed = true;
      replaced++;
      return values[name];
    });
    if (changed) writes.push({ abs, rel, next });
  }
  if (strict && unresolved.size) {
    const list = [...unresolved.entries()].map(([n, rels]) => `  {{uxc:${n}}} in ${[...new Set(rels)].join(', ')}`).join('\n');
    const e = new Error(`unresolved package variables — NOTHING was written:\n${list}`);
    e.explanation = 'provide values with --var name=value (repeatable), --var-file values.json, or UXC_VAR_* env; `uxc vars <pkg>` lists what the package needs.';
    throw e;
  }
  for (const w of writes) writeFileSync(w.abs, w.next);
  return { replaced, files: writes.map((w) => w.rel) };
}

/** Publish/import lint: declarations vs actual placeholders. */
export function lintVariables(manifest, dir) {
  const decls = declaredVariables(manifest);
  const scan = scanPlaceholders(dir);
  return {
    undeclared: [...scan.names].filter((n) => !decls[n]).sort(),                    // ERROR
    unused: Object.keys(decls).filter((n) => !scan.names.has(n)).sort(),            // WARNING
    forbidden: scan.forbidden,                                                       // ERROR
    used: scan,
  };
}

/** Render the variable table for humans/Claude (missing-value errors, `uxc vars`). */
export function variablesTable(manifest, values = {}) {
  const decls = declaredVariables(manifest);
  return Object.entries(decls).map(([name, d]) => ({
    name,
    required: d.required ? 'yes' : '',
    value: values[name] != null ? (d.sensitive ? '(sensitive)' : values[name]) : (d.default != null ? `(default) ${d.default}` : ''),
    description: d.description + (d.example ? `  e.g. ${d.example}` : ''),
  }));
}

/** Public (non-sensitive) view of applied values — for .uxc/variables.json + receipts. */
export function publicValues(manifest, values) {
  const decls = declaredVariables(manifest);
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, decls[k]?.sensitive ? '__sensitive__' : v]));
}
